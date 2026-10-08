"""CI container smoke test: real models, read-only disk, no network."""
from PIL import Image, ImageDraw, ImageFont
from backend.ocr import OCRService, RECOGNIZERS

service = OCRService()
with Image.new('RGB', (1100, 280), 'white') as image:
    draw = ImageDraw.Draw(image)
    font = ImageFont.load_default(size=36)
    draw.text((40, 50), 'Invoice AB-00123', font=font, fill='black')
    draw.text((40, 140), 'Total 1,234.50', font=font, fill='black')
    result = service.recognize(image, 'eng')
    assert 'AB-00123' in result['text'], result['text']
    assert '1,234.50' in result['text'], result['text']
    # Each supported language must load its bundled weights offline, too.
    for recognizer in set(RECOGNIZERS.values()):
        language = next(key for key, value in RECOGNIZERS.items() if value == recognizer)
        service.warmup(language)
assert service.health()['loaded']
print('Passed: exact invoice ID and decimal amount with real local OCR, no network.')
