import path from 'node:path';

/** Resolve the declared role paths once; classification itself has no effects. */
export function nativeExecutionModel(bundleRoot, release) {
  if (!path.isAbsolute(bundleRoot ?? '')) return { ok: false, message: 'Native execution requires an absolute app root.' };
  const executable = role => typeof release?.native?.[role] === 'string'
    ? path.resolve(bundleRoot, 'Contents/Resources', release.native[role]) : null;
  const bun = executable('bun');
  const helper = path.join(bundleRoot, 'Contents/MacOS/mandible-service');
  if (bun !== path.join(bundleRoot, 'Contents/MacOS/mandible-bun')
      || release.native.serviceHelper !== undefined && executable('serviceHelper') !== helper) {
    return { ok: false, message: 'Expected native execution paths leave their declared roles.' };
  }
  const declared = release.serviceExecutables !== undefined;
  if (declared && (!release.serviceExecutables || typeof release.serviceExecutables !== 'object' || Array.isArray(release.serviceExecutables))) return { ok: false, message: 'Invalid expected service executable roles.' };
  const backend = declared ? release.serviceExecutables.backend : 'bun';
  const gateway = declared ? release.serviceExecutables.gateway : 'bun';
  if (backend !== 'bun' || !['bun', 'caddy'].includes(gateway)) return { ok: false, message: 'Invalid expected service executable role.' };
  const caddy = gateway === 'caddy' ? executable('caddy') : null;
  if (gateway === 'caddy' && caddy !== path.join(bundleRoot, 'Contents/MacOS/mandible-caddy')) return { ok: false, message: 'Expected Caddy executable leaves its native role.' };
  const pending = ['xpcproxy', '/usr/libexec/xpcproxy', 'mandible-service', helper, 'mandible-bun'];
  return { ok: true, roles: {
    backend: { terminal: bun, pending },
    gateway: { terminal: gateway === 'caddy' ? caddy : bun, pending: gateway === 'caddy' ? [...pending, bun] : pending },
  } };
}

export function classifyNativeExecution(model, role, executable) {
  const expected = model.ok && model.roles[role];
  if (!expected) return 'foreign';
  if (executable === expected.terminal) return 'executable-qualified';
  return expected.pending.includes(executable) ? 'pending' : 'foreign';
}
