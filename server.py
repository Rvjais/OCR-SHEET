"""Start the optional local server: python server.py (http://127.0.0.1:8000)."""
import argparse


def main():
    parser = argparse.ArgumentParser(description='TextLens local handwriting OCR server')
    parser.add_argument('--port', type=int, default=8000)
    parser.add_argument('--download-models', action='store_true', help='Download/load the English OCR models, then exit')
    args = parser.parse_args()
    if args.download_models:
        from backend.ocr import OCRService
        OCRService().warmup('eng')
        print('English handwriting models are ready.')
        return
    import uvicorn
    from backend.app import app
    uvicorn.run(app, host='127.0.0.1', port=args.port)


if __name__ == '__main__':
    main()
