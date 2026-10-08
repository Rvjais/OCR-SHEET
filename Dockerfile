FROM python:3.12-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 \
    HOME=/tmp/textlens PADDLE_PDX_CACHE_HOME=/tmp/paddlex \
    PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK=True OCR_MODEL_DIR=/opt/textlens-models OCR_PRELOAD=1
WORKDIR /app
COPY requirements.txt requirements-web.txt ./
RUN apt-get update && apt-get install -y --no-install-recommends libgomp1 libglib2.0-0 libgl1 \
    && rm -rf /var/lib/apt/lists/* \
    && pip install --no-cache-dir -r requirements.txt \
    && groupadd --gid 10001 textlens \
    && useradd --uid 10001 --gid textlens --no-create-home textlens
COPY backend/ ./backend/
RUN python -m backend.download_models \
    && chmod -R a+rX /opt/textlens-models \
    && rm -rf /tmp/paddlex /tmp/textlens
COPY index.html extraction-utils.js runtime-config.js ./
ARG APP_VERSION=development
ENV APP_VERSION=$APP_VERSION
USER 10001:10001
EXPOSE 8000
HEALTHCHECK --interval=10s --timeout=5s --start-period=120s --retries=3 \
  CMD python -c "import urllib.request,json; d=json.load(urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=3)); assert d['available'] and d['loaded']"
CMD ["python", "-m", "uvicorn", "backend.app:app", "--host", "0.0.0.0", "--port", "8000", "--no-proxy-headers"]
