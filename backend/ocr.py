"""Local full-page OCR for invoices with printed labels and pen-written values."""
from collections.abc import Mapping
import importlib.util
import math
import os
import threading


RECOGNIZERS = {
    'eng': 'en_PP-OCRv5_mobile_rec',
    'eng+spa': 'latin_PP-OCRv5_mobile_rec',
    'eng+fra': 'latin_PP-OCRv5_mobile_rec',
    'eng+deu': 'latin_PP-OCRv5_mobile_rec',
    'eng+hin': 'devanagari_PP-OCRv5_mobile_rec',
}


def normalize_prediction(prediction):
    """Keep every recognized region, including low-confidence pen-written values."""
    if not isinstance(prediction, Mapping):
        prediction = prediction.json
    if 'res' in prediction:
        prediction = prediction['res']
    texts = prediction.get('rec_texts', [])
    scores = prediction.get('rec_scores', [])
    boxes = prediction.get('rec_boxes', [])
    regions = []
    for index, value in enumerate(texts):
        text = str(value).strip()
        if not text:
            continue
        score = float(scores[index]) if index < len(scores) else 0.0
        score = min(1.0, max(0.0, score)) if math.isfinite(score) else 0.0
        box = [float(x) for x in boxes[index]] if index < len(boxes) else [0, float(index * 20), 100, float(index * 20 + 16)]
        if len(box) != 4 or not all(math.isfinite(x) for x in box):
            box = [0, float(index * 20), 100, float(index * 20 + 16)]
        regions.append({'text': text, 'confidence': round(score * 100, 2), 'box': box})
    # Spatial grouping keeps a printed key beside the handwritten value even
    # when detection emits those regions in a different order.
    regions.sort(key=lambda region: ((region['box'][1] + region['box'][3]) / 2, region['box'][0]))
    rows = []
    for region in regions:
        box = region['box']
        center = (box[1] + box[3]) / 2
        height = max(1, box[3] - box[1])
        if rows and abs(rows[-1]['center'] - center) <= max(3, min(rows[-1]['height'], height) * .55):
            rows[-1]['regions'].append(region)
        else:
            rows.append({'center': center, 'height': height, 'regions': [region]})
    lines = []
    for row in rows:
        row['regions'].sort(key=lambda region: region['box'][0])
        text = ''
        previous = None
        for region in row['regions']:
            if previous:
                gap = region['box'][0] - previous['box'][2]
                text += '\t' if gap > row['height'] * 3 else ' '
            text += region['text']
            previous = region
        lines.append(text)
    weight = sum(len(region['text']) for region in regions)
    confidence = sum(region['confidence'] * len(region['text']) for region in regions) / weight if weight else 0
    return {
        'text': '\n'.join(lines), 'confidence': round(confidence, 2),
        'words': [{'text': region['text'], 'confidence': region['confidence']} for region in regions],
        'uncertain': [{'text': region['text'], 'confidence': region['confidence']} for region in regions if region['confidence'] < 85],
        'regions': regions,
        'notes': ['Handwritten invoice values need review against the original, especially amounts, dates, and IDs.'],
        'engine': 'PaddleOCR PP-OCRv5', 'confidence_unit': 'region',
    }


class OCRService:
    def __init__(self):
        self._engine = None
        self._recognizer = None
        self._lock = threading.Lock()

    def health(self):
        return {
            'available': importlib.util.find_spec('paddleocr') is not None and importlib.util.find_spec('paddle') is not None,
            'loaded': self._engine is not None,
            'languages': list(RECOGNIZERS),
        }

    def _load(self, language):
        recognizer = RECOGNIZERS[language]
        if self._engine is None or self._recognizer != recognizer:
            from paddleocr import PaddleOCR
            # Keep one model set in memory. Model weights download on first use;
            # uploaded documents are passed as arrays and are never saved.
            self._engine = None
            self._engine = PaddleOCR(
                text_detection_model_name='PP-OCRv5_mobile_det',
                text_recognition_model_name=recognizer,
                use_doc_orientation_classify=True,
                use_doc_unwarping=False,
                use_textline_orientation=True,
                textline_orientation_batch_size=4,
                text_recognition_batch_size=4,
                device='cpu', cpu_threads=min(4, os.cpu_count() or 1),
                enable_mkldnn=False,
            )
            self._recognizer = recognizer
        return self._engine

    def warmup(self, language='eng'):
        with self._lock:
            self._load(language)

    def recognize(self, image, language):
        if language not in RECOGNIZERS:
            raise ValueError('Unsupported text language.')
        with self._lock:
            import numpy as np
            engine = self._load(language)
            # PaddleOCR expects BGR arrays. Low confidence must not remove a
            # handwritten value; it is retained and flagged instead.
            resized = image.copy()
            resized.thumbnail((2400, 2400))
            try:
                pixels = np.ascontiguousarray(np.asarray(resized)[:, :, ::-1])
                predictions = list(engine.predict(pixels, text_rec_score_thresh=0.0, text_det_limit_side_len=1600, text_det_limit_type='max'))
            finally:
                resized.close()
            if not predictions:
                return normalize_prediction({})
            result = normalize_prediction(predictions[0])
            if max(image.size) > 2400:
                result['notes'].append('This page was resized for CPU inference. Review small handwritten values.')
            return result
