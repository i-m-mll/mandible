import { render } from 'preact';
import { ToolUseBlock } from '../../../ui/src/components/message-blocks/ToolUseBlock';

render(<main style={{padding: 24, maxWidth: 900}}>
  <ToolUseBlock toolName="exec" toolKind="custom_tool_call" input={`const r = await tools.exec_command({cmd:"sed -n '1,260p' /tmp/example.md"});text(r)`} expanded />
  <div className="artifact-preview--code"><code className="hljs"><span className="hljs-string">reference</span></code></div>
</main>, document.getElementById('root')!);

async function measure(): Promise<void> {
  await document.fonts.ready;
  const code=document.querySelector('.tool-card__terminal code')!;
  const string=code.querySelector('.hljs-string')!;
  const artifact=document.querySelector('.artifact-preview--code .hljs-string')!;
  const values=[];
  for(const theme of ['codex','dark','light']) {
    document.documentElement.dataset.theme=theme;
    values.push({theme,code:getComputedStyle(code).color,string:getComputedStyle(string).color,artifactString:getComputedStyle(artifact).color,command:code.textContent});
  }
  document.documentElement.dataset.theme='codex';
  document.title=btoa(JSON.stringify(values));
}
void measure();
