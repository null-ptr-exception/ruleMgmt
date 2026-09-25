# How to

Task by task. For what the pieces are and why they work the way they do, see
[alert-rules.md](alert-rules.md).

Two roles appear throughout: the **template owner** works on the Templates
page and decides what alerts exist; the **rule owner** works on the Alerts page
and decides what they are applied to.

---

## Template owner

### Start a chart from rules you already have

The fastest way in if you have existing Prometheus rules.

1. **Templates** → **New ▾** → **From rules…**
2. Give the chart a name, paste the rules
3. Check the preview: which groups will be added, what columns each brings, and
   anything that could not be carried across
4. Untick any group you do not want
5. **Create**

What lands renders exactly what you pasted — every literal is still a literal.
Turning it into a template is the next task.

Accepted: a PrometheusRule resource, a rule file with a top-level `groups:`, or
a bare list of rule entries.

### Start a chart from nothing

**Templates** → **New ▾** → **Blank chart** → name it. Then **+** beside ALERT
GROUPS to add your first group; it opens straight into the rules editor.

### Start a chart from another one

Open the chart to copy, then **New ▾** → **From existing chart…** and name the
copy. It gets the same rules files; the original and its deployments are not
touched.

### Turn a literal into something each deployment fills in

This is the gesture that connects the two pages: it opens a column in the rule
owner's table.

1. Select the literal in the expression — a threshold, a namespace, a duration
2. **Set as variable**
3. Name it (`recv_warn`, `namespace`, …) → **Create**

The expression now reads `${recv_warn}` and a column of that name exists. To
use a column that already exists, pick it from **Insert variable** instead.

Anything you leave unmarked stays fixed, and the rule owner never sees it.

### Add another alert to the same table

**Add rule**. The new rule reads the same row, so every column already there is
available to it — that is the point of a table carrying several rules: a pod
regex is filled once no matter how many alerts watch it.

Use **Collapse all** once a group has more than two or three.

### Put a value in a label, annotation or `for`

Type it. All three take the same three kinds of value:

| | Example | Meaning |
|---|---|---|
| literal | `warning` | the same every time |
| column | `${namespace}` | this row's value |
| Prometheus template | `{{ $value }}` | evaluated when the alert fires |

Blank rows in Labels and Annotations only become real once you name the key.

### Hand-write a rule

When a rule needs something the fields do not cover — `limit`,
`keep_firing_for` — switch **raw** on and write that one entry as YAML.
Everything around it is still generated, and `${var}` still reads the row.

Switching raw off parses it back into fields, and tells you which field is
keeping it raw if it cannot.

### Bring more rules into an existing chart

**Import** in the chart header. Same dialog; groups already in the chart are
marked **replaces** in red.

Nothing is written until you **Save**, so the usual checks apply — and
cancelling is just not saving.

### Move an old chart onto the new model

A chart from before `rules/` opens with a banner: *This chart still uses the
old schema-only format.* Its groups are already shown as rules. **Save**, and
it is written out as `rules/*.yaml` with the schema and templates regenerated.

The only change to what it renders is that columns with a default now fall
back to it when a row leaves them empty. Check with **Preview** on a
deployment before committing if that matters.

