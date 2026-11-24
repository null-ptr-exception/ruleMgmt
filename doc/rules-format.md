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
name: MariaDB traffic           # optional; the rule group's name, see below
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
| `name` | no | The rule group's name in the rendered resource (`spec.groups[].name`), e.g. `MariaDB CPU`. Left out, it is the filename with `_` as `-` (`mariadb-cpu`). Only that name changes: the values key, template file and object names stay the filename's, so no deployment changes — see [names, one source](#names-one-source). Text on one line, no space at either end, at most 200 characters, and not the name of another group of the chart (another group's default included; `CPU` and `cpu` are two names). `name:` with nothing after it is refused rather than read as left out. Spaces, `{{`, `: ` and any language go through as written. In the editor: the Name field of the group's settings row, empty for the default. Names are compared as written, character by character, as Prometheus and vmalert compare them: `Café` with `é` and with `e` and a combining accent are two names, which look alike. A clash with a group of a hand-written template (`x-custom-template`) cannot be seen at save — what it renders is only known to Helm; Preview counts each group from its own template file, and shows the other apart |
| `once` | no | `true`: the rules render **once per deployment** instead of once per row — see [once groups](#once-groups). A once group has no `columns` |
| `type` | no | Which kind of rules these are, and so what they are wrapped in: `prometheus2` (the default — `expr` is PromQL for Prometheus 2.x, emitted as a `PrometheusRule`; `prometheus` is the same), `prometheus3` (PromQL for Prometheus 3.13 or later, a `PrometheusRule` marked with the annotation `alertforge.io/profile: prometheus3`, checked with promtool 3), `vm` (`expr` is MetricsQL, evaluated by VMAlert against VictoriaMetrics, emitted as a `VMRule` with `type: prometheus` on the group) or `vlogs` (`expr` is LogsQL, evaluated against VictoriaLogs, emitted as a `VMRule`). The choices are the profiles in `config/outputs.json` — see [output profiles](#output-profiles) |
| `interval` | no | How often the group is evaluated — a [duration](#durations) such as `30s`, `1m`, `1h30m`. Left out, the evaluator's own default applies |
| `limit` | no | Maximum series the group may produce — a whole number, `0` or more. Left out, there is no limit |
| `query_offset`, `labels`, `eval_offset`, … | no | The evaluator's other group fields — which ones depends on `type`, see [group fields by type](#group-fields-by-type) |
| `selectors` | no | The selector columns, coarsest first — see [selectors](#selectors-a-default-with-exceptions) |
| `selectorLabels` | no | Selector column → the label it matches, when the two names differ — see [matching a label of another name](#matching-a-label-of-another-name) |
| `vars` | no | Edit-time text substitutions |
| `columns` | no | The table's columns |
| `derived` | no | Values computed per row from integer columns — see [`derived`](#derived) |
| `rules` | yes | The rules |

Any other key is rejected. Unknown keys are never ignored silently: a typo
(`intervel:`) is caught at save time, and widening the list later stays safe.

A name YAML would read as something else — `null`, `true`, `false`, a number —
has to be quoted when written by hand: `group: "null"`, `selectors: ["true",
workload]`. The editor quotes such names when it saves, and leaves ordinary
names bare.

`type`, `interval`, `limit` and the fields below belong to the whole group
and are the template owner's, set per group (in the editor, the group's
settings row). Different groups in one chart may have different types.

### Group fields by type

Each evaluator reads its own group fields. A group may set those its `type`
has; one it does not have is refused at save, saying which it has — so a
group whose type changed keeps nothing the new evaluator would refuse, or
ignore. They are written into every object of the group as they are.

| Field | `prometheus2` | `prometheus3` | `vm`, `vlogs` | Value |
|---|---|---|---|---|
| `interval`, `limit` | yes | yes | yes | as above |
| `query_offset` | yes | yes | — | a duration: how far back the group's queries look, for late data. Prometheus 2.53 or later (the operator drops it for an older `spec.version`) |
| `labels` | — | yes | yes | label name → text, added to every rule of the group (a rule's own label of the same name wins), recording rules included. Text or a Prometheus template, `{{ $labels.job }}`; not `${column}` or a `vars` entry — one object holds many rows. Not a label the group's selectors match. A `prometheus3` name may be UTF-8 (`service.name`); a `vm`/`vlogs` one is letters, digits and `_` |
| `eval_offset` | — | — | yes | a duration: the point inside each `interval` the group is evaluated at. Needs `interval`, no longer than it (equal is fine), and not with `eval_delay` |
| `eval_delay` | — | — | yes | a duration the evaluation time is moved back by |
| `concurrency` | — | — | yes | a whole number, `0` or more: rules evaluated at once |
| `eval_alignment` | — | — | yes | `true` or `false` |
| `headers`, `notifier_headers` | — | — | yes | a list of `"Name: value"` texts, sent with each query / notification |
| `params` | — | — | yes | name → a list of texts, added to each query: `{nocache: ["1"]}`. A name with an empty list has no values and is not written |

Example — `type: prometheus3` with `labels: {team: shop}` gives every alert of
the group `team: shop`; changed to `type: prometheus2`, the save refuses it:
`labels is not a group field of a prometheus2 group — it has interval, limit,
query_offset`.

AlertForge is stricter than the evaluator in a few places, on purpose: a
duration is text with a unit (`query_offset: 0` is refused — write `0s`), a
negative `eval_offset` or `eval_delay` is refused (vmalert takes `-30s`; every
duration AlertForge writes is `0s` or more), a negative `limit` is refused
(promtool takes `-1`; vmalert does not), `eval_offset` needs an `interval`
even when it is `0s`, a `vm`/`vlogs` label name keeps to the classic
set, a label value is quoted text, and an unclosed `{{` in a label value is
refused. `tenant`, a group's `debug` and `partial_response_strategy` are not
written by AlertForge: a rules file with one is refused, and an import leaves
it out and says so.

### `columns`

| Field | Meaning |
|---|---|
| `type` | `string`, `number`, `integer`, `boolean` or `duration` — decides the field the rule owner gets, and what Helm accepts. Left out, it is `string`; anything else is refused. See [a duration column](#a-duration-column) |
| `required` | Helm refuses values that leave it out |
| `default` | Used when a row leaves the cell empty. See [empty cells](#empty-cells) |
| `enum` | A fixed set of choices — the rule owner gets a dropdown instead of a free text field |
| `description` | Text, shown to the person filling the table in |

### `rules`

| Field | Meaning |
|---|---|
| `alert` | The alert name. Written by you; the generator never composes one |
| `record` | Instead of `alert`: the name of the series a recording rule records, e.g. `job:errors:rate5m`. A rule has exactly one of the two |
| `expr` | PromQL, with `${…}` placeholders |
| `for` | A [duration](#durations), or a placeholder. Left out — or empty, or a bare `0` — there is none: the alert fires on the first evaluation, as in Prometheus |
| `keep_firing_for` | A [duration](#durations), or a placeholder |
| `labels` | A map. Values may be literal, a placeholder, or a Prometheus template |
| `annotations` | Same as labels |
| `raw` | A hand-written `rules[]` entry — see [the escape hatch](#the-escape-hatch) |
| `selectorLabels` | This rule's own selector column → label names, over the group's — see [matching a label of another name](#matching-a-label-of-another-name). Never reaches the alert |
| `note` | Why this rule is the way it is. Never reaches the alert |

Any other key is rejected. A rule that needs a field the list does not cover
goes through `raw`.

A recording rule (`record`) has only `record`, `expr`, `labels`, `selectorLabels` and `note` —
Prometheus gives it no `for`, `keep_firing_for` or annotations, and each of
those is rejected on one.

### Durations

`interval`, `for` and `keep_firing_for` are written the way Prometheus and
the operators' resources read a duration: units from the largest down, each at
most once — `30s`, `5m`, `1h30m`, `1d12h` — and no longer than about 292
years. `30m1h`, `1h1h`, `1.5h` and a bare number such as `30` are refused when
the file is saved, for either kind of group: vmalert alone would read some of
them, Prometheus none.

A zero is `0s`, or a quoted `'0'`. Written bare, YAML reads `0` as a number:
an `interval: 0` is refused, and a `for: 0` is read as no `for`.

A value with a placeholder in it (`for: ${window}`) is the row's and is not
checked here; nor is anything inside a `raw` entry.

### A duration column

A column a rule uses as a duration — a range, a subquery, an `offset`, `for`
— can be `type: duration`. Its cells are then checked as durations are,
with the unit written in the cell:

```yaml
columns:
  win:  { type: duration, required: true }
  hold: { type: duration, default: 5m }
rules:
  - alert: SpcErrors
    expr: rate(errors{job="${job}"}[${win}]) > 0
    for: ${hold}
```

| Cell | |
|---|---|
| `90s`, `21m`, `1h30m` | written into the rule as they are: `[21m]` |
| `21` | refused: a number — write it with a unit, `21s` |
| `"21"` | refused: no unit — write `21s` or `21m` |
| `10.5m`, `21 m`, `30m1h`, `$__interval` | refused: not a duration |
| `0` | refused: no unit — write `0s` |
| `0s` | fine for `for`; refused in a range (it has to be more than 0) and, in a `prometheus2` group, in an `offset` (promtool 2 refuses `offset 0s`; promtool 3 and vmalert take it, so a `prometheus3` or `vm` group may) |

- The cell is checked in the table as it is typed, when the deployment is
  saved (naming the row and the column), and by Helm itself: the schema
  holds the format, so `helm template` refuses a value written by hand.
- The rule writes the column with no unit after it: `[${win}m]` is refused
  at save time, since a `5m` cell would render `[5mm]`.
- Its `default` stands in for every empty cell, so a `0s` default is refused
  at save time where `0s` is: in a range, or an offset of a `prometheus2`
  group.
- It has no `enum`. For a fixed list of durations, use `type: string` with
  the `enum`: the values are yours, so they are checked when you write them.
- Turning a `string` column into a `duration` is a
  breaking change for deployments that fill it (Save asks, as for any other);
  back to `string` is not.
- A [`derived`](#derived) value cannot read a duration column: Helm has no
  way to compute with `21m`. For a computed window, use an integer column
  and a `derived` with a `unit`.
- In a LogsQL group (`type: vlogs`) a time value — `for`, `keep_firing_for`,
  `_time:${w}` — belongs in a duration column too: vmalert, which evaluates
  these groups, does not check `for` at all (`for: 21`, `-5m` and `30m1h`
  pass it and act as 0 or less), so this column's check is the only one.
  `0s` is fine anywhere in such a group: only a range, or an offset in a
  `prometheus2` group, refuses it.

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
  entry in the `properties` of `values.schema.json`: the rule owner has
  nothing to fill in, and the Alerts page says so. The schema names it in a
  top-level `"x-once-groups": ["up"]` instead, so that regenerating removes
  its template once its rules file is gone; Helm skips the key.
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

### `derived`

A value worked out for each row, at render time, from that row's integer
columns. It is referenced like a column, `${name}`, and never appears in the
table. Use it where a value has to be computed and PromQL cannot do it — a
range selector, an offset, `for`, a label.

```yaml
columns:
  freq_num:  { type: integer, required: true }
  spc_point: { type: integer, default: 3 }

derived:
  short_w: { expr: "freq_num * (spc_point + 2)", unit: m }
  long_w:  { expr: "freq_num * spc_point * 4",   unit: m }

rules:
  - alert: SpcCustom
    expr: rate(x[${short_w}]) > 2 * rate(x[${long_w}])
```

A row with `freq_num: 3, spc_point: 5` renders `rate(x[21m]) > 2 *
rate(x[60m])`. The generator writes it as Sprig, reading each cell the way
`${name}` does:

```
{{ mul (int64 .freq_num) (add (int64 (dig "spc_point" 3 .)) 2) }}m
```

- **`expr`** is `+`, `-`, `*`, brackets, whole numbers and column names —
  nothing else, and no Helm: `{{ }}` stays Prometheus's everywhere. There is
  no `/` (Helm drops the remainder, and an empty cell would fail the whole
  chart) and no negative number (subtract instead).
- **It reads integer columns** (`type: integer`) of its group or of
  `_common`, whose `default`, if any, is a whole number. A `number` column
  could hold `2.5`, which Helm would cut to 2 before computing. It does not
  read a `vars` entry, another `derived` or a
  [duration column](#a-duration-column).
- **`unit`** is required, one of `ms s m h d w y`, written after the
  number: a derived value is a duration, for a range, a subquery, an offset
  (`OFFSET` too, or negative), `for` or `keep_firing_for`. In PromQL it
  cannot be compared as a number (`x > 21m` would be taken as 1260). In a
  LogsQL group (`type: vlogs`) the query is not looked at: `_time:${w}` is
  its own text.
- **A `raw` rule cannot use one**: it is written out as it is, so where the
  value goes cannot be checked.
- **An empty cell** works as for a column: a column it reads that a row
  leaves out, with no default, drops the rule (in `expr` or `for`) or the
  line (a label, an annotation or `keep_firing_for` that is nothing but the
  reference), as an [empty cell](#empty-cells) would.
- **Saving a deployment computes it for every row** and refuses a row where
  it overflows a 64-bit integer, comes to 0 or less in a range, to 0 in a
  PromQL `offset` (a negative one is fine), is negative as a `for` or
  `keep_firing_for`, or is longer than a duration can be (about 292 years),
  naming the row.
- **A row reads a cell as Helm does**: its own value, else the Common
  Value (from the deployment or a `_common` folder above it), else the
  column's `default`. Helm counts a row's `0` as not set, so a Common Value
  replaces it; a Common Value of `0` is used as it is, not the default. A
  row that leaves `base` out, under `_common: { base: 0 }`, computes
  `freq_num * base` as 0 — `[0m]` — and the save is refused, naming the row.
- **Preview shows each row's values**, computed the same way, from what Helm
  reads (the Template's own `values.yaml` included): `21m`, *omitted* for a
  row that leaves a column it reads empty, or why a value cannot be deployed.
- **In the editor**, a group's **Derived** section adds, changes and removes
  them; a rule using `${short_w}` is not marked unresolved, a name already a
  column's is marked, and renaming a column renames it in the expressions.
- A `once` group has no rows, so it has no `derived`. A `derived` name may
  not be a column's, a `vars` entry's, a `_common` column's or `selector`.

## Placeholders

Two syntaxes coexist and must not be confused.

| Written as | Belongs to | Resolved when |
|---|---|---|
| `${name}` | us | The templates are generated |
| `{{ … }}` | Prometheus | The alert fires |

`{{ $value }}`, `{{ $labels.pod }}` and the rest are passed through untouched —
write them exactly as you would in a hand-written rule. The escaping that keeps
Helm from eating them is added by the generator; you never see it. That holds
for any brace in any field: a template with a backtick or quotes in it
(`` {{ printf "%s" `x` }} ``), a `{` or `{{` right next to a `${column}`
(`{${host}}` renders `{h1}`), a `"{{"` in a PromQL string. Whether the text is
right for Prometheus is Prometheus's question — Preview checks it with promtool —
except for the one case below that is refused at save.

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
  column counts whenever anything renders — any row, or a once group, which
  renders with none: with no `_common` block at all, Helm checks nothing and
  every reference renders empty. The table marks such a cell before Save,
  a required `boolean` a hand-edited row leaves out included: its checkbox
  shows unticked, but the row holds no value until it is ticked or
  unticked.
- **`""` or `null` in any other column.** A guard reads the key as set, so
  the rule would render with the value missing. Leave the cell out instead.
- **A newline, in any column.** Values are one line; the table never
  produces one, a hand-edited `values.yaml` can.
- **`"` or `\`, in a column a label reads.** A label value is a quoted YAML
  string (see [what gets generated](#what-gets-generated)).

**A number** (a `number` or `integer` column, `_common`'s included) is
written into `expr`, a label, an annotation and a selector as JSON writes
it: `1000000`, `0.5`, `-3`, `12345678901`; with an exponent only from
`1e21` up or under `1e-6` (`1e-7`), which PromQL reads the same. Helm reads
every number in `values.yaml` as a float64 and would print it with Go's
`%v` (`1000000` as `1e+06`), so a matcher `port="${port}"` would match
nothing. `1e3` written in `values.yaml` is the number 1000. A whole number
past 2^53 is not kept exactly: Helm reads it as a float64. A legacy
`x-promql` group renders as it always has.

`expr` and annotations take anything else, which is where a regex like
`web-\\d+` usually goes. A `raw` entry is quoted by hand and is not checked.
A selector column has rules of its own, see
[Selectors](#selectors-a-default-with-exceptions).

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

### The row identity label (`rowIdentity`)

Off unless written. `rowIdentity: true` in `_common.yaml` (or the switch in
the Template editor's **Common Variables**) gives each alerting rule of a
group with rows a label `alertforge_row`, a hash of the row's identifying
cells:

```yaml
# rules/_common.yaml
rowIdentity: true
columns:
  env: { type: string, required: true }
```

**What it is for.** On a reload Prometheus pairs the rules it had with the new
ones by name and labels. Every row of a group renders rules of the same name
and, mostly, the same labels, so they are paired by position: insert, remove
or reorder a row in the middle and every alert after it in the same object
starts its `for` again. With the label, each row's rules are paired with
themselves. A row that moves to another object (a chunk of 100 rows, a shard)
still starts again: that is another rule group. vmalert pairs rules by their
expression and is not affected either way.

**Which cells.** Of the group's own `string` and `boolean` columns and its
`selectors` (a `_common` one included), the cells the row sets — in its own
values or, for a `_common` column, in the `_common` it inherits. Not `number`,
`integer` or `duration` columns, so a threshold or a window edited keeps the
alert. Not a cell the row leaves out, even one with a default: a column added
to the group, or a default changed, leaves every row's label as it was. A
cell written out with its default's value is a cell set (`page: false` and no
`page` differ). A group with none of these columns gets no label, nor does a
recording rule (its series would change), a `raw` rule (written by hand) or a
once group (no rows).

**Two rows with the same cells** — the same identifying values, differing
only in thresholds — get the same label, and Prometheus pairs their alerts
by position again. A deployment's save and a commit say so, naming the rows
(a warning; the save goes through); tell them apart in a text or true/false
column to fix it.

**The value** is the first 16 hex digits of the sha256 of those cells as
JSON, as Go writes it (Helm's `toJson`): keys sorted, no spaces, `<`, `>` and
`&` written as `\u003c`, `\u003e`, `\u0026`. It can be worked out by hand — here
a row setting `namespace`, `workload` and `team`, not `page`:

```bash
printf '%s' '{"namespace":"prod","team":"db\u0026ops","workload":"api"}' | sha256sum | cut -c1-16
# 9bcd584eefe5c529
```

**An AlertForge from before this setting** refuses a `_common.yaml` with
`rowIdentity` in it, as an unknown key, so the chart cannot be saved or
regenerated there; templates already generated still render as they are.
`rowIdentity: false` written out is off, and stays in the file.

**Turning it on, or off, once** changes every alert's labels, measured with
Alertmanager 0.27 and 0.28:

- Alertmanager sees each alert as a new one. Per group, one or two more
  notifications: one listing the old and the new alert together (or, with
  `group_by: ['...']`, the new one alone), and one more for the old alert
  resolved when `send_resolved` is on.
- The same alert is listed twice for about 4 minutes, until Prometheus stops
  sending the old one and it resolves. A rule whose `for` is longer than that
  has a gap instead: the old one resolves before the new one fires.
- Each alert starts its `for` again (measured on Prometheus 2.54, on a reload
  and on a restart, and on vmalert, on a reload).
- Existing silences keep working, and so do inhibit rules whose `equal` does
  not list `alertforge_row`. A source alert that fires later than its target
  (a longer `for`) lets one target notification through. Turn it on at a
  quiet time.

**Do not match a silence, or an inhibit rule's `equal`, on `alertforge_row`**:
its value changes whenever one of the row's identifying cells does. A silence
made from an alert in Alertmanager's UI starts with every label of it,
`alertforge_row` included — remove that matcher before saving it.

`alertforge_row` is reserved: a rule's or a group's own label of that name is
refused at save, whether the option is on or not.

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
- In an alerting rule's label or annotation, a `{{` with no `}}` after it
  (`a {{`): Prometheus reads them as templates and refuses the whole object. A
  `}}` alone is plain text, and a recording rule's labels are no template
- A carriage return (`\r`) anywhere in a rule's text. Prometheus takes one,
  but the generated chart cannot carry it: YAML reads it as a line break
  where an annotation or `expr` is written, and as a space in a label
- In `for` or `keep_firing_for`, a brace next to a `${column}` (`{${window}}`):
  it can only make the duration something no evaluator reads
- A name shared between `vars` and a column, or a name that is `selector`
- A rule's or a group's label named `alertforge_row`, the
  [row identity label](#the-row-identity-label-rowidentity)'s
- A `vars` entry referencing another `vars` entry
- A rule's `labels` or `annotations` that are not a mapping of name to text
  (`labels: foo`, a value that is `null`, a date, a list or a mapping) or a
  list of `{ key, value }` entries (read as that mapping); a number or
  `true` is taken as its text, and a date is to be quoted. A rule's `alert`, `record`, `expr`
  or `raw` that is a list or a mapping. Read as written, each would deploy
  something else; the file and the rule are named
- An optional column with no default referenced from the middle of a string
- `group:` not matching the filename
- A group's `name:` that is empty or written with nothing after it, not
  text (`name: 5` — quote it), with a space at either end, a line break or
  another control character, longer than 200 characters, or the rule-group
  name of another group of the chart (its `name:` or its default)
- A `derived` without a `unit`, with an expression that does not parse or
  reads anything but an integer column (or one whose default is not a whole
  number), used in a `raw` rule, or — in PromQL — compared as a number
- In PromQL, a range of a bare `0` (`rate(x[0])`, `x[0:1m]`): promtool
  takes it, but Prometheus fails the rule on every evaluation
- A unit written right after a [duration column](#a-duration-column)
  (`[${win}m]`); a duration column's `default` that is not a duration, or
  is `0s` where it goes into a range or an offset; a duration column with
  an `enum`

And, before a commit:

- In a group with columns, a rule that references none of them (reading only
  `_common` counts as none) — it would be emitted once per row, identical
  every time. Save allows it (a chart being variabilised passes through this
  state); committing does not. A rule that belongs once per deployment goes in
  a [once group](#once-groups).

A once group with `columns`, a rule with both or neither of `alert` and
`record`, and a recording rule with `for`, `keep_firing_for` or annotations
are rejected at save time.

## Editor hints: the JSON Schemas

`schema/rules-file.schema.json` describes a group file and
`schema/common-file.schema.json` a `_common.yaml`. In VS Code with the YAML
extension, they offer the keys as you type, show what each means, and mark a
misspelled key (`intervel:`), a `type` that is no profile, a group field the
type does not have (`labels:` on a `prometheus2` group), a column type that
is none, or a duration written wrong.

Either point the editor at them for the whole gitops repo, in
`.vscode/settings.json`. A group file's name starts with a letter, so
`[a-z]*.yaml` leaves `_common.yaml` to its own schema:

```json
{
  "yaml.schemas": {
    "https://raw.githubusercontent.com/null-ptr-exception/ruleMgmt/main/schema/rules-file.schema.json": "charts/*/rules/[a-z]*.yaml",
    "https://raw.githubusercontent.com/null-ptr-exception/ruleMgmt/main/schema/common-file.schema.json": "charts/*/rules/_common.yaml"
  }
}
```

or name one in a file's first line (a save from the editor writes a group
file anew, without it):

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/null-ptr-exception/ruleMgmt/main/schema/rules-file.schema.json
```

Without access to GitHub, copy the two files into the gitops repo and give
their paths instead.

The schemas say what each key is and roughly what it holds, not everything
a save checks: a `${…}` naming no column, a name colliding with one in
`_common.yaml`, an `eval_offset` past its `interval`, a `derived` reading a
string column and the rest of the list above are still only refused when
the file is saved. They are never stricter than the save: where it reads a
value leniently (`labels: { a: 5 }` is the text `"5"`), so does the schema.

They are generated from the same tables the save checks read, and so is
`schema/outputs.schema.json` for [`config/outputs.json`](#output-profiles).
After changing a key, a group field, a column type or a profile, run
`node scripts/gen-rules-schema.mjs`; a unit test fails until the files are
current.

## A deployment's values

A deployment's `values.yaml` holds the rows under the chart's name — Helm
passes a dependency only the values under its name:

```yaml
mariadb-alerts:
  _common: { owner: team-a }
  mariadb_saturation_disk:
    - { warn_pct: 80, critical_pct: 92 }
```

On a folder's `_common` (see [how-to](how-to.md#share-settings-across-a-folder)),
one `common:` more per `_common` above it — `common: { mariadb-alerts: … }`,
two levels `common: { common: { mariadb-alerts: … } }`. A `_common`'s own
`values.yaml` is laid out the same, counted from it. The editor shows and
saves only the rows under these keys.

### Writing values by hand

A `values.yaml` written by hand (in git, or saved as text) is read the way
Helm reads it — YAML 1.1 — and checked against what the Template sees:
its own `values.yaml`, under each `_common`, under the deployment's. A save
and a sync refuse, naming the file, line or row and column:

| Written | Why | Write instead |
|---|---|---|
| values not under the chart's name (`cpu: […]` instead of `mariadb-alerts: { cpu: […] }`), or under another name | Helm passes none of them to the Template: it renders only the Template's own rows | the values under the chart's name (on a `_common`, under `common:` first) |
| `010`, `0777`, `1_000`, `0_7` in a number column | Helm reads `010` as 8, `0777` as 511, `1_000` as 1000 | the number as you mean it (`8`, `10`), or `'010'` in quotes for text |
| `yes`, `no`, `on`, `off`, `y`, `n` | Helm reads them as true and false | `true` / `false`, or `'yes'` in quotes for the text |
| a key `y:`, `n:`, `on:` | Helm reads the key as `"true"` / `"false"` | `'y':` in quotes |
| a key written twice in one map | Helm keeps the last one; which was meant cannot be told. In a `_common`, every deployment under it is warned too (its save, Preview, check-deployment, Commit's list) | each key once |
| a value of the wrong type for its column, outside its `enum`, a row that is not a map, a group that is not a list | the Template's schema stops Helm; with no `values.schema.json`, Helm renders it as it is (`> [1,2]`), and AlertForge checks the shape against the columns of `rules/` | what the column asks for |
| a `null` on a `_common` stack, in a deployment's values, a `_common`'s or the Template's | Helm 3.15 and 3.19 deploy different things (one keeps the null, the other removes the key and falls back to the layer above or the default): what deploys depends on the Helm version. Commit refuses it too; a save of a deployment below a `_common` (or the Template) that holds it only says so, since the deployment cannot fix it | a value, or leave the key out to inherit it, `[]` to clear a group |
| syntax AlertForge does not read the same as Helm: a tag (`!!binary`, `!foo`), `?` keys, an indentation digit (`\|2`), a tab Helm's reading depends on, a file larger than `MAX_VALUES_BYTES` (1 MiB) | AlertForge cannot tell what Helm reads | plain YAML: no tags, `key: value`, spaces for indentation |
| a `values.yaml` that is a folder, or a link leading outside the repo | Helm renders the Template's own values and says nothing: what is deployed is not in the repo | a file in the repo |

The editor writes none of these: it quotes `'010'`, `'yes'` and the like
itself. Opening a deployment shows the values as Helm reads them, and says
which ones it reads otherwise than they are written (`010` shows
as 8). Commit does not refuse these: it lists them under the deployment, and
`check-repo` refuses them. A breaking Template change that migrates the
file does not refuse them either: its preview lists each one with the
deployment, and the migrated file holds the value as Helm read it (`010`
becomes `8`, `yes` becomes `true`, a key `y:` becomes `'true':`) — what
deploys does not change. A key written twice, a required cell written
`''` and a value a label cannot take are listed by Commit too; Helm renders
them as written, and `check-repo` says them as warnings. A
`values.yaml` that cannot be read at all — not YAML, a folder, a link out
of the repo — still blocks the commit.

A null that is not on a `_common` stack is read as Helm 3.15 and 3.19 both
read it: over a key the Template has, it removes it (the Template's value is
not used either); over one it does not, it stays a null.

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

How a value is written in a rules file — `|`, `|-`, `>`, `>-`, quoted, plain,
flow `{ }` — is only how YAML spells the text. The cluster gets that text,
spelled the generator's way:

| You write | The cluster gets | The generated file shows |
|---|---|---|
| `expr: \|` or an annotation `\|` over several lines, one indented further | the lines, with that indentation kept; no trailing newline | a `\|-` block |
| `>-` (folded) | the lines joined with spaces, as YAML folds them | a `\|-` block |
| a label value `yes`, `1_000`, `0_7`, or a bare `true` | the text `yes`, `1_000`, `0_7`, `true` | double-quoted: `"yes"` |
| `{{ $labels.pod }}`, `{{ range … }}…{{ end }}` | as written, for Prometheus to expand | escaped for Helm: ``{{ `{{ $labels.pod }}` }}`` |
| a comment | — (it stays in the rules file) | — |

Only a `{{` with no `}}` after it is refused; other template mistakes are not
checked (see [Notification routing](#notification-routing-routingyaml), where
the same holds).

Kubernetes and Helm read YAML 1.1, where a bare `yes`, `on`, `y`, `n` or
`off` is a boolean and `0_7` is the number 7. The generator writes a name
bare, as a hand-written file has it, and double-quotes it only when:

- a group's, an alert's or a recording rule's name would not be text bare:
  `yes`, `true`, `null`, `123`, `0_7` — so a group `rules/yes.yaml` is
  written `- name: "yes"`
- a group's own `name:`, an alert's or a recording rule's name, or a
  group label's value is a YAML 1.1 timestamp, a sexagesimal number or `=`:
  `2026-11-22`, `2026-11-22 10:00:00`, `1:30`. Kubernetes keeps these as
  text, but helm-unittest reads a bare date as a date, and another YAML 1.1
  reader takes `1:30` for 90; quoted, every reader gets the text. (A rule's
  label value starting with a digit is quoted anyway.)
- a label's or annotation's key — on a rule, or one the site puts on every
  object — is a YAML 1.1 boolean, null or number other than `true`, `false`,
  a whole number such as `123`, `.inf`, `-.inf` or `.nan`, which read back
  as themselves: `yes:`
  would be the key `true`, `0_7:` the key `7`, and `null:` is refused
- either would not parse bare, or would lose part of itself: `CPU: high`,
  `a #b`, a leading or trailing space, a control character (written as
  `\uXXXX`)

A name is literal text: a `{{ }}` in it reaches the cluster as written, never
run by Helm (`alert: "x: {{ .host }}"` is that alert name), and a `${column}`
in a name is not substituted.

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

On a reload, Prometheus pairs a group's rules by name and labels, and the
rules of the rows of one object share them: a row inserted, removed or moved
in the middle restarts every alert after it in that object (Prometheus 2.54
and 3; vmalert is not affected). Adding a row at the end does not. The
[row identity label](#the-row-identity-label-rowidentity) keeps each row's
state.

## Output profiles

What a group is wrapped in is decided by its `type`, looked up in
`config/outputs.json` in this repository. The file is part of the release —
a site does not override it; a site's own values, such as the labels a
rule evaluator selects objects by, come from the environment (see
[alert-rules.md](alert-rules.md)).

```json
{
  "outputs": {
    "prometheus2": { "aliases": ["prometheus"],
                     "apiVersion": "monitoring.coreos.com/v1", "kind": "PrometheusRule",
                     "validate": "promtool", "query": "promql" },
    "prometheus3": { "apiVersion": "monitoring.coreos.com/v1", "kind": "PrometheusRule",
                     "annotations": { "alertforge.io/profile": "prometheus3" },
                     "validate": "promtool3", "query": "promql" },
    "vm": { "apiVersion": "operator.victoriametrics.com/v1beta1", "kind": "VMRule",
            "groupFields": { "type": "prometheus" }, "validate": "vmalert", "query": "metricsql" },
    "vlogs": { "apiVersion": "operator.victoriametrics.com/v1beta1", "kind": "VMRule",
               "groupFields": { "type": "vlogs" }, "validate": "vmalert", "query": "logsql" }
  },
  "routing": { "apiVersion": "monitoring.coreos.com/v1alpha1", "kind": "AlertmanagerConfig" }
}
```

| Field | Required | Meaning |
|---|---|---|
| `outputs.<name>` | — | A profile; `<name>` is what a group's `type` says. Lower-case letters, digits, `_`, `-`. `prometheus2` must exist: it is the profile of a group with no `type` |
| `aliases` | no | Other names a group's `type` (and a site's `RULE_OBJECT_*_BY_PROFILE` key) may give the profile. `prometheus` is `prometheus2`'s: the profile's name before Prometheus 3 had one, so a rules file or site setting that says it keeps its meaning. A rules file keeps the name it was written with |
| `annotations` | no | Annotations written on every object of the profile, after the site's — what tells it from another profile of the same kind (`prometheus3`'s `alertforge.io/profile`). A site cannot set one of these keys |
| `apiVersion`, `kind` | yes | The resource the group's objects are |
| `groupFields` | no | Fields written as they are onto every `spec.groups[]` entry of the profile's objects — strings, numbers or booleans. Not `name` or `rules` (the generator's) nor `interval` or `limit` (the template owner's) |
| `validate` | yes | How Preview checks the rendered rules: `promtool` (`promtool check rules`, Prometheus 2.x's, `PROMTOOL_BIN`); `promtool3` (the same with Prometheus 3.x's, `PROMTOOL3_BIN`, default `promtool3`); `vmalert` (`vmalert -dryRun`, for MetricsQL and LogsQL, which promtool cannot read); or `none` — Preview then marks the group as not syntax-checked. There is no default |
| `query` | yes | The language the group's `expr` is written in: `promql`, `metricsql` or `logsql`. With `promql` and `metricsql` the save checks that read the query itself apply — a range of 0, a duration column or derived value in a range or offset, [selectors](#selectors-a-default-with-exceptions) — and the editor helps with PromQL; with `logsql` they do not. There is no default |
| `routing` | yes | Not a profile: the resource a deployment's [notification routing](#notification-routing-routingyaml) is generated as. `apiVersion` and `kind` only. No profile may be named `routing`, so no group can have `type: routing` |

Two profiles may share a kind (`vm` and `vlogs` are both `VMRule`;
`prometheus2` and `prometheus3` both `PrometheusRule`): what tells their
objects apart is the fields each writes on its groups, or the annotations it
writes on its objects. Any other
key is an error. The file is checked when the server starts and
when the frontend is built, and a mistake stops both. Changing a profile's
`kind`, or `routing.kind`, replaces every object it emits — they are deleted
and created again — so it is a release-level change.

`schema/outputs.schema.json` describes the file for an editor (the file
itself cannot name it: `$schema` would be an unknown key). In VS Code:
`"json.schemas": [{ "fileMatch": ["config/outputs.json"], "url": "./schema/outputs.schema.json" }]`
in `.vscode/settings.json`.

## Names, one source

Everything about a group is derived from the filename:

```
rules/mariadb_traffic.yaml
  ├─ values key         .Values.mariadb_traffic
  ├─ group name         mariadb-traffic   (or the file's name:)
  ├─ template file      templates/mariadb-traffic.yaml
  ├─ object name        {release}-mariadb-traffic-1-1
  └─ shown in the UI    mariadb_traffic
```

`group:` and `name:` are two different things. `group:` is the key, and has
to be the filename when written. `name:` (`name: MariaDB traffic`) is only
the rule group's name in the resource, what Prometheus and vmalert call the
group; nothing else changes with it, so it can be set or changed without
touching a deployment. A group split into several objects has the same name
in each.

Changing `name:` (or setting it, or taking it away) is still renaming the
rule group for the evaluator: it starts the group anew, so an alert that is
pending waits its full `for` again, and vmalert's `alertgroup` label on every
alert of the group changes — a route or silence that matches it has to
change too. The save says so; it is not a breaking change.

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

- A selector cell is `.*` or a value matched exactly — never a regex. Which
  of two regexes is more specific cannot be decided; which of `.*` and `api`
  is, can. A value becomes an equality matcher; an excluded value is escaped
  (`my.app` → `` `my\.app` ``). See [what a selector cell can
  hold](#what-a-selector-cell-can-hold).
- `${selector}` stands for the matchers, in `expr` only, right after a metric
  name's `{` or a `,` inside it: with every level `.*` it expands to nothing,
  and `cpu{}` is valid where `{}` is not.
- A level can be a `_common` column (e.g. `cluster`, first). Rows are read with
  `_common` merged in and defaults applied, and every row of the group is
  compared, so an exception in another chunk of 100 rows still counts.
- Each group declares its own hierarchy; groups in one chart may use different
  columns and depths. A group without `selectors` behaves exactly as before.

### What a selector cell can hold

`.*`, or any value — `/data`, `/dev/sda1`, `registry.example.com/app:1.2`.
With `mountpoint` as the selector, rows `.*` (80) and `/data/test.yml` (90):

```
mountpoint      threshold   renders
.*              80          disk{mountpoint!~`/data/test\.yml`} > 80
/data/test.yml  90          disk{mountpoint="/data/test.yml"} > 90
```

The equality is quoted (`"` and `\` escaped) and the exclusion is escaped as
a regex, so `/data/testXyml` is not excluded by the `.` in it.

| Value | Saved? | Why |
|---|---|---|
| `.*` | yes | Any — the only value with a meaning of its own |
| `prod`, `/data`, `app:1.2`, `a b`, `.` | yes | Matched exactly |
| `api-.*`, `a\|b` | yes, with a hint | Matched exactly too: `api-.*` matches only the value `api-.*`. For a regex, use a column that is not a selector, in the `expr` (`pod=~"${pod_regex}"`) |
| `""` | no | `label=""` means the label is absent |
| A backtick | no | The exclusion is a backtick-quoted regex |
| A line break | no | Values are one line |
| A space at either end | no | Matched as written, so almost always a typo |

A selector column that a label also reads keeps that rule too: no `"` or
`\` (see [what a row's value can hold](#what-a-rows-value-can-hold)).

### Matching a label of another name

A selector column's name is the label it matches, unless `selectorLabels`
says otherwise — for the group, or for one rule over the group's. One
`workload` column can then pick a Deployment in one rule and a StatefulSet in
the next, though kube-state-metrics labels them `deployment` and
`statefulset`:

```yaml
# rules/replicas.yaml
selectors: [namespace, workload]
selectorLabels: {workload: deployment}

columns:
  namespace: { type: string, required: true }
  workload:  { type: string, default: ".*" }
  threshold: { type: number, default: 90 }

rules:
  - alert: DeploymentReplicasLow
    expr: kube_deployment_status_replicas_available{${selector}} / kube_deployment_spec_replicas{${selector}} * 100 < ${threshold}
  - alert: StatefulSetReplicasLow
    selectorLabels: {workload: statefulset}
    expr: kube_statefulset_status_replicas_ready{${selector}} / kube_statefulset_replicas{${selector}} * 100 < ${threshold}
```

```
namespace  workload  threshold   DeploymentReplicasLow                       StatefulSetReplicasLow
prod       .*        90          {namespace="prod", deployment!~`api`}  {namespace="prod", statefulset!~`api`}
prod       api       50          {namespace="prod", deployment="api"}   {namespace="prod", statefulset="api"}
```

Only the label in the rendered matcher changes. Which row gives up which is
decided on the columns, and the table's columns keep their names. Whether
each metric has the label is the template owner's to know: it is not checked.

A save that changes which label a rule matches says so, naming the group and
the rules that no longer match as before. Rules have no identity of their
own, so the group's rules are compared as a whole: in a group that maps a
label anywhere, editing a rule in the same save is reported too.

### What is refused

What is refused when the template is saved:

| Refused | Why |
|---|---|
| A selector that is not a string column of the group or `_common` | Nothing to arrange by |
| A selector column that is optional with no default | A row leaving it empty would be neither `.*` nor a name |
| Any rule whose whole-rule reference (`expr`, `for`) is optional with no default | A row that loses its rule leaves unwatched what its parent row gave up to it |
| A rule whose `expr` does not use `${selector}`, or `${selector}` anywhere else | The rows would overlap in what that rule watches |
| `${selector}` not right after `metric{` or a `,` inside it | It can expand to nothing |
| `selectors` on a once group, or on a group whose `expr` is not PromQL | No rows; no label matchers |
| `selectorLabels` naming a column that is not in `selectors`, or on a group without `selectors` | Nothing to rename |
| A `selectorLabels` label that is not a label name: letters, digits and `_`, not starting with a digit or `__` | Prometheus would refuse the matcher; `__` names are its own |
| Two selector columns matching the same label in one rule — `selectorLabels` included | Both matchers would land on one label |

What is refused when a deployment is saved, with the row that would fix it
offered alongside:

| Refused | Offered |
|---|---|
| A selector cell that is empty, has a backtick or a line break, or starts or ends with a space | — |
| Two rows selecting the same thing | — |
| **Crossing**: `prod/.*/noisy` and `prod/api/.*` overlap on `prod/api/noisy`, and neither contains the other | The overlap as a row, thresholds left for you to fill |
| **Skipping**: `prod/api/noisy` under `prod/.*/.*` with no `prod/api/.*` between them — PromQL cannot exclude `NOT(workload=api AND pod=noisy)` | The middle row, with the parent's values: nothing changes |

Changing a group's `selectors` — adding, removing or reordering — or which
label a column matches in a rule (`selectorLabels`) leaves `values.yaml` alone
but changes what each row alerts on, so the save says so.

## Notification routing: `routing.yaml`

Who is notified of an alert is a table too: its dimensions are labels the
alerts carry, and each cell names who gets that combination. A folder
deployment keeps its table in `routing.yaml`, beside `values.yaml`:

```yaml
# deployments/asia/prod/routing.yaml
labels:                                          # the table's dimensions, with their values
  severity: [critical, warning]
  team: [db, web]
defaults: { groupWait: 30s, repeatInterval: 4h } # for a cell that does not set its own
configs:                                         # who can be notified
  db-email:    { type: email,   to: db@example.com }
  ops-webhook: { type: webhook, urlSecret: { name: ops, key: url } }
  relay:       { type: webhook, url: http://alert-relay.monitoring.svc:8080 }
cells:                                           # one entry = one filled cell
  - match: { severity: critical, team: db }
    configs: [db-email, ops-webhook]
    repeatInterval: 1h
  - match: { severity: warning, team: db }
    configs: [db-email]
```

| Key | Meaning |
|---|---|
| `labels` | Label name → its values, in order. Values are kept even when no cell uses them, so a row that is empty on purpose stays in the table |
| `defaults` | `groupWait`, `groupInterval`, `repeatInterval`: durations such as `30s`, `5m`, `1h30m` — largest unit first, each unit once, as Alertmanager reads them (`30m1h` is refused). `groupInterval` and `repeatInterval` cannot be `0`. Quote a bare number (`'0'`): YAML reads it as a number, not text |
| `configs` | Name → `{ type: email, to }` or `{ type: webhook, url }` / `{ type: webhook, urlSecret: { name, key } }`. Names are lower-case letters, digits and `-`; a name starting with `_` is reserved. An e-mail or webhook config may say more — see [E-mail settings](#e-mail-settings) and [Webhook settings](#webhook-settings) |
| `cells[].match` | Every label of `labels`, each with one of its values |
| `cells[].configs` | Who is notified, by name from `configs` |
| `cells[].groupWait` … | Overrides `defaults` for this cell |

A combination with no cell is an empty cell: its alerts notify nobody.

What is refused when it is saved, and reported when it is read back:

| Refused | Why |
|---|---|
| A cell whose `match` leaves out a label, names one not in `labels`, or a value not listed | It would cover its neighbours' combinations, or none |
| Two cells with the same `match` | One of them would never be reached |
| A cell naming a config that is not in `configs` | Nobody to send to |
| A cell's `configs` entry that is not a name — a number, `~`, a list | It would name a receiver that is not there |
| A webhook `url` that is not an `http://` or `https://` address as written, or has spaces around it — `relay:8080` without a scheme, `http:relay`, `http:/relay`, a tab, a line break, `"` or `\` anywhere, a space or `%` in the host, a `%` not followed by two hex digits | Alertmanager or the operator refuses it, and the operator then drops the whole AlertmanagerConfig: every notification of the deployment stops, with only a Warning event. The credential check below cannot read it either |
| A `urlSecret` whose `name` is not a Kubernetes name (lower-case letters, digits, `-` and `.`, at most 253), or whose `key` has anything but letters, digits, `-`, `_` and `.`, is `.`, or starts with `..` | The operator cannot read the Secret, and drops the whole AlertmanagerConfig |
| An e-mail `to` with no address in it (`@`, `db-team`, `:;`), or with a line break. A `to` written as an Alertmanager template (`{{ .CommonLabels.owner }}`) needs no `@`, and a group with no members (`undisclosed-recipients:;`) is taken, with a warning — see below | Nothing can tell whether an address exists, so only what cannot be one is refused; a line break would add mail headers (`Bcc:`) |
| A webhook `url` with a user name or password, a credential-like query parameter (`token=`, `key=` …) or a token-like path segment | Credentials belong in a Secret: use `urlSecret`. An in-cluster address such as `http://alert-relay.monitoring.svc:8080` is fine |
| An e-mail or webhook setting written wrong — see [E-mail settings](#e-mail-settings) and [Webhook settings](#webhook-settings) | |
| Any other key — under `urlSecret` too, which takes only `name` and `key` | Probably a typo; it would be left out of the AlertmanagerConfig |

A `routing.yaml` saved before these three checks, with such a value, is
listed as failing them and is not edited: fix the value in the file.

The shape and types are checked first: every key, its type, and what is
required. A value of the wrong type — a list where a name goes, a number where
text goes — is refused where it is. Only a file of the right shape is checked
for the rest of the table above (cells against `labels` and `configs`,
credentials in a `url`), so fixing the first problems can show new ones.

### Shared configs

A config several deployments notify — the same in-cluster relay in every
region, say — can be written once for the whole repo, in
`_shared/notification-configs.yaml`, and used by name:

```yaml
# _shared/notification-configs.yaml
configs:
  relay-webhook: { type: webhook, url: http://alert-relay.monitoring.svc:8080 }
  ops-email:     { type: email, to: ops@example.com }
```

```yaml
# deployments/shop/prod/routing.yaml
configs:
  relay-webhook: { shared: true }                    # the shared one of this name
  db-email:      { type: email, to: db@example.com } # this deployment's own
cells:
  - match: { severity: critical, team: db }
    configs: [relay-webhook, db-email]
```

- A shared config is written as a `configs` entry of `routing.yaml` is, and is
  checked the same way: the same keys and the same refusals as in the tables
  above and below.
- **It cannot read a Secret** — `urlSecret`, `authorization`, `basicAuth`, a
  CA from a Secret, an e-mail `authPassword` or `authSecret`, and so no
  `authIdentity` either, which needs a password of its own: a shared config
  with `authIdentity` or `authSecret` is refused, saying so. A shared e-mail config may set
  its own `smarthost`, with the warning below: with no password of its own,
  it is handed the platform's login. A Secret is read from the namespace of each deployment the
  resource is in, which AlertForge cannot see, so one change would not reach
  them all. A config that needs a Secret stays in the `routing.yaml` of each
  deployment, with the Secret in that deployment's namespace.
- `{ shared: true }` is all a use says. A name with no shared config, or a
  shared file with problems, is refused when `routing.yaml` is saved, and
  refuses a commit when the shared file changed under it. A
  deployment's own config and a shared one cannot have the same name in one
  `routing.yaml`: it is one or the other.
- The generated AlertmanagerConfig carries the shared config in full, exactly
  as if `routing.yaml` held it. A `routing.yaml` with no `{ shared: true }` is
  generated as before, whether the repo has shared configs or not.
- `_shared/` holds only this file: it is not shown in the tree, and no
  deployment or sync target can be made under it. A repo that already has a
  `_shared/` folder of its own — anything else in it — keeps it as an ordinary
  folder, shown in the tree with its deployments, and cannot use shared
  configs until it is renamed.
- A rename writes the new name where the old one was, in the shared file and
  in each `routing.yaml` using it; a name YAML would read bare as something
  else (`123`, `true`, `0x10`) is quoted.

When a shared config changes, every resource made from it changes too — see
[Share a config between deployments](how-to.md#share-a-config-between-deployments).

### E-mail settings

Only `to` is required. Every other field is optional, and one not written is
not written into the AlertmanagerConfig either: Alertmanager then uses the
platform's own settings (its `global` SMTP settings). AlertForge does not know
how a site sends mail, so it sets no defaults of its own.

```yaml
configs:
  db-email:   { type: email, to: db@example.com }     # the platform's server and sender
  web-email:
    type: email
    to: web@example.com
    from: alertforge@example.com
    smarthost: smtp.example.com:587
    authUsername: alertforge
    authPassword: { name: smtp-auth, key: password }  # a Secret in this namespace
    authIdentity: alertforge                          # AUTH PLAIN's identity, usually the user
    authSecret: { name: smtp-auth, key: cram-secret } # CRAM-MD5's secret, a Secret too
    requireTLS: true
    tlsConfig:
      ca: { secret: { name: smtp-ca, key: ca.crt } }
    sendResolved: true
    headers:
      Subject: "[{{ .CommonLabels.severity }}] {{ .CommonLabels.alertname }}"
    text: |
      {{ range .Alerts }}{{ .Annotations.summary }}
      {{ end }}
    html: '{{ template "email.default.html" . }}'
```

| Field | AlertmanagerConfig (`emailConfigs[]`) | Not written |
|---|---|---|
| `to` | `to` | **required** |
| `from`, `smarthost`, `authUsername` | the same name | the platform's setting |
| `authPassword: { name, key }` | `authPassword`, a Secret reference | the platform's setting |
| `authIdentity` | `authIdentity` | the platform's `smtp_auth_identity` (sent by AUTH PLAIN) |
| `authSecret: { name, key }` | `authSecret`, a Secret reference | the platform's `smtp_auth_secret` (CRAM-MD5) |
| `requireTLS` | `requireTLS` | the platform's setting |
| `tlsConfig.insecureSkipVerify`, `tlsConfig.ca: { secret: { name, key } }` | `tlsConfig` | the platform's TLS settings. Written, `tlsConfig` **replaces** them for this config (Alertmanager 0.28 and later), it is not merged with them |
| `sendResolved` | `sendResolved` | no mail when an alert resolves |
| `headers` (a map) | `headers: [{ key, value }]` | no extra headers |
| `text` | `text` | no plain-text part |
| `html` | `html`; `html: ""` sends the text alone | Alertmanager's default HTML |

- The names are the AlertmanagerConfig's (camelCase), not `alertmanager.yml`'s
  snake_case.
- **`authIdentity` and `authSecret` take the place of the platform's** for
  this config: Alertmanager sends the config's own identity, and makes the
  CRAM-MD5 answer with its own secret (measured, Alertmanager 0.28.1).
  `authIdentity` needs the config's own `authUsername` and `authPassword`
  (AUTH PLAIN sends all three; without them, the platform's user name and
  password go with this identity). `authSecret` needs the config's own
  `authUsername` (CRAM-MD5 sends the user name and an answer made with the
  secret, no password). With a `smarthost` of its own the password is
  needed too, as for any login there: a server that offers PLAIN before
  CRAM-MD5 gets the user name with a password, and without one of its own
  that is the platform's (measured).
- **The password is only ever a Secret's name and key**, and so is `authSecret`: the AlertmanagerConfig
  has no field for a password itself, and one in `routing.yaml` would be in git.
  As with `urlSecret`, AlertForge cannot see the cluster: when the Secret or its
  key is missing, the operator drops the whole AlertmanagerConfig.
- `from`, `to`, `headers`, `text` and `html` may be Alertmanager templates
  (`{{ .CommonLabels.alertname }}`); they reach the cluster as written. A YAML
  value that starts with `{{` must be quoted.
- **A `smarthost` of the config's own is saved with a warning** (see the
  table of warnings above). Alertmanager fills each login field the config
  leaves out — user name, password, identity, secret — from its global
  settings, whatever the server is; with `insecureSkipVerify`, to anyone
  answering there. A certificate that fails verification sends nothing. Leave
  `smarthost` out to use the platform's server.
- **Half a login with its own `smarthost` is refused**: only `authUsername`,
  or only `authPassword`. Alertmanager (and amtool) take it, but the other
  half is the platform's, mixed in without a word.
- With only `to`, the platform's Alertmanager must have `smtp_smarthost` and
  `smtp_from` set (kube-prometheus-stack sets neither by default). Without them
  Alertmanager cannot build its configuration (`no global SMTP smarthost set`),
  and no notification of any kind goes out.
- Not supported yet: `hello`, `forceImplicitTLS`
  (port 465 uses implicit TLS anyway), `threading`, and TLS settings other than
  the two above.
- A `routing.yaml` with these fields is refused by an AlertForge from before
  them, as an unknown key.

What is saved, but said — a warning never refuses a save or a commit:

| Warned | Why |
|---|---|
| An e-mail `to` that is only groups with no members — `undisclosed-recipients:;`, `Ops team: ;`, `a:;, b:;` | Alertmanager takes it and sends to nobody: the config notifies no one. A group with members (`oncall: a@x.com, b@y.com;`), or one beside an address, is an ordinary list |
| A `smarthost` of the config's own with no `authUsername` and no `authPassword` (a shared config has no password) | Alertmanager fills each missing login field from its global settings, whatever the server: the platform's SMTP user name and password — and its identity and secret, where set — are used with this server (AUTH PLAIN sends identity, user name and password; LOGIN user name and password; CRAM-MD5 the user name and an HMAC made with the secret). With `tlsConfig.insecureSkipVerify: true`, to anyone who answers there |
| A `smarthost` of the config's own with its own `authUsername` and `authPassword`, and no `authIdentity` or no `authSecret` | Its user name and password are its own, but what it leaves out — the platform's identity (PLAIN), secret (CRAM-MD5), or both, where set — is still used with this server: a server that offers CRAM-MD5 gets an answer made with the platform's secret instead of the password (measured, 0.28.1). One warning, naming what is left and the field to write (`authIdentity`, usually the same as `authUsername`; `authSecret`); with both written, nothing is said |
| A `smarthost` of the config's own with `requireTLS: false` | No STARTTLS: LOGIN sends the password in clear, CRAM-MD5 runs in clear (PLAIN is refused by Alertmanager's mail client) |

A warning is shown in the config dialog (where Add stays on), on the Routing
page and in the answer to its Save, on the Shared configs page for a shared
config (and on the Routing page of each deployment that uses it, marked
`(shared)`), for a synced target as for its source, in the dialog after a
commit, and by `check-deployment` (`warning:` under `Routing: passed`).

| Refused | Why |
|---|---|
| `from`, `smarthost`, `authUsername`, `authIdentity` or `text` that is not text (said apart: a number, `true`, a date is to be quoted), or is empty; `html` that is not text; `requireTLS` or `sendResolved` that is not `true` / `false` | The AlertmanagerConfig needs them non-empty, of that type |
| `to`, `from`, `smarthost`, `authUsername`, `authIdentity` with spaces before or after it | The Routing page trims them: opening the config there and saving would change the value without a word |
| A `from` with no address in it, or with a line break — the same check as `to` (a template needs no `@`) | A line break would add mail headers |
| A header named `Authorization` or `Proxy-Authorization` (any case), or a header other than `Subject` with a word that looks like a token (20 characters or more, letters and digits, no `.`; a hyphenated word is judged part by part) | A credential does not belong in `routing.yaml`, which is in git, and a mail header cannot be read from a Secret. The subject is not judged: long names with digits are common there |
| A `smarthost` that is not `host:port` — no port (`smtp.example.com`), an empty port (`smtp.example.com:`), more than one `:` outside `[ ]` (`smtp://x:25`, `::1:25`) | Alertmanager refuses it, and with it its whole configuration. As in Alertmanager, the port is not read as a number |
| `authPassword` or `authSecret` written as text, or with keys besides `name` and `key` | Only a Secret reference; another key would be dropped without a word |
| An `authIdentity` with a line break or another control character | It is one value of the login |
| `authIdentity` without both `authUsername` and `authPassword` of the config's own; `authSecret` without `authUsername` of its own — whatever the server | Alertmanager fills in the platform's (measured, 0.28.1): someone else's login under this config's identity, or the platform's user name with this secret |
| `authPassword` without `authUsername`; with a `smarthost` of its own, `authUsername` without `authPassword` too | They are a pair: Alertmanager would fill the missing half from the platform's settings |
| A `tlsConfig` that is not a map, is empty, or has keys besides `insecureSkipVerify` and `ca`; `insecureSkipVerify` not `true` / `false`; a `ca` other than `{ secret: { name, key } }` | Only these two for now; an empty one would still replace the platform's |
| `headers` that is not a map; a header name that is empty or has a space, `:` or a character that is not printable; a value that is not text; a `Subject` with a line break | Alertmanager writes the name into the mail as it is |
| Two header names that differ only in case (`Subject`, `subject`) | The operator and Alertmanager count them as one, and refuse the whole resource |
| A `{{` with no `}}` after it, in `to`, `from`, a header value, `text` or `html` (a `}}` alone is plain text) | Alertmanager cannot read the template, and every notification of the config fails |

Of a template, only that is checked. Anything else wrong in one — a function
or template name Alertmanager does not have (`{{ nosuch . }}`), a field that
does not exist, a `{{` inside an action — is saved, and fails only when
Alertmanager sends that notification.

### Webhook settings

`url` or `urlSecret` is required, one of them, as before. Every other field is
optional; one not written is not written into the AlertmanagerConfig either,
and Alertmanager's default applies.

```yaml
configs:
  relay: { type: webhook, url: http://alert-relay.monitoring.svc:8080 }
  ops-webhook:
    type: webhook
    url: https://hooks.example.com/alert
    sendResolved: false
    maxAlerts: 20
    timeout: 10s
    authorization:                          # or basicAuth, not both
      type: Bearer
      credentials: { name: ops, key: token }
    tlsConfig:
      insecureSkipVerify: false
      ca: { secret: { name: ops-ca, key: ca.crt } }
```

| Field | AlertmanagerConfig (`webhookConfigs[]`) | Not written |
|---|---|---|
| `url` or `urlSecret` | the same name | **one of them is required** |
| `sendResolved` | `sendResolved` | resolved alerts are sent too |
| `maxAlerts` | `maxAlerts` | `0`: every alert in one request |
| `timeout` | `timeout` | no timeout |
| `authorization: { type, credentials: { name, key } }` | `httpConfig.authorization` | no authentication. `type` left out is `Bearer` |
| `basicAuth: { username: { name, key }, password: { name, key } }` | `httpConfig.basicAuth` | no authentication |
| `tlsConfig.insecureSkipVerify`, `tlsConfig.ca: { secret: { name, key } }` | `httpConfig.tlsConfig` | the certificate is checked against the system's CAs |

- Authentication and TLS sit beside the address in `routing.yaml`; the
  generator moves them under `httpConfig`, where the resource has them.
- **A token, user name or password is only ever a Secret's name and key**: the
  AlertmanagerConfig has no field for the value itself, and a `url` with one in
  it is refused already (use `urlSecret`). When a Secret or its key is missing,
  the operator drops the whole AlertmanagerConfig; when its value is empty, the
  request goes out without authentication.
- **`timeout` needs Alertmanager 0.28 and prometheus-operator 0.82 or later**
  (kube-prometheus-stack 75 or later). With an older one the field is dropped
  without a word. Check the platform's versions before relying on it.
- **`timeout` is in `h`, `m`, `s` or `ms`, at most `1h`** — `10s`, `1m30s`,
  `500ms`. It bounds one request. Alertmanager also gives each send of a
  group, retries included, at most the route's `groupInterval` (at least
  10s, and in an Alertmanager cluster by default 15s more for each peer
  ahead of it), so a timeout longer than that has no effect. The `1h` limit is AlertForge's
  own: Alertmanager takes a longer one, which would only make a difference
  with a `groupInterval` over `1h`.
- Not supported yet: `bearerTokenSecret` (use `authorization`), `oauth2`,
  proxies, `followRedirects`, `enableHttp2`, client certificates, TLS settings
  other than the two above, and `payload`.
- The generated resource is prometheus-operator's AlertmanagerConfig; a site
  that converts it to VictoriaMetrics' `VMAlertmanagerConfig` does so on its
  own side.
- A `routing.yaml` with these fields is refused by an AlertForge from before
  them, as an unknown key.

| Refused | Why |
|---|---|
| `sendResolved` that is not `true` / `false` | The resource's type |
| `maxAlerts` that is not a whole number from 0 to 2147483647 (`-1`, `1.5`, `"20"`) | The resource's type, a 32-bit whole number |
| `timeout` that is not a duration as the resource writes it — largest unit first, each unit once (`1m30s`; not `5s1m`, `1s1s`, `""`). Quote a bare number | The API server refuses the resource (`5s1m`); `""` would be ignored |
| `timeout` with `d`, `w` or `y` (`1d`), or longer than `1h` (`24h`, `1h30m`) | Alertmanager reads it as a Go duration, which has no `d`, `w` or `y`, and the operator writes a whole number of days as one (`24h` as `1d`, `25h` as `1d1h`): Alertmanager then cannot load the configuration the operator writes — the platform's one, every team's routes in it — and started with it, does not start. Longer than `1h` is AlertForge's own limit (Alertmanager takes it): a send waits at most the route's `groupInterval`, so a longer timeout only matters with a `groupInterval` over `1h`. A `routing.yaml` saved before with such a timeout is refused on its next save until it is changed |
| `authorization` and `basicAuth` together | The operator refuses the whole AlertmanagerConfig |
| `authorization.type` that is `Basic`, in any case or with spaces around it | The operator refuses it: use `basicAuth` |
| `authorization` without `credentials`, or `credentials` other than `{ name, key }` | Only a Secret reference; another key would be dropped without a word |
| `basicAuth` without both `username` and `password`, or either of them other than `{ name, key }` | They are a pair, and both Secret references |
| A `tlsConfig` that is not a map, is empty, or has keys besides `insecureSkipVerify` and `ca`; `insecureSkipVerify` not `true` / `false`; a `ca` other than `{ secret: { name, key } }` | Only these two for now |

`schema/routing.schema.json` describes the shape for editors. In VS Code with
the YAML extension, a first line naming it gives hints and marks wrong keys
as you type (a save from the Routing page writes the file anew, without it):

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/null-ptr-exception/ruleMgmt/main/schema/routing.schema.json
```

### What is generated

Saving `routing.yaml` also writes `templates/alertmanagerconfig.yaml` into the
deployment folder — a complete AlertmanagerConfig (`routing` in
`config/outputs.json`), which the deployment's chart deploys with its rules.
The file says it is generated; an edit to it is overwritten. Every value stays
text as the cluster reads it: a label value such as `1_000` or `yes` is
quoted, since YAML 1.1 reads them bare as 1000 and true.

How a value is written in `routing.yaml` or the shared configs is only how
YAML spells the text; the cluster gets that text, spelled the generator's way
(measured with `helm template`, byte for byte):

| You write | The cluster gets | The generated file shows |
|---|---|---|
| `text: \|` (or `html`) over several lines, one indented further | the lines, the indentation and the trailing newline as written (`\|-` has none) | a `\|` or `\|-` block |
| a header written `>-`, a quoted or plain value, a long line, a tab | the same text | plain, quoted, or a block — whichever YAML needs |
| a value `yes`, `1_000`, `0_7` | the text `yes`, `1_000`, `0_7` | quoted: `'yes'` |
| a bare `true` where text is wanted (a header value) | refused at save: the value must be text — write `"true"` | — |
| `{{ range .Alerts }}…{{ end }}`, `{{- }}`, `{{ if }}…{{ else }}` | as written, for Alertmanager to expand | escaped for Helm |
| a comment | — (it stays in `routing.yaml`, or the shared file) | — |

Only a `{{` with no `}}` after it is refused; other template mistakes are
saved, as [said above](#e-mail-settings).

| `routing.yaml` | AlertmanagerConfig |
|---|---|
| a config some cell uses | a receiver of the same name; one no cell uses is left out |
| a cell | a route under `spec.route.routes`, matching every label with `=`, with its timings |
| a cell with several configs | one child route per config, all but the last with `continue: true` |
| an empty cell, or an alert with none of these labels | the root's receiver `_drop`, which notifies nobody |

The root route says `continue: true`, so alerts this resource does not take
go on to the rest of Alertmanager's routes. There is no `metadata.namespace`:
the resource is in the release's namespace. `{{` and `}}` in any value are
escaped, so Helm writes them out as they are.

The object carries the same labels and annotations as the rule objects, plus
any set for `routing` — see [Different values per output
profile](alert-rules.md#different-values-per-output-profile).

A synced target gets the source's `routing.yaml` and AlertmanagerConfig with
its `values.yaml`, and cannot change them.

## Synced deployments: `sync.yaml`

Which deployment is kept identical to which is one file at the root of the
repo, `sync.yaml`. **Sync to...** and **Sync from...** write it (see
[Keep a deployment identical to
another](how-to.md#keep-a-deployment-identical-to-another)); written by hand,
it has this shape:

```yaml
# sync.yaml
syncs:
  - source: deployments/shop/prod
    targets:
      - deployments/shop/dr
      - deployments/cart/prod
```

| Field | What it is |
|---|---|
| `syncs` | A list, one entry per source. No file, an empty file or one with only comments is no syncs |
| `source` | The deployment that is copied: its folder's path from the repo's root, `deployments/` included (`deployments/shop/prod`, not `shop/prod`) |
| `targets` | A list of the deployments kept as its copy, each written the same way |

Every path is a deployment's folder. A target follows one source, a source
is not a target of another (sync does not chain), and a deployment is not
its own target. Commit and `check-repo` refuse a `sync.yaml` that says
otherwise, naming the entry (`syncs[0]: source shop/prod is not a
deployment`), and refuse a target whose files are not its source's copy.
