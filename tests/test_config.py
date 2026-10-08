import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from backend.config import load_server_config


class ConfigTests(unittest.TestCase):
    def test_local_settings_are_loaded_and_other_variables_are_ignored(self):
        with tempfile.TemporaryDirectory() as folder, patch.dict(os.environ, {}, clear=True):
            path = Path(folder) / '.env'
            path.write_text('# Local OCR\nOCR_CPU_THREADS=4\nOCR_MODEL_DIR="models"\nPATH=ignored\n', encoding='utf-8')
            load_server_config(path)
            self.assertEqual(os.environ['OCR_CPU_THREADS'], '4')
            self.assertEqual(os.environ['OCR_MODEL_DIR'], 'models')
            self.assertNotIn('PATH', os.environ)

    def test_existing_environment_takes_precedence_and_missing_file_is_safe(self):
        with tempfile.TemporaryDirectory() as folder, patch.dict(os.environ, {'OCR_CPU_THREADS': '2'}, clear=True):
            path = Path(folder) / '.env'
            load_server_config(path)
            path.write_text('OCR_CPU_THREADS=4\nOCR_MODEL_DIR=\n', encoding='utf-8')
            load_server_config(path)
            self.assertEqual(os.environ['OCR_CPU_THREADS'], '2')
            self.assertNotIn('OCR_MODEL_DIR', os.environ)


if __name__ == '__main__':
    unittest.main()
