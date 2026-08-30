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

Open a group still showing **PromQL Expression** and press **Convert to
rules**. If the group has optional selectors you are warned first: their labels
are only emitted today when a row sets them, and converted rules emit every
label unconditionally, so the rendered output changes.

Nothing converts on its own — a chart you never open keeps working as it is.

### Save

**Save** writes the schema and regenerates every template. Two things can stop
it:

- **Some references have no column** — a `${var}` naming a column that does not
  exist. Fix the reference, or press **Create &lt;name&gt;** on the rule that
  flags it.
- **This change breaks deployments that already exist** — see below.

### Change a chart people are already using

Removing a column, a group or a rule, narrowing a type, or making a column
required invalidates rows that already exist. Save refuses and names what
breaks and who is affected.

The way through:

1. Clone the chart, declaring what old columns become in the copy
2. Change the copy
3. Each rule owner moves over when they are ready — the original keeps working
4. Retire the old chart once nobody is on it

**Save anyway** exists for when you know the deployments can take it. It is
listed with the affected paths so it is a decision, not an accident.

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

**Preview** renders the chart with your rows through Helm and shows the
resources that come out — the same path a deploy takes. Save first; Preview
saves for you.

If `promtool` is installed it also checks the rules and reports what it finds.

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

---

## Command line

### Generate templates without the UI

```bash
node scripts/gen-chart.mjs charts/<name>
```

Reads the schema, writes one template per group. Needed when a schema is
committed directly rather than saved through the editor.

### Check a schema and its templates still agree

```bash
node scripts/gen-chart.mjs charts/<name> --check
```

Regenerates and compares instead of writing; non-zero exit on any difference.
Worth wiring into CI or a pre-commit hook if templates are ever committed by
hand — it is what enforces that the schema is the source.

### Import rules into a chart

```bash
node scripts/import-rules.mjs rules.yaml charts/<name> --dry-run   # report only
node scripts/import-rules.mjs rules.yaml charts/<name>             # write
```

Writes `values.schema.json` only; run `gen-chart.mjs` afterwards for the
templates. For a brand-new chart, create it in the UI first so it has a
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
templates are not rewritten — regenerate them, and `--check` will report the
drift until you do.

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
