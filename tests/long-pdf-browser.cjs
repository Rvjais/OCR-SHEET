const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const fixtures = path.resolve(process.env.TEXTLENS_TEST_DIR || 'tests/fixtures');
const url = process.env.TEXTLENS_URL || 'http://127.0.0.1:8000';

(async () => {
  const browser = await chromium.launch({ channel: process.env.TEXTLENS_BROWSER || 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    const crashes = [];
    const recognized = [];
    let delayPageFive = false;
    page.on('pageerror', error => crashes.push(error.message));
    await page.route('**/api/health', route => route.fulfill({ json: { service: 'textlens-handwriting', available: true, loaded: true } }));
    await page.route('**/api/ocr', async route => {
      const number = await page.evaluate(() => ocrPage);
      recognized.push(number);
      if (delayPageFive && number === 5) await new Promise(resolve => setTimeout(resolve, 800));
      await route.fulfill({ json: { text: `PAGE-${String(number).padStart(3, '0')} Total 1,234.50`,
        confidence: 97, words: [], uncertain: [], notes: [], engine: 'Test local OCR' } });
    });
    await page.goto(url);
    // Use the real PDF.js parser/renderer. Inject a stuck render only on page 4
    // and shorten its timeout so recovery can be checked without a 10min wait.
    await page.evaluate(async () => {
      const pdfjs = await loadPDF();
      const originalGuarded = guarded;
      guarded = (promise, label, time, options) => originalGuarded(promise, label,
        label === 'Rendering page 4' && window.failPageFour ? 30 : time, options);
      window.failPageFour = true;
      window.renderAttempts = [];
      window.cancelledRenders = 0;
      window.cleanedPages = 0;
      pdfModulePromise = Promise.resolve({ ...pdfjs, getDocument(options) {
        const loading = pdfjs.getDocument(options);
        loading.promise.then(pdf => {
          const getPage = pdf.getPage.bind(pdf);
          const cleanup = pdf.cleanup.bind(pdf);
          pdf.cleanup = async () => { window.cleanedPages++; return cleanup(); };
          pdf.getPage = async number => {
            const page = await getPage(number);
            const render = page.render.bind(page);
            page.render = options => {
              if (number !== 4 || !window.failPageFour) return render(options);
              window.renderAttempts.push(options.viewport.width);
              let reject;
              return { promise: new Promise((_, r) => { reject = r; }), cancel() {
                window.cancelledRenders++;
                reject(new DOMException('Cancelled render', 'AbortError'));
              } };
            };
            return page;
          };
        });
        return loading;
      } });
    });
    await page.locator('#file-input').setInputFiles(path.join(fixtures, 'scanned-40-pages.pdf'));
    await page.locator('#extract').click();
    await page.waitForFunction(() => !document.getElementById('extract').disabled, null, { timeout: 180000 });
    assert.equal(recognized.length, 39);
    assert.equal(recognized.includes(4), false);
    assert.equal(recognized.at(-1), 40, 'a stuck fourth page does not stop later pages');
    assert.equal(await page.locator('#page-select option').count(), 40);
    assert.equal(await page.evaluate(() => window.cancelledRenders), 2);
    const attempts = await page.evaluate(() => window.renderAttempts);
    assert.ok(attempts[1] < attempts[0], 'timeout retries at a smaller resolution');
    assert.equal(await page.evaluate(() => window.cleanedPages), 40);
    await page.locator('#page-select').selectOption('39');
    assert.match(await page.locator('#output').inputValue(), /PAGE-040/);
    const dimensions = await page.locator('#preview-content img').evaluate(async image => {
      await image.decode(); return [image.naturalWidth, image.naturalHeight];
    });
    assert.ok(Math.max(...dimensions) <= 1200, 'stored previews are compact');
    const saved = await page.evaluate(() => ExtractionUtils.formatBatch(documents));
    assert.match(saved, /Page 4[^]*This page could not be read/);
    assert.match(await page.locator('#quality-summary').textContent(), /Rendering page 4 timed out/);
    assert.match(saved, /PAGE-040/);
    await page.locator('#page-select').selectOption('0');
    await page.locator('#output').fill('Keep this reviewed page 1 edit');
    await page.evaluate(() => { window.failPageFour = false; });
    await page.locator('#extract').click();
    await page.waitForFunction(() => !document.getElementById('extract').disabled, null, { timeout: 120000 });
    assert.equal(recognized.length, 40, 'retry reads only the failed page');
    assert.equal(recognized.at(-1), 4);
    assert.equal(await page.locator('.document-item.done').count(), 1);
    assert.equal(await page.locator('#output').inputValue(), 'Keep this reviewed page 1 edit');
    await page.locator('#page-select').selectOption('3');
    assert.match(await page.locator('#output').inputValue(), /PAGE-004/);

    // Cancelling the same PDF preserves its completed pages, too.
    const beforeCancel = recognized.length;
    delayPageFive = true;
    await page.locator('#extract').click();
    await page.waitForFunction(() => ocrPage === 5 && document.getElementById('progress-label').textContent.includes('handwritten'));
    await page.locator('#cancel').click();
    await page.waitForFunction(() => !document.getElementById('extract').disabled);
    assert.equal(await page.evaluate(() => pageReports.length), 4);
    await page.locator('#page-select').selectOption('0');
    await page.locator('#output').fill('Keep this edit after cancelling the PDF');
    delayPageFive = false;
    await page.locator('#extract').click();
    await page.waitForFunction(() => !document.getElementById('extract').disabled, null, { timeout: 180000 });
    assert.equal(recognized.slice(beforeCancel).filter(number => number < 5).length, 4, 'completed pages are not submitted again after cancellation');
    assert.equal(await page.locator('.document-item.done').count(), 1);
    assert.equal(await page.locator('#output').inputValue(), 'Keep this edit after cancelling the PDF');

    // Hidden-tab time does not count as a render timeout, but cancellation
    // still stops a hidden render immediately and removes its listeners.
    await page.evaluate(async () => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => window.testHidden });
      window.testHidden = true;
      const waiting = guarded(new Promise(resolve => setTimeout(resolve, 150)), 'Hidden render', 30, { pauseWhenHidden: true });
      await waiting;
      window.testHidden = false;
      document.dispatchEvent(new Event('visibilitychange'));
      extractionController = new AbortController();
      window.testHidden = true;
      const cancelled = guarded(new Promise(() => {}), 'Hidden render', 30, { pauseWhenHidden: true });
      extractionController.abort(new DOMException('Cancelled', 'AbortError'));
      try { await cancelled; throw new Error('Cancellation was ignored'); }
      catch (error) { if (error.name !== 'AbortError') throw error; }
      extractionController = null;
      delete document.hidden;
    });
    assert.deepEqual(crashes, []);
    console.log('Passed: real 40-page PDF rendering, isolated timeout recovery, smaller retry, compact previews, memory cleanup, preserved edits, failed-page-only resume and hidden-tab cancellation.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
