#!/bin/sh
# Bug: 88a4472 — create minimal dist/ for tauri production build
# The Mandible app shell redirects to the live daemon at localhost:19420.
# dist/ is gitignored (it's the normal TS build output dir), so we generate it here.
set -e
mkdir -p dist
cat > dist/index.html << 'HTMLEOF'
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta http-equiv="refresh" content="0;url=http://localhost:19420">
  <title>Mandible</title>
</head>
<body>
  <script>window.location.replace("http://localhost:19420");</script>
</body>
</html>
HTMLEOF
echo "dist/index.html generated"
