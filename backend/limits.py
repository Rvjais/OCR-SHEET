"""Bound public OCR traffic before uploads are decoded or recognized locally."""
from collections import deque
from time import monotonic

from starlette.responses import JSONResponse


class PublicOCRLimitsMiddleware:
    def __init__(self, app, per_minute=0, per_day=0, concurrent=0):
        self.app = app
        self.per_minute = per_minute
        self.per_day = per_day
        self.concurrent = concurrent
        self.minute = deque()
        self.day = deque()
        self.active = 0

    async def __call__(self, scope, receive, send):
        if scope['type'] != 'http' or scope.get('method') != 'POST' or scope.get('path') != '/api/ocr':
            return await self.app(scope, receive, send)
        now = monotonic()
        for queue, window in [(self.minute, 60), (self.day, 86400)]:
            while queue and queue[0] <= now - window:
                queue.popleft()
        if self.concurrent and self.active >= self.concurrent:
            detail, retry = 'Text recognition is busy. Wait a moment and retry.', 10
        elif self.per_minute and len(self.minute) >= self.per_minute:
            detail, retry = 'The request limit has been reached. Wait a minute and retry.', 60
        elif self.per_day and len(self.day) >= self.per_day:
            detail, retry = 'The daily extraction limit has been reached. Try again later.', 3600
        else:
            if self.per_minute:
                self.minute.append(now)
            if self.per_day:
                self.day.append(now)
            self.active += 1
            try:
                return await self.app(scope, receive, send)
            finally:
                self.active -= 1
        return await JSONResponse({'detail': detail}, status_code=429, headers={'Retry-After': str(retry)})(scope, receive, send)
