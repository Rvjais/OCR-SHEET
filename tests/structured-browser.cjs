const { chromium } = require('playwright');
const assert = require('node:assert/strict');

const url = process.env.TEXTLENS_URL || 'http://127.0.0.1:8000';

(async () => {
  const browser = await chromium.launch({ channel: process.env.TEXTLENS_BROWSER || 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    const crashes = [];
    page.on('pageerror', error => crashes.push(error.message));
    await page.goto(url);

    // Load a product list through the same code path as the upload control.
    await page.evaluate(() => applyCatalogMatrix([
      ['Product Name', 'Price', 'Stock'],
      ['Amoxycillin 500 MG', '45.5', '12'],
      ['Zinc Syrup', '98', '4'],
      ['Paracetamol 500 MG', '20', '30']
    ], 'products.csv'));
    assert.match(await page.locator('#catalog-status').textContent(), /3 products loaded from products\.csv/);
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('textlens.catalog.v1')).products.length), 3);

    await page.evaluate(() => {
      currentStructuredData = {
        store: { name: 'Sharma Traders', address: '12 MG Road, Pune', state: 'Maharashtra' },
        invoice: { number: 'INV-001' },
        customer: { name: 'Ravi', mobile: 'Not found' },
        items: [
          { description: 'Zinc Syrup', quantity: 2, rate: 'Not found', amount: 196.02, gst_rate: '12%', gst_amount: '23.52' },
          { description: 'Amoxycilln 500 mg', quantity: 1, rate: 45.5, amount: 45.5, gst_rate: '12%', gst_amount: '5.46' },
          { description: 'Kesh King Oil 200ml', quantity: 1, rate: 210, amount: 210, gst_rate: 'Not found', gst_amount: 'Not found' }
        ],
        gst: { rate: '12%', amount: 28.98, cgst: '14.49', sgst: '14.49', igst: 'Not found' },
        payable: { amount: 460.98, account: 'Credit' }
      };
      currentMatches = Utils.matchInvoice(currentStructuredData, productCatalog);
      renderStructuredTable(currentStructuredData, currentMatches);
      document.getElementById('structured-panel').hidden = false;
    });

    assert.equal(await page.locator('#items-table-body tr').count(), 3);
    const rows = await page.locator('#items-table-body tr').allInnerTexts();
    assert.match(rows[0], /Rate mismatch/);
    assert.match(rows[1], /Amoxycillin 500 MG/, 'handwritten spelling is corrected to the list entry');
    assert.match(rows[1], /Verified/);
    assert.match(rows[2], /Not in list/);
    assert.match(await page.locator('#verification-banner').textContent(), /2 of 3 product rows need manual verification/);
    assert.match(await page.locator('#verification-banner').textContent(), /Kesh King Oil 200ml/);
    assert.match(await page.locator('#structured-meta').textContent(), /Maharashtra/);
    assert.match(await page.locator('#structured-meta').textContent(), /Not found/, 'a missing mobile number stays visible as Not found');
    assert.match(await page.locator('#totals-box').textContent(), /Payable Account:\s*Credit/);

    const exported = await page.evaluate(() => Utils.invoiceExportRow(currentStructuredData, currentMatches));
    assert.equal(exported.length, 14);
    assert.equal(exported[5], 'Not found');
    assert.equal(exported[6], 'Zinc Syrup\nAmoxycillin 500 MG\nKesh King Oil 200ml');
    assert.equal(exported[8], '196.02\n45.5\n210');

    const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#export-csv-btn').click()]);
    assert.match(download.suggestedFilename(), /invoice\.csv$/);

    await page.locator('#catalog-clear').click();
    assert.match(await page.locator('#catalog-status').textContent(), /No product list loaded/);
    assert.equal(await page.locator('#verification-banner').isHidden(), true);
    assert.equal(await page.evaluate(() => Utils.invoiceExportRow(currentStructuredData, currentMatches)[12]), 'No product list — not verified');
    assert.deepEqual(crashes, []);
    console.log('Passed: product list upload, fuzzy name correction, strict rate check, Not found fallbacks, verification banner and export row.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
