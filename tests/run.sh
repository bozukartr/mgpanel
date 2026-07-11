#!/usr/bin/env bash
# Emülatörü başlatır (gerekirse), testleri koşar, kendi başlattıysa kapatır.
# Kullanım: bash tests/run.sh   (veya cd tests && npm test)
set -e
cd "$(dirname "$0")"
PORT="${FS_PORT:-8791}"

bash download-emulator.sh
[ -d node_modules ] || npm install --no-audit --no-fund

STARTED=0
if ! curl -s "http://127.0.0.1:$PORT/" >/dev/null 2>&1; then
  echo "Emülatör başlatılıyor (port $PORT)…"
  java -jar bin/firestore-emulator.jar --host 127.0.0.1 --port "$PORT" > emulator.log 2>&1 &
  EMU_PID=$!
  STARTED=1
  trap '[ "$STARTED" = 1 ] && kill $EMU_PID 2>/dev/null' EXIT
  for i in $(seq 1 30); do
    curl -s "http://127.0.0.1:$PORT/" >/dev/null 2>&1 && break
    sleep 1
  done
fi
curl -s "http://127.0.0.1:$PORT/" >/dev/null || { echo "Emülatör ayağa kalkmadı"; exit 1; }

# NODE_PATH: functions/rest-core.js gibi repo modülleri firebase-admin'i
# tests/node_modules'tan çözebilsin (functions/node_modules kurulu olmayabilir).
# --test-concurrency=1: dosyalar SIRALI koşar — eşzamanlılık testleri kendi
# içinde Promise.allSettled ile gerçek yarışı üretir; dosyalar arası CPU
# çekişmesi transaction yeniden-deneme bütçesini tüketip flake yaratabiliyor.
FIRESTORE_EMULATOR_HOST="127.0.0.1:$PORT" NODE_PATH="$PWD/node_modules" node --test --test-concurrency=1 ./*.test.js
