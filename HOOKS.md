Repository hook setup

To enable the repository-local pre-commit hooks for a new clone, run the following from the repository root (this updates local git config only — it does not change global settings):

```sh
./scripts/setup-hooks.sh
```

This will:
- set `core.hooksPath` to `.githooks` (local repo config)
- make `.githooks/pre-commit` executable

To undo:

```sh
git config --unset core.hooksPath
```

Notes:
- Do not run the setup script as root. It intentionally does not change global git settings.
- CI runs the independent GitHub Actions `./.github/workflows/secret-scan.yml` which enforces similar checks on push and pull requests.
