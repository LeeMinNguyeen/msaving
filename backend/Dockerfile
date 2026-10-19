# One image for the API and the jobs; Cloud Run sets the command per service/job:
#   API:     (default CMD)
#   jobs:    python -m app.jobs.fx_update | app.jobs.account_deletion | app.jobs.backup
FROM python:3.14-slim

# pg_dump for the backup job, same major version as the Supabase server (17).
# Debian 13 (this image's base) ships PostgreSQL 17.
RUN apt-get update \
 && apt-get install -y --no-install-recommends postgresql-client-17 \
 && rm -rf /var/lib/apt/lists/*
ENV PATH=/usr/lib/postgresql/17/bin:$PATH \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /srv
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app ./app

RUN useradd --system --uid 10001 msaving
USER msaving

# Cloud Run sets PORT (8080 by default).
CMD ["sh", "-c", "exec uvicorn app.api.main:app --host 0.0.0.0 --port ${PORT:-8080} --proxy-headers"]
