// =====================================================
// ExamPrep - PDF Processing Pipeline
// =====================================================
// Takes an exam PDF + optional solution PDF and produces:
// - Cropped MCQ images
// - Detected answer indices (from yellow highlights in solution)
// - Question metadata
//
// Usage:
//   processExamPair({ examPdfPath, solutionPdfPath, outputDir, parentQuestion })

import { pdf } from 'pdf-to-img';
import sharp from 'sharp';
import * as fs from 'node:fs';
import * as path from 'node:path';
import crypto from 'node:crypto';

const SCALE = 2.0;
const MARGIN_TOP = 8;
const MARGIN_BOTTOM = 16;

// Hebrew letters used in section headers
const ALL_LETTERS = ['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ז', 'ח', 'ט', 'י'];

// ===== Render PDF to PNGs in a temporary folder =====
// `maxPages` is a hard cap — if the PDF has more pages we abort instead
// of rendering them. This is the primary defense against malicious PDFs
// (gzip bombs, thousand-page docs) eating CPU/memory.
export async function renderPdf(pdfPath, outDir, maxPages = 200) {
  fs.mkdirSync(outDir, { recursive: true });
  const document = await pdf(pdfPath, { scale: SCALE });
  const pages = [];
  let i = 1;
  for await (const image of document) {
    if (i > maxPages) {
      throw new Error(`PDF has more than ${maxPages} pages — aborting`);
    }
    const outFile = path.join(outDir, `page-${String(i).padStart(2, '0')}.png`);
    fs.writeFileSync(outFile, image);
    pages.push(outFile);
    i++;
  }
  return { pageCount: pages.length, pages };
}

// ===== Extract text positions per page =====
export async function extractPositions(pdfPath) {
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
    '../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs',
    import.meta.url
  ).href;
  const data = new Uint8Array(fs.readFileSync(pdfPath));
  const loadingTask = pdfjsLib.getDocument({
    data,
    disableWorker: true,
    isEvalSupported: false,
    useSystemFonts: true,
  });
  const pdfDoc = await loadingTask.promise;
  const pages = [];
  for (let i = 1; i <= pdfDoc.numPages; i++) {
    const page = await pdfDoc.getPage(i);
    const viewport = page.getViewport({ scale: 1.0 });
    const tc = await page.getTextContent();
    const items = tc.items.map(it => ({
      str: it.str,
      x: it.transform[4],
      y: it.transform[5],
      yFromTop: viewport.height - it.transform[5],
      width: it.width,
      height: it.height,
    }));
    pages.push({ page: i, width: viewport.width, height: viewport.height, items });
    page.cleanup();
  }
  await pdfDoc.cleanup();
  await pdfDoc.destroy();
  return pages;
}

// ===== Build text lines from items (handle character-split PDFs) =====
function buildLines(page, yTolerance = 3) {
  const items = page.items.filter(it => it.str && it.str.trim() !== '');
  if (!items.length) return [];
  const sorted = [...items].sort((a, b) => a.yFromTop - b.yFromTop);
  const lines = [];
  for (const it of sorted) {
    const line = lines.find(l => Math.abs(l.yFromTop - it.yFromTop) < yTolerance);
    if (line) {
      line.items.push(it);
      line.yFromTop = (line.yFromTop * (line.items.length - 1) + it.yFromTop) / line.items.length;
    } else {
      lines.push({ yFromTop: it.yFromTop, items: [it] });
    }
  }
  for (const line of lines) {
    line.items.sort((a, b) => b.x - a.x); // RTL: rightmost first
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

// ===== Find the page range of a parent question =====
function findQuestionRange(pages, parentQ) {
  let startPage = null, startY = null, endPage = null, endY = null;
  for (const page of pages) {
    const lines = buildLines(page);
    for (const line of lines) {
      const m = line.text.match(/שאלה\s*(\d+)|(\d+)\s*שאלה/);
      if (m) {
        const num = parseInt((m[1] || m[2]), 10);
        if (num === parentQ && startPage === null) {
          startPage = page.page;
          startY = line.yFromTop;
        } else if (num === parentQ + 1 && startPage !== null && endPage === null) {
          endPage = page.page;
          endY = line.yFromTop;
        }
      }
    }
  }
  return { startPage, startY, endPage, endY };
}

// ===== Find sub-section headings within a question =====
function findSectionHeadings(pages, parentQ, letters = ALL_LETTERS) {
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
      let foundLetter = null;
      for (const letter of letters) {
        if (seen.has(letter)) continue;
        const re1 = new RegExp(`(^|\\s)סעיף\\s*${letter}['']?(\\s|$|\\()`);
        const re2 = new RegExp(`(^|\\s)${letter}['']\\s*\\(\\s*\\d+\\s*נק`);
        if (re1.test(line.text) || re2.test(line.text)) {
          if (line.rightX > page.width - 110) {
            foundLetter = letter;
            break;
          }
        }
      }
      if (foundLetter) {
        seen.add(foundLetter);
        results.push({ section: foundLetter, page: page.page, yFromTop: line.yFromTop });
      }
    }
  }
  results.sort((a, b) => a.page - b.page || a.yFromTop - b.yFromTop);
  return { headings: results, range };
}

