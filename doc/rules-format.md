# The rules format

The file a template owner edits, and the only source in a chart. Everything
else — `values.schema.json`, `templates/` — is generated from it and should
never be hand-edited.

For what the pieces mean and why they work this way, see
[alert-rules.md](alert-rules.md). For the steps to do something, see
[how-to.md](how-to.md). The design discussion is in issue #57.

> This describes the format as specified. The editor still reads and writes
> `values.schema.json` until the file-backed path lands; a chart with no
> `rules/` directory is read through the upgrade adapter and rewritten into
> this format the next time it is saved.

## Where it lives

```
charts/<chart>/
  rules/
    _common.yaml           ← chart-level columns (optional)
    mariadb_traffic.yaml   ← one file per alert group
    mariadb_cpu.yaml
  values.schema.json       ← generated
  templates/*.yaml         ← generated
  values.yaml              ← the chart's own default rows, edited separately
  Chart.yaml
```

**The filename is the group's identity.** It is used verbatim as the values
key, so it uses the same underscore form: `mariadb_traffic.yaml` gives
`.Values.mariadb_traffic`. Hyphenated forms appear only in what the generator
emits, and are derived from it — nothing is ever derived in the other
direction.

## A group file

```yaml
group: mariadb_traffic          # optional; if present it must equal the filename
interval: 1m                    # optional, Prometheus rule group field
limit: 0                        # optional, Prometheus rule group field

vars:                           # optional — edit-time text, never a column
  recv: rate(node_receive_bytes_total{namespace="${namespace}", pod=~"${pod_regex}"}[5m])

columns:                        # the table the rule owner fills in
  namespace:  { type: string, required: true, description: "Kubernetes namespace" }
  pod_regex:  { type: string, default: ".*",  description: "Which pods to watch" }
  recv_warn:  { type: number, default: 10000000 }
  recv_crit:  { type: number, default: 50000000 }

rules:                          # what is evaluated against each row
  - alert: MariaDBReceiveHigh
    expr:  ${recv} > ${recv_warn}
    for:   5m
    labels:      { severity: warning }
    annotations: { summary: "receive is {{ $value }} B/s on {{ $labels.pod }}" }
    note: "Threshold raised after the 2024-11 incident."

  - alert: MariaDBReceiveHigh
    expr:  ${recv} > ${recv_crit}
    for:   5m
    labels:      { severity: critical }
    annotations: { summary: "receive is {{ $value }} B/s on {{ $labels.pod }}" }
```

Everything outside `columns` and `vars` is, field for field, a Prometheus rule
group. Rules pasted in from an existing rule file map across one field at a
time.

**Two rules with the same `alert` name and different `severity` is the normal
way to write bands** — that is what Alertmanager routes on. The shared part of
the query lives in `vars` so there is only ever one copy of it.

## Fields

### Group level

| Field | Required | Meaning |
|---|---|---|
| `group` | no | Must equal the filename if present |
| `interval` | no | How often Prometheus evaluates this group |
| `limit` | no | Maximum series the group may produce |
| `vars` | no | Edit-time text substitutions |
| `columns` | no | The table's columns |
| `rules` | yes | The rules |

Any other key is rejected. Unknown keys are never ignored silently: a typo
(`intervel:`) is caught at save time, and widening the list later stays safe.

### `columns`

