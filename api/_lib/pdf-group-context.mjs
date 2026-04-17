// Group context helpers — for MCQs that share a passage / code block /
// figure (e.g. Israeli biology "סט N :" sets where 5+ MCQs depend on
// the same scenario).
//
// applyGroupContextToCrops()  extends each member's crop yTop up to the
// top of the shared context, so the rendered image includes the context.
// extractContextText()        reads the raw text from that context region
// so the UI can show it during quiz without opening the image.

import { buildLines } from './pdf-positions.mjs';

// For questions in a context group (sharing a figure/passage/table), extend
// yTop upward so the crop image includes the shared context element.
// Only applies when context is on the SAME page as the question.
// Cross-page context (context on page N, question on page N+1) is left as-is.
export function applyGroupContextToCrops(mcqs) {
  const groupMap = new Map();
  for (const q of mcqs) {
    if (!q.groupId || q.contextYTop == null || q.contextPage == null) continue;
    const existing = groupMap.get(q.groupId);
    if (!existing) {
      groupMap.set(q.groupId, { contextYTop: q.contextYTop, contextPage: q.contextPage });
    } else if (q.contextYTop < existing.contextYTop) {
      existing.contextYTop = q.contextYTop;
    }
  }

  if (groupMap.size === 0) return mcqs;

  const result = mcqs.map(q => {
    if (!q.groupId) return q;
    const ctx = groupMap.get(q.groupId);
    if (!ctx) return q;
    if (ctx.contextPage !== q.page) return q;
    if (ctx.contextYTop >= q.yTop) return q;
    console.log(`[upload] group ${q.groupId} Q${q.number}: yTop ${q.yTop.toFixed(1)}pt → ${ctx.contextYTop.toFixed(1)}pt (context p.${ctx.contextPage})`);
    return { ...q, yTopBeforeContext: q.yTop, yTop: ctx.contextYTop };
  });

  for (const [gid, ctx] of groupMap) {
    const members = result.filter(q => q.groupId === gid);
    console.log(`[upload] group "${gid}": ${members.length} questions, contextYTop=${ctx.contextYTop.toFixed(1)}pt page=${ctx.contextPage}`);
  }
  return result;
}

// Extract raw text from the context region above a grouped question.
// Used to store code/theorem/scenario context so the UI can show it during quiz.
export function extractContextText(positions, contextPage, contextYTopPt, questionYTopPt) {
  if (!positions || contextPage == null || contextYTopPt == null || questionYTopPt == null) return null;
  const pageData = positions.find(p => p.page === contextPage);
  if (!pageData) return null;
  const lines = buildLines(pageData);
  const from = contextYTopPt - 5;
  const to = questionYTopPt;
  const text = lines
    .filter(l => l.yFromTop >= from && l.yFromTop < to)
    .map(l => l.text)
    .join('\n')
    .trim();
  return text || null;
}