// ===== Find standalone numbered question headings (auto-detect range) =====
function findStandaloneQuestions(pages, fromQ = 1, toQ = 100) {
  const results = [];
  const seen = new Set();
  for (const page of pages) {
    const lines = buildLines(page);
    for (const line of lines) {
      const m = line.text.match(/שאלה\s*(\d+)/);
      if (m) {
        const num = parseInt(m[1], 10);
        if (num >= fromQ && num <= toQ && !seen.has(num)) {
          if (line.rightX > page.width - 110) {
            seen.add(num);
            results.push({ section: String(num), page: page.page, yFromTop: line.yFromTop });
          }
        }
      }
    }
  }
  results.sort((a, b) => a.page - b.page || a.yFromTop - b.yFromTop);
  return results;
}

// ===== Find bottom Y for a question (just before "נימוק" box) =====
function findBottomBoundary(pages, fromHeading, nextHeading) {
  const startPage = fromHeading.page;
  const startY = fromHeading.yFromTop;
  const page = pages.find(p => p.page === startPage);
  if (page) {
    const lines = buildLines(page);
    for (const line of lines) {
      if (line.yFromTop <= startY) continue;
      if (/^נימוק\s*[:.]?\s*$/.test(line.text)) {
        return { page: startPage, yFromTop: line.yFromTop - 12 };
      }
    }
  }
  if (nextHeading && nextHeading.page === startPage) {
    return { page: startPage, yFromTop: nextHeading.yFromTop - MARGIN_TOP };
  }
  if (page) return { page: startPage, yFromTop: page.height - 30 };
  return null;
}

// ===== Crop a single question to a PNG file =====
async function cropQuestion(pageImagesDir, heading, bottom, outFile) {
  const startPage = heading.page;
  const endPage = bottom.page;

  if (startPage === endPage) {
    const imgPath = path.join(pageImagesDir, `page-${String(startPage).padStart(2, '0')}.png`);
    const meta = await sharp(imgPath).metadata();
    const top = Math.max(0, Math.floor((heading.yFromTop - MARGIN_TOP) * SCALE));
    const height = Math.min(
      meta.height - top,
      Math.ceil((bottom.yFromTop + MARGIN_BOTTOM - heading.yFromTop + MARGIN_TOP) * SCALE)
    );
    await sharp(imgPath).extract({ left: 0, top, width: meta.width, height }).webp({ lossless: true }).toFile(outFile);
    return;
  }

  // Multi-page: combine slices
  const slices = [];
  for (let p = startPage; p <= endPage; p++) {
    const imgPath = path.join(pageImagesDir, `page-${String(p).padStart(2, '0')}.png`);
    const meta = await sharp(imgPath).metadata();
    let top = 0, height = meta.height;
    if (p === startPage) {
      top = Math.max(0, Math.floor((heading.yFromTop - MARGIN_TOP) * SCALE));
      height = meta.height - top;
    }
    if (p === endPage) {
      height = Math.min(meta.height - top, Math.ceil((bottom.yFromTop + MARGIN_BOTTOM) * SCALE) - top);
    }
    const buf = await sharp(imgPath).extract({ left: 0, top, width: meta.width, height }).toBuffer();
    slices.push({ buf, width: meta.width, height });
  }
  const totalHeight = slices.reduce((s, sl) => s + sl.height, 0);
  const width = slices[0].width;
  const composite = [];
  let yOffset = 0;
  for (const sl of slices) {
    composite.push({ input: sl.buf, top: yOffset, left: 0 });
    yOffset += sl.height;
  }
  await sharp({
    create: { width, height: totalHeight, channels: 3, background: { r: 255, g: 255, b: 255 } },
  }).composite(composite).webp({ lossless: true }).toFile(outFile);
}

