# Alert rules: from rules/ to a PrometheusRule

How a chart describes alerts, who owns which part, and what the generator does
with it. For the steps to actually do something, see [how-to.md](how-to.md);
for every field of the file format, see [rules-format.md](rules-format.md).
Design discussion and the reasoning behind the decisions live in issue #57.

## The shape of it

One chart, one `rules/` directory. That is the only source; `values.schema.json`
and everything under `templates/` are generated from it and should never be
hand-edited.

```
charts/<chart>/
  rules/
    _common.yaml         ← the source: chart-level columns
    <group>.yaml         ← the source: one file per alert group
  values.schema.json     ← generated
  templates/*.yaml       ← generated, one file per alert group
deployments/<chart>/…    ← or any folder: a deployment's rows
  <name>-values.yaml
```

Two people work on two different halves:

| | Who | What they own |
|---|---|---|
| Template | template owner | `rules/*.yaml` — the columns, and the expressions, labels, annotations and `for` that read them |
| Table | rule owner | the rows: which namespaces, which thresholds |

The table's **columns** are declared in the rules files; the table's **rows**
are the deployment's `values.yaml`. The generated `values.schema.json` is what
turns one into a check on the other: it is the form the rule owner fills in,
and what Helm validates their values against. It carries no rule definitions.

## A group file

```yaml
# rules/network_traffic.yaml
columns:
  namespace: { type: string, required: true }
  pod_regex: { type: string, required: true }
  window:    { type: string, default: 5m }
  recv_warn: { type: number, default: 10000000 }
  xmit_warn: { type: number, default: 10000000 }

rules:
  - alert: NetworkReceiveHigh
    expr: rate(receive_bytes_total{namespace="${namespace}",pod=~"${pod_regex}"}[5m]) > ${recv_warn}
    for: ${window}
    labels: { severity: warning, namespace: "${namespace}" }
    annotations: { summary: "receive is {{ $value }} B/s on {{ $labels.pod }}" }

  - alert: NetworkTransmitHigh
    expr: rate(transmit_bytes_total{namespace="${namespace}",pod=~"${pod_regex}"}[5m]) > ${xmit_warn}
    for: ${window}
    labels: { severity: warning }
```

The filename is the group: `network_traffic.yaml` is read from
`.Values.network_traffic`. Everything under `rules` borrows its field names
from a Prometheus rule group's `rules[]`, so what you already know about
writing rules carries over. It is not a loadable rules file, though — the
values carry placeholders, and it is a template.

**One table, several rules.** Every rule in a group reads the same row, which
is the point: a row describes one monitored scope, and `pod_regex` is filled
once no matter how many alerts watch it.

### Columns

A column is just a typed column. There are no roles — a rule refers to one by
name and that is the whole relationship. `type`, `default`, `enum` and
`required` control what the rule owner's form accepts and what Helm will
validate.

Which columns belong to which rule is worked out from the placeholders each
rule references, across `expr`, `for`, `labels` and `annotations`. Nothing is
declared.

