# Alert rules: from a schema to a PrometheusRule

How a chart describes alerts, who owns which part, and what the generator does
with it. Design discussion and the reasoning behind the decisions live in
issue #57.

## The shape of it

One chart, one `values.schema.json`. That file is the only source; everything
under `templates/` is generated from it and should never be hand-edited.

```
charts/<chart>/
  values.schema.json     ← the source
  templates/*.yaml       ← generated, one file per alert group
deployments/<chart>/…    ← or any folder: a deployment's rows
  <name>-values.yaml
```

Two people work on two different halves of the schema:

| | Who | What they own |
|---|---|---|
| Template | template owner | `x-rules` — the expressions, labels, annotations, `for` |
| Table | rule owner | the rows: which namespaces, which thresholds |

The table's **columns** are declared in the template half (`items.properties`);
the table's **rows** are the deployment's `values.yaml`. So the schema is
simultaneously the generator's input, the form the rule owner fills in, and
what Helm validates their values against.

## The schema

```json
{
  "properties": {
    "network_traffic": {
      "type": "array",
      "x-rules": [
        {
          "alert": "NetworkReceiveHigh",
          "expr": "rate(receive_bytes_total{namespace=\"${namespace}\",pod=~\"${pod_regex}\"}[5m]) > ${recv_warn}",
          "for": "${window}",
          "labels": { "severity": "warning", "namespace": "${namespace}" },
          "annotations": { "summary": "receive is {{ $value }} B/s on {{ $labels.pod }}" }
        },
        {
          "alert": "NetworkTransmitHigh",
          "expr": "rate(transmit_bytes_total{namespace=\"${namespace}\",pod=~\"${pod_regex}\"}[5m]) > ${xmit_warn}",
          "for": "${window}",
          "labels": { "severity": "warning" }
        }
      ],
      "items": {
        "properties": {
          "namespace": { "type": "string" },
          "pod_regex": { "type": "string" },
          "window":    { "type": "string" },
          "recv_warn": { "type": "number" },
          "xmit_warn": { "type": "number" }
        },
        "required": ["namespace", "pod_regex"]
      }
    }
  }
}
```

`x-rules` borrows its field names from a Prometheus rule group's `rules[]`, so
what you already know about writing rules carries over. It is not a loadable
rules file, though — the values carry placeholders, and it is a template.

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

> Older charts still carry `x-var-type: selector` / `threshold` on their
> columns. Those are read only by the compatibility path for `x-promql` groups
> and mean nothing to an `x-rules` group.

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
  name: {{ $.Release.Name }}-network-traffic-{{ add1 $chunkIndex }}
  labels:
    app.kubernetes.io/managed-by: Helm
spec:
  groups:
    - name: network-traffic
      rules:
        {{- range $rows }}
        - alert: NetworkReceiveHigh
          expr: rate(receive_bytes_total{namespace="{{ .namespace }}",…}[5m]) > {{ .recv_warn }}
          for: {{ .window }}
        {{- end }}
{{- end }}
```

Output grows as **rows × rules**, and the two are cut in different places
because only one of them is knowable when the template is written:

| Dimension | Known | Cut by | Threshold |
|---|---|---|---|
| rules | at generation | the generator | a byte budget per object |
| rows | at render | the template's `chunk` | `MAX_ROWS_PER_OBJECT`, 100 |

The object name always carries its index, even when there is only one chunk.
Adding the suffix on overflow instead would rename the first object the moment
a deployment crossed the boundary, and a rename deletes the old resource and
creates another.

Sharding may only change `metadata.name`. Alert names and labels are identical
however the output is split, so silences, inhibit rules and routing are never
affected by it.

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
are a product; regenerate them, and `gen-chart --check` reports the drift until
you do.

## Importing existing rules

Bringing in rules that were never in this system:

```bash
node scripts/import-rules.mjs <rules.yaml> <chart-dir> [--dry-run]
```

or, in the editor, **New → From rules…** for a new chart and **Import** for one
already open. It accepts a PrometheusRule resource, a rule file with a
top-level `groups:`, or a bare list of rule entries.

Import is a one-off conversion at the boundary, not a link. Once the schema
exists, the pasted YAML has no further role.

**Nothing is inferred.** Every literal stays a literal, because only a person
knows whether `namespace="prod"` varies per row or is part of the query — so an
imported chart initially renders exactly what was pasted. Marking the literals
that vary is the next step, in the editor. The one guess is a column's starting
type: a placeholder on the right of a comparison starts as a number, because
typing it as a string would make Helm reject the values it is meant to hold.

Recording rules are skipped. A rule keeping a field the model has no place for
arrives hand-written rather than losing it.

Importing into an open chart edits the schema in hand, so it inherits every
check Save already makes; cancelling is just not saving.

## Changing a schema that people are already using

Removing a column or a group or a rule, narrowing a type, making a column
required, or moving one to the chart level all invalidate `values.yaml` files
that already exist. Save refuses, naming what breaks and who is affected.

Nothing is migrated automatically: `warn_pct → warn_ratio` could be a rename or
a delete plus an add, and only the person making the change knows which. The
way through is to clone the chart, change the copy, and let each rule owner
move over when they are ready — the original keeps working meanwhile. The
mapping their rows need is declared at clone time and stored on the clone as
`x-migrated-from`.

## Command line

```bash
# generate templates from a schema
node scripts/gen-chart.mjs <chart-dir>

# compare instead of writing: reports any drift between schema and templates
node scripts/gen-chart.mjs <chart-dir> --check

# import rules into a chart's schema
node scripts/import-rules.mjs <rules.yaml> <chart-dir> [--dry-run]
```

`--check` is worth wiring into CI or a pre-commit hook. It is what enforces
"the schema is the source" when templates are committed by hand, and it is what
caught the sample chart drifting for three months.

## What holds it together

Three checks, each guarding a different failure:

1. **Round-trip** — an existing chart passed through the generator produces
   byte-identical templates. This is what makes changing the generator safe.
2. **Schema validation** — Helm validates every `values.yaml` against the
   schema, so a wrong type or a missing required column fails the render.
3. **Reference completeness** — every `${var}` names a column that exists.
   Enforced in the editor, the CLI and on import; a dangling one would render
   as an empty value.
