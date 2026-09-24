# AGENTS (Codex / Copilot) Usage Rules

This file documents repository-specific rules for AI assistants (Codex, Copilot)
and any automated agents interacting with this repository.

Rules (summary):

- Repository root: the directory containing this `AGENTS.md` file.
- Do not rely on machine-specific paths or external archive directories as runtime
  dependencies or targets for changes.
- All runtime secrets must be stored only in the root `.env` file.
- The root `.env` file MUST NOT be added, committed, or pushed to git.
- Subdirectory `.env` files (e.g. `apps/web-dashboard/.env`, `scripts/.env`) must not
  contain secret values. Use symbolic links to the root `.env` if needed.
- `.env.example` is the only environment-file artifact that is allowed to be tracked.
  It must contain only variable names and safe placeholders (no real values).
- Do not print, log, or return secret values in terminal output, PR descriptions,
  commit messages, or AI assistant responses.
- Before performing secret-related changes, run and inspect: `git status`,
  `git ls-files | grep '\.env'`, and `git check-ignore -v <file>`.
- Do NOT run `git filter-repo`, perform history-rewrites, force-pushes, or change
  `main` without explicit human approval.
- Do not commit generated data, temporary files, or backups (e.g. `backup-*.bundle`).
- If you detect secrets accidentally staged or committed, STOP and notify a human.

Guidance for AI assistants:

- Always prefer editing or proposing changes in code without touching `.env` values.
- When suggesting changes, include the exact file paths to edit and avoid changing
  files in the `data/` directory unless explicitly requested.
- If asked to remove secrets from history, require explicit human confirmation and
  a backup strategy (bundle / branch) before proceeding.

If you are an automated tool or assistant, follow these rules strictly. Violations
may lead to secret exposure and require emergency rotation.
