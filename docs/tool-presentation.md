# Tool presentation

Chat derives tool semantics from native provider boundaries and complete static
wrapper programs. The source transcript, normalized text/parts and canonical
positions remain unchanged. Tool cards, complete-height measurement and indexed
activity summaries use the same presentation functions.

| Boundary | Projection and representative coverage |
| --- | --- |
| Codex saved function/custom calls | Exact call identity and native input determine the presenter. `execution-presentation.test.tsx` parses saved custom call/output blocks, checks compact command facts and source hydration. |
| Codex `functions.exec` results | A paired exec/functions.exec custom call and a separate native first content block prove wrapper framing and its UTF-16 payload span. `text(r)` consumes the known command result object once; `text(r.output)` remains literal stdout. Wrapper timing retains its scope. The native `total=46 codex=14 named=32` case is represented in the regression. |
| Static wrapper batches | Acorn accounts for every statement, immutable binding, call and forwarding expression. Sequential calls, `Promise.all`, `Promise.allSettled`, direct result arrays and indexed `forEach` spread/result/stdout forms reuse existing tool cards. Tests cover command/edit mixtures, exact index correspondence, rejected results and malformed/truncated output. |
| Codex live `commandExecution` | Explicit command, aggregated output, duration, exit code and process identity drive the shared command presenter. The controller adapter regression exercises actual protocol notifications through display projection. |
| Codex live MCP/dynamic calls | Native item type proves the boundary independently of tool name. MCP content, structured content, error messages and dynamic text/image/audio items remain available; text payloads are never recursively parsed. Controller coverage includes an arbitrary MCP tool name and explicit dynamic failure. |
| Claude saved/live results | Native strings remain literal. Typed text/image content and explicit errors survive in display evidence. Saved flattened canonical text/parts stay intact; lean projections omit media bodies. The parser regression covers that boundary and existing controller paths preserve native results. |
| Gemini `toolCalls` | Native function-response arrays must match their call name/identity. The shared shell presenter uses `run_shell_command.command`. Known response output or structured stdout/stderr is displayed, with execution state preserved and no invented duration. Unknown response shapes remain data. |

The recognized tool categories remain those in `tool-presentation.ts`: command,
file read/edit/write/delete/move, search, browser, fetch, JavaScript, wait,
thinking, mode switch and generic tools. Transparent wrappers dispatch through
that table rather than adding category-specific rendering paths.

The program records literal, explicit JSON and native object emission rules. Literal stdout is never JSON-decoded or stripped by prefix. Several literal emissions without proven boundaries remain together as original output. JSON emissions are decoded once. Native framing is consumed once from its source-proven span.

Indexed outputs are accepted atomically. Duplicate, missing, out-of-range,
truncated or otherwise unaccountable emissions never receive guessed child
bindings. Spread output requires a known noncolliding result envelope; nested
result fields can retain arbitrary application values. Substantive JavaScript
remains complete JavaScript.

Native call/result wrappers own source navigation, selection and disclosure.
Children use local operation indices and have no invented source positions.
Complete export retains original source content. The disposable structure cache
is version16; source parser/normalization epochs remain unchanged. Compact facts
contain categories, counts, language/binding facts and state, without commands,
script bodies, file contents, output or media.

Unrecognized native textual output formats remain literal. In particular, the
implementation does not infer a direct command result grammar from remembered
`Chunk ID`-style headers without a current native boundary fixture. Wait results without already-observed paired native framing evidence also remain literal.

Co-Authored-By: Codex (GPT) <codex@openai.com>
