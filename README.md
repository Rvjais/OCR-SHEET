# TextLens

A browser-only image and PDF text extraction prototype. Start a local server in this folder:

```sh
python -m http.server 8000
```

Open http://localhost:8000, upload one or more images/PDFs, choose their text language, and click **Extract**. Internet is required to download PDF.js, Tesseract.js, and OCR language data. Documents are processed locally in the browser.

The file picker and drag-and-drop area accept multiple images and PDFs together. Files appear in upload order with individual statuses. Select a file, then choose a PDF page with the dropdown or arrows: the preview and editable text refer to that same page. The original preview stays beside the text on desktop and above it on mobile. Edits and selected pages are retained when switching files.

**Copy** and **Save text** export the current page. **Copy all** and **Save all** combine the batch with numbered filename and page headings, including explicit notices for failed or unprocessed pages. Identical filenames remain separate numbered files.

**Add files** preserves existing results. The extraction button processes new, failed, cancelled, or partially completed files; when everything is complete, it becomes **Re-extract all**. Re-extraction replaces the targeted files' previous text and edits. Files are processed sequentially to control OCR memory use. A failed file does not stop the remaining files. Cancelling stops the batch and retains completed files/pages; retrying restarts each unfinished file. Individual files can be removed from the list, and the top clear button clears the batch.

## Extraction behavior

- Reads selectable PDF text directly, using displayed positions to preserve lines, adjacent glyphs, numbers, and gaps between table cells.
- Checks PDFs containing raster images with OCR, including pages that also contain selectable text. Matched selectable lines replace their OCR versions; unmatched selectable text is retained in an explicit section.
- Adds a white background and border, upsamples small images, and compares original and contrast-enhanced OCR passes. Weak results receive further layout and rotation checks. Small skew is corrected through Tesseract's `rotateAuto` option.
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
```

Browser tests use installed Google Chrome by default. Set `TEXTLENS_BROWSER=msedge` for Edge, `TEXTLENS_URL` to change the local server URL, or `TEXTLENS_TEST_DIR` to change the fixture folder. The fixtures verify exact identifiers and decimal amounts on clear, small, skewed, rotated, transparent, dark, and low-contrast images, along with digital/scanned/mixed PDFs, editable exports, review cues, partial failures, cancellation, network recovery, and responsive layouts. These synthetic checks are regression coverage, not an accuracy benchmark for arbitrary documents.

OCR preprocessing follows [Tesseract's image quality guidance](https://tesseract-ocr.github.io/tessdoc/ImproveQuality.html) and uses the [Tesseract.js API](https://github.com/naptha/tesseract.js/blob/master/docs/api.md).
