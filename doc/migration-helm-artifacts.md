# Migration: Remove committed Helm dependency artifacts

## Background

Prior to v1.3.1, every render preview ran `helm dependency build` directly inside
the gitops working directory. This wrote `Chart.lock` and `charts/*.tgz` into
deployment folders as a side effect, and those files could end up committed to git.

As of v1.3.1, render preview uses a temporary directory so the gitops working tree
is never touched. However, **existing gitops repositories** may already have these
artifacts committed and need a one-time cleanup.

## Who is affected

Any gitops repo where a user previewed a deployment and then committed all pending
changes (intentionally or not). Check with:

```bash
git ls-files | grep -E "(^|/)Chart\.lock$"
git ls-files | grep -E "(^|/)charts/.*\.tgz$"
```

If either command produces output, the cleanup below is needed.

## Cleanup (one-time)

Run the following in the root of your gitops repository:

```bash
# Untrack all committed Chart.lock and charts/*.tgz regardless of folder depth
while IFS= read -r f; do git rm --cached "$f"; done < <(git ls-files | grep -E "(^|/)Chart\.lock$")
while IFS= read -r f; do git rm --cached "$f"; done < <(git ls-files | grep -E "(^|/)charts/.*\.tgz$")

git commit -m "chore: remove helm-generated artifacts from working tree"
git push
```

## Prevent recurrence

Add a `.gitignore` to the root of your gitops repository:

```gitignore
# Helm dependency build artifacts — generated at render time, never committed
Chart.lock
charts/*.tgz
```

```bash
git add .gitignore
git commit -m "chore: ignore helm-generated artifacts"
git push
```

New local-dev gitops repos initialized by AlertForge v1.3.1+ include this
`.gitignore` automatically.
