import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, expect, it } from "vitest";
import { ChatAttachmentStore } from "../src/conversation-control/attachment-store.js";
import { attachmentProviderContext, claudeAttachmentContent, codexAttachmentInput } from "../src/conversation-control/attachment-delivery.js";
import { migrate, openDb } from "../src/db.js";
import { setDb } from "../src/db.js";
import { ClientAuthenticator } from "../src/client-auth/authenticator.js";
import { setClientAuthMode } from "../src/client-auth/mode.js";
import { setupOperator } from "../src/users/store.js";
import { Router } from "../src/server.js";
import { registerConversationControlRoutes } from "../src/routes/conversation-control.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-attachments-"));
const dbPath = path.join(root, "mandible.db");
const db = openDb(dbPath);
migrate(db);

afterEach(() => {
  db.prepare("DELETE FROM chat_attachment_files").run();
  fs.rmSync(path.join(root, "chat-attachments"), { recursive: true, force: true });
});

it("retains immutable bytes and rejects binary masquerading as text or false metadata", () => {
  const store = new ChatAttachmentStore(db);
  const file = store.put({ name: "snippet.ts", media_type: "text/plain", data_base64: Buffer.from("const value = 42;\n").toString("base64") });
  expect(store.content(file).toString()).toBe("const value = 42;\n");
  expect(store.resolve([{ kind: "file", file }])).toEqual([{ kind: "file", file }]);
  expect(() => store.resolve([{ kind: "file", file: { ...file, name: "lie.ts" } }])).toThrow(/metadata/);
  expect(() => store.put({ name: "binary.txt", media_type: "text/plain", data_base64: Buffer.from([0, 1, 2]).toString("base64") })).toThrow(/UTF-8/);
  expect(() => store.put({ name: "paper.pdf", media_type: "application/pdf", data_base64: Buffer.from("%PDF").toString("base64") })).toThrow(/Unsupported/);
});

it("keeps file content out of provider prose while delivering annotation text and native image bytes", () => {
  const store = new ChatAttachmentStore(db);
  const secret = "UNREQUESTED_FILE_CONTENT";
  const file = store.put({ name: "notes.md", media_type: "text/markdown", data_base64: Buffer.from(secret).toString("base64") });
  const png = Buffer.from("89504e470d0a1a0a", "hex");
  const screenshot = store.put({ name: "screen.png", media_type: "image/png", data_base64: png.toString("base64") });
  const attachments = store.resolve([
    { kind: "file", file },
    { kind: "annotation", id: "a1", ordinal: 1, text: "Make this clearer", target: {
      url: "http://localhost:19420/#/chat", rect: { x: 1, y: 2, width: 3, height: 4 }, viewport: { width: 800, height: 600 }, element_text: "Send",
      element: "button", selector: "main > button.send", source_file: "ui/src/views/conversations.tsx",
      react_components: "ChatComposer", selected_text: "Send", css_classes: "send primary", computed_styles: "padding: 8px",
    }, screenshot },
  ]);
  const context = attachmentProviderContext("Review", attachments, dbPath);
  expect(context.text).toContain("Make this clearer");
  expect(context.text).toContain("Page URL: http://localhost:19420/#/chat");
  expect(context.text).toContain("Location: main > button.send");
  expect(context.text).toContain("React: ChatComposer");
  expect(context.text).toContain("Computed styles: padding: 8px");
  expect(context.text).toContain("Retained readable path:");
  expect(context.text).not.toContain(secret);
  expect(context.images).toHaveLength(1);
  expect(context.images[0].bytes).toEqual(png);
  const codex = codexAttachmentInput("Review", attachments, dbPath);
  expect(codex).toMatchObject([{ type: "text" }, { type: "localImage", path: context.images[0].path }]);
  expect(JSON.stringify(codex)).not.toContain(secret);
  const claude = claudeAttachmentContent("Review", attachments, dbPath);
  expect(claude).toMatchObject([{ type: "text" }, { type: "image", source: { type: "base64", media_type: "image/png", data: png.toString("base64") } }]);
  expect(JSON.stringify(claude)).not.toContain(secret);
});

it("keeps older annotation drafts valid and rejects oversized new context", () => {
  const store = new ChatAttachmentStore(db);
  const annotation = { kind: "annotation", id: "old", ordinal: 1, text: "Older feedback", target: {
    url: "/chat", rect: { x: 1, y: 2, width: 0, height: 0 }, viewport: { width: 800, height: 600 },
  } };
  expect(store.resolve([annotation])).toMatchObject([annotation]);
  expect(attachmentProviderContext("", store.resolve([annotation]), dbPath).text).toContain("Page URL: /chat");
  expect(() => store.resolve([{ ...annotation, target: { ...annotation.target, computed_styles: "x".repeat(2_001) } }]))
    .toThrow(/metadata is invalid/);
});

it("serves original upload bytes through the operator-only content route", async () => {
  setDb(db);
  const operator = setupOperator(db, { slug: "attachment-test-operator", display_name: "Operator" });
  const auth = new ClientAuthenticator(db, { secretsDir: path.join(root, "auth") });
  const { token } = auth.mintApiToken(operator.id);
  setClientAuthMode(db, "strict");
  const router = new Router({ clientAuth: auth });
  registerConversationControlRoutes(router, {} as never, { db });
  const bytes = Buffer.from("retained upload\n");
  const uploaded = await router.invoke({ method: "POST", url: "/api/chat-attachments", transport: "http", credential: token,
    body: { name: "upload.txt", media_type: "text/plain", data_base64: bytes.toString("base64") } });
  expect(uploaded.status).toBe(201);
  const file = uploaded.body as { id: string };
  const content = await router.invoke({ method: "GET", url: `/api/chat-attachments/${file.id}/content`, transport: "http", credential: token });
  expect(content.status).toBe(200);
  expect(content.body).toEqual(bytes);
  const unauthenticated = await router.invoke({ method: "GET", url: `/api/chat-attachments/${file.id}/content`, transport: "http" });
  expect(unauthenticated.status).toBe(401);
});

afterAll(() => {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});
