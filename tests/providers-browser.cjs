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
    assert.equal(await page.locator('#ocr-provider').inputValue(), 'gemini');
    assert.equal(await page.locator('#gemini-model').inputValue(), 'gemini-3.1-pro-preview');
    await page.locator('#ocr-provider').selectOption('browser');
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

    const gemini = await browser.newPage();
    gemini.on('pageerror', error => crashes.push(error.message));
    await gemini.route('**/api/health', route => route.fulfill({ json: {
      service: 'textlens-handwriting', available: false, gemini: { available: true, configured: false }
    } }));
    let requests = 0;
    await gemini.route('**/api/ocr', async route => {
      requests++;
      const body = route.request().postData();
      assert.match(body, /name="provider"\r\n\r\ngemini/);
      assert.match(body, /name="api_key"\r\n\r\ntest-key/);
      await route.fulfill({ json: { text: 'Invoice number: AB-00123\nTotal: 1,234.50', confidence: null,
        uncertain: [{ text: '1,234.50', confidence: null }], words: [], notes: ['Review handwriting.'], engine: 'Gemini' } });
    });
    await gemini.goto(url);
    await gemini.locator('#ocr-provider').selectOption('gemini');
    await gemini.locator('#gemini-key').fill('test-key');
    await gemini.locator('#file-input').setInputFiles(['invoice-labels.pdf', 'numbers.png'].map(name => path.join(fixtures, name)));
    await gemini.locator('#extract').click();
    await gemini.waitForFunction(() => !document.getElementById('extract').disabled);
    assert.equal(requests, 2, 'Gemini reads both printed PDFs and image pages');
    assert.match(await gemini.locator('#output').inputValue(), /1,234\.50/);
    assert.match(await gemini.locator('#quality-summary').textContent(), /Confidence scores unavailable/);
    assert.doesNotMatch(await gemini.locator('#quality-words').textContent(), /0\/100/);
    assert.match(await gemini.locator('.privacy').textContent(), /Google/);
    assert.equal(await gemini.evaluate(() => localStorage.length + sessionStorage.length), 0);
    for (const width of [320, 390, 768, 1280]) {
      await gemini.setViewportSize({ width, height: 844 });
      assert.equal(await gemini.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    }
    await gemini.screenshot({ path: path.join(fixtures, 'gemini-desktop.png'), fullPage: true });
    await gemini.setViewportSize({ width: 390, height: 844 });
    await gemini.screenshot({ path: path.join(fixtures, 'gemini-mobile.png'), fullPage: true });
    await gemini.unroute('**/api/ocr');
    await gemini.route('**/api/ocr', route => route.fulfill({ status: 429, json: { detail: 'Gemini quota or rate limit reached. Wait and retry.' } }));
    await gemini.locator('#remove').click();
    await gemini.locator('#file-input').setInputFiles(path.join(fixtures, 'numbers.png'));
    await gemini.locator('#extract').click();
    await gemini.waitForFunction(() => !document.getElementById('extract').disabled);
    assert.match(await gemini.locator('#message').textContent(), /quota/);
    assert.equal(await gemini.locator('#output').inputValue(), '');

    // A deployed frontend must use its configured HTTPS server and send the
    // access token in a header without storing it or placing it in the URL.
    const remote = await browser.newPage();
    remote.on('pageerror', error => crashes.push(error.message));
    await remote.route('**/runtime-config.js', route => route.fulfill({
      contentType: 'application/javascript',
      body: 'window.TEXTLENS_CONFIG={backendUrl:"https://72-61-224-90.sslip.io"};'
    }));
    const cors = { 'access-control-allow-origin': new URL(url).origin,
      'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'Authorization, Content-Type' };
    await remote.route('https://72-61-224-90.sslip.io/api/health', route => route.fulfill({ headers: cors,
      json: { service: 'textlens-handwriting', available: false, requires_access_token: true,
        gemini: { available: true, configured: true } } }));
    let protectedRequests = 0;
    await remote.route('https://72-61-224-90.sslip.io/api/ocr', async route => {
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      protectedRequests++;
      assert.equal(route.request().headers().authorization, 'Bearer private-test-token');
      assert.doesNotMatch(route.request().url(), /private-test-token/);
      await route.fulfill({ headers: cors, json: { text: 'AB-00123 1,234.50', confidence: null,
        uncertain: [], words: [], notes: [], engine: 'Gemini' } });
    });
    await remote.goto(url);
    await remote.locator('#server-token').waitFor({ state: 'visible' });
    await remote.locator('#file-input').setInputFiles(path.join(fixtures, 'numbers.png'));
    await remote.locator('#extract').click();
    await remote.waitForFunction(() => !document.getElementById('extract').disabled);
    assert.match(await remote.locator('#message').textContent(), /Enter the server access token/);
    assert.equal(protectedRequests, 0);
    await remote.locator('#server-token').fill('private-test-token');
    await remote.locator('#extract').click();
    await remote.waitForFunction(() => !document.getElementById('extract').disabled);
    assert.equal(protectedRequests, 1);
    assert.match(await remote.locator('#output').inputValue(), /1,234\.50/);
    assert.equal(await remote.evaluate(() => localStorage.length + sessionStorage.length), 0);
    await remote.close();
    assert.deepEqual(crashes, []);
    console.log('Passed: fast pass count, warm worker reuse, Gemini extraction, configured HTTPS backend, token authentication, privacy, review, API failure and mobile layout.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
