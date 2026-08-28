#!/usr/bin/env bash
# Build wa-daemon for both shipping targets, pure-Go (CGO_ENABLED=0).
#
# No C toolchain is required for either target: the SQLite driver is
# modernc.org/sqlite (pure Go), so the Windows binary cross-compiles from
# any machine with only Go installed. That is the whole reason the driver
# was chosen; do not reintroduce a cgo dependency without also
# reintroducing a mingw-w64 toolchain story.
#
# Usage: ./build.sh            vet + test + build both targets into dist/
#        ./build.sh --skip-tests   build only
set -euo pipefail
cd "$(dirname "$0")"

VERSION="$(git describe --tags --always --dirty 2>/dev/null || echo dev)"
LDFLAGS="-s -w -X main.version=${VERSION}"

if [[ "${1:-}" != "--skip-tests" ]]; then
  echo "== go vet =="
  go vet ./...
  echo "== go test (CGO_ENABLED=0) =="
  CGO_ENABLED=0 go test ./...
fi

mkdir -p dist

echo "== build darwin-arm64 =="
CGO_ENABLED=0 GOOS=darwin GOARCH=arm64 \
  go build -trimpath -ldflags "${LDFLAGS}" -o dist/wa-daemon-darwin-arm64 .

echo "== build windows-amd64 =="
CGO_ENABLED=0 GOOS=windows GOARCH=amd64 \
  go build -trimpath -ldflags "${LDFLAGS}" -o dist/wa-daemon-windows-amd64.exe .

echo "== artifacts =="
ls -la dist/
file dist/wa-daemon-darwin-arm64 dist/wa-daemon-windows-amd64.exe
