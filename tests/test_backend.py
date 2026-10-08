from io import BytesIO
import os
import tempfile
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient
from PIL import Image

from backend.app import create_app
from backend.ocr import OCRService, normalize_prediction


class FakeService:
    def __init__(self):
        self.calls = []

    def health(self):
        return {'available': True, 'loaded': True, 'languages': ['eng']}

    def recognize(self, image, language):
        self.calls.append((image.mode, image.getpixel((0, 0)), language))
        return normalize_prediction({
            'rec_texts': ['1,234.50', 'Total:', 'Invoice number:', 'AB-00123'],
            'rec_scores': [.62, .99, .99, .75],
            'rec_boxes': [[230, 70, 340, 90], [10, 70, 90, 90], [10, 10, 160, 30], [180, 10, 280, 30]],
        })


def image_bytes():
    output = BytesIO()
    Image.new('RGBA', (200, 100), (0, 0, 0, 0)).save(output, format='PNG')
    return output.getvalue()


class BackendTests(unittest.TestCase):
    def setUp(self):
        self.service = FakeService()
        self.client = TestClient(create_app(self.service), base_url='http://localhost')

    def test_local_frontend_and_health(self):
        self.assertEqual(self.client.get('/').status_code, 200)
        self.assertEqual(self.client.get('/extraction-utils.js').status_code, 200)
        self.assertEqual(self.client.get('/api/health').json()['service'], 'textlens-handwriting')
        self.assertEqual(self.client.get('/requirements.txt').status_code, 404)

    def test_printed_keys_and_handwritten_values_are_paired_and_retained(self):
        response = self.client.post('/api/ocr', files={'file': ('page.png', image_bytes(), 'image/png')}, data={'language': 'eng'})
        self.assertEqual(response.status_code, 200)
        result = response.json()
        self.assertEqual(result['text'], 'Invoice number: AB-00123\nTotal:\t1,234.50')
        self.assertEqual([item['text'] for item in result['uncertain']], ['AB-00123', '1,234.50'])
        self.assertEqual(self.service.calls, [('RGB', (255, 255, 255), 'eng')])

    def test_invalid_and_empty_images_do_not_reach_the_model(self):
        for data in [b'', b'not an image']:
            response = self.client.post('/api/ocr', files={'file': ('bad.png', data, 'image/png')})
            self.assertEqual(response.status_code, 400)
        self.assertEqual(self.service.calls, [])

    def test_unsupported_language_is_rejected(self):
        response = self.client.post('/api/ocr', files={'file': ('page.png', image_bytes(), 'image/png')}, data={'language': 'unknown'})
        self.assertEqual(response.status_code, 400)

    def test_only_local_recognition_is_accepted(self):
        response = self.client.post('/api/ocr', files={'file': ('page.png', image_bytes(), 'image/png')}, data={'provider': 'cloud'})
        self.assertEqual(response.status_code, 400)
        self.assertEqual(self.service.calls, [])
        self.assertNotIn('api_key', self.client.get('/openapi.json').text)

    def test_missing_installed_models_fail_before_any_model_download(self):
        with tempfile.TemporaryDirectory() as folder, patch.dict(os.environ, {'OCR_MODEL_DIR': folder}):
            with self.assertRaisesRegex(RuntimeError, 'Missing installed OCR model'):
                OCRService().warmup()

    def test_small_scans_preserve_color_and_are_bounded_when_enlarged(self):
        class Engine:
            def predict(self, pixels, **options):
                self.shape = pixels.shape
                self.pixel = pixels[0, 0].tolist()
                return [{'rec_texts': ['1586.52'], 'rec_scores': [.8]}]
        engine = Engine()
        with patch.object(OCRService, '_load', return_value=engine), Image.new('RGB', (517, 633), (50, 70, 250)) as image:
            result = OCRService().recognize(image, 'eng')
        self.assertEqual(engine.shape[:2], (1266, 1034))
        self.assertEqual(engine.pixel, [250, 70, 50])
        self.assertEqual(result['text'], '1586.52')
        self.assertEqual(result['uncertain'][0]['text'], '1586.52')

    def test_upload_and_pixel_limits(self):
        with patch('backend.app.MAX_UPLOAD_BYTES', 20):
            response = self.client.post('/api/ocr', files={'file': ('page.png', image_bytes(), 'image/png')})
            self.assertEqual(response.status_code, 413)
        with patch('backend.app.MAX_PIXELS', 100):
            response = self.client.post('/api/ocr', files={'file': ('page.png', image_bytes(), 'image/png')})
            self.assertEqual(response.status_code, 413)

    def test_model_failure_is_actionable_and_does_not_return_fake_text(self):
        with patch.object(self.service, 'recognize', side_effect=RuntimeError('Test model failure')):
            with self.assertLogs('backend.app', level='ERROR'):
                response = self.client.post('/api/ocr', files={'file': ('page.png', image_bytes(), 'image/png')})
        self.assertEqual(response.status_code, 503)
        self.assertIn('temporarily unavailable', response.json()['detail'])
        self.assertNotIn('text', response.json())

    def test_local_live_server_cors(self):
        response = self.client.options('/api/ocr', headers={'Origin': 'http://127.0.0.1:5500', 'Access-Control-Request-Method': 'POST'})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers['access-control-allow-origin'], 'http://127.0.0.1:5500')

    def test_non_finite_scores_are_safe_and_blank_detection_stays_blank(self):
        result = normalize_prediction({'rec_texts': ['00123'], 'rec_scores': [float('nan')]})
        self.assertEqual(result['confidence'], 0)
        self.assertEqual(result['text'], '00123')
        self.assertEqual(normalize_prediction({})['text'], '')

    def test_large_color_pages_are_bounded_without_dropping_the_value(self):
        class Engine:
            def predict(self, pixels, **options):
                self.shape = pixels.shape
                self.pixel = pixels[0, 0].tolist()
                return [{'rec_texts': ['1,234.50'], 'rec_scores': [.92], 'rec_boxes': [[0, 0, 100, 20]]}]
        engine = Engine()
        service = OCRService()
        with patch.object(service, '_load', return_value=engine):
            with Image.new('RGB', (3000, 1200), (250, 40, 70)) as image:
                result = service.recognize(image, 'eng')
        self.assertLessEqual(max(engine.shape[:2]), 2400)
        self.assertEqual(engine.pixel, [70, 40, 250])
        self.assertEqual(result['text'], '1,234.50')
        self.assertTrue(any('resized' in note for note in result['notes']))


if __name__ == '__main__':
    unittest.main()
