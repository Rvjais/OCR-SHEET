from io import BytesIO
import os
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient
from PIL import Image

from backend.app import create_app


class FakeOCR:
    def health(self):
        return {'available': True, 'loaded': True}

    def recognize(self, image, language):
        return {'text': 'test', 'confidence': 95, 'uncertain': [], 'words': [], 'notes': []}


class DeploymentTests(unittest.TestCase):
    def client(self):
        with patch.dict(os.environ, {
            'FRONTEND_ORIGINS': 'https://ocr-sheet-topaz.vercel.app',
            'ALLOWED_HOSTS': '72-61-224-90.sslip.io,localhost,127.0.0.1',
            'API_ACCESS_TOKEN': 'private-test-token',
        }):
            return TestClient(create_app(FakeOCR()), base_url='https://72-61-224-90.sslip.io')

    def test_vercel_can_send_authorization_but_other_origins_are_rejected(self):
        with self.client() as client:
            headers = {'Origin': 'https://ocr-sheet-topaz.vercel.app',
                       'Access-Control-Request-Method': 'POST',
                       'Access-Control-Request-Headers': 'Authorization, Content-Type'}
            response = client.options('/api/ocr', headers=headers)
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.headers['access-control-allow-origin'], headers['Origin'])
            headers['Origin'] = 'https://unrelated.vercel.app'
            self.assertEqual(client.options('/api/ocr', headers=headers).status_code, 400)

    def test_host_is_checked_and_health_never_leaks_access_token(self):
        with self.client() as client:
            response = client.get('/api/health')
            self.assertEqual(response.status_code, 200)
            self.assertTrue(response.json()['requires_access_token'])
            with patch.dict(os.environ, {'APP_VERSION': 'test-revision'}):
                self.assertEqual(client.get('/api/health').json()['version'], 'test-revision')
            self.assertNotIn('private-test-token', response.text)
            self.assertEqual(client.get('/api/health', headers={'Host': 'attacker.example'}).status_code, 400)

    def test_unauthorized_upload_does_not_reach_ocr_and_correct_token_works(self):
        data = BytesIO()
        Image.new('RGB', (20, 20), 'white').save(data, 'PNG')
        with self.client() as client:
            for headers in [{}, {'Authorization': 'Bearer wrong'}, {'Authorization': 'Basic private-test-token'}]:
                response = client.post('/api/ocr', files={'file': ('page.png', data.getvalue(), 'image/png')}, headers=headers)
                self.assertEqual(response.status_code, 401)
            response = client.post('/api/ocr', files={'file': ('page.png', data.getvalue(), 'image/png')},
                                   headers={'Authorization': 'Bearer private-test-token', 'Origin': 'https://ocr-sheet-topaz.vercel.app'})
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json()['text'], 'test')
            self.assertEqual(response.headers['access-control-allow-origin'], 'https://ocr-sheet-topaz.vercel.app')
