// Debug the upload.mjs detection logic against a real PDF.
// Usage: node scripts/debug-upload-detection.mjs "path/to/exam.pdf"

import * as fs from 'node:fs';

// Inline a minimal copy of the logic that lives in api/upload.mjs so we can
// inspect what the detection thinks the page layout is.

async function extractPositions(pdfBytes) {
  const { getDocumentProxy } = await import('unpdf');
  const doc = await getDocumentProxy(new Uint8Array(pdfBytes));
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const viewport = page.getViewport({ scale: 1.0 });
    const tc = await page.getTextContent();
    const items = tc.items
      .filter(it => it && it.str !== undefined)
      .map(it => ({
        str: it.str,
        x: it.transform[4],
        y: it.transform[5],
        yFromTop: viewport.height - it.transform[5],
        width: it.width,
        height: it.height,
      }));
    pages.push({ page: i, width: viewport.width, height: viewport.height, items });
  }
  return pages;
}

function buildLines(page, yTol = 3) {
  const items = page.items.filter(it => it.str && it.str.trim() !== '');
  if (!items.length) return [];
  const sorted = [...items].sort((a, b) => a.yFromTop - b.yFromTop);
  const lines = [];
  for (const it of sorted) {
    const line = lines.find(l => Math.abs(l.yFromTop - it.yFromTop) < yTol);
    if (line) {
      line.items.push(it);
      line.yFromTop = (line.yFromTop * (line.items.length - 1) + it.yFromTop) / line.items.length;
    } else {
      lines.push({ yFromTop: it.yFromTop, items: [it] });
    }
  }
  for (const line of lines) {
    line.items.sort((a, b) => b.x - a.x);
    const parts = [];
    let lastX = null;
    for (const it of line.items) {
      if (lastX !== null && lastX - (it.x + (it.width || 0)) > 2) parts.push(' ');
      parts.push(it.str);
      lastX = it.x;
    }
    line.text = parts.join('').replace(/\s+/g, ' ').trim();
    line.leftX = Math.min(...line.items.map(it => it.x));
    line.rightX = Math.max(...line.items.map(it => it.x + (it.width || 0)));
  }
  return lines;
}

const path = process.argv[2];
if (!path) { console.error('Usage: node debug-upload-detection.mjs <pdf>'); process.exit(1); }

const bytes = fs.readFileSync(path);
const pages = await extractPositions(bytes);
console.log(`\nPDF: ${path}  (${pages.length} pages)\n`);

for (const page of pages) {
  console.log(`\n=== PAGE ${page.page}  width=${page.width.toFixed(1)}  height=${page.height.toFixed(1)} ===`);
  const lines = buildLines(page);
  for (const line of lines) {
    const rightFromEdge = (page.width - line.rightX).toFixed(1);
    // Show lines that might be question headings or options
    const isMaybeHeading = /שאלה/.test(line.text) || /^\s*[א-ט][.)]/.test(line.text) || /^\s*\.?\s*[1-9]\s*[.)]/.test(line.text);
    if (isMaybeHeading) {
      console.log(`  y=${line.yFromTop.toFixed(1).padStart(6)}  rx=${line.rightX.toFixed(1).padStart(6)}  rightGap=${rightFromEdge.padStart(5)}  len=${String(line.text.length).padStart(4)}  "${line.text.slice(0, 120)}"`);
    }
  }
}

// Simulate findStandaloneQuestions exactly as upload.mjs does it
function findStandalone(pages) {
  const results = [];
  const seen = new Set();
  let skipPage1 = false;
  if (pages.length > 1) {
    const p1 = pages.find(p => p.page === 1);
    if (p1) {
      const lines = buildLines(p1);
      const hasQHeading = lines.some(l => /^\s*שאלה\s*\d/.test(l.text));
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
      const m = line.text.match(/^\s*שאלה\s*(\d{1,3})(?!\d)/);
      if (!m) continue;
      const num = parseInt(m[1], 10);
      if (num < 1 || num > 100 || seen.has(num)) continue;
      if (line.rightX <= page.width - 110) continue;
      seen.add(num);
      results.push({ section: String(num), page: page.page, yFromTop: line.yFromTop, rightX: line.rightX });
    }
  }
  results.sort((a, b) => a.page - b.page || a.yFromTop - b.yFromTop);
  return results;
}

console.log(`\n\n===== findStandaloneQuestions (current upload.mjs) =====`);
const sq = findStandalone(pages);
console.log(sq);

// Also try a RELAXED matcher to see what would be picked up with different rules.
function findStandaloneRelaxed(pages) {
  const results = [];
  const seen = new Set();
  for (const page of pages) {
    const lines = buildLines(page);
    for (const line of lines) {
      const m = line.text.match(/^\s*שאלה\s*(\d+)\b/);
      if (!m) continue;
      const num = parseInt(m[1], 10);
      if (num < 1 || num > 100 || seen.has(num)) continue;
      if (line.rightX <= page.width - 150) continue;
      seen.add(num);
      results.push({ section: String(num), page: page.page, yFromTop: line.yFromTop, len: line.text.length });
    }
  }
  return results;
}
console.log(`\n===== findStandaloneQuestions (RELAXED — no length cap) =====`);
console.log(findStandaloneRelaxed(pages));

