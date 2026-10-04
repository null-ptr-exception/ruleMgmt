# Upgrading to 2.0

2.0 moves a chart's source from `values.schema.json` to `rules/*.yaml` (see
[rules-format.md](rules-format.md)). The alert rules a deployment renders do
not change — same alerts, same expressions, same labels. What changes is how
they are packaged and how a chart is edited:

| | 1.x | 2.0 |
|---|---|---|
| A chart's source | `values.schema.json` (`x-promql`, `x-for`, …) | `rules/*.yaml`; schema and `templates/` are generated |
| Rule object names | `<release>-alerts` (one object), or `<release>-<group>` (one per group) | `<release>-<group>-<n>-<m>`, one or more per group |
| Object labels and annotations | whatever is in `templates/`, by hand | `RULE_OBJECT_LABELS` / `RULE_OBJECT_ANNOTATIONS` |

Converting a chart is one-way: once it has `rules/`, that is its source. To go
back, revert the commit that converted it.

The last 1.x release is **v1.5.1** — the image to return to if you need to.

## Before you start

**1. Carry over object labels.** Prometheus and VMAlert usually load only rule
objects carrying certain labels (`ruleSelector`). 1.x generated none of these;
if your `templates/` have them, they were added by hand, and converting a
chart regenerates `templates/` without them. The rules then deploy fine and
are **never loaded, with no error**. Check what your evaluators select on:

```bash
kubectl get prometheus -A -o custom-columns='NAME:.metadata.name,SELECTOR:.spec.ruleSelector'
kubectl get vmalert -A -o custom-columns='NAME:.metadata.name,SELECTOR:.spec.ruleSelector'
```

and set the same labels where the platform is deployed — in
`singleuser.extraEnv` of `k8s/jupyterhub-values.yaml`, next to `GITOPS_DIR` —
and in the shell that runs `gen-rules` below:

```bash
RULE_OBJECT_LABELS='{"release":"kube-prometheus-stack"}'
```

**2. Check that old objects are pruned.** Every rule object is renamed (see
the table above). If the GitOps tool syncing your deployments does not prune
(Argo CD: `syncPolicy.automated.prune`, or a manual prune), the old objects
stay next to the new ones and **every alert fires twice**.

**3. Plan to convert every chart in one go.** In 2.0.0, a commit is refused
while any chart in the repository is still in the 1.x format — including a
commit that only edits a deployment's values. Convert all charts before
anyone commits on 2.0.0. A later 2.0.x lifts this, so that charts can be
converted one at a time (#79).

## Converting

Do this on a copy of your gitops repository first, then for real.
`gen-rules` is in this repository: run it from a checkout of the 2.0 release
(after `npm ci`), pointing it at each chart in the gitops repository.

```bash
export RULE_OBJECT_LABELS='{"release":"kube-prometheus-stack"}'   # step 1

for chart in /path/to/gitops/charts/*/; do
  node scripts/gen-rules.mjs "$chart"
done
```

`gen-rules` writes `rules/`, then regenerates `values.schema.json` and
`templates/` from it. Run it again with `--check`; it should report no
problems.

**Commit the output on its own** — nothing else in that commit — so that it
can be reverted in one step. One commit per chart is easier still.

## Checking

For each deployment, render it before and after and compare:

```bash
helm template <release> <deployment-dir> > before.yaml   # on the commit before
helm template <release> <deployment-dir> > after.yaml    # on the converted commit
dyff between before.yaml after.yaml
```

Expect the rules to be the same and only the objects to differ: new names,
one or more objects per group, and the labels from `RULE_OBJECT_LABELS`. A
rule that differs, or labels your evaluator selects on going missing, is a
reason to stop.

After the sync, check that the evaluator loaded the new objects and that the
old ones are gone.

## Afterwards

Changing `RULE_OBJECT_LABELS` later marks every converted chart stale, and
commits are refused until they are regenerated — run `gen-rules` on each again
and commit the result on its own.
