# Instruction sources

Edit `cli/instructions-contract.md` for the contract's structure, explanations,
and policy. `{{command issue.report}}` inserts a command synopsis in place.
Descriptions stay beside their insertions in Markdown. The source is never
rewritten by installation; only the exported instruction fragment is generated.

`cli/command-syntax.json` owns command route and synopsis data, without prose.
The same definitions drive `mandible help <command...>`, CLI usage insertions,
and the contract renderer. Update a command definition alongside its handler.
These are CLI-owned usage definitions, not a second command parser: existing
shell handlers continue to validate and execute arguments. Focused CLI tests
remain responsible for argument behavior; the contract checks additionally
reject documented flags absent from the corresponding implementation.

`cli/command-syntax.cjs` implements the one substitution engine used by the
shell installer, CLI help, and SDK instruction injection. It never evaluates
expressions or runs commands. Unknown keys, malformed directives, invalid
registry entries, and missing files fail visibly. A syntax-only change triggers
the post-merge instruction installer just as a prose change does.

Agent policy reviews the authored Markdown and the separate mechanical syntax
registry. Generated exported fragments are views, not editable sources.
