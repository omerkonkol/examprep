// PDF MCQ detection — text-layer driven.
//
// Takes the `pages` structure produced by extractPositions() and finds
// every multiple-choice question on the exam. Supports two structural
// patterns used by Israeli exams:
//   • "sections" mode — a single parent question ("שאלה 1") with sub-
//     sections (סעיף א, סעיף ב, ...). One parent, N sub-MCQs.
//   • "standalone" mode — each question is its own heading ("שאלה N" or
//     biology-style "N (" with no שאלה prefix).
//
// Also handles up to 10 option letters (א–י) — biology/genetics exams
// commonly use 6–10 options per question.

import { buildLines } from './pdf-positions.mjs';

// Crop margins — shared with pdf-crop.mjs but duplicated here to keep
// the bottom-boundary safety math self-contained.
const CROP_MARGIN_BOTTOM_PT = 18;

const ALL_LETTERS = ['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ז', 'ח', 'ט', 'י'];

// Find the page range for a parent question (used by sections mode).
export function findQuestionRange(pages, parentQ) {
  let startPage = null, startY = null, endPage = null, endY = null;
  for (const page of pages) {
    const lines = buildLines(page);
    for (const line of lines) {
      const m = line.text.match(/שאלה\s*(\d+)|(\d+)\s*שאלה/);
      if (m) {
        const num = parseInt((m[1] || m[2]), 10);
        if (num === parentQ && startPage === null) {
          startPage = page.page; startY = line.yFromTop;
        } else if (num === parentQ + 1 && startPage !== null && endPage === null) {
          endPage = page.page; endY = line.yFromTop;
        }
      }
    }
  }
  return { startPage, startY, endPage, endY };
}

// Find sub-section headings (סעיף א/ב/ג...) within a parent question.
export function findSectionHeadings(pages, parentQ) {
  const range = findQuestionRange(pages, parentQ);
  const results = [];
  if (range.startPage === null) return { headings: results, range };
  const seen = new Set();
  for (const page of pages) {
    if (page.page < range.startPage) continue;
    if (range.endPage !== null && page.page > range.endPage) break;
    const lines = buildLines(page);
    for (const line of lines) {
      if (range.endPage === page.page && line.yFromTop >= range.endY) continue;
      for (const letter of ALL_LETTERS) {
        if (seen.has(letter)) continue;
        const re1 = new RegExp(`(^|\\s)סעיף\\s*${letter}['\u2019\u05F3\`]?(\\s|$|\\()`);
        const re2 = new RegExp(`(^|\\s)${letter}['\u2019\u05F3\`]\\s*\\(\\s*\\d+\\s*נק`);
        if (re1.test(line.text) || re2.test(line.text)) {
          if (line.rightX > page.width - 110) {
            seen.add(letter);
            results.push({ section: letter, page: page.page, yFromTop: line.yFromTop });
            break;
          }
        }
      }
    }
  }
  results.sort((a, b) => a.page - b.page || a.yFromTop - b.yFromTop);
  return { headings: results, range };
}

