const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const fixtures = path.resolve(process.env.TEXTLENS_TEST_DIR || 'tests/fixtures');
const url = process.env.TEXTLENS_URL || 'http://127.0.0.1:8000';

(async () => {
  const browser = await chromium.launch({ channel: process.env.TEXTLENS_BROWSER || 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 960 } });
    const crashes = [];
    page.on('pageerror', error => crashes.push(error.message));
    let requests = 0;
    await page.route('**/api/health', route => route.fulfill({ json: { service: 'textlens-handwriting', gemini: { available: true, configured: true } } }));
    await page.route('**/api/ocr', route => {
      requests++;
      assert.match(route.request().postData() || '', /name="file"/);
      return route.fulfill({ json: {
        text: 'Invoice number: AB-00123\nTotal: 1,234.50\nDate: 12/10/2026', confidence: 88,
        words: [{ text: '1,234.50', confidence: 72 }], uncertain: [{ text: '1,234.50', confidence: 72 }],
        notes: ['Review the handwritten amount.'], engine: 'Test handwriting OCR'
      } });
    });
    await page.goto(url);
    await page.locator('#gemini-ocr').check();
    await page.locator('#file-input').setInputFiles(['invoice-labels.pdf', 'numbers.png'].map(name => path.join(fixtures, name)));
    await page.locator('#extract').click();
    await page.waitForFunction(() => !document.getElementById('extract').disabled, { timeout: 120000 });
    assert.equal(requests, 2, 'handwriting mode also reads PDF pages that contain only selectable labels');
    const text = await page.locator('#output').inputValue();
    assert.match(text, /AB-00123/);
    assert.match(text, /Total: 1,234\.50/);
    assert.match(text, /Date: 12\/10\/2026/);
    assert.equal((text.match(/Total:/g) || []).length, 1, 'printed keys do not erase or duplicate pen-written values');
    assert.match(await page.locator('#quality-words').textContent(), /1,234\.50/);
    await page.screenshot({ path: path.join(fixtures, 'handwriting-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: path.join(fixtures, 'handwriting-mobile.png'), fullPage: true });

    // An unavailable backend gives an actionable error and retains the upload.
    const unavailable = await browser.newPage();
    await unavailable.route('**/api/health', route => route.fulfill({ status: 404, json: {} }));
    await unavailable.goto(url);
    await unavailable.locator('#gemini-ocr').check();
    await unavailable.locator('#file-input').setInputFiles(path.join(fixtures, 'numbers.png'));
    await unavailable.locator('#extract').click();
    await unavailable.waitForFunction(() => !document.getElementById('extract').disabled);
    assert.match(await unavailable.locator('#message').textContent(), /Handwriting recognition is temporarily unavailable/);
    assert.doesNotMatch(await unavailable.locator('#message').textContent(), /server|Python|README/i);
    assert.equal(await unavailable.locator('.document-select').count(), 1);
    await unavailable.close();
    assert.deepEqual(crashes, []);
    console.log('Passed: optional handwriting mode, full-page PDF recognition, mixed labels/values, review flags, missing-backend recovery and mobile layout.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
