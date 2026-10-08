import base64
from io import BytesIO
import json
import os
import unittest
from unittest.mock import patch

import httpx
from fastapi.testclient import TestClient
from PIL import Image

from backend.app import create_app
from backend.gemini import GeminiError, GeminiService


def answer(text='Total: 1,234.50\nInvoice AB-00123', finish='STOP'):
    return {'candidates': [{'finishReason': finish, 'content': {'parts': [
        {'text': json.dumps({'text': text, 'uncertain': ['1,234.50']})}
    ]}}]}


class GeminiTests(unittest.TestCase):
    def service(self, handler):
        client = httpx.Client(transport=httpx.MockTransport(handler))
        self.addCleanup(client.close)
        return GeminiService(client)

    def test_transcription_request_and_honest_review_details(self):
        def handle(request):
            self.assertNotIn('secret', str(request.url))
            self.assertEqual(request.headers['x-goog-api-key'], 'secret')
            payload = json.loads(request.content)
            self.assertIn('handwritten', payload['systemInstruction']['parts'][0]['text'])
            self.assertIn('Hindi', payload['contents'][0]['parts'][0]['text'])
            image = payload['contents'][0]['parts'][1]['inlineData']
            with Image.open(BytesIO(base64.b64decode(image['data']))) as page:
                self.assertLessEqual(max(page.size), 2400)
            return httpx.Response(200, json=answer())
        service = self.service(handle)
        with Image.new('RGB', (3000, 1500), 'white') as page:
            result = service.recognize(page, 'eng+hin', 'secret')
        self.assertIn('1,234.50', result['text'])
        self.assertIsNone(result['confidence'])
        self.assertIsNone(result['uncertain'][0]['confidence'])

    def test_missing_key_invalid_model_and_provider(self):
        def unexpected(request):
            self.fail('Invalid inputs must not call Google')
        service = self.service(unexpected)
        with Image.new('RGB', (100, 100)) as page, patch.dict(os.environ, {'GEMINI_API_KEY': ''}):
            for key, model in [('', ''), ('secret', '../../evil'), ('bad\nkey', '')]:
                with self.assertRaises(GeminiError) as error:
                    service.recognize(page, 'eng', key, model)
                self.assertEqual(error.exception.status, 400)
        with TestClient(create_app(gemini_service=service), base_url='http://localhost') as client:
            response = client.post('/api/ocr', files={'file': ('x.png', b'x')}, data={'provider': 'unknown'})
            self.assertEqual(response.status_code, 400)

    def test_server_credentials_and_model(self):
        def handle(request):
            self.assertEqual(request.headers['x-goog-api-key'], 'server-secret')
            self.assertIn('gemini-test-model', str(request.url))
            return httpx.Response(200, json=answer(''))
        service = self.service(handle)
        with patch.dict(os.environ, {'GEMINI_API_KEY': 'server-secret', 'GEMINI_MODEL': 'gemini-test-model'}):
            self.assertTrue(service.health()['configured'])
            with Image.new('RGB', (10, 10)) as page:
                self.assertEqual(service.recognize(page, 'eng')['text'], '')

    def test_errors_are_actionable_and_never_echo_upstream_secrets(self):
        for status in [400, 401, 403, 404, 429, 500]:
            service = self.service(lambda request, status=status: httpx.Response(status, text='secret and private page'))
            with Image.new('RGB', (10, 10)) as page, self.assertRaises(GeminiError) as error:
                service.recognize(page, 'eng', 'secret')
            self.assertNotIn('secret', str(error.exception))
            self.assertNotIn('private page', str(error.exception))
        for data in [{}, answer(finish='MAX_TOKENS'), answer(finish='SAFETY'), {'candidates': [{'finishReason': 'STOP'}]}]:
            service = self.service(lambda request, data=data: httpx.Response(200, json=data))
            with Image.new('RGB', (10, 10)) as page, self.assertRaises(GeminiError):
                service.recognize(page, 'eng', 'secret')

    def test_timeout(self):
        def timeout(request):
            raise httpx.ReadTimeout('secret', request=request)
        with Image.new('RGB', (10, 10)) as page, self.assertRaises(GeminiError) as error:
            self.service(timeout).recognize(page, 'eng', 'secret')
        self.assertEqual(error.exception.status, 504)

    def test_api_routes_gemini_without_loading_local_models(self):
        service = self.service(lambda request: httpx.Response(200, json=answer()))
        class Local:
            def health(self):
                return {'available': False, 'loaded': False}
            def recognize(self, *args):
                raise AssertionError('Gemini must not use PaddleOCR')
        with TestClient(create_app(Local(), service), base_url='http://localhost') as client:
            self.assertTrue(client.get('/api/health').json()['gemini']['available'])
            output = BytesIO()
            Image.new('RGB', (100, 100), 'white').save(output, 'PNG')
            response = client.post('/api/ocr', files={'file': ('page.png', output.getvalue(), 'image/png')},
                                   data={'provider': 'gemini', 'api_key': 'secret'})
            self.assertEqual(response.status_code, 200)
            self.assertIn('1,234.50', response.json()['text'])
            response = client.post('/api/ocr', files={'file': ('page.png', b'broken', 'image/png')}, data={'provider': 'gemini', 'api_key': 'secret'})
            self.assertEqual(response.status_code, 400)


if __name__ == '__main__':
    unittest.main()
