#!/usr/bin/env bash
# The API from source, reloading on every change, against the compose stack's
# built-in database (development only). The web app: `npm run dev` in web/,
# which proxies /v1 here.
#
#   backend/scripts/dev.sh            http://127.0.0.1:8000
set -euo pipefail
cd "$(dirname "$0")/../.."
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --wait db
password=$(docker compose exec -T db cat /secrets/postgres_password)
mkdir -p backend/.dev/secrets backend/.dev/backups
cd backend
export ADMIN_DATABASE_URL="postgresql://postgres:${password}@127.0.0.1:5433/postgres?sslmode=disable"
export SECRETS_DIR=.dev/secrets BACKUP_DIR=.dev/backups PORT=8000 DEV_RELOAD=1 WEB_DIR=../web/dist
exec python -m app.launch
