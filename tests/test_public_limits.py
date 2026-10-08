from io import BytesIO
import os
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient
from PIL import Image

from backend.app import create_app
from backend.limits import PublicOCRLimitsMiddleware


class FakeOCR:
    def __init__(self):
        self.calls = 0

    def health(self):
        return {'available': True}

    def recognize(self, image, language):
        self.calls += 1
        return {'text': 'AB-00123', 'confidence': 95, 'uncertain': [], 'words': [], 'notes': []}


class PublicLimitsTests(unittest.TestCase):
    def test_public_extraction_works_without_tokens_and_limits_do_not_reach_engine(self):
        service = FakeOCR()
        data = BytesIO()
        Image.new('RGB', (20, 20), 'white').save(data, 'PNG')
        with patch.dict(os.environ, {'API_ACCESS_TOKEN': '', 'PUBLIC_OCR_PER_MINUTE': '2', 'PUBLIC_OCR_PER_DAY': '3',
                                      'PUBLIC_OCR_CONCURRENT': '2', 'FRONTEND_ORIGINS': 'https://ocr-sheet-topaz.vercel.app'}):
            app = create_app(service)
        with TestClient(app, base_url='http://localhost') as client, patch('backend.limits.monotonic', return_value=100) as clock:
            def upload():
                return client.post('/api/ocr', files={'file': ('page.png', data.getvalue(), 'image/png')},
                                   headers={'Origin': 'https://ocr-sheet-topaz.vercel.app'})
            self.assertFalse(client.get('/api/health').json()['requires_access_token'])
            self.assertEqual(upload().status_code, 200)
            self.assertEqual(upload().status_code, 200)
            response = upload()
            self.assertEqual(response.status_code, 429)
            self.assertEqual(response.headers['Retry-After'], '60')
            self.assertEqual(response.headers['access-control-allow-origin'], 'https://ocr-sheet-topaz.vercel.app')
            self.assertEqual(service.calls, 2)
            self.assertEqual(client.get('/api/health').status_code, 200, 'health remains accessible at the OCR limit')
            clock.return_value = 161
            self.assertEqual(upload().status_code, 200)
            clock.return_value = 222
            self.assertIn('daily', upload().json()['detail'])
            self.assertEqual(service.calls, 3)
            clock.return_value = 86623
            self.assertEqual(upload().status_code, 200)

    def test_concurrency_limit_releases_slot_after_handler_failure(self):
        import asyncio

        async def exercise():
            entered, release = asyncio.Event(), asyncio.Event()
            calls = []
            async def app(scope, receive, send):
                entered.set()
                await release.wait()
                raise RuntimeError('Simulated failure')
            middleware = PublicOCRLimitsMiddleware(app, concurrent=1)
            scope = {'type': 'http', 'method': 'POST', 'path': '/api/ocr'}
            async def receive():
                return {'type': 'http.request', 'body': b''}
            async def send(message):
                calls.append(message)
            first = asyncio.create_task(middleware(scope, receive, send))
            await entered.wait()
            await middleware(scope, receive, send)
            self.assertEqual(calls[0]['status'], 429)
            release.set()
            with self.assertRaises(RuntimeError):
                await first
            self.assertEqual(middleware.active, 0)
        asyncio.run(exercise())
