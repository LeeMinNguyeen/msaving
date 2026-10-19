# The `msaving` image: the API, the built web app and the daily jobs, in one.
# docker-compose.yml runs it twice: `secrets` (first start only) and `msaving`.
#   docker build -t msaving .

# The web app, built once into static files the API serves.
FROM node:22-alpine AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

FROM python:3.14-slim
# pg_dump for the backups, the same major version as the database (17).
# Debian 13 (this image's base) ships PostgreSQL 17.
RUN apt-get update \
 && apt-get install -y --no-install-recommends postgresql-client-17 \
 && rm -rf /var/lib/apt/lists/*
ENV PATH=/usr/lib/postgresql/17/bin:$PATH \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    WEB_DIR=/srv/web

WORKDIR /srv
COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY backend/app ./app
COPY backend/migrations ./migrations
COPY --from=web /web/dist ./web

# Not root. The secrets and backups volumes start from these folders, so they
# belong to this user.
RUN useradd --system --uid 10001 msaving \
 && mkdir /secrets /backups && chown msaving /secrets /backups
USER msaving

ARG MSAVING_VERSION=dev
ENV MSAVING_VERSION=$MSAVING_VERSION
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/v1/health', timeout=4)"
CMD ["python", "-m", "app.launch"]
