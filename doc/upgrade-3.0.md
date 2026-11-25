# Upgrading to 3.0

The alerts a 2.x repo deploys stay the same; the generated files change format,
and 3.0.0 refuses things 2.x accepted. The plan is two commits: **fix** what
3.0.0 refuses, still on 2.x; then **regenerate** with 3.0.0. Keep them apart:
the second one can be compared and rolled back on its own.

Do it on a copy of the repo first. `IMAGE_OLD` and `IMAGE_NEW` are the 2.3.0
and 3.0.0 images. With a source checkout (after `npm ci`), `node scripts/<tool>`
does the same.

```bash
export RULE_OBJECT_LABELS='{"release":"<your-selector>"}'   # what your deployment sets, and the other RULE_OBJECT_* you use
IMAGE_OLD=ghcr.io/null-ptr-exception/rulemgmt:2.3.0
IMAGE_NEW=ghcr.io/null-ptr-exception/rulemgmt:3.0.0
af() { local image=$1; shift
  docker run --rm -u "$(id -u):$(id -g)" -v "$PWD:/work" \
    -e RULE_OBJECT_LABELS -e RULE_OBJECT_ANNOTATIONS \
    -e RULE_OBJECT_LABELS_BY_PROFILE -e RULE_OBJECT_ANNOTATIONS_BY_PROFILE "$image" "$@"; }
```

## 1. Before you start

1. Everyone commits, pushes and merges to `main`. Branches that are not merged
   need a merge afterwards (step 6).
2. Mark the starting point: `git tag before-3.0.0 && git push origin before-3.0.0`.
3. Check the settings and the repo with 3.0.0. It only reads:

   ```bash
   af "$IMAGE_NEW" node scripts/check-repo.mjs /work; echo "exit $?"
   ```

   | Exit | Do |
   |---|---|
   | 2, naming a `RULE_OBJECT_*` variable | 3.0.0 does not start with it. 2.x left out a value that is not text, so removing the key keeps what is deployed. Set the same value where the server runs, then run it again |
   | 1 | Read the list; step 3 fixes it. `products are out of date` and `its AlertmanagerConfig is behind` are expected: steps 4 and 5 |
   | 0 | Nothing to do in step 3 |

4. Look for links made by hand. `check-repo` does not list a deployment folder
   that is a link, and 3.0.0 does not treat it as a deployment:

   ```bash
   find deployments charts -type l
   ```

## 2. Render what is deployed now

In a separate clone, because `helm dependency build` writes files. Use Bash,
and the Helm your GitOps tool renders with:

```bash
render() {   # render <checkout> <output folder>
  mkdir -p "$2"; local out; out=$(cd "$2" && pwd)
  (cd "$1" && find deployments -name Chart.yaml -not -path '*/charts/*' | sort | while read -r f; do
    d=${f%/Chart.yaml}; n=$(echo "$d" | tr / _)
    helm dependency build "$d" >/dev/null 2>"$out/$n.err" && helm template rel "$d" > "$out/$n.yaml" 2>"$out/$n.err" \
      || { rm -f "$out/$n.yaml"; echo "FAILED $d"; }
  done)
}
lines() {    # lines <output folder>: one sorted line per rule, and per other object
  docker run --rm -v "$(cd "$1" && pwd):/out:ro" "$IMAGE_NEW" node -e '
    const fs = require("fs"), yaml = require("js-yaml"), dir = "/out"
    const number = s => s.replace(/\b\d+(\.\d+)?e\+\d+\b/g, n => String(Number(n)))
    const out = []
    for (const f of fs.readdirSync(dir).filter(f => f.endsWith(".yaml"))) {
      for (const o of yaml.loadAll(fs.readFileSync(dir + "/" + f, "utf8"))) {
        if (!o) continue
        const groups = o.spec && o.spec.groups
        if (!groups) { out.push(`${f} ${JSON.stringify(o)}`); continue }
        out.push(`${f} ${o.kind} ${JSON.stringify(o.metadata)}`)
        for (const { rules, ...g } of groups) for (const r of rules) out.push(number(`${f} ${o.kind} ${o.metadata.name} ${JSON.stringify(g)} ${JSON.stringify(r)}`))
      }
    }
    console.log(out.sort().join("\n"))'
}
git clone -q . ../before && (cd ../before && git checkout -q before-3.0.0)
render ../before ../out-before; lines ../out-before > ../before.txt
```

A deployment reported as `FAILED` does not deploy today; step 3 fixes it.

## 3. Fix what is refused (still on 2.x)

In the 2.x editor or by hand, keeping what is deployed where it deploys:

| `check-repo` says | Fix | Deploys afterwards |
|---|---|---|
| `"abc" is not a number`, `must be a list of rows`, `true is not text` | Correct the value; quote a text (`'yes'`) | It failed before: new alerts |
| `Helm reads 010 as 8` | Write `8`; or `10` if that was meant. In a number column, do not quote it | The same with `8` |
| `the values are not under <chart>` | Put them under the chart's name | **Alerts that were never deployed: check them first** |
| `Helm reads yes as true` (a condition) | `true` | The same |
| `the key … is written twice` (warning) | Keep the last one | The same |
| `asks for the Template … at version` | `version: ">=0.0.0-0"` | It failed before |
| `templates/prometheus-rule.yaml repeats … rules` | Delete that file | Each alert once instead of twice |
| `{{ with no }} after it` | Close it in `rules/`, save the Template | It failed before |
| `routing.yaml: … to must be an e-mail address`, a webhook URL | Correct it on the Routing page | The corrected config |
| A sync target `is not its source's` | Unlink it to keep what it deploys, or save the source to overwrite it | As you choose |
| A sync target's `Template … is not in the repo` | Correct `repository: file://…` in its `Chart.yaml` | It failed before |
| A folder that is a link (step 1.4) | Remove the link; make the target with **Sync to...** | The same |