Nothing converts on its own, but a chart that is not migrated cannot be
committed — see [Commit](#commit). From the command line, `gen-rules` does the
same; see [below](#migrate-a-chart).

### Save

**Save** writes the rules files and regenerates `values.schema.json` and every
template, all or nothing. Files you did not touch are written back exactly as
they were, so comments added by hand survive. Three things can stop it:

- **The chart has a problem** — most often a `${var}` naming a column that
  does not exist. The dialog lists each one; one in another group is a link
  that jumps there. For a missing column, press **Create &lt;name&gt;** on the
  rule that flags it. The full list of what is checked is in
  [rules-format.md](rules-format.md#what-is-rejected-at-save-time).
- **The rules files changed on disk since you opened the chart** — someone
  edited them outside the editor. **Save anyway** overwrites their change;
  cancel and reopen the chart to keep it.
- **This change breaks deployments that already exist** — see below.

### Change a chart people are already using

Removing a column, a group or a rule, renaming a group, narrowing a type,
making a column required, or removing or changing a default affects rows that
already exist. Save opens a dialog instead of saving:

1. **Summary** — *Needs a decision* lists columns and groups that go away;
   *Just so you know* lists the rest. Every affected deployment is named, and
   ones that follow another through sync are marked
2. **Continue** → for each column that goes away, pick what it **Becomes**:
   another column of the same group, or *Delete (value not kept)*. Everything
   starts as delete
3. **Continue** → the preview shows, per deployment, the rows that change and
   the values that are lost
4. **Change in place** rewrites the chart and every affected deployment in one
   step

Deployments that follow another through sync are not rewritten; they follow
their source.

If existing deployments should not change yet, use **Clone to a new chart** on
the first step instead. The copy gets your edits and the mapping; the original
keeps working, and each rule owner moves over when they are ready.

---

## Rule owner

### Fill in a deployment

1. **Alerts** → pick a deployment in the tree
2. Pick an alert template from the sidebar
3. **Add instance** for a row, fill the columns
4. **Save**

**Common Values** at the top of the sidebar is for values shared by every row
of every group in this deployment.

Each row is one monitored scope. What the columns mean is set by whoever wrote
the template; if a name is unclear, that is worth telling them.

### Check what will actually be deployed

**Preview** renders the chart with your rows through Helm — the same path a
deploy takes — and opens on a summary of what came out: how many alerts each
group produced, by alert name and severity. It also points out:

- a group with no rows, which produces nothing
- a group with rows but no alerts, usually a blank cell that drops a rule
- value fields the template no longer has, left over from an older version of
  the chart

**Raw YAML** switches to the rendered resources themselves. Save first;
Preview saves for you.

If `promtool` is installed it also checks the rules and reports what it finds.
Two things promtool accepts but are still wrong are flagged on top: a
`<no value>` in the output (a field that had no value and no default), and a
`{{ … }}` from the template's rules that did not come through verbatim. Either
one is a problem in the chart, not in your rows — pass it on to whoever
maintains the template.

### Work across many groups at once

Switch **Single** / **Overview** above the sidebar. Overview stacks every group
in one page with a filter bar across the top, which is the faster way to answer
"which of these has no threshold set".

### Copy an existing deployment

**Clone** in the deployment list. It copies the rows, so it is the quick way to
stand up staging from production and change what differs.

---

## Both

### Commit

Saving only writes files. **Git** → **Changes** shows the diff, a commit
message box, and **Discard all changes** if you would rather start over.

Nothing leaves the working tree until you commit, which is why Save is safe to
experiment with.

A commit is refused while any chart:

- has a problem Save would refuse, or a rule that reads no column at all — it
  would be emitted identically on every row. Save allows that, because a chart
  being turned into a template passes through it
- has generated files that are behind its rules files — open the chart and
  save, or run `gen-rules`
- is not migrated yet — see [Move an old chart onto the new model](#move-an-old-chart-onto-the-new-model)

---

## Command line

### Migrate a chart

```bash
node scripts/gen-rules.mjs charts/<name>          # write
node scripts/gen-rules.mjs charts/<name> --check  # report only
node scripts/gen-rules.mjs charts/<name> --init   # also create a missing Chart.yaml
```

Writes `rules/*.yaml` from the schema, then regenerates the schema and every
template from those, in one pass. Warnings about `values.yaml` — a key no
column defines, a required column left out — are worth fixing before Helm sees
them.

### Edit the rules files directly

Edit `rules/*.yaml`, then regenerate:

```bash
node scripts/gen-rules.mjs charts/<name>
```

On a chart that already has `rules/`, this regenerates `values.schema.json`
and every template and leaves the rules files exactly as you wrote them,
comments included.

### Check a chart's generated files still agree

```bash
node scripts/gen-rules.mjs charts/<name> --check
```

Regenerates and compares instead of writing; non-zero exit on any difference.
Worth wiring into CI or a pre-commit hook if files are ever committed by hand
— it is what enforces that `rules/` is the source.

### Regenerate every chart after an upgrade

When a release changes the generated format (1.6 moved `expr` and annotations
to block scalars), every migrated chart turns `stale` and commits are refused
until its products are regenerated:

```bash
for c in charts/*/; do [ -d "$c/rules" ] && node scripts/gen-rules.mjs "$c"; done
node scripts/gen-rules.mjs charts/<name> --check   # spot-check: no DIFFERS
```

Commit that on its own, with nothing else in it. The rendered rules are the
same; review it with `dyff` rather than a text diff. See
[alert-rules.md](alert-rules.md#when-an-upgrade-changes-the-output-format).

### Import rules into a chart

```bash
node scripts/import-rules.mjs rules.yaml charts/<name> --dry-run   # report only
node scripts/import-rules.mjs rules.yaml charts/<name>             # write
```

Writes each imported group to `rules/<group>.yaml` and regenerates the schema
and templates; the chart's other rules files are left as they are. A chart
with no `rules/` yet is migrated in the same step. A group that already exists
is replaced, and a column it loses is reported — unlike the editor's Import,
this cannot see which deployments set it. For a brand-new chart, create it in
the UI first, or run `gen-rules.mjs --init` afterwards, so it has a
`Chart.yaml`.

---

## Platform

### Put your own labels on every generated resource

Set these where the platform is deployed — they are read at startup:

```bash
RULE_OBJECT_LABELS='{"release":"kube-prometheus-stack"}'
RULE_OBJECT_ANNOTATIONS='{"alertforge.io/source":"generated"}'
```

Values are literal; one containing `{{ }}` is dropped with a warning. Existing
templates are not rewritten — they turn stale, and commits are refused until
they are regenerated. Opening and saving each chart does it, or
`gen-rules.mjs` per chart.

### If rules deploy but never fire

Check whether the cluster's Prometheus filters by label:

```bash
kubectl get prometheus -A -o custom-columns='NAME:.metadata.name,SELECTOR:.spec.ruleSelector'
```

A `ruleSelector` that your resources do not match means they are ignored
silently — they exist in the cluster, and `/rules` in Prometheus shows nothing.
Put the matching labels in `RULE_OBJECT_LABELS` and regenerate.

### Run it locally

```bash
npm run dev
```

Vite on 5173, the API on 3001. See [AGENTS.md](../AGENTS.md) for the cluster
workflow.
