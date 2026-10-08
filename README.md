# TextLens

For the AlmaLinux Hostinger VPS and Vercel deployment, follow [DEPLOYMENT.md](DEPLOYMENT.md). Docker, HTTPS through the existing OpenLiteSpeed proxy and free `72-61-224-90.sslip.io` hostname, certificate renewal, and the GitHub Actions build/deploy pipeline are configured in this repository. The frontend reads its public API address from `runtime-config.js`; secrets stay on the VPS. The container enables Gemini OCR and requires a server access token.

An image and PDF text extraction prototype with browser OCR and an optional local Python handwriting backend. To use browser OCR alone, start a simple local server in this folder:

```sh
python -m http.server 8000
```

Open http://localhost:8000, upload one or more images/PDFs, choose their text language, and click **Extract**. Internet is required to download PDF.js, Tesseract.js, and OCR language data. Browser mode processes documents locally in the browser.

## Faster extraction

**Fast** is the default browser speed. Clear pages with strong word-level results use one OCR pass. Weak results still receive contrast, layout and rotation retries. Choose **Thorough** to compare original and enhanced passes on every page. Fast mode can miss errors that a second pass would expose; review identifiers and amounts in either mode.

The browser keeps one OCR worker loaded across files and extractions in the same language, releasing it after two idle minutes, on a language change, or after cancellation/failure. This avoids initializing the recognizer for every file. Backend uploads are bounded to 2400 pixels without upsampling or browser contrast analysis, and PDF pages sent to either backend are rendered at that bound directly. Local PaddleOCR inference and its first model load can still be slow on a CPU.

## Gemini OCR, including handwriting

