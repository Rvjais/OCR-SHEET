"""Fetch public model weights during installation, never using document data."""
import os
import shutil
from pathlib import Path


def main():
    os.environ.setdefault('PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK', 'True')
    os.environ.setdefault('PADDLE_PDX_MODEL_SOURCE', 'BOS')
    from paddlex.inference.utils.official_models import official_models
    from .ocr import DETECTOR, RECOGNIZERS, ORIENTATION_MODELS

    destination = Path(os.environ.get('OCR_MODEL_DIR', '').strip() or Path(__file__).resolve().parent.parent / 'models').resolve()
    destination.mkdir(parents=True, exist_ok=True)
    for name in sorted({DETECTOR, *RECOGNIZERS.values(), *ORIENTATION_MODELS.values()}):
        source = Path(official_models[name])
        if source.resolve() != (destination / name).resolve():
            shutil.copytree(source, destination / name, dirs_exist_ok=True)
        print(f'Ready: {name}', flush=True)


if __name__ == '__main__':
    main()
