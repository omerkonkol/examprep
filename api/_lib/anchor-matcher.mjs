// =====================================================
// ID Anchor Matcher — regex fallback for solution PDFs
// =====================================================
// When Gemini's analyzeSolutionPdf returns an incomplete answer map
// (e.g. 18/20 questions), this scans the raw solution text for
// "שאלה N → letter/digit" patterns and cross-validates. Free fallback:
// no extra Gemini tokens.
//
// Input:
//   solutionText  — raw text from unpdf (joined across pages)
//   questionNumbers — array of integers (question numbers from the exam)
//
// Output:
//   {
//     answers: { [qNum]: {idx: number, letter: string, method: 'regex_anchor'} },
//     matched: number,  // count of qNums we found anchors for
//     ambiguous: number[]  // qNums where regex found conflicting anchors
//   }
// =====================================================

// Map of Hebrew letters → 1-based index (matches Gemini convention).
const LETTER_TO_IDX = {
  'א': 1, 'ב': 2, 'ג': 3, 'ד': 4, 'ה': 5,
  'ו': 6, 'ז': 7, 'ח': 8, 'ט': 9, 'י': 10,
};

// Strip common diacritics + geresh so "א'" and "א." both normalize to "א".
function normLetter(raw) {
  if (!raw) return null;
  const ch = String(raw).replace(/['׳`.)\]]/g, '').trim();
  return LETTER_TO_IDX[ch] || null;
}

// Normalize text: collapse whitespace, unify punctuation marks that commonly
// appear between question number and answer letter.
function normalizeText(txt) {
  return String(txt || '')
    .replace(/[–—−]/g, '-')
    .replace(/[:：.]/g, '.')
    .replace(/\s+/g, ' ')
    .trim();
}

// Core scan. Walks the text once and records every (qNum, answer) anchor
// we find within 200 chars of each other.
export function extractAnchorsFromSolutionText(solutionText, questionNumbers = []) {
  if (!solutionText || typeof solutionText !== 'string') {
    return { answers: {}, matched: 0, ambiguous: [] };
  }
  const text = normalizeText(solutionText);
  const wantSet = new Set(questionNumbers.map(n => Number(n)));

  // Collect candidates: { qNum, idx, letter, pos, pattern }
  const candidates = [];

  // Pattern A: "שאלה N" or "שאלה N." or "שאלה N:" followed (within 200 chars)
  //            by "תשובה X" where X is a letter or digit.
  const pat1 = /שאלה\s*(\d{1,3})[.:)\s]+([\s\S]{0,200}?)תשובה[\s.:]*([א-י]|\d)/g;
  let m;
  while ((m = pat1.exec(text)) !== null) {
    const qNum = Number(m[1]);
    if (wantSet.size && !wantSet.has(qNum)) continue;
    const ansRaw = m[3];
    let idx = null;
    if (/^\d$/.test(ansRaw)) {
      const n = parseInt(ansRaw, 10);
      if (n >= 1 && n <= 10) idx = n;
    } else {
      idx = normLetter(ansRaw);
    }
    if (idx) candidates.push({ qNum, idx, letter: ansRaw, pos: m.index, pattern: 'A' });
  }

  // Pattern B: Answer key table lines "N. letter" or "N) letter" or "N - letter"
  //           where N is at start of line / after whitespace + punct.
  const pat2 = /(?:^|\s|[\r\n])(\d{1,3})\s*[.)\-:]\s*([א-י]|\d)\b/g;
  while ((m = pat2.exec(text)) !== null) {
    const qNum = Number(m[1]);
    if (wantSet.size && !wantSet.has(qNum)) continue;
    const ansRaw = m[2];
    let idx = null;
    if (/^\d$/.test(ansRaw)) {
      const n = parseInt(ansRaw, 10);
      if (n >= 1 && n <= 10) idx = n;
    } else {
      idx = normLetter(ansRaw);
    }
    // Filter obvious false positives — "1. 1" is suspicious (ambiguous).
    // Also avoid years like "2023. 2".
    if (qNum > 200) continue;
    if (idx) candidates.push({ qNum, idx, letter: ansRaw, pos: m.index, pattern: 'B' });
  }

  // Pattern C: Summary table format "| N | letter |" with spaces/pipes.
  const pat3 = /\|\s*(\d{1,3})\s*\|\s*([א-י]|\d)\s*\|/g;
  while ((m = pat3.exec(text)) !== null) {
    const qNum = Number(m[1]);
    if (wantSet.size && !wantSet.has(qNum)) continue;
    const ansRaw = m[2];
    let idx = null;
    if (/^\d$/.test(ansRaw)) {
      const n = parseInt(ansRaw, 10);
      if (n >= 1 && n <= 10) idx = n;
    } else {
      idx = normLetter(ansRaw);
    }
    if (idx) candidates.push({ qNum, idx, letter: ansRaw, pos: m.index, pattern: 'C' });
  }

  // Bucket by qNum and resolve conflicts.
  // Priority: A > C > B (explicit "תשובה" > summary table > bare list).
  // If two different idx values appear for same qNum, mark ambiguous.
  const priority = { A: 3, C: 2, B: 1 };
  const bucket = new Map();
  for (const c of candidates) {
    const prev = bucket.get(c.qNum);
    if (!prev) { bucket.set(c.qNum, c); continue; }
    if (prev.idx !== c.idx) {
      // Keep higher priority; if tied, mark both suspicious.
      if (priority[c.pattern] > priority[prev.pattern]) bucket.set(c.qNum, c);
      else if (priority[c.pattern] < priority[prev.pattern]) { /* keep prev */ }
      else bucket.set(c.qNum, { ...prev, _ambiguous: true, _alt: c.idx });
    }
  }

  const answers = {};
  const ambiguous = [];
  for (const [qNum, c] of bucket.entries()) {
    if (c._ambiguous) ambiguous.push(qNum);
    else answers[qNum] = { idx: c.idx, letter: c.letter, method: 'regex_anchor', pattern: c.pattern };
  }

  return {
    answers,
    matched: Object.keys(answers).length,
    ambiguous,
  };
}