Start the Python server, choose **Gemini API + handwriting** under **OCR provider**, enter your API key (or leave it blank when the server has one), and click **Extract**. Get a key from [Google AI Studio](https://aistudio.google.com/apikey). You can change the model ID; the default is [Gemini 3.1 Pro Preview](https://ai.google.dev/gemini-api/docs/models/gemini-3.1-pro-preview), `gemini-3.1-pro-preview`. The integration uses Google's [image input](https://ai.google.dev/gemini-api/docs/image-understanding) and [structured output](https://ai.google.dev/gemini-api/docs/structured-output) APIs.

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe server.py
```

Gemini does not need the PaddleOCR models. For a smaller Gemini-only installation, install the web dependencies instead:

```powershell
python -m pip install fastapi==0.142.2 uvicorn==0.54.0 python-multipart==0.0.32 pillow==12.3.0 httpx==0.28.1
python server.py
```

You may also set `GEMINI_API_KEY` on the server and leave the browser key field blank. The server automatically reads `GEMINI_API_KEY` and `GEMINI_MODEL` from the project's local `.env` file; copy `.env.example` to `.env` to configure them. `.env` is excluded from Git, and existing environment variables take precedence. Set `GEMINI_MODEL` to change the server default and clear the browser model field to use it. Browser-entered keys are kept only in the open page's memory, never local/session storage or files. The server sends the key in Google's API-key header, never a URL. Health checks expose whether a server key is configured, never the key itself.

Gemini mode sends each rendered page to Google, including selectable PDFs so handwritten additions are included. It may consume paid API quota. Gemini is initially selected; choose **On this computer** to use local OCR. Gemini failures, rate limits, blocked pages and incomplete outputs are shown as errors; the app does not silently switch providers. Cancel stops subsequent pages and aborts the browser request; an already submitted cloud request may finish and consume quota. The API does not provide OCR confidence scores, so Gemini results show review notes and ambiguous snippets without a numeric confidence. Review handwritten values against the preview.

## Printed invoices with handwritten values

Use the Python backend when invoice keys/labels are printed but amounts, dates, names, or other values are filled in by pen. It runs PaddleOCR locally with full-page text detection and an English recognition model that supports handwriting. It does not call a paid cloud OCR API.

On this workspace, the virtual environment and English model downloads have already been set up. Start the backend instead of `python -m http.server`:

```powershell
.\.venv\Scripts\python.exe server.py
```

Open http://127.0.0.1:8000 and enable **Read handwritten invoice values** before extraction. It supports the existing mixed image/PDF batches and page navigation. A selectable printed PDF text layer does not cause handwriting mode to skip the visible page. Printed keys and recognized pen-written values are kept together where their positions allow it; merging preserves recognized suffix values rather than replacing an entire OCR line with a shorter printed label.

For a fresh installation with Python 3.12:

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe server.py --download-models
.\.venv\Scripts\python.exe server.py
```

The English model is checked on this Windows/CPU setup. It uses PP-OCRv5's lightweight page detector and English recognizer, bounds recognition images to 2400 pixels on the longest side, and bounds detection to 1600 pixels to keep CPU inference practical. Other language choices select the appropriate Latin or Devanagari PP-OCRv5 recognition model and download its weights on first use; their handwriting accuracy has not been benchmarked here. First startup and CPU inference can be slow. The server binds to this computer (`127.0.0.1`), serves the frontend, and accepts local Live Server origins. It can use another port with `--port 8001` when the UI is opened from that server's URL.

Local handwriting and Gemini modes submit rendered page images to the Python process. Uploads are decoded in memory, do not receive permanent saved copies, and are closed after use. Framework upload spooling can temporarily use a system temp file that is removed when the upload closes. Model weights are cached under your user profile by PaddleOCR. Cancelling stops subsequent batch requests; an inference already running in Python may finish in the background.

Handwriting recognition remains fallible. Review pen-written amounts, decimal points, dates, names, and invoice IDs against the preview, including high-confidence output. This adds transcription of handwritten values; it does not yet produce a validated invoice field schema or accounting entries.

The real model preserved a sample printed invoice ID and decimal amount. A cropped English handwriting page from [PaddleOCR's public demo](https://huggingface.co/datasets/PaddlePaddle/PaddleOCR-VL_demo) produced 15 text regions in about 22 seconds on this computer after model startup, with several word-level transcription errors. This verifies that the handwriting path runs; it is not a successful accuracy benchmark or a validation of your invoices. Actual pen-written invoice samples are needed to assess whether recognition is good enough for your forms.

The file picker and drag-and-drop area accept multiple images and PDFs together. Files appear in upload order with individual statuses. Select a file, then choose a PDF page with the dropdown or arrows: the preview and editable text refer to that same page. The original preview stays beside the text on desktop and above it on mobile. Edits and selected pages are retained when switching files.

**Copy** and **Save text** export the current page. **Copy all** and **Save all** combine the batch with numbered filename and page headings, including explicit notices for failed or unprocessed pages. Identical filenames remain separate numbered files.

**Add files** preserves existing results. The extraction button processes new, failed, cancelled, or partially completed files; when everything is complete, it becomes **Re-extract all**. Re-extraction replaces the targeted files' previous text and edits. Files are processed sequentially to control OCR memory use. A failed file does not stop the remaining files. Cancelling stops the batch and retains completed files/pages; retrying restarts each unfinished file. Individual files can be removed from the list, and the top clear button clears the batch.

## Extraction behavior

- Reads selectable PDF text directly, using displayed positions to preserve lines, adjacent glyphs, numbers, and gaps between table cells.
- Checks PDFs containing raster images with OCR, including pages that also contain selectable text. Matched selectable lines replace their OCR versions; unmatched selectable text is retained in an explicit section.
- Adds a white background and border and upsamples small images for browser OCR. Fast mode retries weak results; Thorough mode always compares original and contrast-enhanced passes. Weak results receive further layout and rotation checks. Small skew is corrected through Tesseract's `rotateAuto` option.
- Retains low-confidence text and identifies uncertain words in review details. Different OCR passes can disagree; those results are flagged. Confidence is an engine score, **not the probability that the result is correct**.
- Allows cancellation, times out stalled operations, preserves completed PDF pages on failures, and releases canvas and preview resources when possible.

OCR cannot guarantee mistake-free results, including high-confidence results. Blurred images, handwriting, unusual fonts, perspective distortion, complex columns, and tables still need manual review. This prototype extracts plain text; it does not reconstruct spreadsheet/table structure. Large images and PDF pages are bounded to roughly 10 million pixels and 4096 pixels on the longest side to control memory usage, which can reduce small-text accuracy. Full-file PDF bytes and preview images still consume browser memory; very large documents are better processed in smaller parts.

## Checks

Run the dependency-free extraction regression tests:

```sh
npm test
```

For the browser tests, install the development dependencies and fixture generators, generate synthetic fixtures, start the server above, and run:

```sh
npm install
python -m pip install pillow reportlab
python tests/create-fixtures.py
npm run test:browser
npm run test:batch
npm run test:handwriting
npm run test:providers
```

Run the Python API tests (install `httpx` in the virtual environment first for FastAPI's test client):

```powershell
.\.venv\Scripts\python.exe -m pip install httpx
.\.venv\Scripts\python.exe -m unittest discover -s tests -p 'test_*.py' -v
```

Browser tests use installed Google Chrome by default. Set `TEXTLENS_BROWSER=msedge` for Edge, `TEXTLENS_URL` to change the local server URL, or `TEXTLENS_TEST_DIR` to change the fixture folder. The fixtures verify exact identifiers and decimal amounts on clear, small, skewed, rotated, transparent, dark, and low-contrast images, along with digital/scanned/mixed PDFs, editable exports, review cues, partial failures, cancellation, network recovery, and responsive layouts. These synthetic checks are regression coverage, not an accuracy benchmark for arbitrary documents.

OCR preprocessing follows [Tesseract's image quality guidance](https://tesseract-ocr.github.io/tessdoc/ImproveQuality.html) and uses the [Tesseract.js API](https://github.com/naptha/tesseract.js/blob/master/docs/api.md).
