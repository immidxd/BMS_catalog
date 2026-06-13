#!/bin/bash
# Запуск TG Shop: backend (порт 8001) + frontend dev-сервер (порт 5173)
set -e
cd "$(dirname "$0")"

# Backend
if [ ! -d venv ]; then
  python3 -m venv venv
  ./venv/bin/pip install -r backend/requirements.txt
fi
(cd backend && ../venv/bin/uvicorn main:app --host 0.0.0.0 --port 8001 --reload) &
BACKEND_PID=$!

# Frontend
if [ ! -d frontend/node_modules ]; then
  (cd frontend && npm install)
fi
(cd frontend && npm run dev) &
FRONTEND_PID=$!

trap "kill $BACKEND_PID $FRONTEND_PID 2>/dev/null" EXIT
wait
