(async () => {
  if (window.__mandibleCandidateInteractionRunning) return;
  window.__mandibleCandidateInteractionRunning = true;
  const nonce = __MANDIBLE_ACCEPTANCE_NONCE__;
  const report = evidence => window.__TAURI__.core.invoke('candidate_acceptance_report', { nonce, evidence });
  const checkpoint = `mandible-candidate-interaction:${nonce}`;
  const prompt = () => document.querySelector('[role="region"][aria-label="Welcome to Mandible"]');
  const complete = () => document.querySelector('button[aria-label="Complete optional integrations"]');
  const theme = () => document.getElementById('settings-app-theme');
  const until = async predicate => {
    const end = Date.now() + 15000;
    while (Date.now() < end) {
      if (await predicate()) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('dashboard interaction timed out');
  };
  const read = async path => {
    const response = await fetch(path, { cache: 'no-store' });
    if (!response.ok) throw new Error(`${path}: ${response.status}`);
    return response.json();
  };
  const integrations = async () => {
    const state = await read('/api/settings/integrations');
    const delivery = await read('/api/settings/instructions-delivery');
    if (!state.available) throw new Error('Optional integration state is not from the installed product');
    if (state.items.some(item => item.status !== 'absent') || delivery.targets.length !== 0) {
      throw new Error('Fresh fixture has optional integrations or instruction destinations');
    }
    return state.items.map(({ id, status, destination }) => ({ id, status, destination }));
  };
  try {
    let progress = JSON.parse(sessionStorage.getItem(checkpoint) || 'null');
    await until(() => document.querySelector('a[aria-label="Settings"]'));
    document.querySelector('a[aria-label="Settings"]').click();
    await until(() => location.hash.startsWith('#/settings') && theme() && !theme().disabled && complete());

    if (!progress) {
      const settings = await read('/api/settings');
      if (settings['integrations.setup'] !== undefined) throw new Error('Optional setup fixture is not fresh');
      const before = await integrations();
      const skip = () => document.querySelector('button[aria-label="Skip optional integrations"]');
      await until(() => prompt() && skip() && !skip().disabled);
      skip().click();
      let skipped;
      await until(async () => {
        skipped = (await read('/api/settings'))['integrations.setup'];
        return skipped === 'skipped' && !prompt();
      });
      sessionStorage.setItem(checkpoint, JSON.stringify({ stage: 'skipped', skipped, before }));
      location.reload();
      return;
    }

    if (progress.stage === 'skipped') {
      if ((await read('/api/settings'))['integrations.setup'] !== progress.skipped) throw new Error('Skipped setup did not survive reload');
      const before = await read('/api/host-preferences/app-theme');
      const next = before.value === 'dark' ? 'light' : 'dark';
      theme().value = next;
      theme().dispatchEvent(new Event('change', { bubbles: true }));
      let persisted;
      await until(async () => {
        persisted = await read('/api/host-preferences/app-theme');
        return persisted.value === next && persisted.revision > before.revision;
      });
      if (prompt()) throw new Error('Optional setup prompt returned after skipping and reloading');
      complete().click();
      let completed;
      await until(async () => {
        completed = (await read('/api/settings'))['integrations.setup'];
        return completed === 'complete' && complete().disabled && !prompt();
      });
      progress = { ...progress, stage: 'complete', completed,
        edit: { key: 'app_theme', before: before.value, after: persisted.value, revision: persisted.revision } };
      sessionStorage.setItem(checkpoint, JSON.stringify(progress));
      location.reload();
      return;
    }

    if (progress.stage !== 'complete') throw new Error('Unknown candidate interaction checkpoint');
    const completed = (await read('/api/settings'))['integrations.setup'];
    await until(() => complete().disabled && theme().value === progress.edit.after);
    if (completed !== progress.completed || prompt()) throw new Error('Completed setup did not stay dismissed after reload');
    const after = await integrations();
    if (JSON.stringify(after) !== JSON.stringify(progress.before)) throw new Error('Optional setup changed integration destinations');
    await report({ passed: true, url: location.href, rendered: theme().value === progress.edit.after && complete().disabled, edit: progress.edit,
      setup: { skipped: progress.skipped, completed, reloads: 2,
        promptDismissedAfterReload: !prompt(), integrationsUnchanged: JSON.stringify(after) === JSON.stringify(progress.before) } });
  } catch (error) { await report({ passed: false, error: String(error) }); }
})();
