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

test('product list parsing reads quoted CSV, detects columns and prices', () => {
  const rows = U.parseDelimitedRows('Product Name,Price\n"Amoxycillin 500, DT",45.5\nZinc Syrup,₹98\n\n');
  assert.equal(rows.length, 3);
  const detected = U.detectCatalogTable(rows);
  assert.equal(detected.headerRow, 0);
  assert.equal(detected.nameColumn, 0);
  assert.equal(detected.priceColumn, 1);
  assert.deepEqual(U.catalogFromMatrix(rows, detected), [
    { name: 'Amoxycillin 500, DT', price: 45.5 },
    { name: 'Zinc Syrup', price: 98 }
  ]);
});

test('column detection prefers a product name header over an item code', () => {
  const detected = U.detectCatalogColumns(['Item Code', 'Product Name', 'Rate (₹)']);
  assert.equal(detected.nameColumn, 1);
  assert.equal(detected.priceColumn, 2);
});

test('product matching corrects handwriting typos to the list spelling', () => {
  const match = U.matchInvoice({ items: [{ description: 'Amoxycilln 500 mg', quantity: 1, rate: 45.5, amount: 45.5 }] }, [{ name: 'Amoxycillin 500 MG', price: 45.5 }]);
  assert.equal(match.items[0].matchStatus, 'matched');
  assert.equal(match.items[0].matchedName, 'Amoxycillin 500 MG');
  assert.equal(match.verified, true);
});

test('product matching understands OCR letter and digit swaps', () => {
  const match = U.matchInvoice({ items: [{ description: 'Paracetam0l 5OO', quantity: 1, rate: 20, amount: 20 }] }, [{ name: 'Paracetamol 500 MG', price: 20 }]);
  assert.equal(match.items[0].matchStatus, 'matched');
});

test('strict price check flags a one-paisa difference and uses qty when rate is missing', () => {
  const catalog = [{ name: 'Zinc Syrup', price: 98 }];
  const mismatch = U.matchInvoice({ items: [{ description: 'Zinc Syrup', quantity: 2, rate: 'Not found', amount: 196.02 }] }, catalog);
  assert.equal(mismatch.items[0].matchStatus, 'price-mismatch');
  assert.match(mismatch.items[0].note, /196\.02|98\.01/);
  const same = U.matchInvoice({ items: [{ description: 'Zinc Syrup', quantity: 2, rate: 'Not found', amount: 196 }] }, catalog);
  assert.equal(same.items[0].matchStatus, 'matched');
});

test('missing rates and unknown products are flagged for manual verification', () => {
  const catalog = [{ name: 'Zinc Syrup', price: 98 }];
  const missing = U.matchInvoice({ items: [{ description: 'Zinc Syrup', quantity: 1, rate: 'Not found', amount: 'Not found' }] }, catalog);
  assert.equal(missing.items[0].matchStatus, 'verify');
  assert.equal(missing.verified, false);
  const unknown = U.matchInvoice({ items: [{ description: 'Kesh King Oil 200ml', quantity: 1, rate: 210, amount: 210 }] }, catalog);
  assert.equal(unknown.items[0].matchStatus, 'not-matched');
  assert.equal(unknown.items[0].matchedName, 'Not found');
});

test('without a product list nothing is claimed as verified', () => {
  const match = U.matchInvoice({ items: [{ description: 'Anything' }] }, []);
  assert.equal(match.hasCatalog, false);
  assert.equal(match.items[0].matchStatus, 'no-list');
  const row = U.invoiceExportRow({ items: [{ description: 'Anything' }] }, match);
  assert.match(row[12], /No product list/);
});

test('export rows carry Not found for missing fields and list items to verify', () => {
  const invoice = {
    store: { name: 'Sharma Traders', address: '12 MG Road, Pune, Maharashtra', state: 'Maharashtra' },
    invoice: { number: 'INV-001' },
    customer: { name: 'Ravi', mobile: 'Not found' },
    items: [
      { description: 'Zinc Syrup', quantity: 2, rate: 98, amount: 196, gst_rate: '12%', gst_amount: 23.52 },
      { description: 'Kesh King Oil 200ml', quantity: 1, rate: 210, amount: 210, gst_rate: 'Not found', gst_amount: 'Not found' }
    ],
    gst: { rate: '12%', amount: 23.52, cgst: '11.76', sgst: '11.76', igst: 'Not found' },
    payable: { amount: 429.52, account: 'Credit' }
  };
  const match = U.matchInvoice(invoice, [{ name: 'Zinc Syrup', price: 98 }]);
  const row = U.invoiceExportRow(invoice, match);
  assert.equal(row.length, U.invoiceExportHeaders().length);
  assert.equal(row[2], 'Maharashtra');
  assert.equal(row[5], 'Not found');
  assert.equal(row[6], 'Zinc Syrup\nKesh King Oil 200ml');
  assert.equal(row[7], '2\n1');
  assert.equal(row[8], '98\n210');
  assert.equal(row[9], '12% (23.52)\nNot found');
  assert.equal(row[10], '429.52');
  assert.equal(row[11], 'Credit');
  assert.match(row[12], /need manual check/);
  assert.match(row[13], /Kesh King Oil 200ml/);
});

test('export fills the GST column from the invoice summary when lines have none', () => {
  const invoice = {
    items: [{ description: 'Zinc Syrup', quantity: 1, rate: 98, amount: 98 }],
    gst: { rate: '12%', amount: 11.76, cgst: 'Not found', sgst: 'Not found', igst: 'Not found' },
    payable: { amount: 109.76, account: 'Not found' }
  };
  const row = U.invoiceExportRow(invoice, U.matchInvoice(invoice, []));
  assert.equal(row[9], '12% | Total 11.76');
  assert.equal(row[11], 'Not found');
});
