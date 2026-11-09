import type { RouteRegistrar } from "../server.js";

/**
 * `/r/<path>?<query>` hands the same app path to the desktop app as
 * `mandible:///<path>?<query>`. The transform reads nothing; the desktop app
 * routes the path, including to its not-found view.
 */
export function registerDesktopHandoffRoute(router: RouteRegistrar): void {
  router.get("/r/*path", (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const html = renderHandoffPage(`mandible://${url.pathname.slice("/r".length)}${url.search}`);
    if (typeof res.html === "function") res.html(html);
    else res.json({ html });
  }, { operation: { id: "desktop.handoff", effects: [], requestSchema: null, reportingCategory: null }, fileRpc: "deny" });
}

function renderHandoffPage(target: string): string {
  const scriptTarget = JSON.stringify(target).replace(/[<>&]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Open in Mandible</title>
</head>
<body>
  <p>Opening Mandible...</p>
  <p><a href="${escapeHtml(target)}">Open in Mandible</a></p>
  <script>
    window.location.replace(${scriptTarget});
  </script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}
