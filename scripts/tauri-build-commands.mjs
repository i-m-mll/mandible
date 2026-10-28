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
