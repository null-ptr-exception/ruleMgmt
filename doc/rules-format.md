# The rules format

The file a template owner edits, and the only source in a chart. Everything
else — `values.schema.json`, `templates/` — is generated from it and should
never be hand-edited.

For what the pieces mean and why they work this way, see
[alert-rules.md](alert-rules.md). For the steps to do something, see
[how-to.md](how-to.md). The design discussion is in issue #57.

> A chart with no `rules/` directory is not migrated yet. The editor reads it
> through the upgrade adapter and writes it out in this format the next time
> it is saved; `scripts/gen-rules.mjs` does the same from the command line.

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
| `once` | no | `true`: the rules render **once per deployment** instead of once per row — see [once groups](#once-groups). A once group has no `columns` |
| `type` | no | Which kind of rules these are, and so what they are wrapped in: `prometheus` (the default — `expr` is PromQL, emitted as a `PrometheusRule`) or `vlogs` (`expr` is LogsQL, evaluated against VictoriaLogs, emitted as a `VMRule`). The choices are the profiles in `config/outputs.json` — see [output profiles](#output-profiles) |
| `interval` | no | How often the group is evaluated — a duration such as `30s`, `1m`, `1h30m`. Left out, the evaluator's own default applies |
| `limit` | no | Maximum series the group may produce — a whole number, `0` or more. Left out, there is no limit |
| `vars` | no | Edit-time text substitutions |
| `columns` | no | The table's columns |
| `rules` | yes | The rules |

Any other key is rejected. Unknown keys are never ignored silently: a typo
(`intervel:`) is caught at save time, and widening the list later stays safe.

`type`, `interval` and `limit` belong to the whole group and are the
template owner's, set per group (in the editor, the group's settings row).
Different groups in one chart may have different types.

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
| `record` | Instead of `alert`: the name of the series a recording rule records, e.g. `job:errors:rate5m`. A rule has exactly one of the two |
| `expr` | PromQL, with `${…}` placeholders |
| `for` | A duration, or a placeholder |
| `keep_firing_for` | Passed through |
| `labels` | A map. Values may be literal, a placeholder, or a Prometheus template |
| `annotations` | Same as labels |
| `raw` | A hand-written `rules[]` entry — see [the escape hatch](#the-escape-hatch) |
| `note` | Why this rule is the way it is. Never reaches the alert |

Any other key is rejected. A rule that needs a field the list does not cover
goes through `raw`.

A recording rule (`record`) has only `record`, `expr`, `labels` and `note` —
Prometheus gives it no `for`, `keep_firing_for` or annotations, and each of
those is rejected on one.

### Once groups

A group renders its rules once per row. Some rules belong once per
deployment instead: a recording rule that aggregates across everything
(`sum by (job) (rate(errors_total[5m]))`), a watchdog, an alert that reads
only chart-wide values. Put those in a group of their own and mark it:

```yaml
# rules/api_recording.yaml
once: true

rules:
  - record: job:errors:rate5m
    expr: sum by (job) (rate(errors_total{cluster="${cluster}"}[5m]))
```

- A once group has **no `columns`** — it has no rows to read them from. Its
  rules may read `_common`.
- It renders whatever `values.yaml` holds, zero rows included, and it has no
  entry in `values.schema.json`: the rule owner has nothing to fill in, and
  the Alerts page says so.
- A group cannot mix the two. A per-row rule and a once rule sit in separate
  Prometheus groups either way, and are evaluated separately — keeping them
  in separate files says so. A rule in a per-row group that reads none of its
  group's columns is refused at commit, pointing here.
- Switching a group between per-row and once renames its objects (see
  [what gets generated](#what-gets-generated)); the save says so.

Recording rules are not necessarily once. **Threshold as a metric** records
one series per row and compares against it in a single alert:

```yaml
# rules/cpu_thresholds.yaml — one recording rule per row
columns:
  namespace: { type: string, required: true }
  workload:  { type: string, required: true }
  threshold: { type: number, default: 80 }
rules:
  - record: cpu_threshold
    expr: vector(${threshold})
    labels: { namespace: "${namespace}", workload: "${workload}" }
```

```yaml
# rules/cpu.yaml — one alert, once
once: true
rules:
  - alert: CPUHigh
    expr: cpu_usage > on(namespace, workload) group_left cpu_threshold
    for: 5m
    labels: { severity: warning }
```

The two groups are evaluated separately, so a changed threshold reaches the
alert up to one evaluation later.

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

### What a row's value can hold

"Not set" means the key is absent from the row (#51) — the table drops an
empty cell on save. A key that is there holds a value, and Helm substitutes it
with no escaping. So a save is refused — naming the row and column — and
`gen-rules` warns, when:

- **A required column is missing or empty.** Helm's `required` only checks
  that the key exists, so `namespace: ""` would pass and render
  `namespace=""` — valid PromQL that matches nothing. A required `_common`
  column counts whenever the deployment has any row: with no `_common` block
  at all, Helm checks nothing and every reference renders empty.
- **`""` or `null` in any other column.** A guard reads the key as set, so
  the rule would render with the value missing. Leave the cell out instead.
- **A newline, in any column.** Values are one line; the table never
  produces one, a hand-edited `values.yaml` can.
- **`"` or `\`, in a column a label reads.** A label value is a quoted YAML
  string (see [what gets generated](#what-gets-generated)).

`expr` and annotations take anything else, which is where a regex like
`web-\\d+` usually goes. A `raw` entry is quoted by hand and is not checked.

## Empty cells

What happens when a rule owner leaves a cell empty depends on the column, in
this order.

**Does the column have a `default`?** Then that value is used and nothing else
happens. "Empty" means the key is absent from the row — the table drops an
empty cell on save — so a row that sets `0`, `false` or `""` keeps it: a
threshold of `0` against a default of `80` is `0`.

Most columns get one for free: marking a literal as a variable stores the
literal it replaced as the default, so marking something and then filling in
nothing renders exactly what it rendered before.

**No default — then it depends where the column is referenced:**

| Referenced in | An empty cell means | What is emitted |
|---|---|---|
| `expr` or `for` | This rule does not apply to this row | **The whole rule is omitted for that row** |
| A label or annotation whose entire value is `${x}` | This row has no such label | That line is omitted |
| `keep_firing_for` whose entire value is `${x}` | The alert resolves as soon as it stops matching | That line is omitted — the alert is still whole without it |
| The middle of a longer string | Neither omission makes sense | **Rejected at save time** — give it a default or make it required |

The principle is to omit the smallest unit that still means something.

**Clearing a default is how you say "leaving this blank is meaningful."** Four
thresholds bounding three rules is the usual case: clear the defaults on the
last two, and a row that fills only the first two produces only the first rule.

Because of this, changing a default is a breaking change: removing one turns
"these rows get 80" into "these rows produce no alert at all", silently. Saving
a change that removes or changes a default goes through the same dialog as
removing a column.

A default only ever applies to a column that is not `required`: a required
column left out fails Helm's schema validation before the template is reached,
so its default is never used.

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

- In a group with columns, a rule that references none of them (reading only
  `_common` counts as none) — it would be emitted once per row, identical
  every time. Save allows it (a chart being variabilised passes through this
  state); committing does not. A rule that belongs once per deployment goes in
  a [once group](#once-groups).

A once group with `columns`, a rule with both or neither of `alert` and
`record`, and a recording rule with `for`, `keep_firing_for` or annotations
are rejected at save time.

## What gets generated

Two things, both products:

**`values.schema.json`** — validates a deployment's values, and describes the
table the rule owner fills in. `columns` become `items.properties`, `_common`
becomes `properties._common`. It carries no rule definitions at all.

**`templates/<group>.yaml`** — one file per group, emitting one or more
`PrometheusRule` objects.

`expr` and every annotation are written as literal block scalars, so nothing
in them is ever escaped — several lines, a leading `{`, `: `, ` #`, quotes and
backslashes go through as written, from the source or from a row:

```yaml
- alert: MariaDBReceiveHigh
  expr: |-
    rate(node_receive_bytes_total{namespace="{{ $row.namespace }}"}[5m]) > {{ dig "recv_warn" 10000000 $row }}
  for: 5m
  labels:
    severity: warning
  annotations:
    summary: |-
      receive is {{ `{{ $value }}` }} B/s on {{ `{{ $labels.pod }}` }}
```

Label values are quoted strings, `for` and `keep_firing_for` plain. Leading
and trailing whitespace of an expression or annotation is dropped — the
trailing newline `expr: |` leaves in the source means nothing.

Objects are named:

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

A [once group](#once-groups) has no rows and so no chunk: its objects are
`{release}-{group}-{shard}`.

Neither ever changes an alert's identity: the `alert` names and labels are
identical however the group is split. Only `metadata.name` differs.

## Output profiles

What a group is wrapped in is decided by its `type`, looked up in
`config/outputs.json` in this repository. The file is part of the release —
a site does not override it; a site's own values, such as the labels a
rule evaluator selects objects by, come from the environment (see
[alert-rules.md](alert-rules.md)).

```json
{
  "outputs": {
    "prometheus": { "apiVersion": "monitoring.coreos.com/v1", "kind": "PrometheusRule", "validate": "promtool" },
    "vlogs": { "apiVersion": "operator.victoriametrics.com/v1beta1", "kind": "VMRule",
               "groupFields": { "type": "vlogs" }, "validate": "none" }
  }
}
```

| Field | Required | Meaning |
|---|---|---|
| `outputs.<name>` | — | A profile; `<name>` is what a group's `type` says. Lower-case letters, digits, `_`, `-`. `prometheus` must exist: it is the profile of a group with no `type` |
| `apiVersion`, `kind` | yes | The resource the group's objects are |
| `groupFields` | no | Fields written as they are onto every `spec.groups[]` entry of the profile's objects — strings, numbers or booleans. Not `name` or `rules` (the generator's) nor `interval` or `limit` (the template owner's) |
| `validate` | yes | `promtool`, to check the rendered rules with promtool; or `none`, for rules promtool cannot read — Preview then marks the group as not syntax-checked. There is no default |

Any other key is an error. The file is checked when the server starts and
when the frontend is built, and a mistake stops both. Changing a profile's
`kind` replaces every object that profile emits — they are deleted and
created again — so it is a release-level change.

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

## Selectors: a default with exceptions

"Most things at 80%, a few at 95%" is two rows once a group declares its
selector columns, coarsest first:

```yaml
# rules/cpu.yaml
selectors: [namespace, workload, pod]

columns:
  namespace: { type: string, required: true }
  workload:  { type: string, default: ".*" }
  pod:       { type: string, default: ".*" }
  threshold: { type: number, default: 80 }

rules:
  - alert: CPUHigh
    expr: cpu{${selector}} > ${threshold}
```

```
namespace  workload  pod    threshold   renders
prod       .*        .*     80          cpu{namespace="prod", workload!~`api`} > 80
prod       api       .*     90          cpu{namespace="prod", workload="api", pod!~`noisy`} > 90
prod       api       noisy  99          cpu{namespace="prod", workload="api", pod="noisy"} > 99
```

**Every monitored object is covered by exactly one row** — the most specific
one that matches it. A row that is `.*` in a level gives up the rows one step
more specific in that level, with one negative matcher; add a more specific
row and the one above makes way. Nobody maintains an exclusion list.

- A selector cell is `.*` or a plain name (letters, digits, `_`, `.`, `-`) —
  never a regex. Which of two regexes is more specific cannot be decided;
  which of `.*` and `api` is, can. A literal becomes an equality matcher; an
  excluded name is escaped (`my.app` → `` `my\.app` ``).
- `${selector}` stands for the matchers, in `expr` only, right after a metric
  name's `{` or a `,` inside it: with every level `.*` it expands to nothing,
  and `cpu{}` is valid where `{}` is not.
- A level can be a `_common` column (e.g. `cluster`, first). Rows are read with
  `_common` merged in and defaults applied, and every row of the group is
  compared, so an exception in another chunk of 100 rows still counts.
- Each group declares its own hierarchy; groups in one chart may use different
  columns and depths. A group without `selectors` behaves exactly as before.

What is refused when the template is saved:

| Refused | Why |
|---|---|
| A selector that is not a string column of the group or `_common` | Nothing to arrange by |
| A selector column that is optional with no default | A row leaving it empty would be neither `.*` nor a name |
| Any rule whose whole-rule reference (`expr`, `for`) is optional with no default | A row that loses its rule leaves unwatched what its parent row gave up to it |
| A rule whose `expr` does not use `${selector}`, or `${selector}` anywhere else | The rows would overlap in what that rule watches |
| `${selector}` not right after `metric{` or a `,` inside it | It can expand to nothing |
| `selectors` on a once group, or on a group whose `expr` is not PromQL | No rows; no label matchers |

What is refused when a deployment is saved, with the row that would fix it
offered alongside:

| Refused | Offered |
|---|---|
| A selector cell that is a regex | — |
| Two rows selecting the same thing | — |
| **Crossing**: `prod/.*/noisy` and `prod/api/.*` overlap on `prod/api/noisy`, and neither contains the other | The overlap as a row, thresholds left for you to fill |
| **Skipping**: `prod/api/noisy` under `prod/.*/.*` with no `prod/api/.*` between them — PromQL cannot exclude `NOT(workload=api AND pod=noisy)` | The middle row, with the parent's values: nothing changes |

Changing a group's `selectors` — adding, removing or reordering — leaves
`values.yaml` alone but changes what each row alerts on, so the save says so.
