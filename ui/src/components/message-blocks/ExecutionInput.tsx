import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import javascript from 'highlight.js/lib/languages/javascript';
import powershell from 'highlight.js/lib/languages/powershell';
import type { ExecutionPresentation } from '../../../../src/presentation/execution-presentation';
import { OverflowFade } from '../shared/OverflowFade';

hljs.registerLanguage('bash', bash);
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('powershell', powershell);

function shellPresentation(shell?: string): {label: string; language?: string} {
  if (!shell) return {label: 'Shell'};
  const name = shell.split('/').pop()!.toLowerCase();
  if (['bash', 'sh', 'zsh', 'ksh'].includes(name)) return {label: shell, language: 'bash'};
  if (['pwsh', 'powershell', 'powershell.exe', 'pwsh.exe'].includes(name)) return {label: shell, language: 'powershell'};
  return {label: shell};
}
function Code({text, language}: {text: string; language?: string}): JSX.Element {
  return language ? <code className={`hljs language-${language}`} dangerouslySetInnerHTML={{__html: hljs.highlight(text, {language, ignoreIllegals: true}).value}} /> : <code>{text}</code>;
}
export function ExecutionInput({execution}: {execution: ExecutionPresentation}): JSX.Element {
  const panels = execution.facts.kind === 'script' ? [{command: execution.script!, label: 'JavaScript', language: 'javascript'}]
    : execution.operations.map(operation => ({command: operation.command, ...shellPresentation(operation.shell)}));
  return <div className="tool-card__terminal">{panels.map((panel, index) => <div key={index}>
    <small>{panel.label}</small>
    <OverflowFade lines={10}><pre><Code text={panel.command} language={panel.language} /></pre></OverflowFade>
  </div>)}</div>;
}
