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
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('textlens.catalog.v2')).products.length), 3);

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

    // Format to Table must send the uploaded product list along with the OCR
    // text so the model can read product names and rates against it.
    let structureRequest = null;
    await page.route('**/api/health', route => route.fulfill({ json: { service: 'textlens-handwriting', available: true } }));
    await page.route('**/api/structure-invoice', async route => {
      structureRequest = route.request().postDataJSON();
      await route.fulfill({
        json: {
          store: { name: 'Sharma Traders', address: '12 MG Road, Pune', state: 'Maharashtra' },
          invoice: { number: 'INV-002' },
          customer: { name: 'Not found', mobile: 'Not found' },
          items: [{ description: 'Zinc Syrup', quantity: 1, rate: 98, amount: 98, gst_rate: '12%', gst_amount: '11.76' }],
          gst: { rate: '12%', amount: 11.76, cgst: 'Not found', sgst: 'Not found', igst: 'Not found' },
          payable: { amount: 109.76, account: 'Cash' }
        }
      });
    });
    await page.evaluate(() => setOutput('Sharma Traders\nInvoice INV-002\nZinc Syrup 98\nPayable 109.76 Cash'));
    await page.evaluate(() => document.getElementById('structure-table').click());
    await page.waitForFunction(() => document.querySelector('#structured-meta').textContent.includes('INV-002'));
    assert.ok(structureRequest, 'the format action posts to the structuring API');
    assert.deepEqual(structureRequest.products.map(product => product.name).sort(),
      ['Amoxycillin 500 MG', 'Paracetamol 500 MG', 'Zinc Syrup']);
    assert.equal(structureRequest.products.find(product => product.name === 'Zinc Syrup').price, 98);
    assert.match(await page.locator('#items-table-body').textContent(), /Verified/);
    assert.match(await page.locator('#message').textContent(), /3 product references/);

    await page.locator('#catalog-clear').click();
    await page.waitForFunction(() => /products loaded from product-catalog\.xlsx/.test(document.getElementById('catalog-status').textContent), null, { timeout: 60000 });
    assert.match(await page.locator('#catalog-status').textContent(), /products loaded from product-catalog\.xlsx/);
    const bundled = await page.evaluate(() => ({
      count: productCatalog.length,
      stored: localStorage.getItem('textlens.catalog.v2'),
      match: Utils.matchInvoice({ items: [{ description: 'Instax Mini 12 Camera', quantity: 1, rate: 6999, amount: 6999 }] }, productCatalog).items[0],
      variant: Utils.matchInvoice({ items: [{ description: 'INSTAX Mini 99', quantity: 1, rate: 17999, amount: 17999 }] }, productCatalog).items[0],
      wrongPrice: Utils.matchInvoice({ items: [{ description: 'Instax Mini 12 Camera', quantity: 1, rate: 6500, amount: 6500 }] }, productCatalog).items[0]
    }));
    assert.ok(bundled.count >= 80, 'the bundled sheet loads all catalog products');
    assert.equal(bundled.stored, null, 'the bundled sheet is not persisted to localStorage');
    assert.equal(await page.locator('#catalog-clear').isHidden(), true, 'no upload to clear when using the bundled sheet');
    assert.equal(bundled.match.matchStatus, 'matched');
    assert.equal(bundled.match.matchedName, 'Instax Mini 12 Camera');
    assert.equal(bundled.variant.matchedName, 'INSTAX Mini 99 - Silver', 'the printed rate chooses the right priced variant');
    assert.equal(bundled.variant.matchStatus, 'matched');
    assert.equal(bundled.wrongPrice.matchStatus, 'price-mismatch');
    assert.match(await page.locator('#verification-banner').textContent(), /need manual verification/);
    assert.match(await page.evaluate(() => Utils.invoiceExportRow(currentStructuredData, currentMatches)[12]), /need manual check/);

    // After an upload is removed, the bundled sheet must guide the next
    // formatting request just like an uploaded list did.
    const bundledResponse = page.waitForResponse(response => response.url().includes('/api/structure-invoice'));
    await page.evaluate(() => document.getElementById('structure-table').click());
    await bundledResponse;
    assert.ok(structureRequest.products.length >= 80, 'the bundled sheet is sent as extraction guidance');
    assert.ok(structureRequest.products.some(product => product.name === 'Instax Mini 12 Camera' && product.price === 6999));
    assert.deepEqual(crashes, []);
    console.log('Passed: product list upload, bundled sheet auto-load, guided extraction request, fuzzy name correction, strict rate check, Not found fallbacks, verification banner and export row.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
