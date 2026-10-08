const { test } = require('node:test');
const assert = require('node:assert/strict');
const U = require('../extraction-utils.js');

const item = (str, x, y, width, height = 12) => ({ str, width, height, dir: 'ltr', transform: [height, 0, 0, height, x, y] });

test('PDF glyph fragments preserve account numbers and punctuation', () => {
  const items = [item('A', 10, 100, 8), item('B', 18, 100, 8), item('-', 26, 100, 5), item('00123', 31, 100, 35), item('₹1,234.50', 85, 100, 65)];
  assert.equal(U.textFromPage(items), 'AB-00123 ₹1,234.50');
});

test('PDF rows are ordered visually and distant table cells retain tabs', () => {
  const items = [item('Second row', 10, 70, 65), item('100.00', 160, 100, 40), item('First row', 10, 100, 60), item('200.00', 160, 70, 40)];
  assert.equal(U.textFromPage(items), 'First row\t100.00\n\nSecond row\t200.00');
});

test('PDF viewport rotation maps text into its displayed order', () => {
  const rotated = [
    { str: 'Top', width: 20, dir: 'ltr', transform: [0, 12, -12, 0, 100, 10] },
    { str: 'Bottom', width: 45, dir: 'ltr', transform: [0, 12, -12, 0, 80, 10] }
  ];
  assert.equal(U.textFromPage(rotated, [0, 1, 1, 0, 0, 0]), 'Bottom\nTop');
});

test('format cleanup preserves identifiers, spelling, tabs, accents and paragraph breaks', () => {
  assert.equal(U.cleanText('  Référence AB-00123\t₹1,234.50  \r\n\r\nINV/2026/007\r\n'), 'Référence AB-00123\t₹1,234.50\n\nINV/2026/007');
});

test('unreadable font mappings trigger fallback; legitimate numbers remain valid', () => {
  assert.equal(U.readableText('��������'), false);
  assert.equal(U.readableText('\uE010\uE011\uE012'), false);
  assert.equal(U.readableText('...'), false);
  assert.equal(U.readableText('00123 1,234.50'), true);
  assert.equal(U.readableText('हिन्दी पाठ'), true);
});

test('confidence review retains low-confidence names and numbers', () => {
  const data = { text: 'Akhil AB-00123', confidence: 90, blocks: [{ paragraphs: [{ lines: [{ words: [{ text: 'Akhil', confidence: 55 }, { text: 'AB-00123', confidence: 96 }] }] }] }] };
  const result = U.analyzeOCR(data);
  assert.equal(result.text, 'Akhil AB-00123');
  assert.deepEqual(result.uncertain, [{ text: 'Akhil', confidence: 55 }]);
  assert(result.confidence < 96 && result.confidence > 55);
});

test('candidate selection does not discard a paragraph for a confident fragment', () => {
  const full = U.analyzeOCR({ text: 'Invoice number AB-00123\nTotal amount 1,234.50\nPayment due 12 October', confidence: 88 });
  const fragment = U.analyzeOCR({ text: 'Invoice', confidence: 97 });
  assert.equal(U.chooseCandidate([full, fragment]), full);
});

test('mixed PDFs prefer exact selectable numbers and keep scanned body text', () => {
  const merged = U.mergeHybrid('Invoice AB-00123', 'lnvoice AB-00123\nScanned body 67890');
  assert.equal(merged.text, 'Invoice AB-00123\nScanned body 67890');
  assert.equal(merged.missing, 0);
});

test('unmatched selectable text is retained explicitly instead of silently lost', () => {
  const merged = U.mergeHybrid('Account ZX-007', 'Scanned body 67890');
  assert.match(merged.text, /Scanned body 67890/);
  assert.match(merged.text, /\[Additional selectable text\]\nAccount ZX-007/);
  assert.equal(merged.missing, 1);
});

test('batch export preserves file order, page order, edits and identical filenames', () => {
  const documents = [
    { file: { name: 'same.pdf' }, pageCount: 2, reports: [{ page: 2, text: 'Second page' }, { page: 1, text: 'Edited first page 00042' }] },
    { file: { name: 'same.pdf' }, pageCount: 1, reports: [{ page: 1, text: 'Different file AB-00123' }] },
    { file: { name: 'photo.png' }, pageCount: 1, reports: [{ page: 1, text: 'Photo text 1,234.50' }] }
  ];
  assert.equal(U.formatBatch(documents), '=== File 1: same.pdf ===\n— Page 1 —\nEdited first page 00042\n\n— Page 2 —\nSecond page\n\n\n=== File 2: same.pdf ===\n— Page 1 —\nDifferent file AB-00123\n\n\n=== File 3: photo.png ===\n— Page 1 —\nPhoto text 1,234.50');
});

test('batch export marks failed, empty and unprocessed pages explicitly', () => {
  const result = U.formatBatch([
    { file: { name: 'partial.pdf' }, pageCount: 3, reports: [{ page: 1, text: 'Completed text' }, { page: 2, text: '', failed: true }], error: 'Cancelled' },
    { file: { name: 'blank.png' }, pageCount: 1, reports: [{ page: 1, text: '' }] },
    { file: { name: 'waiting.png' }, pageCount: 1, reports: [] }
  ]);
  assert.match(result, /— Page 2 —\n\[This page could not be read\]/);
  assert.match(result, /— Page 3 —\n\[Cancelled\]/);
  assert.match(result, /blank.png ===\n— Page 1 —\n\[No text found on this page\]/);
  assert.match(result, /waiting.png ===\n— Page 1 —\n\[Not extracted yet\]/);
});

test('batch export honors a page intentionally edited to blank', () => {
  assert.equal(U.formatBatch([{ file: { name: 'cleared.pdf' }, pageCount: 1, reports: [{ page: 1, text: '', edited: true }] }]), '=== File 1: cleared.pdf ===\n— Page 1 —\n');
});

test('printed invoice labels never replace handwritten values on the same line', () => {
  const result = U.mergeHybrid('Invoice number\nTotal\nCustomer name', 'Invoice number AB-00123\nTotal 1,234.50\nCustomer name Akhil Taneja');
  assert.equal(result.text, 'Invoice number AB-00123\nTotal 1,234.50\nCustomer name Akhil Taneja');
  assert.equal(result.missing, 0);
});

test('fuzzy label matches keep a handwritten numeric suffix', () => {
  const result = U.mergeHybrid('Invoice number', 'lnvoice number 00123');
  assert.match(result.text, /00123/);
});

test('long printed keys cannot erase a short pen-written value after a fuzzy match', () => {
  const result = U.mergeHybrid('Total invoice amount inclusive of tax:', 'TotaI invoice amount inclusive of tax: 5');
  assert.match(result.text, /tax: 5/);
});
