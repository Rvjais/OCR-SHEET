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
    page.on('pageerror', error => crashes.push(error.message));
    await page.goto(url);
    assert.equal(await page.locator('#handwritten-ocr').isChecked(), true);
    assert.equal(await page.locator('#printed-ocr').isChecked(), false);
    assert.equal(await page.locator('#localOCR-model, #localOCR-key, #ocr-provider, #backend-status, #deployment-info').count(), 0);
    await page.locator('#printed-ocr').check();
    assert.equal(await page.locator('#handwritten-ocr').isChecked(), false);
    await page.locator('#printed-ocr').uncheck();
    assert.equal(await page.locator('#handwritten-ocr').isChecked(), true, 'one recognition mode remains selected');
    await page.locator('#printed-ocr').check();
    await page.evaluate(() => {
      window.counts = { workers: 0, passes: 0, terminated: 0 };
      window.Tesseract = { PSM: { AUTO: '3' }, createWorker: async () => {
        counts.workers++;
        return { setParameters: async () => {}, terminate: async () => { counts.terminated++; },
          recognize: async () => { counts.passes++; return { data: {
            text: 'Invoice AB-00123 Total 1,234.50', confidence: 97,
            blocks: [{ paragraphs: [{ lines: [{ words: [{ text: 'AB-00123', confidence: 97 }, { text: '1,234.50', confidence: 97 }] }] }] }]
          } }; }
        };
      } };
    });
    async function run() {
      await page.locator('#extract').click();
      await page.waitForFunction(() => !document.getElementById('extract').disabled);
    }
    await page.locator('#file-input').setInputFiles(['numbers.png', 'other.png'].map(name => path.join(fixtures, name)));
    await run();
    assert.deepEqual(await page.evaluate(() => counts), { workers: 1, passes: 2, terminated: 0 });
    await page.locator('#ocr-quality').selectOption('thorough');
    await run();
    assert.deepEqual(await page.evaluate(() => counts), { workers: 1, passes: 6, terminated: 0 });
    await page.locator('#language').selectOption('eng+hin');
    await page.waitForFunction(() => counts.terminated === 1);
    await run();
    assert.equal(await page.evaluate(() => counts.workers), 2);

    const localOCR = await browser.newPage();
    localOCR.on('pageerror', error => crashes.push(error.message));
    await localOCR.route('**/api/health', route => route.fulfill({ json: {
      service: 'textlens-handwriting', available: true, loaded: true
    } }));
    let requests = 0;
    await localOCR.route('**/api/ocr', async route => {
      requests++;
      const body = route.request().postData();
      assert.match(body, /name="provider"\r\n\r\nlocal/);
      assert.doesNotMatch(body, /name="(?:api_key|model)"/, 'credentials and model selection are not submitted by users');
      assert.match(body, /Content-Type: image\/png/i, 'lossless page upload preserves handwriting strokes');
      await route.fulfill({ json: { text: 'Invoice number: AB-00123\nTotal: 1,234.50', confidence: 88,
        uncertain: [{ text: '1,234.50', confidence: 72 }], words: [{ text: '1,234.50', confidence: 72 }], notes: ['Review handwriting.'], engine: 'PaddleOCR' } });
    });
    await localOCR.goto(url);
    await localOCR.locator('#handwritten-ocr').check();
    await localOCR.locator('#file-input').setInputFiles(['invoice-labels.pdf', 'numbers.png'].map(name => path.join(fixtures, name)));
    await localOCR.locator('#extract').click();
    await localOCR.waitForFunction(() => !document.getElementById('extract').disabled);
    assert.equal(requests, 2, 'Local OCR reads both printed PDFs and image pages');
    assert.match(await localOCR.locator('#output').inputValue(), /1,234\.50/);
    assert.match(await localOCR.locator('#quality-words').textContent(), /1,234\.50/);
    assert.doesNotMatch(await localOCR.locator('#quality-words').textContent(), /0\/100/);
    assert.match(await localOCR.locator('.privacy').textContent(), /No external AI services/);
    assert.equal(await localOCR.evaluate(() => localStorage.length + sessionStorage.length), 0);
    for (const width of [320, 390, 768, 1280]) {
      await localOCR.setViewportSize({ width, height: 844 });
      assert.equal(await localOCR.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    }
    await localOCR.screenshot({ path: path.join(fixtures, 'localOCR-desktop.png'), fullPage: true });
    await localOCR.setViewportSize({ width: 390, height: 844 });
    await localOCR.screenshot({ path: path.join(fixtures, 'localOCR-mobile.png'), fullPage: true });
    await localOCR.unroute('**/api/ocr');
    await localOCR.route('**/api/ocr', route => route.fulfill({ status: 429, json: { detail: 'Local OCR request limit reached. Wait and retry.' } }));
    await localOCR.locator('#remove').click();
    await localOCR.locator('#file-input').setInputFiles(path.join(fixtures, 'numbers.png'));
    await localOCR.locator('#extract').click();
    await localOCR.waitForFunction(() => !document.getElementById('extract').disabled);
    assert.match(await localOCR.locator('#message').textContent(), /request limit/);
    assert.equal(await localOCR.locator('#output').inputValue(), '');

    // The deployed frontend uses its configured server without credential entry.
    const remote = await browser.newPage();
    remote.on('pageerror', error => crashes.push(error.message));
    await remote.route('**/runtime-config.js', route => route.fulfill({
      contentType: 'application/javascript',
      body: 'window.TEXTLENS_CONFIG={backendUrl:"https://72-61-224-90.sslip.io"};'
    }));
    const cors = { 'access-control-allow-origin': new URL(url).origin,
      'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'Authorization, Content-Type' };
    await remote.route('https://72-61-224-90.sslip.io/api/health', route => route.fulfill({ headers: cors,
      json: { status: 'ok', service: 'textlens-handwriting', requires_access_token: false,
        available: true, loaded: true } }));
    let protectedRequests = 0;
    await remote.route('https://72-61-224-90.sslip.io/api/ocr', async route => {
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      protectedRequests++;
      assert.equal(route.request().headers().authorization, undefined);
      assert.doesNotMatch(route.request().postData(), /name="api_key"\r\n\r\n[^\r]/);
      await route.fulfill({ headers: cors, json: { text: 'AB-00123 1,234.50', confidence: null,
        uncertain: [], words: [], notes: [], engine: 'PaddleOCR' } });
    });
    await remote.goto(url);
    assert.equal(await remote.locator('#server-token').count(), 0);
    assert.equal(await remote.locator('#localOCR-key, #localOCR-model, #deployment-info, #backend-status').count(), 0);
    assert.doesNotMatch(await remote.locator('body').innerText(), /\b(?:VPS|server|deployment)\b/i);
    await remote.locator('#file-input').setInputFiles(path.join(fixtures, 'numbers.png'));
    await remote.locator('#extract').click();
    await remote.waitForFunction(() => !document.getElementById('extract').disabled);
    assert.equal(protectedRequests, 1);
    assert.match(await remote.locator('#output').inputValue(), /1,234\.50/);
    assert.equal(await remote.evaluate(() => localStorage.length + sessionStorage.length), 0);
    await remote.close();
    assert.deepEqual(crashes, []);
    console.log('Passed: exclusive recognition tick boxes, local OCR requests, fast OCR, automatic extraction, clean production interface, privacy, review, API failure and mobile layout.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
