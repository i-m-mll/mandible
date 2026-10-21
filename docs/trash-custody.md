# Trash custody and ignored files

`mandible trash create` and post-merge cleanup (actor `auth-merge`) remove a
branch and its worktree into reversible custody. Tracked and untracked changes
go into the snapshot commit under `refs/mandible/trash/<id>`, which restore
makes the branch tip.

Ignored files are classified before anything is removed:

- **Skipped:** symlinks, which hold no unique bytes (shared links are
  symlinks), and directories named on the rebuildable list, matched by name at
  any depth and never descended into.
- **Kept:** every other ignored file, when their total size is at or under the
  limit. They are stored as a parentless commit under
  `refs/mandible/trash-ignored/<id>`, separate from the snapshot, so they never
  become tracked content or history on the branch. `mandible trash restore
  --worktree-path` writes them back byte for byte as untracked, ignored files.
  GC deletes this ref with the snapshot ref.
- **Refused:** when the kept files exceed the limit, or an ignored directory
  holds a nested repository (`.git`), create fails with
  `ignored_files_refused`. It names the largest files (up to 50), the total
  size and the limit, and removes nothing.

The entry's `outcome.ignored` records `kept`, `skipped` and `refused` counts,
`kept_bytes`, `limit_bytes`, up to 50 `kept_paths`, and the custody `ref` and
`oid`.

## Repository configuration

The checkout root's `mandible.toml` or `.mandible.toml` may set:

```toml
[trash.ignored]
# Replaces the default list.
rebuildable_dirs = ["node_modules", ".venv"]
# Adds to the default list, or to rebuildable_dirs when both are set.
extra_rebuildable_dirs = ["coverage"]
# Largest total of unique ignored bytes trash keeps. Default 52428800 (50 MB).
max_preserved_bytes = 52428800
```

The default rebuildable list is `node_modules`, `.venv`, `venv`,
`__pycache__`, `.pytest_cache`, `.mypy_cache`, `.ruff_cache`, `dist`, `build`,
`.next`, `.turbo`, `target` and `.cache`. An invalid section fails create with
`invalid_repo_config`.