// ===== Detect yellow highlight in a region (returns: {hasYellow, intensity}) =====
async function detectYellowInRegion(imgPath, top, bottom) {
  // Yellow in RGB ~ R: 240-255, G: 220-255, B: 0-150
  const meta = await sharp(imgPath).metadata();
  const left = 0;
  const width = meta.width;
  const cropTop = Math.max(0, Math.floor(top * SCALE));
  const height = Math.min(meta.height - cropTop, Math.ceil((bottom - top) * SCALE));
  if (height <= 0) return { hasYellow: false, intensity: 0 };

  const { data, info } = await sharp(imgPath)
    .extract({ left, top: cropTop, width, height })
    .raw()
    .toBuffer({ resolveWithObject: true });

  let yellowPixels = 0;
  let totalPixels = info.width * info.height;
  for (let i = 0; i < data.length; i += info.channels) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    if (r > 220 && g > 200 && b < 160 && (r - b) > 80) {
      yellowPixels++;
    }
  }
  return {
    hasYellow: yellowPixels > totalPixels * 0.005, // > 0.5% yellow pixels
    intensity: yellowPixels / totalPixels,
  };
}

// ===== Detect which option is highlighted in solution PDF =====
// Strategy: For each option line in the question, check if the corresponding
// line in the solution PDF has yellow pixels.
async function detectHighlightedAnswer(solutionPagesDir, solutionPositions, heading, bottom, numOptions) {
  // Find option lines (lines starting with .1 / .2 / etc., or numbered list items)
  const startPage = heading.page;
  const page = solutionPositions.find(p => p.page === startPage);
  if (!page) return null;

  const lines = buildLines(page);
  const optionLines = [];

  // Look for lines that look like options between heading and bottom
  for (const line of lines) {
    if (line.yFromTop <= heading.yFromTop) continue;
    if (line.yFromTop >= bottom.yFromTop) continue;
    // Match patterns: ".1", ".2", "1.", "2.", "א.", "ב.", etc.
    const m = line.text.match(/^([1-9]|[א-ת])\s*[.)]?/) || line.text.match(/[.)]\s*([1-9]|[א-ת])\s*$/);
    if (m) {
      optionLines.push({ y: line.yFromTop, label: m[1] });
    }
  }

  // For each option line, check yellow in a small region around it (±10px)
  const imgPath = path.join(solutionPagesDir, `page-${String(startPage).padStart(2, '0')}.png`);
  const detections = [];
  for (let i = 0; i < optionLines.length; i++) {
    const ol = optionLines[i];
    const nextY = (i + 1 < optionLines.length) ? optionLines[i + 1].y : bottom.yFromTop;
    const result = await detectYellowInRegion(imgPath, ol.y - 5, nextY - 5);
    detections.push({ index: i + 1, label: ol.label, ...result });
  }

  // Pick the option with the highest yellow intensity (if any)
  const highlighted = detections.filter(d => d.hasYellow).sort((a, b) => b.intensity - a.intensity);
  if (highlighted.length === 0) return null;
  return highlighted[0].index; // 1-based
}

