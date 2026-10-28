import path from 'node:path';
import { runSupervisedCommand } from './process-group-supervisor.mjs';

/** Keep package inventory out of Cargo inputs; all generated-context settings remain. */
const compileConfiguration = JSON.stringify({ bundle: {
  resources: null, externalBin: null, macOS: { files: null, frameworks: null },
} });

export function tauriCompileArguments(options, cargoArguments = []) {
  return ['build', ...options, '--no-bundle', '--config', compileConfiguration, ...cargoArguments];
}

/** Forward only flags supported by both installed Tauri build and bundle commands. */
export function tauriBundleArguments(options) {
  const args = ['bundle'];
  for (let index = 0; index < options.length; index++) {
    const option = options[index];
    if (['--debug', '-d', '--ci', '--verbose'].includes(option) || /^-v+$/.test(option)) args.push(option);
    else if (['--target', '-t', '--config', '-c'].includes(option)) args.push(option, options[++index]);
    else if (/^--(?:target|config|features)=/.test(option)) args.push(option);
    else if (['--features', '-f'].includes(option)) {
      args.push(option);
      while (index + 1 < options.length && !options[index + 1].startsWith('-')) args.push(options[++index]);
    } else if (['--runner', '-r'].includes(option)) index++;
  }
  return [...args, '--bundles', 'app', '--no-sign'];
}
/** Native compilation and the source payload converge before one package assembly. */
export async function assembleDesktopApplication(root, options, cargoArguments, { run = runSupervisedCommand, env = process.env } = {}) {
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  const cli = path.join(root, 'node_modules/@tauri-apps/cli/tauri.js');
  const settings = { cwd: root, env, stdio: 'inherit', timeout: 600_000, signal: controller.signal };
  let failure;
  try {
    await Promise.allSettled([
      run(process.execPath, [cli, ...tauriCompileArguments(options, cargoArguments)], settings),
      run('/bin/sh', [path.join(root, 'scripts/stage-desktop-package.sh')], settings),
    ].map(operation => operation.catch(error => { failure ??= error; controller.abort(); throw error; })));
    if (failure) throw failure;
    await run(process.execPath, [cli, ...tauriBundleArguments(options)], settings);
  } finally {
    controller.abort();
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
  }
}