// Find standalone numbered question headings ("שאלה 1", "שאלה 2", ..., "1 (", "2 (").
// Requires that the line STARTS with "שאלה" or "N (" (not embedded in a paragraph)
// and sits near the right edge of the page (RTL heading position).
//
// Page 1 is scanned unless it's clearly an instructions page (has the word
// "הוראות" / "כללי" near the top and no question headings).
export function findStandaloneQuestions(pages) {
  const results = [];
  const seen = new Set();
  let skipPage1 = false;
  if (pages.length > 1) {
    const p1 = pages.find(p => p.page === 1);
    if (p1) {
      const lines = buildLines(p1);
      const hasQHeading = lines.some(l =>
        /^\s*שאלה\s*\d/.test(l.text) ||
        /^\s*\d{1,3}\s*\(\s*(?!\d)/.test(l.text));
      const looksLikeInstructions = lines.slice(0, 15).some(l =>
        /(הוראות\s+כלליות|משך\s+הבחינה|חומר\s+עזר|מהלך\s+הבחינה)/.test(l.text));
      skipPage1 = !hasQHeading && looksLikeInstructions;
    }
  }
  for (const page of pages) {
    if (page.page === 1 && skipPage1) continue;
    const lines = buildLines(page);
    for (const line of lines) {
      if (line.text.length > 300) continue;
      // Match "שאלה N" at line start OR bare "N (" format used by biology/genetics
      // exams: "1 ( לפי התוצאות...".
      const m = line.text.match(/^\s*שאלה\s*(\d{1,3})(?!\d)/)
             || line.text.match(/^\s*(\d{1,3})\s*\(\s*(?!\d)/);
      if (!m) continue;
      const num = parseInt(m[1], 10);
      if (num < 1 || num > 100 || seen.has(num)) continue;
      if (line.rightX <= page.width * 0.35) continue;
      seen.add(num);
      results.push({ section: String(num), page: page.page, yFromTop: line.yFromTop });
    }
  }
  results.sort((a, b) => a.page - b.page || a.yFromTop - b.yFromTop);
  return results;
}

// Given a heading and the next heading, find where the current question ends.
//
// Returned `yFromTop` is pre-margin bottom — buildCropUrl adds CROP_MARGIN_BOTTOM_PT
// on top. We cap at (hardUpper - safety) so the crop never spills into the
// next heading after aesthetic margin.
//
// Priority: (A) נימוק line, (B) last sequential option, (C) next heading, (D) page bottom.
export function findBottomBoundary(pages, fromHeading, nextHeading) {
  const startPage = fromHeading.page;
  const startY = fromHeading.yFromTop;
  const page = pages.find(p => p.page === startPage);
  if (!page) return null;

  const hardUpper = (nextHeading && nextHeading.page === startPage)
    ? nextHeading.yFromTop
    : page.height;

  const SAFETY = CROP_MARGIN_BOTTOM_PT + 6;
  const safeCap = hardUpper - SAFETY;

  const lines = buildLines(page);

  // A. "נימוק" line
  for (const line of lines) {
    if (line.yFromTop <= startY || line.yFromTop >= hardUpper) continue;
    if (/^נימוק\s*[:.]?\s*$/.test(line.text)) {
      return { page: startPage, yFromTop: Math.min(safeCap, line.yFromTop - 10) };
    }
  }

  // B. Last sequential option line in the region (supports up to 10 options)
  const HEB_OPTS_BB = 'אבגדהוזחטי';
  let lastOptionY = null;
  let numSeen = 0, hebSeen = 0;
  for (const line of lines) {
    if (line.yFromTop <= startY || line.yFromTop >= hardUpper) continue;
    const t = line.text.replace(/^[\s•·]+/, '');
    const mNum = t.match(/^\(?\s*(\d{1,2})\s*[.)]/);
    if (mNum) {
      const n = parseInt(mNum[1], 10);
      if (n === numSeen + 1 && n <= 10) {
        numSeen = n;
        lastOptionY = line.yFromTop;
        continue;
      }
    }
    const mHeb = t.match(/^\(?\s*([א-י])\s*[.)]/);
    if (mHeb) {
      const idx = HEB_OPTS_BB.indexOf(mHeb[1]);
      if (idx === hebSeen && hebSeen < HEB_OPTS_BB.length) {
        hebSeen = idx + 1;
        lastOptionY = line.yFromTop;
        continue;
      }
    }
  }
  if (lastOptionY !== null && Math.max(numSeen, hebSeen) >= 2) {
    let includeY = lastOptionY;
    const tail = lines
      .filter(l => l.yFromTop > lastOptionY && l.yFromTop < hardUpper)
      .sort((a, b) => a.yFromTop - b.yFromTop);
    for (const line of tail) {
      if (/^נימוק\s*[:.]?\s*$/.test(line.text)) break;
      if (/^\s*שאלה\s*\d/.test(line.text)) break;
      if (/^\s*\d{1,3}\s*\(\s*(?!\d)/.test(line.text)) break;
      const t = line.text.replace(/^[\s•·]+/, '');
      if (/^\(?\s*\d{1,2}\s*[.)]/.test(t)) break;
      if (/^\(?\s*[א-י]\s*[.)]/.test(t)) break;
      if (line.yFromTop - includeY > 25) break;
      includeY = line.yFromTop;
    }
    return { page: startPage, yFromTop: Math.min(safeCap, includeY + 6) };
  }

  // C. Next heading on the same page
  if (nextHeading && nextHeading.page === startPage) {
    return { page: startPage, yFromTop: safeCap };
  }

  // D. Page bottom
  return { page: startPage, yFromTop: page.height - 30 };
}

// Does the region between heading and bottom look like an MCQ?
// Signals:
//   + "הקיפו" / "בחרו" / "איזו מהטענות" → explicit circle = MCQ
//   + ≥3 sequential numbered (1.2.3.4) or lettered (א.ב.ג.ד.) option lines
//   - open-question commands at start (הוכיחו / השלימו / ...)
export function classifyRegion(pages, heading, bottom, strict = false) {
  const page = pages.find(p => p.page === heading.page);
  if (!page) return { isMCQ: false, numOptions: 0 };
  const lines = buildLines(page);
  const regionBottom = bottom ? bottom.yFromTop : page.height;
  let regionLines = lines.filter(l =>
    l.yFromTop > heading.yFromTop && l.yFromTop < regionBottom);

  if (regionBottom >= page.height - 60) {
    const nextPage = pages.find(p => p.page === heading.page + 1);
    if (nextPage) {
      const nextLines = buildLines(nextPage).filter(l => l.yFromTop < 380);
      regionLines = [...regionLines, ...nextLines];
    }
  }

  if (regionLines.length === 0) return { isMCQ: false, numOptions: 0 };

  const regionText = regionLines.map(l => l.text).join(' ');

  // Count sequential option markers. Up to 10 options (biology/genetics).
  const HEB_OPTION_LETTERS = 'אבגדהוזחטי';
  let num = 0, heb = 0;
  for (const l of regionLines) {
    const t = l.text.replace(/^[\s•·]+/, '');
    const mNum = t.match(/^\(?\s*(\d{1,2})\s*[.):\s]/);
    if (mNum) {
      const n = parseInt(mNum[1], 10);
      if (n === num + 1 && n <= 10) num = n;
    }
    const mHeb = t.match(/^\(?\s*([א-י])\s*[.):\s]/);
    if (mHeb) {
      const letterIdx = HEB_OPTION_LETTERS.indexOf(mHeb[1]);
      if (letterIdx === heb && heb < HEB_OPTION_LETTERS.length) heb = letterIdx + 1;
    }
  }
  const numOptions = Math.max(num, heb);
  const hasCirclePhrase = /(הקיפו|איזו\s+מהטענות|איזה\s+מהבא|בחרו\s+את|סמנו\s+את)/.test(regionText);

  if (hasCirclePhrase) {
    return { isMCQ: true, numOptions: Math.max(numOptions, 2) };
  }

  const openMarkers = /(הוכיחו|הפריכו|השלימו\s+את|כתבו\s+את|מימשו\s+את|ממשו\s+את|חשבו\s+את|תכננו\s+את|סרטטו|ציירו|תארו\s+את|הסבירו|פתרו\s+את|נמקו\s+את)/;
  if (openMarkers.test(regionText) && numOptions < 3) {
    return { isMCQ: false, numOptions: 0 };
  }

  if (numOptions >= 3) return { isMCQ: true, numOptions };

  if (strict) return { isMCQ: false, numOptions };

  return { isMCQ: true, numOptions: numOptions || 4 };
}

// Extract question stem + per-option text from a detected MCQ region.
// Returns { questionStemText, optionTexts: {1..N: text} }.
export function extractRegionText(pages, page, yTop, yBottom) {
  const pageData = pages.find(p => p.page === page);
  if (!pageData) return { questionStemText: '', optionTexts: {} };

  let lines = buildLines(pageData).filter(l => l.yFromTop > yTop && l.yFromTop < yBottom);
  if (yBottom >= pageData.height - 60) {
    const nextPage = pages.find(p => p.page === page + 1);
    if (nextPage) {
      const nextLines = buildLines(nextPage).filter(l => l.yFromTop < 380);
      lines = [...lines, ...nextLines];
    }
  }
  lines = lines.filter(l =>
    !/^\s*שאלה\s*\d{1,3}/.test(l.text) &&
    !/^\s*\d{1,3}\s*\(\s*(?!\d)/.test(l.text)
  );
  if (lines.length === 0) return { questionStemText: '', optionTexts: {} };

  const HEB_OPTS = 'אבגדהוזחטי';
  const stemLines = [];
  const options = {};
  let currentOpt = 0;

  for (const l of lines) {
    const t = l.text.replace(/^[\s•·]+/, '').trim();
    if (!t) continue;
    const mNum = t.match(/^\(?\s*(\d{1,2})\s*[.)]\s*(.*)$/);
    const mHeb = t.match(/^\(?\s*([א-י])\s*[.)]\s*(.*)$/);
    if (mNum) {
      const n = parseInt(mNum[1], 10);
      if (n === currentOpt + 1 && n <= 10) {
        currentOpt = n;
        options[n] = [mNum[2].trim()].filter(Boolean);
        continue;
      }
    }
    if (mHeb) {
      const idx = HEB_OPTS.indexOf(mHeb[1]) + 1;
      if (idx === currentOpt + 1) {
        currentOpt = idx;
        options[idx] = [mHeb[2].trim()].filter(Boolean);
        continue;
      }
    }
    if (currentOpt > 0) {
      options[currentOpt].push(t);
    } else {
      stemLines.push(t);
    }
  }

  const optionTexts = {};
  for (const [k, v] of Object.entries(options)) {
    optionTexts[k] = v.join(' ').replace(/\s+/g, ' ').trim();
  }

  return {
    questionStemText: stemLines.join(' ').replace(/\s+/g, ' ').trim(),
    optionTexts,
  };
}

// Top-level MCQ detection: auto-picks sections vs. standalone mode.
export function detectMCQsFromPositions(pages) {
  let best = { mode: 'none', mcqs: [] };
  for (let pq = 1; pq <= 6; pq++) {
    const { headings } = findSectionHeadings(pages, pq);
    if (headings.length < 3) continue;
    const mcqs = [];
    for (let i = 0; i < headings.length; i++) {
      const h = headings[i];
      const next = headings[i + 1];
      const bottom = findBottomBoundary(pages, h, next);
      if (!bottom) continue;
      const cls = classifyRegion(pages, h, bottom);
      if (!cls.isMCQ) continue;
      const pageMeta = pages.find(p => p.page === h.page);
      const regionText = extractRegionText(pages, h.page, h.yFromTop, bottom.yFromTop);
      mcqs.push({
        section: h.section,
        number: i + 1,
        page: h.page,
        yTop: h.yFromTop,
        yBottom: bottom.yFromTop,
        pageWidth: pageMeta.width,
        pageHeight: pageMeta.height,
        numOptions: cls.numOptions,
        questionStemText: regionText.questionStemText,
        optionTexts: regionText.optionTexts,
      });
    }
    if (mcqs.length > best.mcqs.length) {
      best = { mode: `sections(parent=${pq})`, mcqs };
    }
  }

  const standalone = findStandaloneQuestions(pages);
  if (standalone.length >= 3) {
    const mcqs = [];
    for (let i = 0; i < standalone.length; i++) {
      const h = standalone[i];
      const next = standalone[i + 1];
      const bottom = findBottomBoundary(pages, h, next);
      if (!bottom) continue;
      const cls = classifyRegion(pages, h, bottom, /* strict */ true);
      if (!cls.isMCQ) continue;
      const pageMeta = pages.find(p => p.page === h.page);
      const regionText = extractRegionText(pages, h.page, h.yFromTop, bottom.yFromTop);
      mcqs.push({
        section: h.section,
        number: parseInt(h.section, 10),
        page: h.page,
        yTop: h.yFromTop,
        yBottom: bottom.yFromTop,
        pageWidth: pageMeta.width,
        pageHeight: pageMeta.height,
        numOptions: cls.numOptions,
        questionStemText: regionText.questionStemText,
        optionTexts: regionText.optionTexts,
      });
    }

    // Second pass — recover missed MCQs with a non-strict classifier.
    if (mcqs.length >= 2 && mcqs.length < standalone.length) {
      const confirmedNums = new Set(mcqs.map(m => m.number));
      for (let i = 0; i < standalone.length; i++) {
        const h = standalone[i];
        const num = parseInt(h.section, 10);
        if (confirmedNums.has(num)) continue;
        const next = standalone[i + 1];
        const bottom = findBottomBoundary(pages, h, next);
        if (!bottom) continue;
        const cls2 = classifyRegion(pages, h, bottom, /* strict */ false);
        if (!cls2.isMCQ) continue;
        const pageMeta = pages.find(p => p.page === h.page);
        const regionText = extractRegionText(pages, h.page, h.yFromTop, bottom.yFromTop);
        console.log(`[standalone-gap-fill] adding Q${num} via non-strict pass`);
        mcqs.push({
          section: h.section,
          number: num,
          page: h.page,
          yTop: h.yFromTop,
          yBottom: bottom.yFromTop,
          pageWidth: pageMeta.width,
          pageHeight: pageMeta.height,
          numOptions: cls2.numOptions || 4,
          questionStemText: regionText.questionStemText,
          optionTexts: regionText.optionTexts,
        });
      }
    }

    if (mcqs.length > best.mcqs.length) {
      best = { mode: 'standalone', mcqs };
    }
  }

  return best;
}
