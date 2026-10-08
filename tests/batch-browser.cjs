const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const fixtures = path.resolve(process.env.TEXTLENS_TEST_DIR || 'tests/fixtures');
const url = process.env.TEXTLENS_URL || 'http://127.0.0.1:8000';

(async () => {
  const browser = await chromium.launch({ channel: process.env.TEXTLENS_BROWSER || 'chrome', headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 960 }, permissions: ['clipboard-read', 'clipboard-write'] });
    const page = await context.newPage();
    const crashes = [];
    page.on('pageerror', error => crashes.push(error.message));
    await page.goto(url);
    await page.locator('#ocr-provider').selectOption('browser');
    assert.equal(await page.locator('#file-input').getAttribute('multiple'), '');
    await page.locator('#file-input').setInputFiles(['numbers.png', 'broken.pdf', 'pages.pdf', 'other.png', 'exact.pdf'].map(name => path.join(fixtures, name)));
    assert.equal(await page.locator('.document-select').count(), 5);
    await page.locator('#extract').click();
    await page.waitForFunction(() => !document.getElementById('extract').disabled, { timeout: 180000 });
    assert.equal(await page.locator('.document-item.error').count(), 1);
    assert.match(await page.locator('#message').textContent(), /1 file needs retry/);
    assert.match(await page.locator('#output').inputValue(), /AB-00123/);

    await page.locator('.document-select').nth(2).click();
    assert.match(await page.locator('#viewer-file').textContent(), /3. pages.pdf/);
    assert.match(await page.locator('#output').inputValue(), /FIRST page PAGE-00111/);
    assert.match(await page.locator('#preview-content img').getAttribute('alt'), /pages.pdf, page 1 of 2/);
    await page.locator('#next-page').click();
    assert.match(await page.locator('#output').inputValue(), /SECOND page PAGE-00222/);
    assert.match(await page.locator('#preview-content img').getAttribute('alt'), /page 2 of 2/);
    const edited = 'SECOND page PAGE-00222\nReviewed edit 00042';
    await page.locator('#output').fill(edited);
    await page.locator('.document-select').nth(3).click();
    assert.match(await page.locator('#output').inputValue(), /PHOTO-007/);
    await page.locator('.document-select').nth(2).click();
    assert.equal(await page.locator('#output').inputValue(), edited);
    await page.locator('#page-select').selectOption('0');
    assert.match(await page.locator('#output').inputValue(), /PAGE-00111/);
    await page.locator('#page-select').selectOption('1');
    assert.equal(await page.locator('#output').inputValue(), edited);
    await page.locator('#output').fill('');
    await page.locator('#page-select').selectOption('0');
    await page.locator('#page-select').selectOption('1');
    assert.equal(await page.locator('#output').getAttribute('readonly'), null);
    await page.locator('#output').fill(edited);
    const [singleDownload] = await Promise.all([page.waitForEvent('download'), page.locator('#download').click()]);
    assert.equal(singleDownload.suggestedFilename(), 'pages-page-2-text.txt');
    assert.equal(await fs.readFile(await singleDownload.path(), 'utf8'), edited);

    await page.locator('#copy-all').click();
    const all = (await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, '\n');
    assert.match(all, /=== File 1: numbers.png ===/);
    assert.match(all, /=== File 2: broken.pdf ===\n— Page 1 —\n\[This PDF is damaged or invalid/);
    assert.match(all, /=== File 3: pages.pdf ===\n— Page 1 —\nFIRST page PAGE-00111\n\n— Page 2 —\nSECOND page PAGE-00222\nReviewed edit 00042/);
    assert.match(all, /=== File 4: other.png ===/);
    const [batchDownload] = await Promise.all([page.waitForEvent('download'), page.locator('#save-all').click()]);
    assert.equal(batchDownload.suggestedFilename(), 'textlens-all-results.txt');
    assert.equal(await fs.readFile(await batchDownload.path(), 'utf8'), all);

    // Adding a file preserves existing pages and edits; only pending/failed files run.
    await page.locator('#file-input').setInputFiles(path.join(fixtures, 'mixed.pdf'));
    assert.equal(await page.locator('.document-select').count(), 6);
    await page.locator('#extract').click();
    await page.waitForFunction(() => !document.getElementById('extract').disabled, { timeout: 180000 });
    assert.match(await page.locator('#output').inputValue(), /ACCOUNT-007/);
    await page.locator('.document-select').nth(2).click();
    assert.equal(await page.locator('#output').inputValue(), edited);
    for (const width of [320, 390, 700, 768, 1280]) {
      await page.setViewportSize({ width, height: 844 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `overflow at ${width}`);
      if (width === 390) await page.screenshot({ path: path.join(fixtures, 'batch-mobile.png'), fullPage: true });
    }
    await page.screenshot({ path: path.join(fixtures, 'batch-desktop.png'), fullPage: true });
    await page.getByRole('button', { name: 'Remove broken.pdf', exact: true }).click();
    assert.equal(await page.locator('.document-select').count(), 5);
    assert.equal(await page.locator('#output').inputValue(), edited);

    // Identical filenames remain separate numbered records; invalid siblings are skipped.
    await page.locator('#file-input').setInputFiles([
      { name: 'same.png', mimeType: 'image/png', buffer: await fs.readFile(path.join(fixtures, 'numbers.png')) },
      { name: 'same.png', mimeType: 'image/png', buffer: await fs.readFile(path.join(fixtures, 'other.png')) },
      { name: 'unsupported.txt', mimeType: 'text/plain', buffer: Buffer.from('not an image') }
    ]);
    assert.equal(await page.locator('.document-select').count(), 7);
    assert.match(await page.locator('#message').textContent(), /Skipped 1/);
    await page.locator('#extract').click();
    await page.waitForFunction(() => !document.getElementById('extract').disabled, { timeout: 180000 });
    await page.locator('.document-select').nth(5).click();
    assert.match(await page.locator('#output').inputValue(), /AB-00123/);
    await page.locator('.document-select').nth(6).click();
    assert.match(await page.locator('#output').inputValue(), /PHOTO-007/);

    // Multi-file drag and drop also populates the queue.
    await page.locator('#remove').click();
    const payload = await Promise.all(['exact.pdf', 'pages.pdf'].map(async name => ({ name, data: Array.from(await fs.readFile(path.join(fixtures, name))) })));
    const transfer = await page.evaluateHandle(payload => {
      const transfer = new DataTransfer();
      for (const item of payload) transfer.items.add(new File([new Uint8Array(item.data)], item.name, { type: 'application/pdf' }));
      return transfer;
    }, payload);
    await page.locator('#upload-card').dispatchEvent('drop', { dataTransfer: transfer });
    assert.equal(await page.locator('.document-select').count(), 2);
    await transfer.dispose();
    await page.locator('#extract').click();
    await page.waitForFunction(() => !document.getElementById('extract').disabled, { timeout: 180000 });
    assert.equal(await page.locator('.document-item.done').count(), 2);

    // Cancel mid-batch: keep completed work, then resume only unfinished files.
    const cancel = await context.newPage();
    await cancel.goto(url);
    await cancel.locator('#ocr-provider').selectOption('browser');
    await cancel.evaluate(() => {
      window.Tesseract = { PSM: { AUTO: '3' }, createWorker: async () => ({
        setParameters: async () => {}, terminate: async () => {},
        recognize: async () => { await new Promise(resolve => setTimeout(resolve, 600)); return { data: { text: 'Mock OCR AB-00123', confidence: 97 } }; }
      }) };
    });
    await cancel.locator('#file-input').setInputFiles(['exact.pdf', 'numbers.png', 'other.png'].map(name => path.join(fixtures, name)));
    await cancel.locator('#extract').click();
    await cancel.waitForFunction(() => document.getElementById('progress-label').textContent.includes('File 2 of 3'));
    await cancel.locator('#cancel').click();
    await cancel.waitForFunction(() => !document.getElementById('extract').disabled);
    assert.match(await cancel.locator('#output').inputValue(), /AB-00123/);
    assert.match(await cancel.locator('#message').textContent(), /Batch cancelled/);
    await cancel.locator('#output').fill('Keep this completed-file edit 00042');
    await cancel.locator('#extract').click();
    await cancel.waitForFunction(() => !document.getElementById('extract').disabled);
    assert.equal(await cancel.locator('#output').inputValue(), 'Keep this completed-file edit 00042');
    assert.equal(await cancel.locator('.document-item.done').count(), 3);
    await cancel.close();
    assert.deepEqual(crashes, []);
    console.log('Passed: mixed batches, all PDF pages, isolated failures, page edits, exports, adding/removing files, duplicate names, multi-file drop, cancellation/resume and mobile layouts.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
