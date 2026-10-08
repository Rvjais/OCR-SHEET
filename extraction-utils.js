/* Shared, dependency-free extraction rules. Works in a browser and in Node tests. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ExtractionUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function cleanText(text) {
    // Keep digits, punctuation, spelling, tabs and paragraph breaks as recognized.
    return String(text || '').replace(/\r\n?/g, '\n').replace(/\u0000/g, '')
      .replace(/[ \t]+$/gm, '').trim();
  }

  function readableText(text) {
    const value = cleanText(text);
    if (!/[\p{L}\p{N}]/u.test(value)) return false;
    const bad = value.match(/[\uFFFD\uE000-\uF8FF\u0001-\u0008\u000B\u000C\u000E-\u001F]/g) || [];
    return bad.length / Math.max(1, value.length) < 0.02;
  }

  function transformPoint(matrix, x, y) {
    return { x: matrix[0] * x + matrix[2] * y + matrix[4], y: matrix[1] * x + matrix[3] * y + matrix[5] };
  }

  function textFromPage(items, viewportMatrix = [1, 0, 0, -1, 0, 0]) {
    const positioned = items.filter(item => typeof item.str === 'string' && item.str && item.transform?.length === 6).map(item => {
      const t = item.transform;
      const start = transformPoint(viewportMatrix, t[4], t[5]);
      const magnitude = Math.hypot(t[0], t[1]) || 1;
      const end = transformPoint(viewportMatrix, t[4] + (item.width || 0) * t[0] / magnitude, t[5] + (item.width || 0) * t[1] / magnitude);
      const top = transformPoint(viewportMatrix, t[4] + t[2], t[5] + t[3]);
      return { text: item.str, x: Math.min(start.x, end.x), right: Math.max(start.x, end.x), y: start.y,
        height: Math.max(1, Math.hypot(top.x - start.x, top.y - start.y)), dir: item.dir };
    }).sort((a, b) => a.y - b.y || a.x - b.x);
    const rows = [];
    for (const item of positioned) {
      let row = rows[rows.length - 1];
      if (!row || Math.abs(row.y - item.y) > Math.max(2, Math.min(row.height, item.height) * 0.4)) {
        row = { y: item.y, height: item.height, items: [] };
        rows.push(row);
      }
      row.items.push(item);
      row.height = Math.max(row.height, item.height);
    }
    let result = '';
    let previousRow = null;
    for (const row of rows) {
      const rtl = row.items.filter(item => item.dir === 'rtl').length > row.items.length / 2;
      row.items.sort((a, b) => rtl ? b.x - a.x : a.x - b.x);
      let line = '';
      let previous = null;
      for (const item of row.items) {
        const gap = previous ? (rtl ? previous.x - item.right : item.x - previous.right) : 0;
        // Adjacent PDF glyphs stay adjacent; distant cells retain a tab separator.
        if (previous && !/\s$/u.test(line) && !/^\s/u.test(item.text)) {
          if (gap > Math.max(previous.height, item.height) * 3) line += '\t';
          else if (gap > Math.min(previous.height, item.height) * 0.15) line += ' ';
        }
        line += item.text;
        previous = item;
      }
      if (previousRow) result += row.y - previousRow.y > Math.max(row.height, previousRow.height) * 1.8 ? '\n\n' : '\n';
      result += line;
      previousRow = row;
    }
    return cleanText(result).replace(/[\uFB00-\uFB06]/g, glyph => ['ff', 'fi', 'fl', 'ffi', 'ffl', 'st', 'st'][glyph.charCodeAt(0) - 0xFB00]);
  }

  function analyzeOCR(data) {
    const words = [];
    for (const block of data.blocks || []) for (const paragraph of block.paragraphs || [])
      for (const line of paragraph.lines || []) for (const word of line.words || []) {
        if (word.text?.trim()) words.push({ text: word.text, confidence: Number.isFinite(word.confidence) ? word.confidence : 0 });
      }
    const total = words.reduce((sum, word) => sum + word.text.length, 0);
    const confidence = total ? words.reduce((sum, word) => sum + word.confidence * word.text.length, 0) / total
      : (Number.isFinite(data.confidence) ? data.confidence : 0);
    return { text: cleanText(data.text), confidence, words, uncertain: words.filter(word => word.confidence < 80) };
  }

  function candidateScore(candidate) {
    if (!readableText(candidate.text)) return -Infinity;
    const chars = (candidate.text.match(/[\p{L}\p{N}]/gu) || []).length;
    return candidate.confidence - 12 * candidate.uncertain.length / Math.max(1, candidate.words.length)
      + Math.min(8, Math.log2(chars + 1));
  }

  function chooseCandidate(candidates) {
    const viable = candidates.filter(candidate => readableText(candidate.text));
    if (!viable.length) return candidates[0] || analyzeOCR({});
    let best = viable.reduce((a, b) => candidateScore(b) > candidateScore(a) ? b : a);
    // Do not trade a whole paragraph for a short, confident fragment.
    for (const candidate of viable) {
      if (candidate.text.length > best.text.length * 1.5 && candidate.confidence >= best.confidence - 10 && candidate.confidence >= 70) best = candidate;
    }
    return best;
  }

  function normalized(text) {
    return cleanText(text).normalize('NFC').toLocaleLowerCase().replace(/\s+/g, ' ');
  }

  function similarity(left, right) {
    const a = normalized(left), b = normalized(right);
    if (a === b) return 1;
    if (a.length < 3 || b.length < 3) return 0;
    const counts = new Map();
    for (let i = 0; i < a.length - 1; i++) { const key = a.slice(i, i + 2); counts.set(key, (counts.get(key) || 0) + 1); }
    let common = 0;
    for (let i = 0; i < b.length - 1; i++) { const key = b.slice(i, i + 2); if (counts.get(key) > 0) { common++; counts.set(key, counts.get(key) - 1); } }
    return 2 * common / (a.length + b.length - 2);
  }

  function mergeHybrid(nativeText, ocrText) {
    const lines = cleanText(ocrText).split('\n');
    const missing = [];
    const replaced = new Set();
    for (const nativeLine of cleanText(nativeText).split('\n').filter(line => line.trim())) {
      // Printed labels can share a line with handwritten values. Never replace
      // that whole OCR line with the shorter selectable label.
      let contained = false;
      const needle = normalized(nativeLine);
      for (let i = 0; i < lines.length; i++) {
        if (normalized(lines[i]).includes(needle)) { contained = true; break; }
      }
      if (contained) continue;
      let bestIndex = -1, bestScore = 0;
      for (let i = 0; i < lines.length; i++) {
        if (replaced.has(i)) continue;
        const score = similarity(nativeLine, lines[i]);
        if (score > bestScore) { bestIndex = i; bestScore = score; }
      }
      const matched = bestIndex >= 0 ? normalized(lines[bestIndex]) : '';
      const sameNumbers = (matched.match(/\p{N}+/gu) || []).join('|') === (needle.match(/\p{N}+/gu) || []).join('|');
      if (bestScore >= 0.78 && matched.length <= needle.length && matched.split(' ').length <= needle.split(' ').length && sameNumbers) {
        lines[bestIndex] = nativeLine; replaced.add(bestIndex);
      }
      else missing.push(nativeLine);
    }
    const text = cleanText(lines.join('\n'));
    return { text: missing.length ? `${text}${text ? '\n\n' : ''}[Additional selectable text]\n${missing.join('\n')}` : text, missing: missing.length };
  }

  function formatBatch(documents) {
    return documents.map((document, index) => {
      const pages = [];
      for (let page = 1; page <= Math.max(document.pageCount || 1, document.reports.length); page++) {
        const report = document.reports.find(report => report.page === page);
        const text = report?.edited ? report.text : report?.text || (report?.failed ? '[This page could not be read]'
          : report ? '[No text found on this page]'
          : document.error ? `[${document.error}]` : '[Not extracted yet]');
        pages.push(`— Page ${page} —\n${text}`);
      }
      return `=== File ${index + 1}: ${document.file.name} ===\n${pages.join('\n\n')}`;
    }).join('\n\n\n');
  }

  return { cleanText, readableText, textFromPage, analyzeOCR, candidateScore, chooseCandidate, similarity, mergeHybrid, formatBatch };
});