// Cross-validate Gemini answers against regex anchors.
// Returns the merged answer map + flags for conflicts/fills.
// - If Gemini had an answer and regex agrees → keep Gemini (high confidence).
// - If Gemini had an answer and regex DISAGREES → mark the qNum for review
//   (caller should set answer_confidence='uncertain').
// - If Gemini had nothing and regex has an answer → use regex (fills gap).
// - If both empty → no answer (caller already handles this as 'unknown').
export function crossValidateAnswers(geminiAnswers, regexAnswers) {
  const merged = {};
  const conflicts = [];  // qNums where gemini and regex disagree
  const fills = [];      // qNums where regex filled a gap
  const agreements = []; // qNums where both agree

  const allKeys = new Set([
    ...Object.keys(geminiAnswers || {}),
    ...Object.keys(regexAnswers || {}),
  ]);

  for (const k of allKeys) {
    const qNum = Number(k);
    const gem = geminiAnswers?.[k];
    const reg = regexAnswers?.[k];
    const gemIdx = typeof gem === 'number' ? gem : (typeof gem === 'object' ? gem?.idx : null);
    const regIdx = reg?.idx || null;

    if (gemIdx && regIdx) {
      if (gemIdx === regIdx) {
        merged[k] = gemIdx;
        agreements.push(qNum);
      } else {
        merged[k] = gemIdx;
        conflicts.push(qNum);
      }
    } else if (gemIdx) {
      merged[k] = gemIdx;
    } else if (regIdx) {
      merged[k] = regIdx;
      fills.push(qNum);
    }
  }

  return { merged, conflicts, fills, agreements };
}