Optional, for later use of `_common`: 2.x wrote one exact version into each
deployment, and 3.0.0 cannot put such a deployment under a `_common`.
`">=0.0.0-0"` renders the same (review the diff: this rewrites every
dependency version):

```bash
grep -rlE '^ +(- )?version: "?[0-9]' deployments --include=Chart.yaml \
  | xargs sed -i -E 's/^( +(- )?version: ).*/\1">=0.0.0-0"/'
```

Commit on 2.x, then render again and compare. Expect only what the table says:

```bash
git clone -q . ../fixed && render ../fixed ../out-fixed
lines ../out-fixed > ../fixed.txt; diff ../before.txt ../fixed.txt
```

`check-repo` now lists only `products are out of date`, routing that is behind,
and warnings.

## 4. Regenerate

Upgrade the server to 3.0.0 (the image, with the corrected `RULE_OBJECT_*`),
then in a clone, with the same variables exported:

```bash
status=0
for c in charts/*/; do
  [ -d "$c/rules" ] || continue      # a 1.x chart would be converted: leave it
  af "$IMAGE_NEW" node scripts/gen-rules.mjs "/work/$c" || status=1
done
echo "exit $status"                  # 0
for c in charts/*/; do
  [ -d "$c/rules" ] || continue
  af "$IMAGE_NEW" node scripts/gen-rules.mjs "/work/$c" --check || echo "DIFFERS $c"
done
```

A chart named with `ERROR` is left as it was: correct its `rules/` and repeat.

## 5. Commit and check

Open the repo in the 3.0.0 editor and commit, with nothing else in it. If it
is refused because routing is behind (the object labels changed), use
**Regenerate** in the refusal, then commit again. Then:

```bash
af "$IMAGE_NEW" node scripts/check-repo.mjs /work; echo "exit $?"     # 0
git clone -q . ../after && render ../after ../out-after
lines ../out-after > ../after.txt; diff ../fixed.txt ../after.txt
```

`exit 0` and an empty `diff` is the result to expect. What may differ:

| Difference | Why |
|---|---|
| A large number: `1.5e+06` → `1500000` | The same value; `lines` already treats them as equal |
| An alert named like `on` or `2026-11-22` | Now quoted; before, Kubernetes read it as another type |
| An AlertmanagerConfig's labels | The object labels changed since it was made |

Anything else is a reason to stop and restore (below). Push and merge, let the
GitOps tool sync, and check that the evaluator loaded the same alerts.

## 6. Everyone's workspace

A branch from before the upgrade is refused at Commit (`products are out of
date`). Without unmerged commits: Git → **Sync to latest main**. With them:
`git merge origin/main`, then regenerate a Template that conflicts.

## Rolling back to 2.3.0

2.3.0 renders what 3.0.0 wrote; its editor refuses commits until the generated
files are its own again.

| Since the upgrade | Do |
|---|---|
| Nothing | `git revert <the regenerate commit>` (keep the fixes), or go back to `before-3.0.0` |
| Ordinary work: values, deployments, Template rules, sync | Do not revert (it conflicts in the generated files). Switch the image back, run step 4's loop with `IMAGE_OLD`, commit. With `--check`, an `ERROR` names a chart that uses something new |
| A new type, group `name:`, `rowIdentity`, new group fields | Take it out in 3.0.0, or revert that commit; then as above |
| Shared configs (`_shared/`) | Put the configs back into each `routing.yaml` in 3.0.0, or revert that commit; then as above. 2.3.0 cannot edit such a routing, but what was generated still deploys |
| **`_common`** | Remove every `_common` in 3.0.0 **before** switching back, or revert the commits that made them. 2.3.0 does not refuse such a repo: what is deployed stays the same, but its editor shows these deployments with no alerts and nothing to edit, and a save sent to its API replaced a deployment's values |

Find them first:

```bash
find deployments -type d -name _common
ls _shared 2>/dev/null
grep -rnE '^(name|rowIdentity):|^type: *(prometheus2|prometheus3|vm)\b' charts/*/rules
for c in charts/*/; do [ -d "$c/rules" ] && af "$IMAGE_OLD" node scripts/gen-rules.mjs "/work/$c" --check; done   # ERROR: uses something new
```

Set the environment back too: 2.3.0 also accepts the corrected `RULE_OBJECT_*`.

## Tested

Once, on a repo made with 2.3.0 (8 Templates, 20 deployments, routing, sync,
one case of each refusal above), from source checkouts of both releases:

| Step | Result |
|---|---|
| `check-repo` before | Exit 2 for the bad variable; then exit 1, 26 refused |
| After the fixes (2.3.0 commit) | 10 refused, all out of date or routing behind |
| Regenerate and commit in 3.0.0 | Refused once for routing; after **Regenerate**, committed; `check-repo` exit 0 |
| Rules before and after regenerating, parsed | 141 and 141; 13 written as a plain number, 1 alert name quoted, 6 AlertmanagerConfigs with the new label |
| Helm 3.19.0 and 3.15.4 | The same rendered files, and `check-repo` exit 0 on both |
| 2.3.0 on the tag | Renders the same 149 rules; commits |
| 2.3.0 after reverting the regenerate commit | The same files as before it; commits |
| 2.3.0 on the upgraded repo | Renders the same; commit refused until its `gen-rules` ran, then commits |
| `_common`, removed in 3.0.0 or reverted | The files are as before it |

The 3.0.0 image, built locally, gave the same: `gen-rules` wrote the same files
and `check-repo` exited 0. Not run: the released images, a cluster, the
editor's pages (the API was used).
