#!/usr/bin/env bash
# deploy/ci-build.sh — выполняется на раннере GitHub Actions перед упаковкой релиза (см. .github/workflows/vps.yml).
# Собирает сервер на Go в один статический файл backend/kotiki-server под Linux amd64:
# на VPS тогда не нужен Go. Если Go на раннере нет, сборку сделает deploy/remote-build.sh на сервере.
set -euo pipefail

cd backend
if ! command -v go >/dev/null 2>&1; then
  echo "Go на раннере нет — сервер соберётся на VPS (deploy/remote-build.sh)"
  exit 0
fi
export GOTOOLCHAIN=auto   # если на раннере Go старше, чем в go.mod, нужная версия скачается сама
go version
go vet ./...
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o kotiki-server .
ls -la kotiki-server
echo "✓ backend/kotiki-server собран"