// ===== Compute SHA-256 hash of a file =====
export function fileHash(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// ===== Main: Process exam + solution pair =====
export async function processExamPair({
  examPdfPath,
  solutionPdfPath,
  outputDir,
  mcqMode = 'auto', // 'sections' | 'questions' | 'auto'
  parentQuestion = 1,
  fromQ = 3,
  toQ = 12,
  expectedNumOptions = 4,
  maxPages = 200,
}) {
  fs.mkdirSync(outputDir, { recursive: true });
  const examPagesDir = path.join(outputDir, 'exam-pages');
  const solutionPagesDir = path.join(outputDir, 'solution-pages');

  // 1. Render both PDFs to images (capped at maxPages each)
  const examRender = await renderPdf(examPdfPath, examPagesDir, maxPages);
  let solutionRender = null;
  if (solutionPdfPath && fs.existsSync(solutionPdfPath)) {
    solutionRender = await renderPdf(solutionPdfPath, solutionPagesDir, maxPages);
  }

  // 2. Extract text positions
  const examPositions = await extractPositions(examPdfPath);
  const solutionPositions = solutionPdfPath ? await extractPositions(solutionPdfPath) : null;

  // 3. Find headings (auto-detect mode if not specified)
  let headings = [];
  let mode = mcqMode;
  if (mode === 'auto') {
    // Try sections within multiple parent questions (1-20) and pick the best
    let bestSectionHeadings = [];
    let bestParent = parentQuestion;
    for (let pq = 1; pq <= 20; pq++) {
      const { headings: sectionHeadings } = findSectionHeadings(examPositions, pq);
      if (sectionHeadings.length > bestSectionHeadings.length) {
        bestSectionHeadings = sectionHeadings;
        bestParent = pq;
      }
    }
    if (bestSectionHeadings.length >= 3) {
      headings = bestSectionHeadings;
      parentQuestion = bestParent;
      mode = 'sections';
    } else {
      // Try standalone questions with full range
      const stHeadings = findStandaloneQuestions(examPositions, 1, 100);
      headings = stHeadings;
      mode = 'questions';
    }
  } else if (mode === 'sections') {
    const r = findSectionHeadings(examPositions, parentQuestion);
    headings = r.headings;
  } else if (mode === 'questions') {
    headings = findStandaloneQuestions(examPositions, fromQ, toQ);
  }

  if (!headings.length) {
    // Don't throw — return 0 questions so the exam is saved with a warning
    console.warn('[process-pdf] No MCQ headings detected in PDF');
    return { mode, questionCount: 0, questions: [] };
  }

  // 4. Crop each question + detect answer
  const questions = [];
  for (let i = 0; i < headings.length; i++) {
    const h = headings[i];
    const next = headings[i + 1];
    const bottom = findBottomBoundary(examPositions, h, next);
    if (!bottom) continue;

    // Crop the question image (from exam PDF)
    const outFile = path.join(outputDir, `q-${String(i + 1).padStart(2, '0')}.webp`);
    await cropQuestion(examPagesDir, h, bottom, outFile);

    // Detect the highlighted answer (from solution PDF)
    let correctIdx = null;
    if (solutionPositions) {
      // Find the corresponding heading in the solution (by section letter)
      const solHeadings = mode === 'sections'
        ? findSectionHeadings(solutionPositions, parentQuestion).headings
        : findStandaloneQuestions(solutionPositions, 1, 100);
      const solRange = solHeadings.find(s => s.section === h.section);

      if (solRange) {
        const solIdx = solHeadings.indexOf(solRange);
        const solBottom = findBottomBoundary(solutionPositions, solRange, solHeadings[solIdx + 1]);
        if (solBottom) {
          correctIdx = await detectHighlightedAnswer(solutionPagesDir, solutionPositions, solRange, solBottom, expectedNumOptions);
        }
      }
    }

    questions.push({
      index: i + 1,
      section: h.section,
      imageFile: path.basename(outFile),
      correctIdx, // may be null if detection failed
      numOptions: expectedNumOptions,
    });
  }

  // 5. Cleanup temporary page images (optional - keep for debugging)
  // fs.rmSync(examPagesDir, { recursive: true, force: true });
  // fs.rmSync(solutionPagesDir, { recursive: true, force: true });

  return {
    mode,
    questionCount: questions.length,
    questions,
  };
}
