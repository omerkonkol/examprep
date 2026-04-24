// =====================================================
// Explanation validator — Layer 4
// =====================================================
// Called before persisting an AI-generated explanation to ep_questions.
// Rejects outputs that don't meet quality bars so users never see broken
// KaTeX, mis-aligned answers, or suspiciously short text.
//
// Validation checks:
//   1. JSON shape: required fields present and correctly typed
//   2. LaTeX balance: $ and $$ are paired (no hanging math blocks)
//   3. Min length: correct_analysis/general_explanation not trivially short
//   4. Alignment: the explanation actually claims the right option is correct
//   5. Forbidden patterns: no explicit "correct answer is X" where X != correctIdx
// =====================================================

const HEBREW_LETTERS = ['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ז', 'ח', 'ט', 'י'];

export function validateExplanation(exp, { correctIdx, numOptions } = {}) {
  const errors = [];
  if (!exp || typeof exp !== 'object') {
    return { valid: false, errors: ['explanation missing or not an object'] };
  }

  // 1. Required fields.
  const general = String(exp.general_explanation || exp.correct_analysis || '').trim();
  if (!general) errors.push('general_explanation missing or empty');

  const opts = Array.isArray(exp.option_explanations) ? exp.option_explanations : [];
  if (opts.length === 0 && !Array.isArray(exp.distractor_analysis)) {
    errors.push('no option_explanations or distractor_analysis provided');
  }

  // 2. LaTeX balance — $ count must be even; $$ must be paired.
  const combinedText = [
    general,
    ...opts.map(o => String(o?.explanation || '')),
    ...(Array.isArray(exp.distractor_analysis) ? exp.distractor_analysis.map(d => `${d?.misconception || ''} ${d?.why_wrong || ''}`) : []),
  ].join(' ');
  const dollarMatches = combinedText.match(/\$+/g) || [];
  let totalDollars = 0;
  let doubleDollars = 0;
  for (const tok of dollarMatches) {
    if (tok.length === 2) doubleDollars++;
    else if (tok.length === 1) totalDollars++;
    // Triple+ dollars are suspicious (likely a typo).
    else if (tok.length >= 3) errors.push(`suspicious $-sequence (len=${tok.length})`);
  }
  if (totalDollars % 2 !== 0) errors.push(`unbalanced $...$ (${totalDollars} single $ tokens, must be even)`);
  if (doubleDollars % 2 !== 0) errors.push(`unbalanced $$...$$ (${doubleDollars} double-$ tokens, must be even)`);

  // 3. Min length — general explanation should be substantive.
  if (general.length > 0 && general.length < 80) {
    errors.push(`general_explanation too short (${general.length} chars, need >=80)`);
  }

  // 4. Alignment — if we know the correct index, confirm at least one per-option
  // explanation agrees. Tolerant check: if explanations explicitly say a WRONG
  // option is correct, we reject.
  if (correctIdx && opts.length > 0) {
    const correctLetter = HEBREW_LETTERS[correctIdx - 1] || String(correctIdx);
    // Find the option marked as correct in the explanations.
    const markedCorrect = opts.filter(o => o && o.isCorrect === true).map(o => parseInt(o.idx, 10));
    if (markedCorrect.length > 0 && !markedCorrect.includes(correctIdx)) {
      errors.push(`option_explanations marks ${markedCorrect.join(',')} as correct, but correct_idx=${correctIdx}`);
    }
    // 5. Forbidden pattern — explicit "correct answer is X" with X != our idx.
    // Only flag when X is actually a valid letter for another option.
    const re = /(?:התשובה\s+(?:ה)?נכונה|תשובה\s+סופית)\s+(?:היא\s+)?([א-י])/g;
    let m;
    while ((m = re.exec(combinedText)) !== null) {
      const claimedLetter = m[1];
      const claimedIdx = HEBREW_LETTERS.indexOf(claimedLetter) + 1;
      if (claimedIdx > 0 && claimedIdx <= (numOptions || 10) && claimedIdx !== correctIdx) {
        errors.push(`explanation claims correct answer is ${claimedLetter} (idx ${claimedIdx}) but ground truth is ${correctLetter} (idx ${correctIdx})`);
        break;
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

// Pick the best explanation from a set of candidates (self-consistency voting).
// Strategy: prefer the longest VALID explanation — more detail usually means
// better pedagogy as long as it passed validation.
export function selectBestExplanation(candidates, context = {}) {
  const scored = [];
  for (const cand of candidates) {
    if (!cand) continue;
    const v = validateExplanation(cand, context);
    if (!v.valid) continue;
    const gen = String(cand.general_explanation || '').length;
    const optsLen = (Array.isArray(cand.option_explanations) ? cand.option_explanations : [])
      .reduce((s, o) => s + String(o?.explanation || '').length, 0);
    scored.push({ cand, score: gen + optsLen * 0.5, validation: v });
  }
  if (scored.length === 0) return { best: null, reason: 'no candidate passed validation' };
  scored.sort((a, b) => b.score - a.score);
  return { best: scored[0].cand, score: scored[0].score, totalValid: scored.length };
}
