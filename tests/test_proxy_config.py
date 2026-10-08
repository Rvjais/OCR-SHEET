import unittest
import importlib.util
from pathlib import Path

spec = importlib.util.spec_from_file_location('proxy_config', Path(__file__).resolve().parents[1] / 'deploy' / 'configure-openlitespeed.py')
proxy_config = importlib.util.module_from_spec(spec)
spec.loader.exec_module(proxy_config)
add_mappings, vhost_config = proxy_config.add_mappings, proxy_config.vhost_config


class ProxyConfigTests(unittest.TestCase):
    def test_existing_websites_survive_and_tls_maps_are_added_only_when_ready(self):
        existing = '''listener Default{
  map existing existing.example
  address *:80
  secure 0
}
listener SSL {
  map existing existing.example
  address *:443
  secure 1
  keyFile /existing/key
}
'''
        http = add_mappings(existing)
        self.assertEqual(http.count('map textlens_ocr'), 1)
        self.assertEqual(http.count('map existing existing.example'), 2)
        self.assertEqual(add_mappings(http), http)
        tls = add_mappings(http, True)
        self.assertEqual(tls.count('map textlens_ocr'), 2)
        self.assertIn('keyFile /existing/key', tls)
        self.assertEqual(add_mappings(tls, True), tls)
        self.assertEqual(tls.count('virtualhost textlens_ocr'), 1)

    def test_no_http_listener_or_unbalanced_config_is_rejected(self):
        for config in ['listener X {address *:443}', 'listener Default {']:
            with self.assertRaises(ValueError):
                add_mappings(config)

    def test_acme_files_and_backend_are_separate_from_credentials(self):
        config = vhost_config(True)
        self.assertIn('address 127.0.0.1:8010', config)
        self.assertIn('/var/www/textlens/html/.well-known/acme-challenge/', config)
        self.assertNotIn('/opt/textlens/.env', config)
        self.assertIn('vhssl {', config)
