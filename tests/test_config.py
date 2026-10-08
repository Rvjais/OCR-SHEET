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
            path.write_text('# Server only\nGEMINI_API_KEY=test-key\nGEMINI_MODEL="gemini-3.1-pro-preview"\nPATH=ignored\n', encoding='utf-8')
            load_server_config(path)
            self.assertEqual(os.environ['GEMINI_API_KEY'], 'test-key')
            self.assertNotIn('GEMINI_MODEL', os.environ, 'model selection belongs to the codebase')
            self.assertNotIn('PATH', os.environ)

    def test_existing_environment_takes_precedence_and_missing_file_is_safe(self):
        with tempfile.TemporaryDirectory() as folder, patch.dict(os.environ, {'GEMINI_API_KEY': 'existing'}, clear=True):
            path = Path(folder) / '.env'
            load_server_config(path)
            path.write_text('GEMINI_API_KEY=from-file\nGEMINI_MODEL=\n', encoding='utf-8')
            load_server_config(path)
            self.assertEqual(os.environ['GEMINI_API_KEY'], 'existing')
            self.assertNotIn('GEMINI_MODEL', os.environ)


if __name__ == '__main__':
    unittest.main()