// ===== Simulate the NEW findBottomBoundary =====
const CROP_MARGIN_BOTTOM_PT = 18;
function findBottomBoundaryNew(pages, fromHeading, nextHeading) {
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
  for (const line of lines) {
    if (line.yFromTop <= startY || line.yFromTop >= hardUpper) continue;
    if (/^נימוק\s*[:.]?\s*$/.test(line.text)) {
      return { page: startPage, yFromTop: Math.min(safeCap, line.yFromTop - 10), via: 'nimuk' };
    }
  }
  let lastOptionY = null;
  let numSeen = 0, hebSeen = 0;
  for (const line of lines) {
    if (line.yFromTop <= startY || line.yFromTop >= hardUpper) continue;
    const t = line.text.replace(/^[\s•·]+/, '');
    const mNum = t.match(/^\.?\s*([1-9])\s*[.)]/);
    if (mNum) {
      const n = parseInt(mNum[1], 10);
      if (n === numSeen + 1 && n <= 6) { numSeen = n; lastOptionY = line.yFromTop; continue; }
    }
    const mHeb = t.match(/^\.?\s*([א-ט])\s*[.)]/);
    if (mHeb) {
      const idx = 'אבגדהוזח'.indexOf(mHeb[1]);
      if (idx === hebSeen && hebSeen < 6) { hebSeen = idx + 1; lastOptionY = line.yFromTop; continue; }
    }
  }
  if (lastOptionY !== null && Math.max(numSeen, hebSeen) >= 2) {
    let includeY = lastOptionY;
    const tail = lines.filter(l => l.yFromTop > lastOptionY && l.yFromTop < hardUpper).sort((a, b) => a.yFromTop - b.yFromTop);
    for (const line of tail) {
      if (/^נימוק\s*[:.]?\s*$/.test(line.text)) break;
      if (/^\s*שאלה\s*\d/.test(line.text)) break;
      const t = line.text.replace(/^[\s•·]+/, '');
      if (/^\.?\s*[1-9]\s*[.)]/.test(t)) break;
      if (/^\.?\s*[א-ט]\s*[.)]/.test(t)) break;
      if (line.yFromTop - includeY > 25) break;
      includeY = line.yFromTop;
    }
    return { page: startPage, yFromTop: Math.min(safeCap, includeY + 6), via: `last-option(n=${numSeen},h=${hebSeen},+tail=${(includeY-lastOptionY).toFixed(0)})` };
  }
  if (nextHeading && nextHeading.page === startPage) {
    return { page: startPage, yFromTop: safeCap, via: 'next-heading' };
  }
  return { page: startPage, yFromTop: page.height - 30, via: 'page-bottom' };
}

console.log(`\n===== NEW bottom-boundary for each standalone heading =====`);
for (let i = 0; i < sq.length; i++) {
  const h = sq[i];
  const next = sq[i + 1];
  const b = findBottomBoundaryNew(pages, h, next);
  const pageMeta = pages.find(p => p.page === h.page);
  const heightPct = ((b.yFromTop - h.yFromTop) / pageMeta.height * 100).toFixed(0);
  console.log(`  Q${h.section}: page ${h.page}  y=${h.yFromTop.toFixed(1)} → ${b.yFromTop.toFixed(1)}  (${heightPct}% of page)  via=${b.via}`);
}

// Also test sections mode (parent=1..6)
function findQuestionRange(pages, parentQ) {
  let startPage = null, startY = null, endPage = null, endY = null;
  for (const page of pages) {
    const lines = buildLines(page);
    for (const line of lines) {
      const m = line.text.match(/שאלה\s*(\d+)|(\d+)\s*שאלה/);
      if (m) {
        const num = parseInt((m[1] || m[2]), 10);
        if (num === parentQ && startPage === null) { startPage = page.page; startY = line.yFromTop; }
        else if (num === parentQ + 1 && startPage !== null && endPage === null) { endPage = page.page; endY = line.yFromTop; }
      }
    }
  }
  return { startPage, startY, endPage, endY };
}
const ALL_LETTERS = ['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ז', 'ח', 'ט', 'י'];
function findSectionHeadings(pages, parentQ) {
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
          if (line.rightX > page.width - 110) { seen.add(letter); results.push({ section: letter, page: page.page, yFromTop: line.yFromTop }); break; }
        }
      }
    }
  }
  results.sort((a, b) => a.page - b.page || a.yFromTop - b.yFromTop);
  return { headings: results, range };
}

console.log(`\n===== sections mode (parent Q 1..6) =====`);
for (let pq = 1; pq <= 6; pq++) {
  const { headings } = findSectionHeadings(pages, pq);
  if (headings.length >= 3) {
    console.log(`\n  parent=${pq}  (${headings.length} sub-sections):`);
    for (let i = 0; i < headings.length; i++) {
      const h = headings[i];
      const next = headings[i + 1];
      const b = findBottomBoundaryNew(pages, h, next);
      console.log(`    ${h.section}: page ${h.page}  y=${h.yFromTop.toFixed(1)} → ${b.yFromTop.toFixed(1)}  via=${b.via}`);
    }
  }
}
