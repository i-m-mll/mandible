import roles from './bundle-services.json' with { type: 'json' };

export const serviceRoles = roles;
export function bundleServiceLabel(role, identifier = 'bio.mll.mandible') {
  if (!Object.hasOwn(serviceRoles, role)) throw new Error('Unknown service role');
  return `${identifier}.${serviceRoles[role]}`;
}
