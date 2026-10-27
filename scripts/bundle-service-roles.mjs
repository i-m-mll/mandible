import fs from 'node:fs';

export const serviceRoles = JSON.parse(fs.readFileSync(new URL('./bundle-services.json', import.meta.url), 'utf8'));
export function bundleServiceLabel(role, identifier = 'bio.mll.mandible') {
  if (!Object.hasOwn(serviceRoles, role)) throw new Error('Unknown service role');
  return `${identifier}.${serviceRoles[role]}`;
}
