export const DOTFILES_INSTRUCTION_COMMAND = "bash bin/compile-agent-instructions";
export const DOTFILES_INSTRUCTION_LABEL = "Compile agent instructions";

const STOCK_REPAIR_COMMAND = 'if [[ -x bin/agent-instruction-symlink-doctor ]]; then bash bin/agent-instruction-symlink-doctor; elif [[ -x bin/compile-agent-instructions ]]; then bash bin/compile-agent-instructions; else echo "dotfiles agent instruction hook missing repair script" >&2; exit 1; fi';
const sqlLiteral = (value: string): string => `'${value.replaceAll("'", "''")}'`;

export const DOTFILES_INSTRUCTION_HOOK_MIGRATION_SQL = [
  `UPDATE auth_hooks
   SET command = ${sqlLiteral(DOTFILES_INSTRUCTION_COMMAND)},
       label = CASE WHEN label = 'Compile agent instructions and repair home symlinks'
         THEN ${sqlLiteral(DOTFILES_INSTRUCTION_LABEL)} ELSE label END
   WHERE builtin = 1 AND auth_type = 'merge'
     AND command = ${sqlLiteral(STOCK_REPAIR_COMMAND)}
     AND ((id = 'builtin-dotfiles-agent-instructions' AND repo_pattern = '.dotfiles')
       OR (id = 'builtin-dotfiles-agent-instructions-nodot' AND repo_pattern = 'dotfiles'))`,
];
