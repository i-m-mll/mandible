import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { chromium, webkit } from "playwright-core";

export async function proveDiff(resources, port) {
  const bytes = (url) => fs.statSync(path.join(resources, "ui", new URL(url).pathname)).size;
  const gateway = http.createServer((request, response) => {
    const host = `payload-proof.mandible.localhost:${port}`;
    const headers = { ...request.headers, host };
    if (headers.origin) headers.origin = `https://${host}`;
    const upstream = http.request({ host: "127.0.0.1", port, path: request.url, headers }, result => {
      response.writeHead(result.statusCode, result.headers);
      result.pipe(response);
    });
    upstream.on("error", error => response.destroy(error));
    upstream.end();
  });
  await new Promise(resolve => gateway.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${gateway.address().port}`;
  try {
    const engines = [chromium, webkit];
    const results = [];
    for (const engine of engines) {
      const browser = await engine.launch({ headless: true });
      const page = await browser.newPage({ viewport: { width: 760, height: 620 } });
      try {
        const errors = [];
        page.setDefaultTimeout(5000);
        const startedWorkers = new Set();
        page.on("pageerror", error => errors.push(error.message));
        page.on("worker", worker => startedWorkers.add(worker.url()));
        await page.addInitScript(() => {
          window.messages = [];
          window.requests = [];
          window.Worker = class extends Worker {
            postMessage(request, ...args) {
              window.requests.push(request.type);
              return super.postMessage(request, ...args);
            }
            constructor(...args) {
              super(...args);
              this.addEventListener("message", ({data}) => window.messages.push({ type: data.type, requestType: data.requestType, time: performance.now(), error: data.error }));
            }
          };
          document.addEventListener("click", event => {
            if (event.target.textContent === "Open diff") performance.mark("diff-click");
            if (event.target.textContent === "Open request") performance.mark("request-click");
          }, { capture: true });
        });
        await page.route(`${origin}/diff-verify`, route => route.fulfill({
          contentType: "text/html", body: "<!DOCTYPE html><html data-theme=light><link rel=stylesheet href=/dist/diff-proof.css><body><script type=module src=/dist/diff-proof.js></script></body></html>",
        }));
        await page.goto(`${origin}/diff-verify`);
        await page.getByRole("button", { name: "Open diff" }).waitFor();
        const initiallyLoaded = await page.evaluate(() => performance.getEntriesByType("resource").map(entry => entry.name));
        await page.getByRole("button", { name: "Open diff" }).click();
        await page.waitForFunction(() => document.querySelector("diffs-container")?.shadowRoot?.querySelector("[data-line][data-line-type=change-deletion]"));
        const firstPaint = await page.evaluate(() => performance.now() - performance.getEntriesByName("diff-click")[0].startTime);
        await page.waitForFunction(() => window.messages.some(message => message.type === "success" && message.requestType === "diff"));
        await page.waitForFunction(() => document.querySelector("diffs-container")?.shadowRoot?.querySelector("[data-line] span[style]"));
        const domInfo = await page.evaluate(() => {
          const shadow = document.querySelector("diffs-container").shadowRoot;
          const first = shadow.querySelector("[data-line][data-line-type=change-deletion]");
          return { count: shadow.querySelectorAll("[data-line]").length, lineHeight: first.clientHeight };
        });
        assert.ok(domInfo.count > 0 && domInfo.count < 1000, JSON.stringify(domInfo));
        assert.ok(domInfo.lineHeight >= 40, JSON.stringify(domInfo));
        await page.locator(".pierre-file-diff").evaluate(element => { element.scrollTop = element.scrollHeight * 0.75; });
        await page.waitForFunction(() => Array.from(document.querySelector("diffs-container").shadowRoot.querySelectorAll("[data-column-number]")).some(e => +e.dataset.columnNumber > 1000));
        const ranges = [];
        for (const [type, side] of [["change-deletion", "before"], ["change-addition", "after"]]) {
          const points = await page.evaluate((type) => {
            const frame = document.querySelector(".pierre-file-diff").getBoundingClientRect();
            return Array.from(document.querySelector("diffs-container").shadowRoot.querySelectorAll(`[data-column-number][data-line-type=${type}]`))
              .map(e => { const r = e.getBoundingClientRect(); return { line: +e.dataset.columnNumber, x: r.x + r.width / 2, y: r.y + r.height / 2 }; })
              .filter(point => point.y > frame.top + 10 && point.y < frame.bottom - 10).slice(0, 3);
          }, type);
          assert.ok(points.length >= 2, JSON.stringify(points));
          await page.mouse.move(points.at(-1).x, points.at(-1).y);
          await page.mouse.down();
          await page.mouse.move(points[0].x, points[0].y, { steps: 4 });
          await page.mouse.up();
          const expected = { side, startLine: points[0].line, endLine: points.at(-1).line };
          await page.waitForFunction(expected => document.querySelector("output").textContent === JSON.stringify(expected), expected);
          ranges.push(expected);
        }
        const marks = await page.evaluate(() => {
          const click = performance.getEntriesByName("diff-click")[0].startTime;
          return { highlightedMs: window.messages.find(message => message.type === "success" && message.requestType === "diff").time - click,
            assets: performance.getEntriesByType("resource").filter(entry => entry.startTime >= click).map(entry => entry.name) };
        });
        const lazy = [...new Set([...marks.assets, ...startedWorkers])].filter(url => url.startsWith(`${origin}/dist/`) && !initiallyLoaded.includes(url));
        const worker = lazy.find(url => url.includes("/assets/worker-portable-"));
        assert.ok(worker, JSON.stringify(lazy));
        await page.getByRole("button", { name: "Open request" }).click();
        await page.getByRole("button", { name: "src/file-399.ts", exact: true }).waitFor({ state: "attached" });
        const request = await page.getByRole("region", { name: "Large request" }).evaluate(region => ({
          files: region.querySelectorAll("button[aria-expanded=false]").length,
          expanded: region.querySelectorAll("button[aria-expanded=true]").length,
          readyMs: performance.now() - performance.getEntriesByName("request-click")[0].startTime,
        }));
        assert.equal(request.files, 400);
        assert.equal(request.expanded, 0);
        assert.deepEqual(errors, []);
        results.push({ engine: engine.name(), firstVisibleMs: firstPaint, highlightedMs: marks.highlightedMs, ...domInfo, ranges,
          lazyMainThreadBytes: lazy.filter(url => url !== worker).reduce((sum, url) => sum + bytes(url), 0), workerBytes: bytes(worker), request });
      } catch (error) {
        console.error(engine.name(), await page.evaluate(() => ({ messages: window.messages, requests: window.requests, result: document.querySelector("output")?.textContent })));
        throw error;
      } finally {
        await browser.close();
      }
    }
    console.log(JSON.stringify({ diffProof: results }));
  } finally {
    gateway.close();
  }
}
