# TextLens

Text extraction for images and PDFs, with printed-text recognition in the browser and local handwriting recognition in the Python backend. Recognition never calls an external AI/OCR API and needs no API key. For the existing Vercel frontend and AlmaLinux deployment, see [DEPLOYMENT.md](DEPLOYMENT.md).

## Recognition modes

Choose one of the two tick boxes:

- **Printed text** runs Tesseract in your browser. Your documents stay on your computer. Fast mode reuses the worker and skips extra passes on strong results; Thorough compares original and enhanced images. Weak results receive contrast, layout and rotation checks.
- **Printed + handwritten text** uses PaddleOCR on your own backend. It reads the whole visible page, including handwritten additions on selectable PDFs. Images are uploaded as PNG where possible to preserve faint strokes, bounded to 2400 pixels. Small scans are enlarged by at most 2x for recognition. The English recognizer is trained to support handwriting; Spanish, French and German use the Latin recognizer, and Hindi uses the Devanagari recognizer.

Handwriting mode is selected initially. Only one mode can be active. Both modes preserve low-confidence text and show review guidance; extraction does not silently change modes after a failure.

**Perfect OCR cannot be guaranteed.** Review handwriting, punctuation, dates, IDs and amounts against the preview, including high-confidence results. Blurred strokes, overwriting and low-resolution images remain ambiguous. Use the original scan/photo rather than a screenshot where possible. Results are editable plain text; this app does not validate accounting values or reconstruct spreadsheet tables.

## Local setup (Python 3.12)

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe server.py --download-models
.\.venv\Scripts\python.exe server.py
```

Open http://127.0.0.1:8000. Downloading public model weights is a one-time installation step; it sends no documents. Weights go into the Git-ignored `models/` directory. Copy `.env.example` to `.env` to customize the model directory and CPU threads. Missing installed models cause a clear error rather than a network download during recognition. Docker installs all supported weights into the image and preloads English before serving requests.

For browser printed OCR alone, use `python -m http.server 8000` and select **Printed text**. Internet access is needed to load PDF.js, Tesseract.js and language files from their CDNs; those asset downloads contain no uploaded documents.

The backend binds to `127.0.0.1` locally and supports local Live Server origins. Use `--port 8001` if needed. The Vercel frontend discovers the HTTPS backend through `runtime-config.js`. Users do not enter tokens, keys or model names. Operator health is available at `/api/health`; the product does not show deployment controls.

## Performance and accuracy

The English path uses `PP-OCRv5_mobile_det` with `en_PP-OCRv5_mobile_rec`, document orientation and text-line orientation. A single cached model set and an inference lock bound memory and CPU use. Changing to a different recognizer reloads that set. The browser also reuses one printed OCR worker across extractions, releasing it after two idle minutes or a language change.

The supplied 517x633 invoice was tested with the actual local models. Enlarging it 2x retained the customer phone number, amount `20800`, amount in words and both tax amounts `1586.52`; the native-resolution pass missed a tax decimal and a character in the email address. The handwriting date separators and parts of the item description still need correction. A PP-OCRv6 medium comparison was slower and misread the handwritten customer name, so it was not selected. These checks cover one invoice, not arbitrary handwriting or other languages. CPU inference can still take tens of seconds per page; this is not a handwriting speed guarantee.

The [official English model documentation](https://www.paddleocr.ai/main/en/version3.x/module_usage/text_recognition.html) describes the recognizer's handwriting support. Confidence is an engine estimate, not the probability that the result is correct.

## Files, review and export

Upload multiple images and PDFs together. Each file retains its own pages, preview and editable results. Select a file and page to review the matching source. **Add files** keeps existing results; completed batches can be re-extracted. A failed file does not stop the remaining files. Cancel keeps completed pages and stops later requests; an inference already running on the backend may finish.

**Copy** and **Save text** export the current page. **Copy all** and **Save all** export files in upload order with filename/page headings and notices for failed or unprocessed pages. Identical filenames remain separate entries.

Selectable PDF text is read using its displayed positions. Mixed PDFs combine visible OCR with exact selectable text while retaining recognized handwritten suffixes next to printed labels. Handwriting mode always reads the visible page, even when it has a text layer.

Uploads are decoded in memory and are not saved permanently. Upload spooling may briefly use a temporary file, removed when the upload closes. No document images or transcriptions are logged. The public hosted endpoint has configurable global rate and concurrency limits; see the deployment guide.

## Checks

```powershell
.\.venv\Scripts\python.exe -m unittest discover -s tests -p 'test_*.py' -v
npm test
```

For browser regression checks, start the Python server above, then:

```sh
npm install
python -m pip install pillow reportlab
python tests/create-fixtures.py
npm run test:browser
npm run test:batch
npm run test:handwriting
npm run test:providers
```

Browser tests use installed Chrome. Set `TEXTLENS_BROWSER=msedge`, `TEXTLENS_URL` or `TEXTLENS_TEST_DIR` to change the browser, app URL or fixture directory. Synthetic tests cover identifiers, decimal amounts, PDFs, mixed handwriting results, editing/export, cancellation and responsive layout; they are regression tests, not a handwriting accuracy benchmark.

GitHub Actions builds the full image, checks real recognition with network disabled and a read-only filesystem, and verifies that every supported language's bundled model loads offline. Deployment requires a healthy container, loaded models and the expected commit version before promoting the release.
