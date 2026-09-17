// Client-authentication routes:
//   POST /api/client-auth/pairing/*   approve and redeem browser-bound pairing
//   POST /api/client-auth/renew       renew the current opaque browser session
//   POST /api/client-auth/logout      revoke the current browser session family
//   POST /api/client-auth/session-token  exchange an agent PAT for a session-scoped token
//   GET  /api/client-auth/whoami      effective client identity for this request (read)
//   POST /api/users/:ref/tokens       mint an api_token (self or operator)
//   GET  /api/users/:ref/tokens       list a user's api_token credentials (self or operator)
//
// Token revocation reuses the guarded credential-revoke route in routes/users.ts.
// Management routes require an authenticated identity. Pairing starts and
// completes through a browser-held HttpOnly secret and an explicit operator
// approval; no reusable browser credential is exposed to renderer code.

import { getDb } from "../db.js";
import type { ClientAuthenticator } from "../client-auth/authenticator.js";
import {
  ClientAuthzError,
  requireIdentity,
  requireOperator,
  requireSelfOrOperator,
} from "../client-auth/authz.js";
import { serialize } from "cookie";
import { COOKIE_NAME, PAIRING_COOKIE_NAME, TRANSFER_COOKIE_NAME } from "../client-auth/session-authority.js";
import { validateLegacyBrowserState } from "../client-auth/legacy-browser-state.js";
import type { IssuedBrowserSession } from "../client-auth/session-authority.js";
import {
  getOperator,
  getUserById,
  listCredentials,
  resolveUserOrThrow,
  UserRegistryError,
} from "../users/store.js";
import type { ResponseLike, RouteRegistrar } from "../server.js";
import { bodyRecord, sendJson } from "./http.js";
function optionalString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === "string" ? value : undefined;
}

function cookieOptions(maxAge: number) {
  return {
    secure: true,
    httpOnly: true,
    sameSite: "lax" as const,
    path: "/",
    maxAge,
  };
}

function setSessionCookie(res: ResponseLike, token: string, absoluteExpiresAt: number): void {
  const maxAge = Math.max(0, Math.floor((absoluteExpiresAt - Date.now()) / 1_000));
  res.header?.("Set-Cookie", serialize(COOKIE_NAME, token, cookieOptions(maxAge)));
}

function clearSessionCookie(res: ResponseLike): void {
  res.header?.("Set-Cookie", serialize(COOKIE_NAME, "", cookieOptions(0)));
}

function setTransferCookie(res: ResponseLike, secret: string): void {
  res.header?.("Set-Cookie", serialize(TRANSFER_COOKIE_NAME, secret, cookieOptions(300)));
}

function setSessionAndClearTransferCookies(
  res: ResponseLike,
  token: string,
  absoluteExpiresAt: number,
): void {
  const maxAge = Math.max(0, Math.floor((absoluteExpiresAt - Date.now()) / 1_000));
  res.header?.("Set-Cookie", [
    serialize(COOKIE_NAME, token, cookieOptions(maxAge)),
    serialize(TRANSFER_COOKIE_NAME, "", cookieOptions(0)),
  ]);
}

function requestBody(req: { body: unknown }): Record<string, unknown> {
  if (typeof req.body !== "string") return bodyRecord(req as never);
  return Object.fromEntries(new URLSearchParams(req.body));
}

function htmlEscape(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]!);
}

function migrationPreparedPage(showBrowserApprovals: boolean): string {
  const approvals = showBrowserApprovals
    ? '<p><a href="/api/client-auth/recovery/requests">Review browser connection requests</a> in the desktop app if a Codex browser needs reconnecting.</p>'
    : '';
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'"><title>Mandible migration prepared</title><main style="font:16px system-ui;max-width:42rem;margin:4rem auto"><h1>Browser session prepared</h1><p id="verification" role="status">Checking this browser's new session…</p><p>Mandible will restore this browser's saved view state when the final secure address opens.</p>${approvals}<p>If the new HTTPS page cannot load, <a href="mandible://connections/setup">open the macOS setup action</a> in the installed Mandible app. It is a one-time setup for secure local connections on this Mac account; this browser page cannot install trust.</p></main><script>fetch('/api/client-auth/legacy-conversion/verify',{credentials:'same-origin'}).then(response=>{document.getElementById('verification').textContent=response.ok?'This browser is connected. The final address can now restore its saved view.':'This browser could not verify its new session. Keep this page open and retry.'}).catch(()=>{document.getElementById('verification').textContent='Session verification is temporarily unavailable. Keep this page open and retry.'})</script>`;
}

