"""FastAPI endpoints and the existing frontend, served on this computer."""
from io import BytesIO
from contextlib import asynccontextmanager
import logging
import os
from pathlib import Path
import secrets
import warnings

from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from PIL import Image, ImageOps, UnidentifiedImageError
from starlette.concurrency import run_in_threadpool
from starlette.middleware.trustedhost import TrustedHostMiddleware

from .ocr import OCRService, RECOGNIZERS
from .gemini import GeminiService, GeminiError
from .config import comma_separated_setting, load_server_config

load_server_config()

ROOT = Path(__file__).resolve().parent.parent
MAX_UPLOAD_BYTES = 20 * 1024 * 1024
MAX_PIXELS = 20_000_000
logger = logging.getLogger(__name__)


class UploadLimitMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope['type'] != 'http':
            return await self.app(scope, receive, send)
        headers = dict(scope.get('headers', []))
        try:
            length = int(headers.get(b'content-length', b'0'))
        except ValueError:
            return await JSONResponse({'detail': 'Invalid content length.'}, status_code=400)(scope, receive, send)
        if length > MAX_UPLOAD_BYTES + 65536:
            return await JSONResponse({'detail': 'Image upload is too large. Use an image below 20 MB.'}, status_code=413)(scope, receive, send)
        total = 0

        async def limited_receive():
            nonlocal total
            message = await receive()
            if message['type'] == 'http.request':
                total += len(message.get('body', b''))
                if total > MAX_UPLOAD_BYTES + 65536:
                    raise HTTPException(413, 'Image upload is too large. Use an image below 20 MB.')
            return message

        await self.app(scope, limited_receive, send)


def decode_image(data):
    try:
        with warnings.catch_warnings():
            warnings.simplefilter('error', Image.DecompressionBombWarning)
            with Image.open(BytesIO(data)) as source:
                if source.width * source.height > MAX_PIXELS:
                    raise HTTPException(413, 'Image dimensions are too large. Use an image below 20 megapixels.')
                if source.format not in {'PNG', 'JPEG', 'WEBP', 'BMP', 'TIFF', 'GIF'}:
                    raise HTTPException(415, 'Unsupported image format. Try PNG or JPG.')
                image = ImageOps.exif_transpose(source).convert('RGBA')
                background = Image.new('RGBA', image.size, 'white')
                background.alpha_composite(image)
                return background.convert('RGB')
    except (Image.DecompressionBombWarning, Image.DecompressionBombError):
        raise HTTPException(413, 'Image dimensions are too large.') from None
    except (UnidentifiedImageError, OSError, ValueError):
        raise HTTPException(400, 'The uploaded image is damaged or unreadable.') from None


def create_app(service=None, gemini_service=None):
    service = service or OCRService()
    gemini_service = gemini_service or GeminiService()

    @asynccontextmanager
    async def lifespan(app):
        yield
        gemini_service.close()

    app = FastAPI(title='TextLens OCR', lifespan=lifespan)
    access_token = os.environ.get('API_ACCESS_TOKEN', '').strip()
    app.state.ocr_service = service
    app.add_middleware(UploadLimitMiddleware)
    app.add_middleware(CORSMiddleware, allow_origins=comma_separated_setting('FRONTEND_ORIGINS'), allow_origin_regex=r'https?://(?:localhost|127\.0\.0\.1)(?::\d+)?', allow_methods=['GET', 'POST'], allow_headers=['Content-Type', 'Authorization'])
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=comma_separated_setting('ALLOWED_HOSTS', ['localhost', '127.0.0.1', '[::1]']))

    async def authorize_ocr(request: Request):
        if not access_token:
            return
        scheme, _, token = request.headers.get('authorization', '').partition(' ')
        if scheme.lower() != 'bearer' or not secrets.compare_digest(token.encode(), access_token.encode()):
            raise HTTPException(401, 'Enter the server access token to use this OCR server.', headers={'WWW-Authenticate': 'Bearer'})

    @app.get('/')
    @app.get('/index.html')
    async def index():
        return FileResponse(ROOT / 'index.html')

    @app.get('/extraction-utils.js')
    async def utilities():
        return FileResponse(ROOT / 'extraction-utils.js', media_type='application/javascript')

    @app.get('/runtime-config.js')
    async def runtime_config():
        return FileResponse(ROOT / 'runtime-config.js', media_type='application/javascript')

    @app.get('/api/health')
    async def health():
        return {'service': 'textlens-handwriting', **service.health(), 'gemini': gemini_service.health(),
                'requires_access_token': bool(access_token), 'version': os.environ.get('APP_VERSION', 'development')}

    @app.post('/api/ocr', dependencies=[Depends(authorize_ocr)])
    async def recognize(file: UploadFile = File(...), language: str = Form('eng'),
                        provider: str = Form('local'), api_key: str = Form(''), model: str = Form('')):
        try:
            if provider not in {'local', 'gemini'}:
                raise HTTPException(400, 'Unsupported OCR provider.')
            if language not in RECOGNIZERS:
                raise HTTPException(400, 'Unsupported text language.')
            data = await file.read(MAX_UPLOAD_BYTES + 1)
            if not data:
                raise HTTPException(400, 'The uploaded image is empty.')
            if len(data) > MAX_UPLOAD_BYTES:
                raise HTTPException(413, 'Image upload is too large. Use an image below 20 MB.')
            image = await run_in_threadpool(decode_image, data)
            del data
            try:
                if provider == 'gemini':
                    try:
                        return await run_in_threadpool(gemini_service.recognize, image, language, api_key, model)
                    except GeminiError as error:
                        raise HTTPException(error.status, str(error)) from None
                return await run_in_threadpool(service.recognize, image, language)
            except HTTPException:
                raise
            except Exception:
                if provider == 'gemini':
                    logger.error('Gemini recognition failed unexpectedly')
                    raise HTTPException(502, 'Gemini could not read this page. Retry or check your server installation.') from None
                logger.exception('Local handwriting recognition failed')
                raise HTTPException(503, 'The handwriting model could not run. Check the server terminal, installed requirements, and model download connection, then retry.') from None
            finally:
                image.close()
        finally:
            await file.close()

    return app


app = create_app()
