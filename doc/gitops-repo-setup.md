# Gitops Repo Setup

## .gitignore

The gitops repository should include a `.gitignore` at its root to exclude
Helm dependency build artifacts:

```gitignore
# Helm dependency build artifacts — generated at render time, never committed
Chart.lock
charts/*.tgz
```

These files are written by `helm dependency build` during render preview and
carry no source-of-truth value — they are always re-generated from `Chart.yaml`.
Committing them causes GitOps tools to use the bundled `.tgz` instead of the
`file://` source, silently bypassing any subsequent chart updates.

## Cleanup: removing previously committed artifacts

If these files were committed before the `.gitignore` was in place, untrack them
with:

```bash
while IFS= read -r f; do git rm --cached "$f"; done < <(git ls-files | grep -E "(^|/)Chart\.lock$")
while IFS= read -r f; do git rm --cached "$f"; done < <(git ls-files | grep -E "(^|/)charts/.*\.tgz$")

git commit -m "chore: remove helm-generated artifacts from working tree"
git push
```

To check if cleanup is needed:

```bash
git ls-files | grep -E "(^|/)Chart\.lock$"
git ls-files | grep -E "(^|/)charts/.*\.tgz$"
```