| Field | Meaning |
|---|---|
| `type` | `string` or `number` — decides the field the rule owner gets, and what Helm accepts |
| `required` | Helm refuses values that leave it out |
| `default` | Used when a row leaves the cell empty. See [empty cells](#empty-cells) |
| `enum` | A fixed set of choices — the rule owner gets a dropdown instead of a free text field |
| `description` | Shown to the person filling the table in |

### `rules`

| Field | Meaning |
|---|---|
| `alert` | The alert name. Written by you; the generator never composes one |
| `expr` | PromQL, with `${…}` placeholders |
| `for` | A duration, or a placeholder |
| `keep_firing_for` | Passed through |
| `labels` | A map. Values may be literal, a placeholder, or a Prometheus template |
| `annotations` | Same as labels |
| `raw` | A hand-written `rules[]` entry — see [the escape hatch](#the-escape-hatch) |
| `note` | Why this rule is the way it is. Never reaches the alert |

Any other key is rejected. A rule that needs a field the list does not cover
goes through `raw`.

### `vars`

A flat map of name to text, substituted when the templates are generated. A
`vars` entry is **not** a column: the rule owner never sees it and cannot
change it.

```yaml
vars:
  recv: rate(node_receive_bytes_total{namespace="${namespace}"}[5m])
```

The text may reference columns — they are resolved after the substitution, like
any other reference.

- A `vars` entry may not reference another `vars` entry.
- A `vars` name may not collide with a column name. A collision is rejected
  rather than resolved by precedence: any precedence rule leaves someone
  staring at a substitution that came out wrong with no way to see why.

## Placeholders

Two syntaxes coexist and must not be confused.

| Written as | Belongs to | Resolved when |
|---|---|---|
| `${name}` | us | The templates are generated |
| `{{ … }}` | Prometheus | The alert fires |

`{{ $value }}`, `{{ $labels.pod }}` and the rest are passed through untouched —
write them exactly as you would in a hand-written rule. The escaping that keeps
Helm from eating them is added by the generator; you never see it.

### Resolution

Every string field — `expr`, `for`, label values, annotation values, and the
whole of a `raw` entry — goes through the same five steps:

1. Expand `vars` (text substitution)
2. Reject any `{{ … }}` that now contains a `${` — see below
3. Every remaining `${name}` must be a column or a `_common` column
4. Escape `{{ … }}` so Helm passes it through
5. Substitute columns with their Helm references

Step 2 runs after step 1 so that nesting introduced by a `vars` entry is caught
too — otherwise the expression looks clean and the problem hides in `vars`.

### Names

`vars`, this group's `columns`, and `_common`'s columns share one flat
namespace and may not collide. `selector` is reserved.

Names match `[A-Za-z_][A-Za-z0-9_]*`.

### The one thing you cannot write

`${…}` inside `{{ … }}`:

```yaml
summary: "{{ humanize ${recv_warn} }}"      # rejected
```

Escaping happens before substitution, so the whole span would be passed through
as literal text and the column's value would never be substituted — silently.
Writing the two separately is fine and reads better:

```yaml
summary: "{{ humanize $value }} exceeded ${recv_warn}"
```

There is no way to emit a literal `${…}`. PromQL does not use the syntax and
label values almost never do.

## Empty cells

What happens when a rule owner leaves a cell empty depends on the column, in
this order.

**Does the column have a `default`?** Then that value is used and nothing else
happens.

Most columns get one for free: marking a literal as a variable stores the
literal it replaced as the default, so marking something and then filling in
nothing renders exactly what it rendered before.

**No default — then it depends where the column is referenced:**

| Referenced in | An empty cell means | What is emitted |
|---|---|---|
| `expr` or `for` | This rule does not apply to this row | **The whole rule is omitted for that row** |
| A label or annotation whose entire value is `${x}` | This row has no such label | That line is omitted |
| The middle of a longer string | Neither omission makes sense | **Rejected at save time** — give it a default or make it required |

The principle is to omit the smallest unit that still means something.

**Clearing a default is how you say "leaving this blank is meaningful."** Four
thresholds bounding three rules is the usual case: clear the defaults on the
last two, and a row that fills only the first two produces only the first rule.

Because of this, changing a default is a breaking change: removing one turns
"these rows get 80" into "these rows produce no alert at all", silently. Saving
a schema that removes or changes a default goes through the same dialog as
removing a column.

## `_common.yaml`

Columns that belong to the chart rather than to one group: filled in once per
deployment, read by every row of every group.

```yaml
# rules/_common.yaml
columns:
  cluster: { type: string, required: true }
  env:     { type: string, enum: [dev, staging, prod] }
```

Typically `cluster`, `env`, `team` — one value for the whole deployment, but
every row needs it. Putting them in the table would mean retyping them on every
row.

## The escape hatch

When a rule needs something the fields do not cover, write that one entry as
YAML:

```yaml
rules:
  - raw: |
      alert: SomethingUnusual
      expr: rate(x[5m]) > ${threshold}
      keep_firing_for: 10m
      limit: 100
```

**One `rules[]` entry is as large as it gets.** The resource around it, the row
loop and the sharding stay with the generator, so a hand-written entry can
still be sharded and still be emitted as another kind of resource. `${…}` still
reads the row and `{{ … }}` is still Prometheus.

This is what lets the field whitelist be strict: anything the model does not
cover has somewhere to go, so rejecting unknown keys costs nobody anything.

## What is rejected at save time

- A key that is not in the whitelist, at any level
- `${…}` naming something that is not a column
- `${…}` inside `{{ … }}`
- A name shared between `vars` and a column, or a name that is `selector`
- A `vars` entry referencing another `vars` entry
- An optional column with no default referenced from the middle of a string
- `group:` not matching the filename

And, before a commit:

- A rule that references no column at all — it would be emitted once per row,
  identical every time. Save allows it (a chart being variabilised passes
  through this state); committing does not.

## What gets generated

Two things, both products:

**`values.schema.json`** — validates a deployment's values, and describes the
table the rule owner fills in. `columns` become `items.properties`, `_common`
becomes `properties._common`. It carries no rule definitions at all.

**`templates/<group>.yaml`** — one file per group, emitting one or more
`PrometheusRule` objects:

```
{release}-{group}-{shard}-{chunk}
```

Both indices are always present, even when there is only one of each. Adding
the index only past a threshold would rename the first object the moment a
deployment crossed it — and renaming a resource deletes the old one and creates
a new one, at a threshold nobody is watching.

- **shard** — rules are packed into shards that stay inside a per-object byte
  budget. Known when the templates are generated
- **chunk** — rows are chunked at a fixed size by the template itself. Only
  known when Helm renders

Neither ever changes an alert's identity: the `alert` names and labels are
identical however the group is split. Only `metadata.name` differs.

## Names, one source

Everything about a group is derived from the filename:

```
rules/mariadb_traffic.yaml
  ├─ values key         .Values.mariadb_traffic
  ├─ group name         mariadb-traffic
  ├─ template file      templates/mariadb-traffic.yaml
  ├─ object name        {release}-mariadb-traffic-1-1
  └─ shown in the UI    mariadb_traffic
```

Renaming a group means renaming the file. Every deployment's values key changes
with it, so it goes through the breaking-change dialog like any other rename —
the mapping is declared there and applied to every affected `values.yaml`.

## Reserved for later: `selectors`

A group may declare its selector columns, coarsest first:

```yaml
selectors: [namespace, workload, pod]
```

Declaring it turns on automatic exclusion: a row whose column is `.*` stops
covering whatever a more specific row covers, so a baseline and its exceptions
can live in the same table without overlapping and without anyone maintaining
an exception list. `${selector}` then stands for the computed matcher set:

```yaml
rules:
  - alert: CPUHigh
    expr: cpu{${selector}} > ${threshold}
```

Declaring it also restricts those columns to a literal string or `.*` — telling
which of two regexes is the more specific one is not decidable, and the whole
mechanism rests on that comparison.

**Not implemented yet.** The key is reserved so that adding it later is not a
schema change. See issue #57 for the full contract.
