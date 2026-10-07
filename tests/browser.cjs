// Run against a local HTTP server with TEXTLENS_URL and TEXTLENS_TEST_DIR if needed.
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

    async function extract(name) {
      if (await page.locator('#file-row').isVisible()) await page.locator('#remove').click();
      await page.locator('#file-input').setInputFiles(path.join(fixtures, name));
      await page.locator('#extract').click();
      await page.waitForFunction(() => !document.getElementById('extract').disabled, { timeout: 180000 });
      const text = await page.locator('#output').inputValue();
      const status = await page.locator('#message').textContent();
      console.log(name, JSON.stringify({ text, status }));
      return { text, status };
    }

    for (const name of ['numbers.png', 'small.png', 'low-contrast.png', 'dark.png', 'transparent.png', 'rotated-90.png', 'rotated-180.png', 'rotated-270.png', 'skewed.png', 'scanned.pdf', 'mixed.pdf', 'exact.pdf']) {
      const { text } = await extract(name);
      assert.match(text, /AB-00123/, `${name}: invoice identifier`);
      assert.match(text, /1,234\.50/, `${name}: exact amount`);
      assert.match(text, /ZX\/2026\/007/, `${name}: reference code`);
      if (name === 'mixed.pdf') assert.match(text, /ACCOUNT-007/, 'selectable header is retained along with the scan');
      assert.equal(await page.locator('#output').getAttribute('readonly'), null);
    }
    const original = await page.locator('#output').inputValue();
    const edited = `${original}\nReviewed correction: 00042`;
    await page.locator('#output').fill(edited);
    await page.locator('#copy').click();
    assert.equal((await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, '\n'), edited);
    const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#download').click()]);
    const exported = await fs.readFile(await download.path(), 'utf8');
    assert.equal(exported, edited);
    for (const width of [320, 390, 768, 1280]) {
      await page.setViewportSize({ width, height: 844 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    }
    await page.screenshot({ path: path.join(fixtures, 'review-mobile.png'), fullPage: true });

    assert.match((await extract('locked.pdf')).status, /password-protected/);
    assert.match((await extract('broken.pdf')).status, /damaged or invalid/);
    assert.match((await extract('corrupt.png')).status, /format cannot be read/);
    assert.equal((await extract('blank.png')).text, '');

    // A delayed library load must be cancellable, and a later retry must succeed.
    const cancelPage = await context.newPage();
    await cancelPage.route('**/tesseract.min.js', async route => { await new Promise(resolve => setTimeout(resolve, 2500)); await route.continue().catch(() => {}); });
    await cancelPage.goto(url);
    await cancelPage.locator('#file-input').setInputFiles(path.join(fixtures, 'numbers.png'));
    await cancelPage.locator('#extract').click();
    await cancelPage.locator('#cancel').click();
    await cancelPage.waitForFunction(() => !document.getElementById('extract').disabled);
    assert.match(await cancelPage.locator('#message').textContent(), /cancelled/);
    await cancelPage.locator('#extract').click();
    await cancelPage.waitForFunction(() => !document.getElementById('extract').disabled, { timeout: 180000 });
    assert.match(await cancelPage.locator('#output').inputValue(), /AB-00123/);
    await cancelPage.close();

    const offline = await context.newPage();
    await offline.route('**/tesseract.min.js', route => route.abort());
    await offline.goto(url);
    await offline.locator('#file-input').setInputFiles(path.join(fixtures, 'numbers.png'));
    await offline.locator('#extract').click();
    await offline.waitForFunction(() => !document.getElementById('extract').disabled);
    assert.match(await offline.locator('#message').textContent(), /internet connection/);
    await offline.unroute('**/tesseract.min.js');
    await offline.locator('#extract').click();
    await offline.waitForFunction(() => !document.getElementById('extract').disabled, { timeout: 180000 });
    assert.match(await offline.locator('#output').inputValue(), /AB-00123/);
    await offline.close();

    // Deterministic engine fault injection checks review cues and partial results.
    const review = await context.newPage();
    await review.goto(url);
    await review.evaluate(() => {
      window.Tesseract = {
        PSM: { AUTO: '3' },
        createWorker: async () => ({
          setParameters: async () => {}, terminate: async () => {},
          recognize: async () => ({ data: {
            text: 'Uncertain name AB-00123', confidence: 65,
            blocks: [{ paragraphs: [{ lines: [{ words: [{ text: 'Uncertain', confidence: 60 }, { text: 'name', confidence: 68 }, { text: 'AB-00123', confidence: 72 }] }] }] }]
          } })
        })
      };
    });
    await review.locator('#file-input').setInputFiles(path.join(fixtures, 'numbers.png'));
    await review.locator('#extract').click();
    await review.waitForFunction(() => !document.getElementById('extract').disabled);
    assert.match(await review.locator('#quality-title').textContent(), /needs review/);
    assert.match(await review.locator('#quality-words').textContent(), /AB-00123/);
    assert.match(await review.locator('#output').inputValue(), /AB-00123/);
    await review.setViewportSize({ width: 390, height: 844 });
    assert.equal(await review.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await review.screenshot({ path: path.join(fixtures, 'uncertain-mobile.png'), fullPage: true });
    await review.close();

    const partial = await context.newPage();
    await partial.goto(url);
    await partial.evaluate(() => {
      window.Tesseract = {
        PSM: { AUTO: '3' },
        createWorker: async (_lang, _mode, options) => {
          let calls = 0;
          return {
            setParameters: async () => {}, terminate: async () => {},
            recognize: async () => {
              if (++calls === 3) { options.errorHandler('Simulated second-page failure'); throw new Error('Simulated second-page failure'); }
              return { data: { text: 'Completed page AB-00123', confidence: 97, blocks: [{ paragraphs: [{ lines: [{ words: [{ text: 'Completed', confidence: 97 }, { text: 'page', confidence: 97 }, { text: 'AB-00123', confidence: 97 }] }] }] }] } };
            }
          };
        }
      };
    });
    await partial.locator('#file-input').setInputFiles(path.join(fixtures, 'scanned-two-pages.pdf'));
    await partial.locator('#extract').click();
    await partial.waitForFunction(() => !document.getElementById('extract').disabled);
    assert.match(await partial.locator('#output').inputValue(), /Completed page AB-00123/);
    assert.match(await partial.locator('#message').textContent(), /completed pages is still shown/);
    assert.equal(await partial.locator('#copy').isEnabled(), true);
    await partial.close();
    assert.deepEqual(crashes, []);
    console.log('All OCR, mixed PDF, editable export, responsive, cancellation and recovery checks passed.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
