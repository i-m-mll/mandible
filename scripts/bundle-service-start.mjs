import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { assertLifecycleLockHeld } from './lifecycle-lock.mjs';
import { inspectServiceDefinitionsSync, matchingServiceDefinitions } from './service-definitions.mjs';
import { RuntimeObservationError, runtimeProcessChanged, runtimeObservationTimeout } from './runtime-observation.mjs';
import { RUNTIME_HEALTH_PROBE_INTERVAL_MS } from './runtime-probe-cadence.mjs';

export const BUNDLE_SERVICE_START_TIMEOUT_MS = 20_000;

export function startOwnedJob(context, role, until) {
  assertLifecycleLockHeld();
  const result = spawnSync('/bin/launchctl', ['kickstart', `${context.domain}/${context[`${role}Label`]}`], { encoding: 'utf8', timeout: runtimeObservationTimeout(until, 2500) });
  return { ok: !result.error && result.status === 0, status: result.status, error: result.error?.message || result.stderr?.trim() || null };
}

/** Progress only from registration transitions or an exact owned dormant job. */
export function bundleServiceStartAction(state, nativeStatus, job) {
  if (nativeStatus !== state.previousStatus) state.registered = false;
  state.previousStatus = nativeStatus;
  if (!job) return null;
  if (!job.loaded) state.startAttempted = false;
  if (nativeStatus === 'enabled' && job.loaded) {
    if (!job.pid && !state.startAttempted) { state.startAttempted = true; return 'start'; }
  } else if (['not_found', 'not_registered'].includes(nativeStatus) && !state.registered) {
    state.registered = true;
    return 'register';
  }
  return null;
}

/** Registration status is permission evidence; only the exact observed job admits start. */
export async function reconcileBundleServiceStart(context, role, { until, control, readProcess, processes = {},
  observe = inspectServiceDefinitionsSync, start = startOwnedJob, now = Date.now,
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const label = context[`${role}Label`];
  const observations = [];
  const fail = (code, message, outcome = 'failed') => ({ ok: false,
    error: new RuntimeObservationError(code, message, { service: role, label, until, observations, processes: { ...processes } }, outcome) });
  const continuity = () => {
    for (const [service, expected] of Object.entries(processes)) {
      const current = readProcess(context, service, { until });
      if (runtimeProcessChanged(expected, current)) {
        observations.push({ at: now(), service, expected, current });
        return fail('process_changed', `Qualified ${service} process changed during service registration.`);
      }
    }
    return null;
  };
  const progress = {};
  while (now() < until) {
    let native, inspection;
    try {
      const changed = continuity(); if (changed) return changed;
      native = control(context, 'status', role, { until }); inspection = observe(context, { until });
      const replaced = continuity(); if (replaced) return replaced;
    }
    catch (error) { return fail('service_observation_failed', error.message); }
    const observed = inspection.ok ? inspection.observations.find(item => item.service === role) : null;
    const sample = { at: now(), native, job: observed ? {
      loaded: observed.job.loaded, pid: observed.job.pid, program: observed.job.program,
      bundleProgram: observed.job.bundleProgram, parentBundleIdentifier: observed.job.parentBundleIdentifier,
    } : null, refusal: inspection.ok ? null : inspection.refusal };
    observations.push(sample);
    if (!inspection.ok && inspection.refusal.category !== 'starting') return fail(inspection.refusal.category, inspection.refusal.message);
    if (inspection.ok) {
      const matching = matchingServiceDefinitions(inspection);
      if (!matching.ok) return fail(matching.refusal.category, matching.refusal.message);
      if (!observed) return fail('missing_definition', `The expected ${role} service observation is missing.`);
      if (observed.job.loaded && (observed.loadedDefinition?.BundleProgram !== 'Contents/MacOS/mandible-service'
          || observed.job.program !== path.join(context.bundleRoot, 'Contents/MacOS/mandible-service'))) {
        return fail('ownership_conflict', `The loaded ${role} is not the expected bundle-owned native service.`);
      }
    }
    if (native.status === 'requires_approval') return fail('background_permission_required', 'Allow Mandible background services in System Settings.', 'pending');
    if (now() >= until) break;
    const action = bundleServiceStartAction(progress, native.status, observed?.job);
    if (inspection.ok) {
      if (native.status === 'enabled' && observed.job.loaded) {
        if (observed.job.pid) {
          const current = readProcess(context, role, { until });
          if (current?.pid === observed.job.pid && current.startedAt) {
            processes[role] = current;
            return { ok: true, observation: sample, processes: { ...processes } };
          }
        }
        if (action === 'start' && now() < until) {
          try { sample.start = start(context, role, until); } catch (error) { return fail('service_start_failed', error.message); }
          if (sample.start.ok) return { ok: true, observation: sample, processes: { ...processes } };
        }
      } else if (action === 'register' && now() < until) {
        assertLifecycleLockHeld();
        try { sample.registration = control(context, 'register', role, { until }); }
        catch (error) { return fail('service_registration_failed', error.message); }
        if (sample.registration.status === 'requires_approval') return fail('background_permission_required', 'Allow Mandible background services in System Settings.', 'pending');
      }
    }
    const remaining = until - now();
    if (remaining <= 0) break;
    await wait(Math.min(RUNTIME_HEALTH_PROBE_INTERVAL_MS, remaining));
  }
  return fail('registration_inconsistent', `Native registration and the owned launchd job for ${label} did not converge before the original deadline.`, 'pending');
}
