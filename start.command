#!/bin/bash
# Подвійний клік у Finder → піднімає каталог (backend :8001 + frontend :5173)
# і сам відкриває його в браузері. Закрити — Ctrl+C або просто закрити вікно.
cd "$(dirname "$0")"

# Відкриваємо браузер, щойно frontend підніметься (чекаємо порт 5173)
(
  for _ in $(seq 1 60); do
    if curl -s -o /dev/null http://localhost:5173; then
      open http://localhost:5173
      break
    fi
    sleep 1
  done
) &

# Запуск backend + frontend (вся логіка в run.sh)
./run.sh
