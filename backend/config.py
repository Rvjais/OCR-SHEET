"""Load local server settings without exposing credentials to the frontend."""
import os
from pathlib import Path


def load_server_config(path=None):
    path = Path(path) if path is not None else Path(__file__).resolve().parent.parent / '.env'
    if not path.is_file():
        return
    for line in path.read_text(encoding='utf-8-sig').splitlines():
        name, separator, value = line.strip().partition('=')
        name = name.strip()
        if not separator or name not in {'FRONTEND_ORIGINS', 'ALLOWED_HOSTS', 'API_ACCESS_TOKEN', 'OCR_PRELOAD', 'OCR_CPU_THREADS', 'OCR_MODEL_DIR'}:
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
            value = value[1:-1]
        if value:
            os.environ.setdefault(name, value)


def comma_separated_setting(name, default=()):
    value = os.environ.get(name)
    return [item.strip() for item in value.split(',') if item.strip()] if value is not None else list(default)
