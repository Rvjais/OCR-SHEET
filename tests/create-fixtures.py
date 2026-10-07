"""Create synthetic OCR regression documents; requires Pillow and reportlab."""
import os
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
from reportlab.pdfgen import canvas

target = Path(os.environ.get('TEXTLENS_TEST_DIR', 'tests/fixtures'))
target.mkdir(parents=True, exist_ok=True)
font_path = 'C:/Windows/Fonts/arial.ttf' if os.name == 'nt' else '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'


def sample(name, background, color, size=(1400, 500), font_size=48):
    image = Image.new('RGB', size, background)
    draw = ImageDraw.Draw(image)
    font = ImageFont.truetype(font_path, font_size)
    draw.text((45, 60), 'Invoice AB-00123', fill=color, font=font)
    draw.text((45, 145), 'Total 1,234.50', fill=color, font=font)
    draw.text((45, 230), 'Reference ZX/2026/007', fill=color, font=font)
    image.save(target / name)
    return image


original = sample('numbers.png', 'white', 'black')
original.rotate(90, expand=True).save(target / 'rotated-90.png')
original.rotate(180, expand=True).save(target / 'rotated-180.png')
original.rotate(270, expand=True).save(target / 'rotated-270.png')
original.rotate(5, expand=True, fillcolor='white').save(target / 'skewed.png')
original.resize((700, 250)).save(target / 'small.png')
sample('low-contrast.png', (210, 210, 210), (160, 160, 160))
sample('dark.png', (20, 20, 20), (240, 240, 240))
transparent = original.convert('RGBA')
pixels = transparent.load()
for y in range(transparent.height):
    for x in range(transparent.width):
        if pixels[x, y][:3] == (255, 255, 255):
            pixels[x, y] = (255, 255, 255, 0)
transparent.save(target / 'transparent.png')
Image.new('RGB', (350, 200), 'white').save(target / 'blank.png')
(target / 'corrupt.png').write_bytes(b'not a real image')

c = canvas.Canvas(str(target / 'mixed.pdf'))
c.setFont('Helvetica', 18)
c.drawString(40, 750, 'Selectable header: ACCOUNT-007')
c.drawImage(str(target / 'numbers.png'), 40, 460, width=500, height=179)
c.save()

c = canvas.Canvas(str(target / 'exact.pdf'))
c.setFont('Helvetica', 16)
c.drawString(40, 750, 'Reference: AB-00123')
c.drawString(40, 720, 'Total: 1,234.50')
c.drawString(40, 690, 'Code: ZX/2026/007')
c.save()

c = canvas.Canvas(str(target / 'scanned.pdf'), pagesize=(700, 250))
c.drawImage(str(target / 'numbers.png'), 0, 0, width=700, height=250)
c.save()

c = canvas.Canvas(str(target / 'scanned-two-pages.pdf'), pagesize=(700, 250))
for _ in range(2):
    c.drawImage(str(target / 'numbers.png'), 0, 0, width=700, height=250)
    c.showPage()
c.save()

c = canvas.Canvas(str(target / 'pages.pdf'))
for label, code in [('FIRST', 'PAGE-00111'), ('SECOND', 'PAGE-00222')]:
    c.setFont('Helvetica', 20)
    c.drawString(40, 750, f'{label} page {code}')
    c.showPage()
c.save()

other = Image.new('RGB', (1200, 400), 'white')
ImageDraw.Draw(other).text((50, 100), 'Second photo PHOTO-007', fill='black', font=ImageFont.truetype(font_path, 50))
other.save(target / 'other.png')

c = canvas.Canvas(str(target / 'locked.pdf'), encrypt='secret')
c.drawString(40, 750, 'Protected document')
c.save()
(target / 'broken.pdf').write_bytes(b'not a PDF')
print(f'Fixtures generated in {target.resolve()}')