function migrationOrigin(authenticator: ClientAuthenticator, targetAudience: string): string {
  const target = authenticator.instanceRegistration(targetAudience);
  if (!target) throw new Error("The migration target is not registered.");
  const configured = process.env.MANDIBLE_LEGACY_MIGRATION_ORIGIN
    ?? `${new URL(target.public_origin).protocol}//${new URL(target.public_origin).hostname}:19419`;
  const parsed = new URL(configured);
  const targetUrl = new URL(target.public_origin);
  if (parsed.protocol !== "https:" || parsed.hostname !== targetUrl.hostname || !parsed.port
      || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("Legacy migration origin must be exact HTTPS on the target hostname.");
  }
  return parsed.origin;
}

function publicSession(session: IssuedBrowserSession): Record<string, unknown> {
  return {
    family_id: session.family_id,
    audience: session.audience,
    csrf_token: session.csrf_token,
    effect_ceiling: session.effect_ceiling,
    expires_at: session.expires_at,
    absolute_expires_at: session.absolute_expires_at,
  };
}

function handleError(res: ResponseLike, error: unknown): void {
  if (error instanceof ClientAuthzError) {
    sendJson(res, error.status, { error: error.message, code: error.code });
    return;
  }
  if (error instanceof UserRegistryError) {
    const status = error.code === "not_found" ? 404 : error.code === "conflict" ? 409 : 400;
    sendJson(res, status, { error: error.message, code: error.code });
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  sendJson(res, 400, { error: message });
}

export function registerClientAuthRoutes(
  router: RouteRegistrar,
  authenticator: ClientAuthenticator,
): void {
  router.get("/api/client-auth/preview-bootstrap", (req, res) => {
    try {
      const target = req.target_instance_id;
      const preview = target ? authenticator.instanceRegistration(target) : null;
      if (!preview || preview.role !== "preview") {
        sendJson(res, 404, { error: "preview_not_registered" });
        return;
      }
      res.html?.(`<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; connect-src 'self'"><title>Opening Mandible preview</title><main>Opening preview…</main><script>(async()=>{const return_path=location.pathname+location.search+location.hash;const response=await fetch('/api/client-auth/preview-transfer/prepare',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({return_path})});if(!response.ok)throw new Error('preview bootstrap failed');const body=await response.json();location.replace(body.authorize_url)})().catch(()=>{document.querySelector('main').textContent='Could not open this preview.'})</script>`);
    } catch (error) {
      handleError(res, error);
    }
  }, { fileRpc: "deny", countUnattributed: false });

  router.post("/api/client-auth/preview-transfer/prepare", (req, res) => {
    try {
      const target = req.target_instance_id;
      const production = authenticator.productionRegistration();
      if (!target || !production) throw new Error("A registered preview target is required.");
      const body = requestBody(req);
      const transfer = authenticator.beginPreviewTransfer(
        target,
        optionalString(body, "return_path") ?? "/",
      );
      setTransferCookie(res, transfer.secret);
      sendJson(res, 201, {
        reference: transfer.reference,
        expires_at: transfer.expires_at,
        authorize_url: `${production.public_origin}/api/client-auth/preview-transfer/authorize?reference=${encodeURIComponent(transfer.reference)}`,
      });
    } catch (error) {
      handleError(res, error);
    }
  }, { fileRpc: "deny", countUnattributed: false });

  router.get("/api/client-auth/preview-transfer/authorize", (req, res) => {
    try {
      const identity = req.client_identity;
      if (!identity || identity.source !== "browser_cookie") {
        sendJson(res, 401, { error: "production_browser_session_required" });
        return;
      }
      const reference = req.query?.reference?.trim();
      if (!reference) throw new Error("Preview transfer reference is required.");
      const preview = authenticator.authorizePreviewTransfer(reference, identity);
      const action = `${preview.public_origin}/api/client-auth/preview-transfer/complete`;
      res.html?.(`<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; form-action ${htmlEscape(preview.public_origin)}"><title>Opening Mandible preview</title><form method="post" action="${htmlEscape(action)}"><input type="hidden" name="reference" value="${htmlEscape(reference)}"></form><script>document.forms[0].submit()</script>`);
    } catch (error) {
      handleError(res, error);
    }
  }, { fileRpc: "deny", countUnattributed: false });

  router.post("/api/client-auth/preview-transfer/complete", (req, res) => {
    try {
      const reference = optionalString(requestBody(req), "reference")?.trim();
      const secret = req.browser_transfer_secret;
      if (!reference || !secret) {
        sendJson(res, 401, { error: "preview_transfer_secret_required" });
        return;
      }
      const session = authenticator.completePreviewTransfer(reference, secret);
      const returnPath = authenticator.previewTransferReturnPath(reference);
      if (!session || !returnPath || session.audience !== req.target_instance_id) {
        sendJson(res, 409, { error: "preview_transfer_invalid" });
        return;
      }
      setSessionAndClearTransferCookies(res, session.token, session.absolute_expires_at);
      res.header?.("Location", returnPath);
      res.status(303).empty?.();
    } catch (error) {
      handleError(res, error);
    }
  }, { fileRpc: "deny", countUnattributed: false });

  router.post("/api/client-auth/legacy-conversion/prepare", (req, res) => {
    try {
      const identity = req.client_identity;
      const raw = req.legacy_browser_credential;
      const legacyOrigin = req.legacy_browser_origin;
      const targetAudience = req.target_instance_id;
      if (!identity || identity.source !== "legacy_browser_conversion" || !raw || !legacyOrigin
          || !targetAudience) {
        sendJson(res, 401, { error: "legacy_browser_session_required" });
        return;
      }
      const body = requestBody(req);
      const conversion = authenticator.beginLegacyConversion(
        identity,
        raw,
        optionalString(body, "return_path") ?? "/",
        validateLegacyBrowserState(body.browser_state),
        legacyOrigin,
        targetAudience,
      );
      sendJson(res, 201, {
        reference: conversion.reference,
        secret: conversion.secret,
        complete_url: `${migrationOrigin(authenticator, conversion.target_audience)}/api/client-auth/legacy-conversion/complete`,
        expires_at: conversion.expires_at,
      });
    } catch (error) {
      handleError(res, error);
    }
  }, { fileRpc: "deny", countUnattributed: false });

  router.post("/api/client-auth/legacy-conversion/complete", (req, res) => {
    try {
      const body = requestBody(req);
      const reference = optionalString(body, "reference")?.trim();
      const secret = optionalString(body, "secret")?.trim();
      if (!reference || !secret) {
        sendJson(res, 401, { error: "legacy_conversion_proof_required" });
        return;
      }
      const session = authenticator.completeLegacyConversion(reference, secret);
      if (!session || session.audience !== req.target_instance_id) {
        sendJson(res, 409, { error: "legacy_conversion_invalid" });
        return;
      }
      setSessionCookie(res, session.token, session.absolute_expires_at);
      res.status(303);
      res.header?.("Location", "/api/client-auth/legacy-conversion/prepared");
      res.header?.("Cache-Control", "no-store");
      res.empty?.();
    } catch (error) {
      handleError(res, error);
    }
  }, { fileRpc: "deny", countUnattributed: false });

  router.get("/api/client-auth/legacy-conversion/prepared", (req, res) => {
    const identity = req.client_identity;
    if (!identity || identity.source !== "browser_cookie" || !authenticator.legacyConversionDetails(identity)) {
      sendJson(res, 401, { error: "replacement_browser_session_required" });
      return;
    }
    res.html?.(migrationPreparedPage(
      typeof identity.audience === "string"
        && authenticator.instanceRegistration(identity.audience)?.role === "main",
    ));
  }, { fileRpc: "deny", countUnattributed: false });

  router.get("/api/client-auth/legacy-conversion/verify", (req, res) => {
    const identity = req.client_identity;
    if (!identity || identity.source !== "browser_cookie" || !authenticator.legacyConversionDetails(identity)) {
      sendJson(res, 401, { verified: false });
      return;
    }
    sendJson(res, 200, { verified: true, audience: identity.audience });
  }, { fileRpc: "deny", countUnattributed: false });

  router.get("/api/client-auth/legacy-conversion/state", (req, res) => {
    const identity = req.client_identity;
    if (!identity || identity.source !== "browser_cookie") {
      sendJson(res, 401, { error: "replacement_browser_session_required" });
      return;
    }
    const details = authenticator.legacyConversionDetails(identity);
    sendJson(res, 200, {
      pending: Boolean(details && !details.finalized),
      finalized: details?.finalized ?? false,
      browser_state: details?.browser_state ?? null,
      return_path: details?.return_path ?? null,
      target_origin: identity.audience
        ? authenticator.instanceRegistration(identity.audience)?.public_origin ?? null
        : null,
    });
  }, { fileRpc: "deny", countUnattributed: false });

  router.post("/api/client-auth/legacy-conversion/finalize", (req, res) => {
    try {
      const identity = req.client_identity;
      if (!identity || identity.source !== "browser_cookie") {
        sendJson(res, 401, { error: "replacement_browser_session_required" });
        return;
      }
      if (!authenticator.finalizeLegacyConversion(identity)) {
        sendJson(res, 409, { error: "legacy_conversion_not_pending" });
        return;
      }
      sendJson(res, 200, { finalized: true });
    } catch (error) {
      handleError(res, error);
    }
  }, { fileRpc: "deny", countUnattributed: false });

  router.get("/api/client-auth/forward-auth", async (req, res) => {
    try {
      const identity = req.client_identity;
      const target = req.target_instance_id;
      if (!identity || identity.source !== "browser_cookie" || !target) {
        sendJson(res, 401, { error: "preview_session_required" });
        return;
      }
      const context = await authenticator.signPreviewContext(identity, target);
      res.header?.("X-Mandible-Session-Context", context);
      res.status(204).empty?.();
    } catch (error) {
      handleError(res, error);
    }
  }, { fileRpc: "deny", countUnattributed: false });

  router.post("/api/client-auth/native-enrollment", (req, res) => {
    try {
      const db = getDb();
      const identity = requireOperator(db, req);
      const operator = getOperator(db);
      if (!operator) {
        sendJson(res, 409, {
          error: "operator_not_configured",
          code: "operator_not_configured",
          hint: "Run `mandible user setup` to create the local operator first.",
        });
        return;
      }
      const session = authenticator.issueBrowserSession(identity, authenticator.instanceId());
      setSessionCookie(res, session.token, session.absolute_expires_at);
      sendJson(res, 200, {
        session: publicSession(session),
        user: { id: operator.id, slug: operator.slug },
      });
    } catch (error) {
      handleError(res, error);
    }
  }, { fileRpc: "deny", countUnattributed: false });

  router.post("/api/client-auth/pairing/start", (req, res) => {
    try {
      if (req.client_identity) {
        sendJson(res, 403, { error: "browser_access_requires_unbound_profile" });
        return;
      }
      const body = bodyRecord(req);
      const audience = req.target_instance_id ?? authenticator.instanceId();
      const pairing = authenticator.beginPairing(audience, optionalString(body, "return_path") ?? "/");
      res.header?.("Set-Cookie", serialize(PAIRING_COOKIE_NAME, pairing.secret, cookieOptions(600)));
      sendJson(res, 201, {
        reference: pairing.reference,
        audience: pairing.audience,
        return_path: pairing.return_path,
        expires_at: pairing.expires_at,
      });
    } catch (error) {
      handleError(res, error);
    }
  }, { fileRpc: "deny", countUnattributed: false });

  router.post("/api/client-auth/pairing/approve", (req, res) => {
    try {
      const identity = requireOperator(getDb(), req);
      const reference = (optionalString(bodyRecord(req), "reference") ?? "").trim();
      if (!reference) throw new UserRegistryError("invalid", "reference is required.");
      authenticator.approvePairing(reference, identity.user_id);
      sendJson(res, 200, { approved: true, reference });
    } catch (error) {
      handleError(res, error);
    }
  }, { fileRpc: "allow", countUnattributed: false });

  router.post("/api/client-auth/pairing/complete", (req, res) => {
    try {
      const reference = (optionalString(bodyRecord(req), "reference") ?? "").trim();
      const secret = req.browser_pairing_secret;
      if (!reference || !secret) {
        sendJson(res, 401, { error: "pairing_secret_required" });
        return;
      }
      const session = authenticator.completePairing(reference, secret);
      if (!session) {
        sendJson(res, 409, { error: "pairing_not_approved" });
        return;
      }
      setSessionCookie(res, session.token, session.absolute_expires_at);
      sendJson(res, 200, { session: publicSession(session) });
    } catch (error) {
      handleError(res, error);
    }
  }, { fileRpc: "deny", countUnattributed: false });

  router.post("/api/client-auth/recovery/start", (req, res) => {
    try {
      if (process.env.MANDIBLE_LEGACY_CONVERSION !== "allow" || !req.legacy_browser_origin || !req.target_instance_id) {
        sendJson(res, 403, { error: "invalid_browser_recovery_ingress" });
        return;
      }
      const source = authenticator.instanceRegistration(req.target_instance_id);
      if (!source || (new URL(req.legacy_browser_origin).port === "19421") !== (source.role === "preview")) {
        sendJson(res, 403, { error: "invalid_browser_recovery_source" });
        return;
      }
      const body = requestBody(req);
      const rawState = optionalString(body, "browser_state");
      if (!rawState) throw new Error("Saved browser state is required for recovery.");
      const state = validateLegacyBrowserState(JSON.parse(rawState));
      const recovery = authenticator.beginBrowserRecovery(
        source.instance_id, optionalString(body, "return_path") ?? "/", state,
      );
      res.header?.("Set-Cookie", serialize(PAIRING_COOKIE_NAME, recovery.secret, cookieOptions(600)));
      res.header?.("Content-Security-Policy", "default-src 'none'; script-src 'unsafe-inline'; connect-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'");
      const reference = htmlEscape(recovery.reference);
      const openCanonicalDashboard = req.legacy_browser_origin === "https://app.mandible.localhost:19420";
      res.html?.(`<!doctype html><meta charset="utf-8"><title>Opening Mandible</title><main style="font:16px system-ui;max-width:36rem;margin:4rem auto;line-height:1.5"><h1>Opening Mandible</h1><p id="result" role="status">Connecting this browser to the installed app…</p></main><script>(async()=>{const result=document.getElementById('result');const opener=document.createElement('a');opener.href='mandible://access/approve?reference=${reference}';opener.hidden=true;document.body.append(opener);opener.click();opener.remove();const deadline=Date.now()+30000;while(Date.now()<deadline){const response=await fetch('/api/client-auth/pairing/complete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({reference:'${reference}'})});if(response.status===409){await new Promise(resolve=>setTimeout(resolve,500));continue}if(!response.ok)throw Error('The installed app could not establish browser access.');const body=await response.json();const proof=await fetch('/api/client-auth/recovery/verify',{method:'POST',headers:{'X-Mandible-CSRF':body.session.csrf_token}});if(!proof.ok)throw Error('The saved browser state could not be verified.');result.textContent='Browser connected.';${openCanonicalDashboard ? "location.replace('/')" : ""};return}throw Error('The installed app did not answer the browser handoff. Check that Mandible is installed and running.')})().catch(error=>{document.getElementById('result').textContent=error.message})</script>`);
    } catch (error) {
      handleError(res, error);
    }
  }, { fileRpc: "deny", countUnattributed: false });

  router.get("/api/client-auth/recovery/requests", (req, res) => {
    try {
      if (process.env.MANDIBLE_LEGACY_CONVERSION !== "allow") throw new Error("Browser recovery is not active.");
      const identity = requireOperator(getDb(), req);
      if (identity.source !== "browser_cookie" || !identity.csrf_token) throw new Error("Open this page from the connected Mandible desktop app.");
      const pending = authenticator.pendingBrowserRecoveries();
      const rows = pending.map((item) => `<li><strong>${htmlEscape(item.reference)}</strong> — ${htmlEscape(item.source_audience)} preview; ${item.browser_state_entries} saved settings <button data-reference="${htmlEscape(item.reference)}">Approve</button></li>`).join("");
      res.header?.("Cache-Control", "no-store");
      res.header?.("Content-Security-Policy", "default-src 'none'; script-src 'unsafe-inline'; connect-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'");
      res.html?.(`<!doctype html><meta charset="utf-8"><title>Browser connections</title><main style="font:16px system-ui;max-width:36rem;margin:4rem auto;line-height:1.5"><h1>Browser connections</h1><p>Approve only a connection you started in your Codex browser. This gives that browser profile access to your Mandible account; it does not approve every computer browser.</p>${pending.length ? `<ul>${rows}</ul>` : '<p>No browser connections are waiting.</p>'}<p id="result" role="status"></p></main><script>document.querySelectorAll('button[data-reference]').forEach(button=>button.onclick=async()=>{const result=document.getElementById('result');const reference=button.dataset.reference;result.textContent='Approving '+reference+'…';try{const response=await fetch('/api/client-auth/recovery/approve',{method:'POST',headers:{'Content-Type':'application/json','X-Mandible-CSRF':${JSON.stringify(identity.csrf_token)}},body:JSON.stringify({reference})});result.textContent=response.ok?'Approved. Return to the Codex browser and finish connecting.':'Could not approve this connection.';if(response.ok)button.disabled=true}catch{result.textContent='Connection unavailable. Try again.'}})</script>`);
    } catch (error) {
      handleError(res, error);
    }
  }, { fileRpc: "deny", countUnattributed: false });

  router.post("/api/client-auth/recovery/approve", (req, res) => {
    try {
      if (process.env.MANDIBLE_LEGACY_CONVERSION !== "allow") throw new Error("Browser recovery is not active.");
      const identity = requireOperator(getDb(), req);
      if (identity.source !== "browser_cookie") throw new Error("Desktop browser approval requires an active session.");
      const reference = (optionalString(bodyRecord(req), "reference") ?? "").trim();
      if (!authenticator.pendingBrowserRecoveries().some((item) => item.reference === reference)) {
        sendJson(res, 404, { error: "recovery_not_pending" });
        return;
      }
      authenticator.approvePairing(reference, identity.user_id);
      sendJson(res, 200, { approved: true, reference });
    } catch (error) {
      handleError(res, error);
    }
  }, { fileRpc: "deny", countUnattributed: false });

  router.post("/api/client-auth/recovery/verify", (req, res) => {
    try {
      const identity = requireIdentity(req);
      const recovery = authenticator.verifyBrowserRecovery(identity);
      if (!recovery) {
        sendJson(res, 404, { error: "recovery_not_found" });
        return;
      }
      sendJson(res, 200, { verified: true, target_audience: recovery.source_audience });
    } catch (error) {
      handleError(res, error);
    }
  }, { fileRpc: "deny", countUnattributed: false });

  router.get("/api/client-auth/recovery/state", (req, res) => {
    try {
      const identity = requireIdentity(req);
      const recovery = authenticator.browserRecoveryState(identity);
      if (!recovery) {
        sendJson(res, 404, { error: "recovery_not_found" });
        return;
      }
      sendJson(res, 200, recovery);
    } catch (error) {
      handleError(res, error);
    }
  }, { fileRpc: "deny", countUnattributed: false });

  router.post("/api/client-auth/recovery/finalize", (req, res) => {
    try {
      const identity = requireIdentity(req);
      if (!authenticator.finalizeBrowserRecovery(identity)) {
        sendJson(res, 404, { error: "recovery_not_found" });
        return;
      }
      sendJson(res, 200, { finalized: true });
    } catch (error) {
      handleError(res, error);
    }
  }, { fileRpc: "deny", countUnattributed: false });

  router.post("/api/client-auth/renew", (req, res) => {
    try {
      const identity = req.client_identity;
      if (!identity || identity.source !== "browser_cookie") {
        sendJson(res, 401, { error: "browser_session_required" });
        return;
      }
      sendJson(res, 200, { session: authenticator.browserSessionMetadata(identity) });
    } catch (error) {
      handleError(res, error);
    }
  }, { fileRpc: "deny", countUnattributed: false });

  router.post("/api/client-auth/logout", (req, res) => {
    try {
      const identity = req.client_identity;
      if (!identity || identity.source !== "browser_cookie") {
        sendJson(res, 401, { error: "browser_session_required" });
        return;
      }
      const revoked = authenticator.revokeBrowserFamily(identity);
      if (!revoked) {
        sendJson(res, 403, {
          error: "The browser session is already revoked.",
          code: "session_revoked",
        });
        return;
      }
      clearSessionCookie(res);
      sendJson(res, 200, { logged_out: true, audience: identity.audience });
    } catch (error) {
      handleError(res, error);
    }
  }, { fileRpc: "deny", countUnattributed: false });

  router.post("/api/client-auth/logout-everywhere", (req, res) => {
    try {
      const identity = requireOperator(getDb(), req);
      const revoked = authenticator.revokeAllBrowserFamilies(identity);
      clearSessionCookie(res);
      sendJson(res, 200, { logged_out_everywhere: true, revoked });
    } catch (error) {
      handleError(res, error);
    }
  }, { fileRpc: "deny", countUnattributed: false });

  // Issue 0b989d1 — exchange a long-lived agent PAT for a session-scoped
  // ephemeral token. `cli/wrap.sh` calls this at launch so the credential that
  // actually enters an agent's environment (and therefore its transcript) dies
  // when that one session ends, instead of being a shared PAT whose leak forces
  // a rotation across every live agent.
  //
  // The exchange NARROWS an identity, it never establishes one: the caller must
  // already authenticate with a durable api_token, and the minted token resolves
  // to that same user. Requiring api_token specifically (not merely "some
  // authenticated identity") stops an exchanged token — or a dashboard/bootstrap
  // ephemeral — from being re-exchanged into a fresh, differently-scoped
  // credential with a renewed TTL.
  router.post("/api/client-auth/session-token", (req, res) => {
    try {
      const db = getDb();
      const identity = req.client_identity ?? null;
      if (!identity) {
        sendJson(res, 401, {
          error: "Session-token exchange requires an authenticated client.",
          code: "authentication_required",
        });
        return;
      }
      if (identity.method !== "api_token") {
        sendJson(res, 403, {
          error: "Session-token exchange requires a durable api_token credential.",
          code: "exchange_requires_api_token",
        });
        return;
      }
      const sessionId = (optionalString(bodyRecord(req), "session_id") ?? "").trim();
      if (!sessionId) {
        throw new UserRegistryError("invalid", "session_id is required.");
      }
      const user = getUserById(db, identity.user_id);
      if (!user || user.status !== "active") {
        sendJson(res, 403, {
          error: "Session-token exchange requires an active user.",
          code: "inactive_user",
        });
        return;
      }
      const existingSession = db.prepare(
        "SELECT status, ended_at, owner_user_id FROM sessions WHERE id = ?",
      ).get(sessionId) as {
        status: string;
        ended_at: string | null;
        owner_user_id: string | null;
      } | undefined;
      if (
        existingSession
        && (
          existingSession.status !== "active"
          || existingSession.ended_at !== null
          || existingSession.owner_user_id !== user.id
        )
      ) {
        sendJson(res, 403, {
          error: "Session-token exchange requires the caller's own active session.",
          code: "session_exchange_forbidden",
        });
        return;
      }
      const minted = authenticator.issueSessionScopedToken(
        { user_id: user.id, slug: user.slug },
        sessionId,
      );
      // The raw token is returned exactly once and is never persisted or logged.
      sendJson(res, 201, {
        token: minted.token,
        expires_at: minted.expires_at,
        session_id: sessionId,
        user: { id: user.id, slug: user.slug },
      });
    } catch (error) {
      handleError(res, error);
    }
  }, { fileRpc: "deny", countUnattributed: false });

  // Issue 499c148 — the cheap self-check. A session that carries the wrong
  // bearer (e.g. an inherited operator token in an agent shell) previously had
  // no way to notice before the auth-request gate refused it. This reports the
  // identity the daemon actually resolves for the calling request. It is a read
  // of the caller's own request context and reveals nothing another route would
  // not, so it stays usable while anonymous: an unauthenticated caller gets
  // `authenticated: false` rather than a 401, which is itself the answer.
  router.get("/api/client-auth/whoami", (req, res) => {
    try {
      const db = getDb();
      const identity = req.client_identity ?? null;
      if (!identity) {
        sendJson(res, 200, {
          authenticated: false,
          audience: authenticator.authorityId(),
          failure_reason: req.client_auth_failure ?? "unknown",
          user: null,
          evidence_method: null,
          source: null,
          ephemeral_purpose: null,
          credential: null,
        });
        return;
      }
      const user = getUserById(db, identity.user_id);
      // The credential label is the operator-facing name of the presented
      // api_token ("mll-cli"), which is what makes a wrong-token diagnosis
      // actionable. Ephemeral identities have no persisted credential row.
      const credential = identity.credential_id
        ? listCredentials(db, identity.user_id, { includeRevoked: true }).find(
            (row) => row.id === identity.credential_id,
          ) ?? null
        : null;
      sendJson(res, 200, {
        authenticated: true,
        audience: identity.audience ?? authenticator.instanceId(),
        session: authenticator.browserSessionMetadata(identity),
        user: user
          ? {
              id: user.id,
              slug: user.slug,
              kind: user.kind,
              display_name: user.display_name,
            }
          : { id: identity.user_id, slug: identity.slug, kind: null, display_name: null },
        evidence_method: identity.method,
        source: identity.source,
        // Distinguishes bounded bootstrap or agent-session proofs; opaque
        // browser sessions report their durable authentication evidence above.
        ephemeral_purpose: identity.ephemeral_purpose ?? null,
      credential: credential
          ? {
              id: credential.id,
              type: credential.type,
              label: credential.label,
              status: credential.status,
            }
          : null,
        legacy_conversion_pending: identity.source === "browser_cookie"
          ? Boolean(authenticator.legacyConversionDetails(identity)?.finalized === false)
          : false,
      });
    } catch (error) {
      handleError(res, error);
    }
  }, { fileRpc: "allow" });

  // Mint a bearer token for a user. Self-service, or operator for another user.
  // The raw token is returned exactly once and never persisted.
  router.post("/api/users/:ref/tokens", (req, res) => {
    try {
      const db = getDb();
      const target = resolveUserOrThrow(db, req.params.ref);
      requireSelfOrOperator(db, req, target.id);
      const body = bodyRecord(req);
      const minted = authenticator.mintApiToken(target.id, {
        label: optionalString(body, "label") ?? null,
      });
      sendJson(res, 201, {
        token: minted.token,
        credential: minted.credential,
      });
    } catch (error) {
      handleError(res, error);
    }
  }, { fileRpc: "allow", countUnattributed: false });

  // List a user's api_token credentials (metadata only — never the raw token).
  router.get("/api/users/:ref/tokens", (req, res) => {
    try {
      const db = getDb();
      const target = resolveUserOrThrow(db, req.params.ref);
      requireSelfOrOperator(db, req, target.id);
      const query = req.query ?? {};
      const includeRevoked = query.all === "1" || query.all === "true";
      const tokens = listCredentials(db, target.id, { includeRevoked }).filter(
        (credential) => credential.type === "api_token",
      );
      sendJson(res, 200, { tokens });
    } catch (error) {
      handleError(res, error);
    }
  }, { fileRpc: "allow" });
}
