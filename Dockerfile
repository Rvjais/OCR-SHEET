FROM python:3.12-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
WORKDIR /app
COPY requirements-gemini.txt ./
RUN pip install --no-cache-dir -r requirements-gemini.txt \
    && groupadd --gid 10001 textlens \
    && useradd --uid 10001 --gid textlens --no-create-home textlens
COPY backend/ ./backend/
COPY index.html extraction-utils.js runtime-config.js ./
ARG APP_VERSION=development
ENV APP_VERSION=$APP_VERSION
USER 10001:10001
EXPOSE 8000
HEALTHCHECK --interval=10s --timeout=5s --start-period=15s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=3)"
CMD ["python", "-m", "uvicorn", "backend.app:app", "--host", "0.0.0.0", "--port", "8000", "--no-proxy-headers"]
