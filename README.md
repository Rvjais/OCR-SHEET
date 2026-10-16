# TextLens — Privacy-First Image / PDF to Text 📄🔍

> Batch Image + PDF → editable text. Printed OCR runs 100% in-browser, handwriting OCR runs on your local Python backend. No external OCR API, no API key. Optional DeepSeek invoice → structured table.

![Frontend](https://img.shields.io/badge/Frontend-Vanilla_JS-yellow)
![OCR](https://img.shields.io/badge/OCR-Tesseract.js_+_PaddleOCRv5-green)
![Backend](https://img.shields.io/badge/Backend-FastAPI-blue)
![Docker](https://img.shields.io/badge/Docker-Ready-teal)
![Deploy](https://img.shields.io/badge/Deploy-Vercel_+_AlmaLinux-black)

Live: `https://ocr-sheet-topaz.vercel.app` → Backend: `https://72-61-224-90.sslip.io` (see [DEPLOYMENT.md](DEPLOYMENT.md))

## ✨ What It Does

- 📤 Batch images + PDFs, per-file pages / previews / results, add/remove, cancel-keeps-done
- 🌐 Languages: `eng, eng+hin, eng+spa, eng+fra, eng+deu`
- 🖨️ **Printed text mode:** browser Tesseract.js (Fast reuses worker / Thorough compares original+enhanced, contrast/rotation passes)
- ✍️ **Printed + handwritten mode (default):** backend PaddleOCR PP-OCRv5 (`mobile_det` + `en/latin/devanagari_rec` + orientation), 2400px bound, 2x upscale if <1280px
- 📑 Native PDF text extraction + hybrid `mergeHybrid()` keeps handwritten suffixes next to printed labels
- 📊 Quality panel: weighted confidence, `<85` flagged, `<80` uncertain words, review notes
- 💾 Export: per-page Copy/Save, Copy-all/Save-all with headings, Format-to-Table → invoice meta-cards + line-items + totals → JSON/CSV
- 🔒 Privacy: 20MB/20MP limits, in-memory decode (no persistence/logging), rate-limited public endpoint

## 🎯 Features in Detail — What it does & How it helps you

| Feature | What it does | How it helps you |
|---------|--------------|------------------|
| 📤 **Batch upload (images + PDFs)** | Queue many files, each keeps pages/preview/text, add-more keeps results, fail-one-continues, cancel-keeps-done. | Digitize 50-page ledger in one go — no one-by-one wait. |
| 🖨️ **Printed mode (in-browser)** | Tesseract.js runs locally, Fast/Thorough toggle + contrast/rotation passes. | CA/shop bills stay on your PC — zero upload, ideal for sensitive docs. |
| ✍️ **Handwriting mode (local backend)** | PaddleOCR PP-OCRv5 reads full page PNG (2400px cap, 2x upscale), Devanagari/Latin support. | Reads handwritten totals, signatures, Hindi notes that normal OCR misses. |
| 📑 **Hybrid selectable + handwritten** | Merges exact PDF text layer with OCR suffixes next to labels. | Printed invoice + pen-written phone/amount both captured — no manual re-type. |
| 📊 **Confidence + review guidance** | Weighted score, `<85` flagged, `<80` word highlight, edit box with notes. | Spot errors in seconds — accountant checks only red words, not full page. |
| 🧾 **Format to Table (DeepSeek)** | Converts raw text → seller/invoice/items/totals JSON → CSV download + meta-cards. | Paste into Tally/Excel directly — saves 15 min per invoice. |
| 💾 **Copy-all / Save-all** | Exports in upload order with filename/page headings + failed-page notices. | Client-ready text file, identical filenames kept separate — no confusion. |
| 🌐 **5 languages** | `eng, eng+hin, eng+spa, eng+fra, eng+deu` toggle, fresh extraction on change. | Hindi bills + English + EU invoices in one tool. |
| 🔒 **Privacy + limits** | In-memory decode, no logs, 20MB/20MP cap, 429 rate-limit, offline model preload. | Safe for Aadhaar/PAN scans — nothing stored, abuse blocked. |

> **Perfect OCR cannot be guaranteed.** Review handwriting, dates, IDs and amounts against preview. Confidence is an engine estimate, not correctness probability.

## 🛠️ Tech Stack

- **Frontend:** Single-file `index.html` + `extraction-utils.js` + `runtime-config.js` — vanilla JS/CSS, CDN `pdfjs-dist@6.4.299`, `tesseract.js@7.0.0`
- **Backend:** `server.py` → `uvicorn backend.app:app` (FastAPI)
  - `backend/ocr.py`: PaddleOCR, CPU, single cached set + `threading.Lock`
  - `backend/deepseek.py`: `deepseek-chat` via `httpx` → structured invoice JSON
  - `backend/config.py`: `.env` (`FRONTEND_ORIGINS, OCR_MODEL_DIR, DEEPSEEK_API_KEY...`)
  - `backend/limits.py`: per-minute/per-day/concurrent 429 + `Retry-After`
- **Deps:** `requirements-web.txt` (fastapi, uvicorn, httpx, pillow) + `requirements.txt` (+ paddlepaddle 3.3.1, paddleocr 3.7.0)
- **Deploy:** `Dockerfile` (python:3.12-slim, non-root 10001, preload EN, `/api/health`) + `deploy/` (compose, OpenLiteSpeed, GHCR → `72.61.224.90:8010`)

## 📁 Project Structure

```
OCR-SHEET/
├── index.html, extraction-utils.js, runtime-config.js
├── server.py, backend/ app.py, ocr.py, deepseek.py, config.py, limits.py
├── models/ (git-ignored weights)
├── tests/ test_backend.py, extraction.test.cjs, browser*.cjs
├── Dockerfile, deploy/, DEPLOYMENT.md
└── requirements.txt, requirements-web.txt, package.json (playwright tests)
```

## 🔌 API

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/, /api/health` | UI + health |
| `POST` | `/api/ocr {file,language,provider=local}` | Handwriting OCR |
| `POST` | `/api/structure-invoice {text}` | DeepSeek table |

## 🚀 Getting Started

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
Copy-Item .env.example .env
.\.venv\Scripts\python.exe server.py --download-models
.\.venv\Scripts\python.exe server.py
# → http://127.0.0.1:8000, --port 8001 optional

# Printed-only (no backend):
python -m http.server 8000
# select Printed text
```

```bash
# Docker
docker build -t textlens .
docker run -p 8000:8000 textlens
```

## ✅ Tests

```powershell
.\.venv\Scripts\python.exe -m unittest discover -s tests -p 'test_*.py' -v
npm test
npm run test:browser
```

GitHub Actions builds full image, checks offline recognition with network disabled + read-only FS.

## 👤 Author

**Rvjais / Veer** — TextLens. See `DEPLOYMENT.md` for Vercel + AlmaLinux setup.