A column with a `default` carries it into the template, so a row that leaves
the cell empty renders the default. A column without one may genuinely be
left out, and then the rule, or the one label, that reads it is omitted for
that row. [rules-format.md](rules-format.md#empty-cells) has the full rule.

Columns every group needs — a cluster, an environment, an owning team — go in
`rules/_common.yaml` instead. They are filled in once per deployment and read
by every row of every group.

## Two kinds of placeholder

This is the one thing worth reading twice.

| Written | Belongs to | Resolved |
|---|---|---|
| `${namespace}` | this system | when the chart is rendered — becomes the row's value |
| `{{ $value }}`, `{{ $labels.pod }}` | Prometheus | when the alert fires |

Both may appear in the same string:

```yaml
summary: "receive is {{ $value }} B/s in ${namespace}"
```

The generator escapes the Prometheus ones so Helm passes them through
untouched, and substitutes ours. Rendered, that line reads:

```yaml
summary: "receive is {{ $value }} B/s in prod"
```

You never write the escaping yourself.

## Hand-writing one rule

When a rule needs a field the model has no place for — `limit`,
`keep_firing_for` — flip **raw** on that rule and write the entry as YAML:

```yaml
rules:
  - raw: |
      alert: HandWritten
      expr: rate(x{ns="${namespace}"}[5m]) > ${warn}
      limit: 10
```

Only that one `rules[]` entry is hand-written. The resource around it, the row
loop and the sharding stay generated, so it is still rendered as whatever kind
the platform emits and is still sharded. Placeholders work exactly as
elsewhere: a raw entry is not opting out of the row model, only out of the
structure.

Toggling raw off parses it back into fields, and refuses when it cannot —
rather than dropping whatever it could not represent.

## What the generator emits

```
{{- $chunks := chunk 100 ($.Values.network_traffic | default list) }}
{{- range $chunkIndex, $rows := $chunks }}
---
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: {{ $.Release.Name }}-network-traffic-1-{{ add1 $chunkIndex }}
  labels:
    app.kubernetes.io/managed-by: Helm
spec:
  groups:
    - name: network-traffic
      rules:
        {{- $common := $.Values._common | default dict }}
        {{- range $rows }}
        {{- $row := merge . $common }}
        - alert: NetworkReceiveHigh
          expr: |-
            rate(receive_bytes_total{namespace="{{ $row.namespace }}",…}[5m]) > {{ $row.recv_warn | default 10000000 }}
          for: {{ $row.window | default `5m` }}
        {{- end }}
{{- end }}
```

Each row is merged with `_common`, so a common column reads like any other.

`expr` and annotations are literal block scalars (`|-`): nothing in them is
escaped, so multi-line expressions and descriptions, quotes, backslashes and
PromQL that YAML would otherwise misread (`{job="x"} == 0`, `"(.*): .*"`, a
`# comment`) all go through as written. Labels stay quoted strings, which is
why a label's column cannot take `"` or `\` — see
[rules-format.md](rules-format.md#what-a-rows-value-can-hold).

Output grows as **rows × rules**, and the two are cut in different places
because only one of them is knowable when the template is written:

| Dimension | Known | Cut by | Threshold |
|---|---|---|---|
| rules | at generation | the generator | a byte budget per object |
| rows | at render | the template's `chunk` | `MAX_ROWS_PER_OBJECT`, 100 |

The object name always carries both indices — `{release}-{group}-{shard}-{chunk}`
— even when there is only one of each. Adding a suffix on overflow instead
would rename the first object the moment a deployment crossed the boundary,
and a rename deletes the old resource and creates another.

Sharding may only change `metadata.name`. Alert names and labels are identical
however the output is split, so silences, inhibit rules and routing are never
affected by it.

## Keeping the generated files current

Because `values.schema.json` and `templates/` are products, they can fall
behind their source — someone edits `rules/` by hand, or the site policy below
changes. Whether they have is worked out by regenerating in memory and
comparing byte for byte, never by timestamp. A chart is in one of these
states:

| State | Means |
|---|---|
| ok | the products match what `rules/` regenerates to |
| missing | a product file is absent |
| stale | a product no longer matches, or `rules/` does not parse |
| legacy | the chart has no `rules/` yet — see below |
| empty | no rules and no alert groups |

It shows up in three places. Opening a chart in the editor regenerates
missing products and says when the rest are stale; Save regenerates them.
Preview tells the rule owner the output may be behind. And a commit is refused
while any chart is stale or legacy.

### Charts that are not migrated yet

A chart from before `rules/` keeps everything in `values.schema.json`, with an
`x-promql` expression per group. It still renders exactly as it always has —
quietly changing what an un-migrated chart deploys is the surprise this design
exists to avoid.

Migrating it is one step: open it in the editor and save, or run `gen-rules`
on it. Either way the schema is read once through an adapter, written out as
`rules/*.yaml`, and the products regenerated. The only change to what it
renders is the `| default` fallback on columns that have a default. The sample
chart went through exactly this, and rendered byte-for-byte the same with its
own values.

## Site policy: labels and annotations on the resource

Which labels a cluster's Prometheus selects rules by (`ruleSelector`), and
whatever an organisation's kubernetes conventions require, are set where the
platform is deployed — not in this repository and not in a gitops repo:

```bash
RULE_OBJECT_LABELS='{"release":"kube-prometheus-stack"}'
RULE_OBJECT_ANNOTATIONS='{"alertforge.io/source":"generated"}'
```

Both are JSON objects of string pairs, both optional. Values are literal: one
containing `{{ }}` is dropped with a warning rather than escaped, since a label
that silently reads `{{ $.Release.Name }}` in the cluster is worse than one
that never appears. An empty value omits its key.

> If your Prometheus has a `ruleSelector`, rules without the labels it matches
> are **silently ignored** — no error, nothing in `/rules`. Check with:
>
> ```bash
> kubectl get prometheus -A -o custom-columns='NAME:.metadata.name,SELECTOR:.spec.ruleSelector'
> ```

Changing the configuration does not rewrite templates that already exist. They
are a product and turn stale; regenerate them, and `gen-rules --check` reports
the drift until you do.

## Importing existing rules

Bringing in rules that were never in this system: in the editor,
**New → From rules…** for a new chart and **Import** for one already open. It
accepts a PrometheusRule resource, a rule file with a top-level `groups:`, or
a bare list of rule entries.

Import is a one-off conversion at the boundary, not a link. Once the rules
files exist, the pasted YAML has no further role.

**Nothing is inferred.** Every literal stays a literal, because only a person
knows whether `namespace="prod"` varies per row or is part of the query — so an
imported chart initially renders exactly what was pasted. Marking the literals
that vary is the next step, in the editor. The one guess is a column's starting
type: a placeholder on the right of a comparison starts as a number, because
typing it as a string would make Helm reject the values it is meant to hold.

Recording rules are skipped. A rule keeping a field the model has no place for
arrives hand-written rather than losing it.

A placeholder naming a column the chart already has in `_common` reads it
from there; it does not become a second column of the group.

Multi-line expressions and descriptions arrive as they are, and render as
they are. To check an imported chart against the file it came from, compare
the rendered rules as YAML (`dyff`, or parse both), not as text: the generator
writes `expr` and annotations as block scalars, so the same rule is formatted
differently from a hand-written one.

Importing into an open chart edits the chart in hand, so it inherits every
check Save already makes; cancelling is just not saving.
`scripts/import-rules.mjs` does the same from the command line, with one
difference: it cannot see the deployments using the chart, so a replaced group
that drops a column is a warning there rather than the breaking-change dialog.

## When an upgrade changes the output format

The products are regenerated from `rules/`, so a release that changes how the
generator writes them makes every migrated chart `stale` at once — the editor
shows the banner, and a commit is refused — even though no rule changed.
Version 1.6 is one: `expr` and annotations moved to block scalars.

After upgrading, regenerate every chart once and commit the result on its
own (see [how-to](how-to.md#regenerate-every-chart-after-an-upgrade)). What
Helm renders parses to the same rules as before, so the resources in the
cluster do not change and a tool that compares objects, like Argo CD, sees no
difference. Review the commit with a YAML-aware diff (`dyff`), not a text one:
every `expr` line moves.

The one thing not kept is trailing whitespace at the end of a value — a
summary ending in a column that was empty used to render with a trailing
space. It means nothing to PromQL or an annotation.

## Changing a chart that people are already using

Removing a column or a group or a rule, renaming a group, narrowing a type,
making a column required, or removing or changing a default all affect
`values.yaml` files that already exist. Save stops and opens a dialog that
lists every affected deployment and walks through the change:

1. **Summary** — what needs a decision (a column or group that goes away) apart
   from what is only for information (a narrowed type, a new required column,
   a changed default, a dropped rule)
2. **Mapping** — for each column that goes away, keep its values under another
   column of the same group, or delete them
3. **Preview** — per deployment, the rows that change and the values that are
   lost

**Change in place** then rewrites the chart and every affected deployment's
values in one step. Deployments that follow another through sync are left for
their source and follow it.

Nothing is guessed: `warn_pct → warn_ratio` could be a rename or a delete plus
an add, and only the person making the change knows which, so every mapping
starts as delete. When the change should not reach existing deployments yet,
**Clone to a new chart** instead: the copy carries the edits and the declared
mapping as `x-migrated-from`, the original is untouched, and each rule owner
moves over when they are ready.

## Command line

```bash
# migrate a chart to rules/, or regenerate the schema and templates from rules/
node scripts/gen-rules.mjs <chart-dir>

# compare instead of writing
node scripts/gen-rules.mjs <chart-dir> --check

# import rules into a chart's rules/
node scripts/import-rules.mjs <rules.yaml> <chart-dir> [--dry-run]
```

Once a chart has `rules/`, `gen-rules` treats it as the source and never
rewrites it: comments and formatting added by hand survive, the same as a save
in the editor. Only a migration writes rules files.

`gen-rules --check` is worth wiring into CI or a pre-commit hook. It is what
enforces "`rules/` is the source" when files are committed by hand.
(`gen-chart.mjs` is the older, templates-only tool; it reads groups from the
generated schema, so it misses a group added to `rules/` by hand.)

## What holds it together

Four checks, each guarding a different failure:

1. **Round-trip** — the sample chart is committed fully generated, and a test
   requires both `--check` runs on it to be clean. A generator change that
   moves its output has to be regenerated and reviewed on purpose.
2. **Schema validation** — Helm validates every `values.yaml` against the
   generated schema, so a wrong type or a missing required column fails the
   render.
3. **Save-time checks** — every `${var}` names a column that exists, no `${…}`
   sits inside a `{{ … }}`, and no optional column without a default is read
   from the middle of a string. Enforced in the editor, the CLI and on import;
   the full list is in [rules-format.md](rules-format.md#what-is-rejected-at-save-time).
4. **Commit-time checks** — the same, plus no rule that reads no column, and
   no chart that is stale or not migrated.
