// Edits product-catalog.xlsx from the price-sheet window, then proves the
// app persists those edits and falls back to the attached file on request.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');

const url = process.env.TEXTLENS_URL || 'http://127.0.0.1:8000';

(async () => {
  const browser = await chromium.launch({ channel: process.env.TEXTLENS_BROWSER || 'chrome', headless: true });
  try {
    const page = await browser.newPage({ acceptDownloads: true });
    const crashes = [];
    page.on('pageerror', error => crashes.push(error.message));
    await page.goto(url);
    await page.waitForFunction(() => Array.isArray(productCatalog) && productCatalog.length > 0, null, { timeout: 60000 });

    const target = 'Instax Mini 12 Camera';
    assert.ok(
      await page.evaluate(name => productCatalog.some(item => item.name === name), target),
      'the bundled sheet has a known product to edit'
    );

    await page.locator('#catalog-view-nav').click();
    await page.locator('#catalog-modal').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#catalog-edit-toggle').isVisible(), true, 'the sheet is reachable without formatting an invoice');

    // ---- edit a price in place ----
    await page.locator('#catalog-edit-toggle').click();
    assert.equal(await page.locator('#catalog-edit-label').textContent(), 'Done editing');
    await page.locator('#catalog-search-input').fill(target);
    const priceInput = page.locator('#catalog-sheet-body input.sheet-price-input').first();
    assert.equal(await priceInput.inputValue(), '6999', 'the attached price is editable as-is');
    await priceInput.fill('6,499');
    await priceInput.press('Tab');

    const edited = await page.evaluate(() => ({
      price: productCatalog.find(item => item.name === 'Instax Mini 12 Camera')?.price,
      saved: JSON.parse(localStorage.getItem('textlens.catalog.v2')),
      meta: catalogMeta
    }));
    assert.equal(edited.price, 6499, 'a typed "6,499" keeps the thousands separator');
    assert.equal(edited.meta.source, 'bundled-edited');
    assert.ok(edited.saved.matrix && edited.saved.matrix.length > 80, 'the whole sheet, not just names, is saved');
    assert.ok(edited.saved.baseSignature, 'the attached file signature is recorded');

    // ---- add a new product row ----
    await page.locator('#catalog-add-row').click();
    const newRow = await page.evaluate(() => catalogMatrix.length - 1);
    const nameColumn = await page.evaluate(() => catalogMeta.nameColumn);
    const priceColumn = await page.evaluate(() => catalogMeta.priceColumn);
    await page.locator(`#catalog-sheet-body input[data-row="${newRow}"][data-col="${nameColumn}"]`).fill('Instax Film Sample Pack');
    await page.locator(`#catalog-sheet-body input[data-row="${newRow}"][data-col="${priceColumn}"]`).fill('1,250');
    await page.locator(`#catalog-sheet-body input[data-row="${newRow}"][data-col="${priceColumn}"]`).press('Tab');
    assert.equal(
      await page.evaluate(() => productCatalog.find(item => item.name === 'Instax Film Sample Pack')?.price),
      1250,
      'a new row is used immediately'
    );

    // ---- download the edited sheet ----
    const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#catalog-download').click()]);
    assert.equal(download.suggestedFilename(), 'product-catalog.xlsx');
    assert.match(await page.locator('#catalog-edit-status').textContent(), /replace the attached file/i);

    // ---- delete a row ----
    page.once('dialog', dialog => dialog.accept());
    await page.locator(`#catalog-sheet-body input[data-row="${newRow}"][data-col="${nameColumn}"]`).hover();
    await page.locator(`#catalog-sheet-body button[data-delete="${newRow}"]`).click();
    assert.ok(
      await page.evaluate(() => !productCatalog.some(item => item.name === 'Instax Film Sample Pack')),
      'a deleted row no longer guides extraction'
    );

    // ---- the edit survives a reload because the attached file is unchanged ----
    await page.locator('#catalog-modal-close').click();
    await page.reload();
    await page.waitForFunction(() => Array.isArray(productCatalog) && productCatalog.length > 0, null, { timeout: 60000 });
    await page.waitForFunction(
      () => catalogMeta?.source === 'bundled-edited' && productCatalog.some(item => item.name === 'Instax Mini 12 Camera' && item.price === 6499),
      null,
      { timeout: 60000 }
    );
    await page.locator('#catalog-view-nav').click();
    assert.match(await page.locator('#catalog-modal-meta').textContent(), /edited in this browser/);

    // ---- "Use bundled sheet" discards the browser copy ----
    await page.locator('#catalog-reset').click();
    await page.waitForFunction(
      () => catalogMeta?.source === 'bundled' && productCatalog.some(item => item.name === 'Instax Mini 12 Camera' && item.price === 6999),
      null,
      { timeout: 60000 }
    );
    assert.equal(await page.evaluate(() => localStorage.getItem('textlens.catalog.v2')), null);
    assert.match(await page.locator('#catalog-modal-meta').textContent(), /Bundled with the app/);

    // ---- editing the attached .xlsx outside the app wins over browser edits ----
    await page.locator('#catalog-modal-close').click();
    await page.evaluate(() => {
      const matrix = catalogMatrix.map(row => [...row]);
      const target = matrix.findIndex((row, index) =>
        index > catalogMeta.headerRow && String(row[catalogMeta.nameColumn] ?? '').trim() === 'Instax Mini 12 Camera');
      matrix[target][catalogMeta.priceColumn] = 1234;
      localStorage.setItem('textlens.catalog.v2', JSON.stringify({
        products: [], matrix, headerRow: catalogMeta.headerRow, nameColumn: catalogMeta.nameColumn,
        priceColumn: catalogMeta.priceColumn, fileName: 'product-catalog.xlsx', updated: new Date().toISOString(),
        source: 'bundled-edited', baseSignature: 'an-older-version-of-the-file'
      }));
    });
    await page.reload();
    await page.waitForFunction(
      () => catalogMeta?.source === 'bundled' && productCatalog.some(item => item.name === 'Instax Mini 12 Camera' && item.price === 6999),
      null,
      { timeout: 60000 }
    );
    assert.equal(await page.evaluate(() => localStorage.getItem('textlens.catalog.v2')), null, 'the changed file replaces the browser copy');
    await page.locator('#catalog-view-nav').click();
    assert.match(await page.locator('#catalog-edit-status').textContent(), /changed, so the updated file is now in use/);
    await page.locator('#catalog-modal-close').click();

    assert.deepEqual(crashes, []);
    console.log('Passed: in-app price/name/row edits, full-sheet persistence, .xlsx download, reload, reset, and attached-file precedence.');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
