// PDF text-layer position extraction (pdf.js via unpdf).
// Shared by upload analysis and any future PDF-reading route.

// Extract per-item text positions for every page.
// Each item carries x, y in PDF native coords, and yFromTop (flipped so 0
// is at the top of the page, matching how we'll crop the rendered image).
export async function extractPositions(pdfBytes) {
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

// Group items into visual lines (items whose yFromTop is within yTol of each
// other). Returns each line with its concatenated text + left/right X extents.
export function buildLines(page, yTol = 3) {
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
    // RTL: rightmost item first when building visual text.
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
