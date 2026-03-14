#!/bin/sh
# Bug: 88a4472 — create desktop bootstrap assets for Tauri builds.
# dist/ is gitignored (it's also the TS output dir), so copy the local shell page here.
set -e
mkdir -p dist
cp src-tauri/bootstrap/index.html dist/index.html
cp src-tauri/bootstrap/bootstrap.css dist/bootstrap.css
cp src-tauri/bootstrap/bootstrap.js dist/bootstrap.js
echo "desktop bootstrap assets generated"
