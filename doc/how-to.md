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
In the editor a `${…}` is shown in orange; a PromQL mistake around it is
underlined in red, the reference itself is not.

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

### Work out a window from a row's numbers

When a window is computed from two columns — `freq_num` samples of
`spc_point + 2` minutes each — add it under **Derived**: a name (`short_w`),
an expression (`freq_num * (spc_point + 2)`) and a unit (`m`). Rules use it as
`${short_w}`, in a range, a subquery, an `offset`, `for` or
`keep_firing_for`:

```
rate(x[${short_w}]) > 2 * rate(x[${long_w}])
```

- The expression is `+ - *`, brackets, whole numbers and the group's or
  `_common`'s **integer** columns. A `number` column can hold `2.5`: make it
  an integer column first (a row with a decimal has to be changed before the
  save takes the change).
- A unit is required: the value is a duration. Changing the unit (`m` to
  `s`) changes every row's window; look at Preview after.
- Renaming a column renames it in the expressions that read it.
- A row that leaves a column it reads empty, with no default, has no rule
  using it, as for a column.
- Saving a deployment computes it for every row, the way Helm reads the row
  (the row, then its Common Values, then the default), and refuses a row
  where it comes to 0 in a range, overflows, or is negative in a `for`.
- Preview shows each row's values. See
  [derived](rules-format.md#derived) for the whole format.

### Set a group's type and its group fields

The row under the group's name: **Type** (`prometheus2`, `prometheus3` for
Prometheus 3.13 or later, `vm` for MetricsQL on VictoriaMetrics, or `vlogs`
for LogsQL log alerts), **Interval** (a duration such as `30s`; blank is the
evaluator's default) and **Limit** (blank is no limit), then the other group
fields that type has — for example `query_offset` on `prometheus2`,
`query_offset` and `labels` on `prometheus3`, `labels`, `eval_offset`,
`concurrency` and the rest of vmalert's on `vm` and `vlogs` (the full list:
[group fields by type](rules-format.md#group-fields-by-type)). A map or a list
is typed as YAML on one line: `{team: shop}`, `["X-Scope-OrgID: 1"]`. They
apply to the whole group.

Switching the type changes what `expr` is written in and which fields the row
offers. A field the new type does not have stays, shown as a red tag —
`labels: not a prometheus2 field — Save refuses it` — and Save refuses the
group until you take it off with its ×, or switch back. Between kinds
(`PrometheusRule` ↔ `VMRule`) the group's objects are replaced when it is
saved; within one they are updated in place — see
[alert-rules.md](alert-rules.md#log-alerts-groups-of-another-type).

Severity written in a group's `labels` counts in Preview's summary for every
alert of the group that has none of its own.

### Render rules once per deployment, or record a series

**Once per deployment** in the same row makes the group render once for the
whole deployment instead of once per row — for a recording rule that
aggregates everything, a watchdog, an alert on chart-wide values. It can be
turned on only while the group has no columns; its rules can read the common
variables. Saving tells you the group's objects are replaced.

A rule's **Alert / Record** switch, left of its name, makes it a recording
rule: it keeps the name, `expr` and labels, and loses `for` and annotations,
which a recording rule does not have. See
[alert-rules.md](alert-rules.md#recording-rules-and-once-groups).

### Give a group a default with exceptions

**Selectors** in the group's settings row: add the columns that narrow what a
row watches, coarsest first (↑ ↓ to reorder), and write `${selector}` in each
rule's expr where the label matchers go — `cpu{${selector}}`. Those columns
become `.*`-or-a-name, and give each a default, usually `.*`. See
[rules-format.md](rules-format.md#selectors-a-default-with-exceptions).

### Keep alerts when rows are inserted or removed

On Prometheus, a row inserted, removed or moved in the middle of a group
restarts the `for` of every alert after it in the same object. To keep each
row's alerts, open **Common Variables** in the Template editor, turn on
**Row identity label**, and **Save**: each alerting rule of a group with
text, true/false or selector columns gets a label `alertforge_row`. Turning
it on (or off) is itself a change every alert sees once — new alerts in
Alertmanager, one or two more notifications per group — so do it at a quiet
time, and never match a silence on `alertforge_row`. See
[the row identity label](rules-format.md#the-row-identity-label-rowidentity).

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

Nothing converts on its own, and a chart that is not migrated does not stop a
commit — it is named after the commit as a reminder, so charts can be
converted one at a time (see [Commit](#commit)). From the command line,
`gen-rules` does the same; see [below](#migrate-a-chart).

### Save

**Save** writes the rules files and regenerates `values.schema.json` and every
template, all or nothing. Files you did not touch are written back exactly as
they were, so comments added by hand survive. Four things can stop it:

- **The chart has a problem** — most often a `${var}` naming a column that
  does not exist. The dialog lists each one; one in another group is a link
  that jumps there. For a missing column, press **Create &lt;name&gt;** on the
  rule that flags it. The full list of what is checked is in
  [rules-format.md](rules-format.md#what-is-rejected-at-save-time).
- **The rules files changed on disk since you opened the chart** — someone
  edited them outside the editor. **Save anyway** overwrites their change;
  cancel and reopen the chart to keep it.
- **This change breaks deployments that already exist** — see below.
- **This change would leave deployments with values a save refuses**, though
  it breaks nothing in the table: for example, making a column a selector
  when two rows of a deployment fill it the same. The dialog names each
  deployment and cell; change those rows first (a deployment synced from
  another is changed in its source, which the dialog names). A problem a
  deployment had before the change does not stop it, nor does a deployment
  whose `values.yaml` cannot be read; the others are still checked.
  Each deployment is checked as its own save checks it — the new schema
  and columns, its `_common` and the Template's own values counted, every
  file the change migrates as it will be written. A value of a column the
  change renames counts as new under its new name.

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
3. **Continue** → the preview shows, per deployment, the rows that change,
   the values that are lost, and the **Problems**: what a values save would
   refuse in the rewritten file — a value that cannot go in a label, rows a
   selector cannot tell apart, a required value left empty
4. **Change in place** rewrites the chart and every affected deployment in one
   step. It stays off while the change would cause a problem: change the
   mapping, or fix the deployment first (one synced from another is
   read-only: unlink it first). Each problem a deployment already had before
   this change is marked *already there before* and does not stop it; a new
   one in the same deployment still does

A deployment that follows another through sync gets its source's new file in
the same step, so the two stay identical; the preview says *copied from* the
source. One whose source does not use this chart is rewritten on its own. A
sync target that cannot be written does not stop the change: the chart and
its source are rewritten, and the editor names the target, which may not
match its source until the source is saved again.

A removed rule is found by counting the rules of each name, raw rules
included (a raw rule is read for the `alert:` or `record:` in it, and one
holding a list counts each entry). Removing one of two rules of the same name
— one alert at two severities — is listed as "1 of the 2 rules … is gone".
Rules have no other identity, so removing one rule and adding a different one
of the same name in the same save is not listed.

If existing deployments should not change yet, use **Clone to a new chart** on
the first step instead. The copy gets your edits and the mapping; the original
keeps working, and no deployment moves to the copy by itself: each rule owner
moves theirs by hand when they are ready — see
[Move a deployment to a cloned chart](#move-a-deployment-to-a-cloned-chart).

### Move a deployment to a cloned chart

AlertForge has no button for this: it is two files in the deployment's folder,
edited by hand and committed. Say `mariadb-alerts` was cloned to
`mariadb-alerts-v2`, which renamed `warn_pct` to `warn_ratio` in the
`mariadb_cpu` group and dropped `crit_pct`. The clone's `values.schema.json`
says so under `x-migrated-from`:

```json
"x-migrated-from": {
  "chart": "mariadb-alerts",
  "columns": { "mariadb_cpu": { "warn_pct": "warn_ratio" } },
  "dropped": { "mariadb_cpu": ["crit_pct"] },
  "groups": {}
}
```

1. **`Chart.yaml`**: in `dependencies`, the old chart's entry gets the new
   name, and in its `repository` only the last part changes — the `../`
   before it depend on how deep the deployment's folder is, and stay as they
   are:

   ```yaml
   dependencies:
     - name: mariadb-alerts-v2                              # was mariadb-alerts
       version: ">=0.0.0-0"
       repository: file://../../../charts/mariadb-alerts-v2   # was …/charts/mariadb-alerts
   ```

2. **`values.yaml`**: the top-level key is the chart's name, so
   `mariadb-alerts:` becomes `mariadb-alerts-v2:`, everything under it
   (`_common` too) moving with it. Then, in each group `x-migrated-from`
   names, rename the columns it renames (`warn_pct:` → `warn_ratio:`) and
   delete the ones it drops (`crit_pct:` lines). `columns` and `dropped` name
   a group by its **old** name; rename the groups under `groups` last. A
   column it does not name keeps its name.
3. Open the deployment on **Alerts**: the table shows the new chart's columns,
   and **Preview** renders it. Commit both files.

A deployment that follows another through sync gets its source's files on the
next save of the source; move the source.

### Remove a group

In the editor, pick the group → **Remove** → **Save**. Its rules file and its
template go in the same save; if deployments have rows for it, Save opens the
dialog above first.

From the command line, delete `rules/<group>.yaml` and run
[`gen-rules`](#edit-the-rules-files-directly): the group's template is removed
with it (`removed templates/<group>.yaml`). A once group's goes too: the
schema lists it under `x-once-groups`.

Only files the generator wrote are ever removed. Anything else in
`templates/` is left alone — see
[Files of your own in templates/](alert-rules.md#files-of-your-own-in-templates).

### Delete a chart

In the editor, pick the chart → **Delete**. A chart a deployment still uses is
not deleted: the deployment would fail to render without it. The refusal lists
those deployments — delete them, then delete the chart again.

This covers the editor. A chart removed by hand or through git is not
checked.

---

## Rule owner

### Create a deployment

**Alerts** → **+** → type the folder path (e.g. `shop/prod`) and pick the
chart → **Create**.

Under a folder with a `_common` for that chart, it inherits from it and
writes nothing of its own (see [Share settings across a folder](#share-settings-across-a-folder)).

It is made only where it can deploy: when the chart's own `values.yaml` or
`rules/` cannot be read, or what the chart or the `_common` gives stops Helm
or the rule checker (a group written as a map, a Common Value of `0` a
derived window reads as `[0m]`), **Create** says so, naming the file, and
nothing is written. Required cells left empty, and a required Common Value
nothing gives yet, are fine: they are filled in the editor, and its Save
and Commit ask for them.

Its `Chart.yaml` asks for any version of the chart (`">=0.0.0-0"`): there
is one copy of each chart, and a new version of one is a clone of it under
another name.
The chart's own version is not changed in the editor; Save writes its
description and keeps the rest of its `Chart.yaml` as it is on disk.

A folder or deployment name cannot start with `_`: those are reserved for
AlertForge's own folders. A folder that already has such a name is marked with
a warning in the tree and keeps working — rename it when you can.

A deployment is a folder of its own, beside the others:

| Where | |
|---|---|
| `shop/prod`, `shop/eu/stg`, any depth | yes |
| Inside another deployment (`shop/prod/canary`) | refused |
| On a folder that already holds a deployment (`shop`, with `shop/prod` in it) | refused |
| Inside a `_common` folder (`shop/_common/…`) | refused: `_common` holds what the deployments beside it inherit |
| On a folder that holds a `_common` (`shop`, with `shop/_common`) | refused: its deployments go under it (`shop/prod`) |
| Under a folder starting with `.`, `node_modules`, the Templates folder, the shared configs' `_shared/`, or a deployment's own `templates/` or `charts/` | refused: AlertForge does not look there |

The same holds for a new sync target. A deployment already in such a place
(made by hand, or pulled) is marked with a warning in the tree and keeps
working: it is listed, synced, checked before a commit and migrated like any
other. Move it to a folder of its own when you can.

Two more kinds of folder are flagged in the tree:

| Folder | What it means | Counts as using its Template |
|---|---|---|
| A `Chart.yaml` and no `values.yaml` | Helm deploys the Template's example rows | Yes: listed for a breaking change (nothing is written in it), and the Template cannot be deleted while it is there. Delete it like a deployment, or add a `values.yaml` |
| One AlertForge cannot read (permissions), a deployment whose `Chart.yaml` cannot be read or used (no permission, a folder, a link to nothing or out of the repo, not YAML, empty, `dependencies` that is not a list), a folder that is a link leading outside the repo, or one that is a link round in a circle | The deployments in it (or it) are not listed for sync, checked or migrated | Not known: named in the tree, in the list of who uses a Template, when a commit goes through, when a breaking change is confirmed and when the Template is deleted, and blocks none of them (`check-deployment` and `check-repo` cannot check it: exit 2) |
| A `Chart.yaml` that names no Template beside a `values.yaml` that writes values | Not a deployment: none of its rows is deployed | Named when a commit goes through (not refused); `check-repo` refuses it (exit 1) |

A folder that is a link — or is reached through one — is never a
deployment, wherever it leads: the tree does not show it (one leading out
of the repo is shown as one that cannot be read), sync, Preview, the
Routing page and the deployment routes refuse it (400), and
`check-deployment` names it and what it leads to (exit 2). The deployment
it leads to is found, listed and checked where it is. Each refusal says
which folder is the link and, when it stays in the repo, the path to ask
for instead: with `deployments/in-link` a link to `deployments/team`,
`deployments/in-link/a` is refused with "ask for deployments/team/a" (a new
deployment or `_common` there: "make it in …"). One leading out of the
repo is said to do so, without where. A link that leads into git's own
folder (`.git`) is treated as one leading out: nothing is read, listed or
written through it, wherever it is on the way. The Git panel's diff of a file in
such a folder is refused too (400), and so is a diff at a commit the repo
does not have — an id it has not, a tree, `HEAD~9` in a shorter history —
instead of an empty one.

A name — of a Template, a deployment, a template file, a folder — is at
most 255 bytes, what the file system and git take for one name; a longer
one is refused (400) naming the limit.

A deployment in a hidden folder (`.something/…`) is not in the tree, but
counts as using its Template, and a breaking change migrates it: ArgoCD
deploys whatever folder it is pointed at.

### Share settings across a folder

A folder's `_common` holds what the deployments of one Template under it
share: Common Values (an owner, a cluster) and whole groups of rows. Each
deployment inherits them unless it writes its own.

**Make one:** in the tree, the folder's **⋯** → **Add _common...** → pick the
Template. Before anything is written, the dialog lists every deployment it
changes, how, and every file. **Create** writes all of it or nothing.

| What | What happens |
|---|---|
| The new `_common` | `<folder>/_common/<chart>/`: a chart named `common` with a link to the Template; every group `[]` |
| Each deployment of that Template under the folder, at any depth | Inherits from it: its `Chart.yaml` depends on the `_common`, its values move under `common:`. It deploys exactly what it did |
| A deployment that wrote no row for a group | Deployed the Template's example rows for it: they are written into it, so it still does |
| A folder under one that has a `_common` | The new one inherits from that one (it writes nothing of its own) |
| A folder above one that has a `_common` | The lower `_common` inherits from the new one; its deployments get one more `common:` level |
| A sync target | Not re-attached by itself: it follows its source. When the source is re-attached, the target is re-attached with it (wherever it is); when not, it is listed and left |
| A deployment of another Template, one with no `values.yaml` | Left as they are |

Values are moved as text, never read and written again: every value stays
as written (`010`, `1_0`, `on` mean to Helm what they did), and comments,
anchors and the order of keys stay too. In `Chart.yaml` only the
dependency's `name` and `repository` change. So a make and then a remove
give back every file byte for byte — but for the example rows a make
copied into a deployment, which the dialog lists. Only the document Helm
reads is moved: a byte order mark at the start and a `---` with anything
after it stay where they are.

What a deployment's values already are is not judged: Helm renders each
deployment it changes before and after, and nothing is written unless it
deploys the same. A deployment is not re-attached when its values cannot be
moved as Helm reads them: a `values.yaml` that cannot be read (a folder, a
link leading outside the repo), values not under the Template's name (Helm
passes none of them on), a key written twice, a `null` (once on the
`_common`, Helm 3.15 and 3.19 deploy it differently), or a Template whose own
`values.yaml` cannot be read. The dialog names each, with why.

Before anything is written, Helm renders every deployment it would touch,
with the same steps as Preview; once written, Helm renders them again, and
if one renders anything else, everything is put back and that deployment
named. It stops before writing, naming each deployment, when:

| | |
|---|---|
| Helm cannot render the deployment now | Fix it first: AlertForge cannot tell a change keeps it the same |
| Its `values.yaml` is not valid YAML, or holds no map at its top level (a list, a single value) | |
| Its dependency has an `alias:`, a `condition:`, `tags:`, a version other than `>=0.0.0-0`, or is not a `file://` path | Undone, the file would not be the same: change it by hand first |

With no `helm` on the server, only the values AlertForge works out are
compared, and the dialog says so.

The dialog lists everything under the folder once: what changes, what is
left as it is and why (another Template, a deployment on two Templates, a
sync target of a deployment elsewhere), what stops it, and folders that
cannot be read. **Create** (or **Remove**) writes what was listed: a file
changed since, by anyone, refuses it and shows the list again. Nothing is
made or removed through a folder that is a link. A `_common` is not deleted,
cloned or given routing as a deployment: **Remove this _common...** is the
way, so the deployments on it keep what they inherited. While it renders and
writes, it holds the commit lock: measured with 300 deployments, 33–41
seconds (Helm 3.15, 3.19), commits and saves waiting meanwhile.

**Edit it:** click `_common/<chart>` in the tree. It opens in the same editor
as a deployment, with the same checks — except that a required Common Value
may be left to the deployments. Above the editor: the deployments that
inherit from it, how many groups and rows each takes from it, and, for the
group open, whether each has its own rows. Saving it changes every deployment
that does not write that group (or that Common Value) itself. It has no
Preview: preview a deployment under it.

**Remove it:** `_common/<chart>`'s **⋯** → **Remove this _common...** The
dialog lists each deployment that inherits from it: what it inherited is
copied into its own values as written in the `_common` (Helm's way: Common
Values key by key, a group whole — a group it wrote itself stays its own),
and it depends on the Template again (or on the `_common` above). It is
checked with Helm the same way.

**A deployment under it** — made with **+** in a folder under the
`_common` — depends on the nearest `_common` of its Template and writes
nothing of its own (`common: {mariadb-alerts: {}}`): it inherits every group
and Common Value, a group the `_common` gets later too. A folder with no
`_common` makes a deployment as before (on the Template, every group `[]`).

On a deployment's page, what it inherits is marked:

| | What you see | What you can do |
|---|---|---|
| A group it does not write | The inherited rows, dimmed, "Inherited from shop/_common/…: N rows" | **Override here**: the rows are copied into the deployment, to edit. **Add instance** copies them first too, and says so: a group is inherited whole, so a deployment that writes one row of it writes all of them |
| A group it writes, that a `_common` gives too | "Overrides shop/_common/… (N rows there)", or "clears it" when it writes `[]` | **Reset to inherited**: shows its rows and the inherited ones; on OK the group is removed from the deployment (the key, never a `null`), and the inherited rows show. Save writes it |
| A Common Value it does not set | The inherited value as the field's placeholder, and "from shop/_common/…" | Type a value to override it; **Reset** beside a value it sets removes it |

Saving never writes an inherited group into the deployment unless it was
overridden. After an override, a change to that group in the `_common` no
longer reaches the deployment; after Reset, it does again.

In **Overview**, an inherited group shows its rows read-only, with where they
come from: override it in **Single**, where its rows are copied first.

A page saves only over what it was opened on. When the deployment changed
since — a `_common` made or removed above it, its `_common` edited, or
someone else saved it — Save is refused ("changed since you opened it") and
nothing is written; **Reload** shows what is there now, and the edits on the
page are discarded. Making or removing a `_common` from the tree asks first
when the page open has unsaved edits.

### How a `_common` is laid out

A folder's `_common/<chart>/` is a small chart named `common`, reading the
Template through a link in its own `charts/`; a deployment depends on it
instead of on the Template, and wraps its values under one more `common:`
per layer:

```
shop/_common/mariadb-alerts/Chart.yaml   name: common, dependencies: [{name: mariadb-alerts, version: ">=0.0.0-0"}]
shop/_common/mariadb-alerts/charts/mariadb-alerts → ../../../../charts/mariadb-alerts
shop/_common/mariadb-alerts/values.yaml  mariadb-alerts: {_common: {owner: team-a}, mariadb_saturation_disk: [...]}
shop/prod/Chart.yaml                     dependencies: [{name: common, version: ">=0.0.0-0", repository: file://../_common/mariadb-alerts}]
shop/prod/values.yaml                    common: {mariadb-alerts: {...prod's own...}}
```

Helm renders `prod` with `_common`'s values under its own: Common Values key
by key, a group's rows as a whole — a group `prod` writes replaces the
inherited one, `[]` clears it. A `_common` made by AlertForge gives every
group (`[]` where it has no rows); one written by hand that leaves a group out
renders the chart's example rows for it. A
second layer (`shop/team-b/_common/…`) depends on the first through its link
`charts/common`, and its deployments wrap under `common: {common: {…}}`.

What Helm needs (the same on Helm 3.15 and 3.19):

- Only the deployment's own dependency is fetched (`file://`). A `_common`
  passes its values only to the chart linked in its own `charts/`; a
  `repository:` there is not fetched, and with no link Helm renders nothing
  without an error.
- A chart in `charts/` is known by its Chart.yaml `name`; its values go
  under that name, or under the dependency's `alias:`.
- The deployment's dependency names the `_common` by its Chart.yaml `name`
  (`common`), or Helm stops with an error.
- The link in a `_common`'s `charts/` must be a link. A checkout with links
  turned off (`core.symlinks=false`, the default of Git for Windows) writes
  it as a text file, and Helm stops with an error; AlertForge names it. Check
  the repo out with links on (on Windows: `git clone -c core.symlinks=true`,
  with Developer Mode or as an administrator).

AlertForge reports, naming the layer, a stack Helm renders nothing from (no
link, a `condition:` or `tags:` that is false, a `_common` missing), one it
stops on, and one it cannot show as one stack: a deployment depending on a
Template and a `_common` at once, or a `_common` linking two charts, or a
packed chart (`.tgz`) in a `_common`'s `charts/`.

AlertForge reads the stack wherever it uses a deployment:

| | What it does |
|---|---|
| Tree, editor | Opens the Template at the bottom; shows and saves only the deployment's own values, under every key of the stack |
| Save | A required value a layer gives need not be filled again |
| Preview | Counts the rows the deployment renders with, its layers' included. A link gone or a `_common` missing is an error naming the layer, not "passed" |
| Commit | Refused while a deployment's layer is missing or has lost its link |
| Breaking change | Every `_common` and every deployment on it is migrated, each checked with what its layers give. One whose stack is broken (a `_common` gone, a link gone) holds the change until it is fixed |
| Deleting the Template | Refused while a deployment uses it, through a `_common` too — a broken one included |
| `check-deployment` | Checks a deployment on a stack; refuses the `_common` chart itself |

Never write `null` in a deployment's or a `_common`'s values: Helm versions
read it differently. Write `[]` to clear a group, or remove the key to
inherit it. On a deployment with a `_common` — in its own values.yaml and in
every `_common` it renders on — a null, a group that is not a list of rows
(`false`, `0`, a map) and Common Values that are not a map are:

| Where | What happens |
|---|---|
| Save (from the editor, or as text) | Refused |
| Preview | Listed above the result |
| Commit | Refused, naming the file |

A deployment with no `_common` is not checked for them: what it renders is
what Preview shows.

### Fill in a deployment

1. **Alerts** → pick a deployment in the tree
2. Pick an alert template from the sidebar
3. **Add instance** for a row, fill the columns
4. **Save**

**Common Values** at the top of the sidebar is for values shared by every row
of every group in this deployment.

Each row is one monitored scope. What the columns mean is set by whoever wrote
the template; if a name is unclear, that is worth telling them.

A required column is marked `*`, here and on Common Values, and an empty
required cell is outlined in red until it is filled. A cell left empty is
left out of the row, which is how an optional column says "not set". Save is
refused, naming the row and column, when:

- a required column is empty — in a row, or in Common Values once anything
  renders (any row, or a group marked **No values needed**), unless a
  `_common` above or the Template's own `values.yaml` gives it
- a value holds a line break
- a value read by a label holds `"` or `\`
- a value is not what its column takes (`abc` in a number column, a value
  outside the column's list), as the Template's schema would refuse it in Helm

Saved as text, the values are also refused when Helm would read them
otherwise than they look (`010` is 8 to Helm, `yes` is true), when they are
not under the chart's name, or when a key is written twice — see
[writing values by hand](rules-format.md#writing-values-by-hand). A problem
in what a `_common` above gives is said when you save, not refused: it is
fixed on that `_common`.

In a group with selectors, a row that is `.*` covers everything the rows
under it do not. **Scope** says which rows a row gives up (*excludes N* —
hover for which) and which row it is an exception to. **Add exception**
(the branch icon) copies a row one step more specific in one level: that is
how to carve out a workload with its own threshold. A save that would leave
two rows overlapping is refused, with the row that fixes it offered — **Add
this row**, then Save again.

A group marked **No values needed** renders once per deployment and has no
table — there is nothing to fill in. Preview shows what it produces.

### Check what will actually be deployed

**Preview** renders the chart with your rows through Helm — the same path a
deploy takes — and opens on a summary of what came out: how many alerts each
group produced, by alert name and severity. It also points out:

- a group with no rows, which produces nothing
- a group marked *once per deployment*, which needs no rows; recording rules
  are counted next to the alerts, not in the total
- a group with rows but no alerts, usually a blank cell that drops a rule
- value fields the template no longer has, left over from an older version of
  the chart
- for a group with derived values, each row's values (`21m`, `60m`) as Helm
  renders them; *omitted* for a row that leaves a column they read empty, and
  the reason for one that cannot be deployed

**Raw YAML** switches to the rendered resources themselves. Save first;
Preview saves for you.

It also checks the rules' syntax and reports what it finds: `promtool` for
metrics alerts, `vmalert -dryRun` for log alerts (LogsQL). The title says which
ran — **Promtool + vmalert check passed** for a deployment with both. A LogsQL
mistake is a failed check that names the group and the rule; vmalert stops at
the first bad rule of each group, so check again after fixing it.

A lint problem — most often two rows producing an alert with the same name and
the same labels — shows as **passed with warnings**, in yellow, with the object
listed first. It does not stop a save or a commit. promtool compares only the
name and labels, not the expression; the effect shows up after deployment, when
those rows also query the same series (only a threshold differs) and
Alertmanager receives their alerts as one. Usually a rule's labels are missing
a column that differs per row, or one of the rows is redundant.

Two things promtool accepts but are still wrong are flagged on top: a
`<no value>` in the output (a field that had no value and no default), and a
`{{ … }}` from the template's rules that did not come through verbatim. Either
one is a problem in the chart, not in your rows — pass it on to whoever
maintains the template.

### Set who is notified

Open **Routing** and pick a folder deployment. Routing is per deployment,
kept in its `routing.yaml` next to `values.yaml` (the format is in
[rules-format.md](rules-format.md#notification-routing-routingyaml)).

1. **Set up routing** — name the alert labels to route by and their values,
   e.g. `severity: critical, warning` and `team: db, web`. Every combination
   is a cell of the table.
2. **Notify** — add who a cell can notify: an email address, or a webhook. A
   webhook URL with a token or password in it is refused; put the URL in a
   Secret in the deployment's namespace and give its name and key instead
   (AlertForge cannot see the cluster, so check the Secret exists). These
   configs belong to this deployment; another deployment has its own. A
   config several deployments use can be shared instead — see
   [Share a config between deployments](#share-a-config-between-deployments).
   An email config's **More settings** sets its sender, SMTP server, user
   and password (from a Secret), TLS, headers such as the subject, and the
   text and HTML body. Each one left empty is the platform's own setting
   ([E-mail settings](rules-format.md#e-mail-settings)). A webhook's
   **More settings** sets its authentication (a Bearer token, or a user and
   password, each from a Secret), TLS, timeout and how many alerts go in one
   request ([Webhook settings](rules-format.md#webhook-settings)).
3. **Routes** — pick one or more configs in each cell. An empty cell says
   *drop*: its alerts notify no one, and so does every alert no cell
   matches (*All other alerts: drop*). The brush on a row or column header
   adds a config to — or removes it from — every cell in it; what is saved
   is still one cell per combination. With three or more labels the table
   is a list, one combination per row; **Grid** / **List** switches.
4. **Timing** — `groupWait`, `groupInterval` and `repeatInterval` for every
   cell. The clock in a cell overrides them for that cell alone; a filled
   clock marks a cell that does; a red clock holds a value Alertmanager
   refuses (hover it for why). Empty means the default, and with no default either, what
   the platform's Alertmanager sets. A duration is written largest unit
   first, each unit once: `1h30m`, not `30m1h`; `groupInterval` and
   `repeatInterval` cannot be zero. A cell emptied of configs — by hand or with the brush — is
   removed, its timing override with it.
5. **Save** writes `routing.yaml` and generates the AlertmanagerConfig into
   the deployment's `templates/`. **Preview** shows that resource as Helm
   renders it. Commit both files.

A config a cell still uses cannot be deleted — the cells are listed. A
synced target shows its source's routing, read-only; edit the source.
**Remove routing** deletes both files.

**Labels** changes the labels after set-up, and keeps what the cells say:

| Change | The cells |
|---|---|
| Add a label, e.g. `env: [prod, dev]` | Each cell is copied to every value, configs and timing alike: `critical · db` becomes `critical · db · prod` and `critical · db · dev`. An alert with a listed `env` goes where it did. **An alert without `env`, or with a value not listed, now matches no cell**, and nobody here is notified of it — the page says so until you save |
| Take a label away | The cells that differ only in it become one. Where they do not say the same — other configs, other timing, or one of them empty — the page asks which to keep; the same configs in another order count as the same. Alerts that were dropped for lacking the label now match a cell |
| Rename a label | The cells are kept under the new name. Rename it in its row: a row deleted and added again is a label taken away and a new one added, so its cells are merged, then copied |
| Add a value | Its cells are empty |
| Take a value away | Its cells go; the page lists them and asks first |

The page only edits a `routing.yaml` that passes the checks below. One that
does not — after a hand edit, a merge, or checks that have become stricter
since it was saved — is not drawn as a table: the page lists what is wrong, and the file is
fixed by hand (or removed with **Remove routing** and set up again).

The page rewrites `routing.yaml` when it saves, so comments in a hand-written
one are not kept. To keep editing by hand, edit the file and commit: the
commit is refused while the AlertmanagerConfig is behind `routing.yaml`, and
its **Regenerate** makes the resource from the file as written, comments
kept, for you to look at in the diff and commit.

A save that does not pass the checks is refused with what is wrong, by cell
or config, and writes nothing. The page says when the AlertmanagerConfig is
stale — not what `routing.yaml` says: after a hand edit to
the file, or after the site's object labels changed. Saving again
regenerates it; with nothing edited, the page saves the file as it is,
comments and all. A `routing.yaml` with problems makes no resource, so one
that is there is stale too. On a sync target, stale also means its
routing is not its source's; its Save is off, so the
page names the source and points to **Regenerate** in the Git panel.

A file the page cannot read is named, never taken for "no routing": a
`routing.yaml` or `templates/alertmanagerconfig.yaml` with no permission, a
folder in its place, a link to nothing or a link that leads out of the repo,
and a `sync.yaml` that cannot be read (the answer is 409, `unreadable: true`).
A link to a file elsewhere in the repo is read through. An
AlertmanagerConfig left without its `routing.yaml` — still deployed, with
no table saying so — is named too: remove it (**Remove routing**), or put
`routing.yaml` back. A save is refused only when a file it would replace
cannot be read (no permission, a folder in its place); a file that is a
link — to nothing, or out of the repo — is replaced by the file saved, and
what it led to is left alone. **Remove routing** removes files it cannot
read, and is refused, before anything is removed, by a folder where one of
them should be or a file where `templates/` should be. No save, removal,
sync or Regenerate writes outside the repo: a `templates/` (or `_shared/`)
that is a link leading out of it refuses the write, naming the file.

### Share a config between deployments

A config the same in several deployments — one relay address for every
region — is kept once, in the repo's shared configs
([format](rules-format.md#shared-configs)), and each deployment uses it by
name. Open **Routing** → **Shared configs**:

- **Add**, **Edit** and **Delete** a shared config, with the same dialog as a
  deployment's own. A shared config cannot read a Secret: a Secret lives in
  each deployment's own namespace, so a webhook with a token in a Secret, or an
  SMTP server with its own login, stays in each deployment's routing. The
  dialog does not offer those settings: a shared e-mail config goes through
  the platform's SMTP server, a shared webhook does not authenticate. Saving
  keeps the file's comments and layout; a changed config is written again
  whole, and a comment at the end of its lines goes with it.
- **Used by** lists the deployments that use each config, a sync target with
  the source it is copied from. Before a change is saved, the page lists them:
  saving writes the shared file and makes every one of their
  AlertmanagerConfigs again, all together. If one cannot be made — its
  `routing.yaml` has a problem — nothing is written, and the page names it.
  `routing.yaml` files do not change. Commit what it wrote.
- **Rename** renames the config in the shared file and in every `routing.yaml`
  that uses it (its cells too, comments kept), and makes their resources again.
  It is refused when one of them has a config of its own by the new name.
- A config still used cannot be deleted: the page says by whom.
- A `sync.yaml` that cannot be read stops the page, a save and a rename,
  naming it: without it, which deployment is whose target — and so whose
  resource a change reaches — cannot be told. A shared file that cannot be
  read (no permission, a folder in its place) is named the same way when it
  is saved or renamed; one that is a link (to nothing, or out of the repo)
  is named on the page and by a rename, and replaced by the file a save
  writes, from the page or as text alike. A `_shared/` that is a link
  leading out of the repo refuses every write. A deployment whose
  AlertmanagerConfig cannot be read is listed, and stops only a change to a
  shared config it uses.
- **The same alert twice** — the page lists the cells of different
  deployments that pick one shared config and can match one alert. Two cells
  can when every label both have holds the same value in each; a label only
  one of them has is no condition for the other. `shop/a`'s
  `{severity: critical}` and `shop/b`'s `{severity: critical, team: db}` can
  (a critical `team=db` alert reaches both); two cells with `team: db` and
  `team: web` cannot. With `alertmanagerConfigMatcherStrategy: None`, as set
  up [below](#let-alertmanager-load-the-notification-routing), the config is notified once
  per deployment. All the deployments of one shared config are one line —
  the first 20, then how many more. A sync target is not listed: its
  routing is its source's, so it always matches what its source does; when
  the two are on the same Alertmanager, that config gets each of those
  alerts twice. A `routing.yaml` the save would refuse (written by hand,
  say, with a cell that leaves a label out) is not compared, and named.
  Only said: nothing is refused.
- **Behind** — the shared file was edited with git, or pulled, and the
  resources made from it were not made again. The page lists them, and a
  commit is refused, naming each one. **Regenerate** makes them all again.
  A config taken out of the file while a deployment still uses it, or a file
  that cannot be read, also refuses the commit (see [Commit](#commit)).

On a deployment's Routing page, **Add from shared** picks a shared config: it
is marked *shared* and shown read-only, with what it sends to. A config of the
deployment's own with the same name is replaced at once when it says the same;
when it does not, the page shows both and asks. **Make local copy** turns a
shared one into a config of the deployment's own, with the same settings,
which no later change to the shared one reaches.

Shared configs, like the rest of the repo, can be changed by anyone who can
edit it.

### Work across many groups at once

Switch **Single** / **Overview** above the sidebar. Overview stacks every group
in one page with a filter bar across the top, which is the faster way to answer
"which of these has no threshold set".

### Compare deployments side by side

In Overview, the deployment tree has a checkbox on each deployment of the
selected chart. Check a few more — say `shop/stg` and `cart/prod` next to
`shop/prod` — and every group's card shows one part per deployment, in the
order you checked them, each exactly as that deployment's own Overview shows
it: the rows and Common Values in effect for it. A group a deployment inherits
from a `_common` shows the inherited rows, under "Inherited from
&lt;the _common&gt;: N rows"; one it writes itself (an empty one included,
which clears what it would inherit) shows its own. Filters apply to every
part, and a card's row count is of the rows shown.

With two or more checked the view is read-only. Click a deployment's name in a
card to go back to editing just that one; the groups stay checked. Only one
chart at a time: other charts' deployments cannot be checked. Nothing marks the
differences yet — you compare by eye.

### Copy an existing deployment

**Clone** in the deployment list. It copies the rows, so it is the quick way to
stand up staging from production and change what differs.

### Keep a deployment identical to another

**Sync to...** on the source (or **Sync from...** on the target) makes the
target a copy of the source: the Template its `Chart.yaml` depends on, its
`values.yaml` and its routing. From then on
the target is read-only, and every save of the source's values or routing is
copied to it.

- The target renders the same Template as the source: its `Chart.yaml`
  depends on what the source's does, with the `file://` path worked out from
  where the target is, so a target in a deeper or shallower folder renders
  too. A target on another Template is moved onto the source's, and its own
  alert rows go; the dialog says so, with how many, before you confirm. A
  sync made before this, to a target on another Template, is moved at the
  next save of the source; **Sync to...** marks such a target the same way.
- The target inherits what the source inherits: on a source under a
  folder's `_common`, its `Chart.yaml` depends on that `_common`, wherever the
  target is — not on the `_common` of the target's own folder, nor on none.
  It deploys what the source does. This is not refused; it is said: **Sync
  to...** marks such a target ("will inherit shop/_common/…, its source's —
  not cart/_common/…"), the tree marks it after ("inherits shop/_common/…
  (from its source)"), and its page says where its inherited values come
  from. A `_common` made in the target's folder leaves it to its source
  (the dialog lists it, and why); unlinked, it keeps the source's, and the
  tree goes on marking it ("inherits shop/_common/…, not cart/_common/…")
  — as it marks any deployment on another `_common` than its folder's.
- A source with values a save would refuse — a required value left empty, a
  value that cannot go in a label, a `values.yaml` that is not YAML — cannot
  be synced, nor one whose `routing.yaml` a save would refuse: neither file
  is copied. The dialog lists what to fix in the source first. A source
  whose routing resource is behind its `routing.yaml` (edited by hand) gives
  the target the resource made from it, not the old one; the source itself
  keeps deploying the old one until its routing is saved. A routing
  resource left without its `routing.yaml` refuses the sync too: remove it,
  or put `routing.yaml` back.
- Deleting a source lets go of its targets: each keeps what it has and can
  be edited again. The **Delete** dialog lists them, and each can be deleted
  along with the source instead. Those marked to be deleted go
  first: when the source then cannot be deleted, the message says why and
  names the ones already gone; the source keeps the rest.
- A `sync.yaml` that cannot be read (no permission, a folder in its place)
  or is no registry (not YAML, not a map, `syncs:` not a list) is named, with 409 and `unreadable: true`, by everything that
  needs to know who syncs from whom: the sync list, sync and unlink, a
  save, deleting a deployment, the Routing page, the shared configs, a
  Template change that checks or migrates its deployments (and its
  preview), and making or removing a `_common`.
  It is never taken for "no syncs", and nothing rewrites it. An empty
  `sync.yaml`, or one with only comments, is no syncs yet.
- A sync to a target whose `values.yaml` is a folder is refused (409)
  naming the file; one whose `Chart.yaml` is a folder (or cannot be read)
  is no deployment, and is refused (400, "exists but is not a valid
  deployment"). Nothing is written.
- A target is its source's copy, and Commit holds it to that: a target
  whose `values.yaml`, or the Template its `Chart.yaml` depends on, is not
  what a sync of the source writes (edited with git, or in the Gitea web
  editor) refuses the commit, naming the target, its source and the file
  (for values, the first key that differs). Sync it again from the source
  (save the source, or **Sync from...** on the target), or unlink it. Its
  routing is held to its source's the same way (**Regenerate** copies it
  again). `check-repo` refuses it too. A source whose files cannot be read
  is named as such, not the target.
- When a save cannot write a target (a permission error, or a `sync.yaml`
  entry that is not a deployment on disk), the source is still saved and the
  page names the target, which may not match the source. Fix the cause and
  save the source again. A target on another Template whose `values.yaml`
  cannot be written keeps its own Template too, so it still renders its
  alerts.

---

## Both

### Commit

Saving only writes files. **Git** → **Changes** shows the diff, a commit
message box, and **Discard all changes** if you would rather start over.

Nothing leaves the working tree until you commit, which is why Save is safe to
experiment with.

If the page says **the server's answer could not be read**, the answer was
cut off on its way, or was not one (a proxy's sign-in page when the session
ran out). After a save or a delete the server may well have made the change:
reload the page to see what it has — signing in again if asked — before
doing it again. **Changes** shows what is on disk either way.

A commit is refused while any chart:

- has a problem Save would refuse, or a rule that reads no column at all — it
  would be emitted identically on every row. Save allows that, because a chart
  being turned into a template passes through it
- has generated files that are behind its rules files, or one of them
  missing — open the chart and save, or run `gen-rules`. Only the
  `values.schema.json` missing does not stop it (Helm renders the same,
  without checking the values): the commit goes through and lists it under
  **Templates to look at**, with a schema keyword AlertForge does not check.
  Opening the Template or regenerating writes it back
- has a file Helm stops on or renders other than written: a
  `values.schema.json` that is not JSON, a `values.yaml` that is not YAML (or
  written in a way AlertForge cannot tell how Helm reads — a tag, an anchor,
  `|2`: the message names the line; write it plainly), a `Chart.yaml` whose
  `name` is not the folder's, a folder name with a dot (Helm passes no values
  under it, so nothing renders), a file in `templates/` starting with `_` that
  holds a rule object (Helm takes it for a partial and renders none of it)
- is a link that leads outside the repo, or has a file that does (named as
  one that cannot be read)

Only AlertForge's Templates are checked: a folder under `charts/` whose
`Chart.yaml` is not annotated `app: alertforge` and that has no `rules/` (a
backup, an empty folder, someone else's chart) is not.

A chart that is not migrated yet does not stop a commit: it renders as it
always has, so the commit goes through and names it as a reminder — see
[Move an old chart onto the new model](#move-an-old-chart-onto-the-new-model).

A commit is refused, too, while any deployment:

- has a routing resource that is not what its `routing.yaml` and the shared
  configs it uses say: either file edited by hand, or the object labels
  changed (`RULE_OBJECT_LABELS` and the rest) since it was made — Alertmanager
  would stop loading it and its notifications stop without a word
- uses a shared config (`{ shared: true }`) the shared configs do not give:
  the config was taken out of `_shared/notification-configs.yaml`, the file
  was removed, or it has problems. The refusal names the config and each
  deployment using it, and the file when it has problems. Regenerate cannot
  fix it: put the config back, or fix the file
- has a routing resource with no `routing.yaml` left — remove it, or put
  `routing.yaml` back
- has a `routing.yaml` or routing resource that cannot be read (no
  permission, a folder in its place, a link to nothing or out of the repo),
  named by its path
- follows another through sync, and its routing is not its source's
- uses a Template that is no longer in the repo (deleted outside AlertForge)
- asks in its `Chart.yaml` for one exact version of its Template (e.g.
  `"2.0.0"`) that the Template is not at, or for no version — or its
  Template's `Chart.yaml` has no version Helm reads: Helm then renders none
  of it. A range other than that is not checked. A deployment AlertForge
  creates asks for `">=0.0.0-0"`, any version, so changing the Template's
  version by hand (or pulling a change to it) breaks nothing; an older one
  with an exact version is fixed by writing `">=0.0.0-0"` there
- has a `values.yaml` that cannot be read as values at all: not YAML, YAML
  AlertForge cannot tell Helm's reading of, a folder, a link out of the repo,
  or no map under the chart's name
- renders on a `_common` stack with a `null` in it — in its own values, a
  `_common`'s or the Template's: Helm 3.15 and 3.19 deploy different things
  for it (one keeps the null, the other removes the key and takes what is
  above it, or the default), so what deploys would depend on the Helm
  version. The message names the file and the key: give it a value, or
  delete the line

A deployment's other value problems do not refuse the commit: Helm stopping
on a cell, a value Helm reads otherwise (`010`), values not under the
chart's name, a key written twice (in its own values, or in a `_common` it
renders on: Helm deploys the later one, which may not be the one meant). They are
listed under the deployment after the commit, as rows the row identity label
cannot tell apart are, and as a required cell written `''`, a value a label
cannot take and selector rows that cannot be told apart are. `check-repo`
refuses what Helm stops on or reads otherwise than written (the first three);
the rest Helm renders as written, and `check-repo` says them as warnings.

and while `sync.yaml` has an entry that cannot be right: one deployment
following another that follows a third, a target with two sources, a path
that is not a deployment (a folder that is a link included), an entry with
no `targets` list, a source listed twice — or cannot be read at all (not
YAML, no permission, a folder). The refusal names each
deployment or entry. A `\` in a path is read as `/`, and a target listed
twice under one source is one link: neither refuses a commit. **Regenerate N** makes the routing that is behind again
from each `routing.yaml` (the text stays as written) and copies each sync
target's from its source; it writes the files and commits nothing, so look
at the changes, then commit. One that cannot be made is listed, and the
commit stays refused.

A `routing.yaml` with problems of its own does not stop a commit: the commit
goes through and names it, to fix on its Routing page. Nor does a shared
configs file with problems that no deployment uses: it is named the same way.
Nor does an AlertmanagerConfig in a `_common` chart's `templates/`, which
every deployment on that chart deploys with no `routing.yaml` saying so: it
is named for each of them (`check-deployment` fails on it).

A commit waits for a save in progress — of a Template, a chart, a folder
or a deployment, in this tab or another — and a save waits for a commit,
so what is committed is never half of a save. A commit made while files
change some other way (a terminal, a git pull) may answer **Files changed
while committing — try again**. Nothing was committed; commit again. What would fail every time — a
symlink pointing nowhere, a git `index.lock` left by a git that is gone, a
commit hook that fails — is reported as a failure, naming it, instead.
A save or a commit that fails in a way the server did not expect is
answered at once (500, "the cause is in its log") and lets the next one
go at once, instead of leaving it waiting. A request whose body is not
JSON, or is over 100 KB, is answered 400 or 413 saying so.

These checks are AlertForge's commit button only: a commit made with git, or
in the Gitea web editor, does not go through them. `check-repo` (see
[Check the whole repo](#check-the-whole-repo)) makes every one of them on
the whole repo, refuses what Commit only names, and renders every
deployment with Helm.

---

## Command line

`gen-rules`, `import-rules`, `check-deployment` and `check-repo` ship in the AlertForge
image, which is the way to run them from a gitops repo: it has no `scripts/`.
The commands below are written short, as run from an AlertForge source
checkout (after `npm ci`), with `charts/<name>` standing for the chart's
folder in the gitops repo. From the image, put the `docker run` in front and
the paths under `/work` — see [Run them from the image](#run-them-from-the-image).

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

A new chart can start from `rules/` alone: write `rules/*.yaml` in an empty
folder and run it with `--init`. It creates `values.schema.json`, the
templates and `Chart.yaml`.

### Edit the rules files directly

Edit `rules/*.yaml`, then regenerate:

```bash
node scripts/gen-rules.mjs charts/<name>
```

On a chart that already has `rules/`, this regenerates `values.schema.json`
and every template and leaves the rules files exactly as you wrote them,
comments included.

It first runs the checks a save in the editor makes. Rules the editor would
refuse — an optional column with no default read mid-string, say — are listed
as `ERROR` with the group and rule, and nothing is written. What only a commit
refuses is listed as `warn` and does not stop it.

### Check a chart's generated files still agree

```bash
node scripts/gen-rules.mjs charts/<name> --check
```

Runs the same checks, then regenerates and compares instead of writing;
non-zero exit on a refused rule or any difference.
Worth wiring into CI or a pre-commit hook if files are ever committed by hand
— it is what enforces that `rules/` is the source.

### Regenerate every chart after an upgrade

When a release changes the generated format (moving `expr` and annotations
to block scalars was one such change, and writing number columns through
`toJson`, so `1000000` no longer renders as `1e+06`, another), every migrated
chart turns `stale` and
commits are refused until its products are regenerated. Coming from 1.x, see
[upgrade-2.0.md](upgrade-2.0.md) instead. A change to the routing resource's
format, or to the object labels, turns every deployment's routing behind the
same way: commit, and use **Regenerate** in the refusal (see
[Commit](#commit)).

Run it from the gitops repo's root with the new release's image (see
[Run them from the image](#run-them-from-the-image)), with the site's
`RULE_OBJECT_*` variables **exported** in your shell, set to what the
editor runs with. `-e NAME` passes on a variable the shell exports; one
only set (`NAME=…` without `export`), or not set at all, is left out, and
the templates are written without the site's labels — every chart then
reads as different from what the editor makes.

Each loop below is a script: save it as a file and run it with `bash`, or
as a CI step. It goes through every chart and exits non-zero when any one
failed.

```bash
export RULE_OBJECT_LABELS='{"release":"kube-prometheus-stack"}'   # and the others the site sets
IMAGE=ghcr.io/null-ptr-exception/rulemgmt:<version>

status=0
for c in charts/*/; do
  [ -d "$c/rules" ] || continue
  docker run --rm -u "$(id -u):$(id -g)" -v "$PWD:/work" \
    -e RULE_OBJECT_LABELS -e RULE_OBJECT_ANNOTATIONS \
    -e RULE_OBJECT_LABELS_BY_PROFILE -e RULE_OBJECT_ANNOTATIONS_BY_PROFILE \
    "$IMAGE" node scripts/gen-rules.mjs "/work/$c" || status=1
done
exit "$status"
```

A chart that fails is named with `ERROR` and left as it was. Then run the
`--check` loop [below](#check-every-chart) over every chart: it should
exit 0, with no `DIFFERS`.

From an AlertForge source checkout of the same release (after `npm ci`,
with the same variables exported), it is the same loop over the gitops
repo's path:

```bash
status=0
for c in /path/to/gitops/charts/*/; do
  [ -d "$c/rules" ] || continue
  node scripts/gen-rules.mjs "$c" || status=1
done
exit "$status"
```

Commit that on its own, with nothing else in it. The rendered rules are the
same; review it with `dyff` rather than a text diff. See
[alert-rules.md](alert-rules.md#when-an-upgrade-changes-the-output-format).

A release can also refuse a value it used to accept — a rules file with
`interval: 30m1h`, or a column with `type: strng`
([durations](rules-format.md#durations)). Such a chart cannot be regenerated
until the file is corrected, and commits are refused meanwhile, naming the
file and the value. Find them before upgrading, with the new release's image
(`IMAGE` set to the new version, the same variables exported as above).

<a id="check-every-chart"></a>
A chart it lists as `ERROR` needs correcting; one only listed as `DIFFERS`
is what regenerating fixes. The script exits non-zero when any chart is
either:

```bash
IMAGE=ghcr.io/null-ptr-exception/rulemgmt:<version>

status=0
for c in charts/*/; do
  [ -d "$c/rules" ] || continue
  docker run --rm -u "$(id -u):$(id -g)" -v "$PWD:/work" \
    -e RULE_OBJECT_LABELS -e RULE_OBJECT_ANNOTATIONS \
    -e RULE_OBJECT_LABELS_BY_PROFILE -e RULE_OBJECT_ANNOTATIONS_BY_PROFILE \
    "$IMAGE" node scripts/gen-rules.mjs "/work/$c" --check || status=1
done
exit "$status"
```

From a source checkout of the new release:

```bash
status=0
for c in /path/to/gitops/charts/*/; do
  [ -d "$c/rules" ] || continue
  node scripts/gen-rules.mjs "$c" --check || status=1
done
exit "$status"
```

A chart still in the old schema-only format is checked when it is converted:
a column of a type other than `string`, `number`, `integer`, `boolean` or `duration`
stops the conversion until the schema is corrected.

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

### Run them from the image

The AlertForge image carries these tools, so no checkout or Node install is
needed — only the same image version that will run the editor. Mount the
gitops repo and run as yourself, so the files it writes stay yours:

```bash
IMAGE=ghcr.io/null-ptr-exception/rulemgmt:<version>

docker run --rm -u "$(id -u):$(id -g)" -v "$PWD:/work" "$IMAGE" \
  node scripts/gen-rules.mjs /work/charts/<name> --check

docker run --rm -u "$(id -u):$(id -g)" -v "$PWD:/work" "$IMAGE" \
  node scripts/import-rules.mjs /work/rules.yaml /work/charts/<name> --dry-run
```

Site policy for the generated resources goes in with `-e`, the same variables
the editor reads (see [below](#put-your-own-labels-on-every-generated-resource)):

```bash
docker run --rm -u "$(id -u):$(id -g)" -v "$PWD:/work" \
  -e RULE_OBJECT_LABELS='{"release":"kube-prometheus-stack"}' "$IMAGE" \
  node scripts/gen-rules.mjs /work/charts/<name>
```

Pass the same values the editor runs with: otherwise the templates are
generated without the site's labels, and `--check` reports every one as
different.

### Check a deployment from the image

`check-deployment.mjs` checks one deployment the way the editor does: it
renders it with Helm and runs `promtool` (or `vmalert`) on each rule object,
as **Preview** does, checks its Template's files as a commit does — through a `_common` too —
(a generated template missing, a partial `templates/_x.yaml` holding a rule
object, a rule object repeating the generated alerts, a Template folder name
with a dot: Helm renders the rest without a word, so the render alone does
not show them), and checks its `routing.yaml` as the **Routing** page
reads it — including whether `templates/alertmanagerconfig.yaml` is still what
`routing.yaml` generates, whether one is there with no `routing.yaml`, and
whether a `_common` chart it renders on has one of its own. It reads the
deployment's `values.yaml` as the editor does, within the same size limit
(`MAX_VALUES_BYTES`): one that cannot be read — a folder, a link leading
outside the repo — fails the check, naming it; one AlertForge cannot tell
Helm's reading of (larger than the limit, a tag like `!!binary`, a `|2`
block, an unclosed `[`) is left to Helm: if Helm fails on it the check
fails (exit 1) with Helm's error, and if Helm renders it the rest is
checked on what Helm rendered, with a line saying AlertForge cannot tell
how Helm reads the file (the editor and Commit refuse it, though it
deploys).

```bash
docker run --rm -u "$(id -u):$(id -g)" -v "$PWD:/work" "$IMAGE" \
  node scripts/check-deployment.mjs --repo /work /work/deployments/<chart>/<env>
```

It exits:

| Exit | When | Example |
|---|---|---|
| 0 | it is a deployment, and every check passes | `deployments/shop/prod` renders, its rules load, its routing is current (values AlertForge cannot tell Helm's reading of, which Helm renders, are checked as rendered and said) |
| 1 | it is a deployment, and it would not deploy as written or is wrong: Helm fails to render it, a rule check fails, or a file of its own cannot be read (its `values.yaml`, `routing.yaml` or routing resource: no permission, a folder in its place, a link to nothing or out of the repo) | `values.yaml` is a link to a file that is not there |
| 2 | it is not a deployment, or AlertForge cannot tell: wrong arguments; a folder that is not a folder deployment (its own `Chart.yaml` naming a Template, and a `values.yaml`); a folder that is a link, or is reached through one (named, with the folder to check instead); a folder outside the repo given with `--repo`; a `Chart.yaml` that cannot be read or used (whether it is a deployment cannot be told); site settings it cannot read; helm or a checker missing; a repo root it cannot tell (below) | `deployments/shop/old` has a `Chart.yaml` with no `dependencies` |

- Mount the gitops repo whole: the deployment finds its chart through
  `file://../../../charts/<chart>`.
- Mount it writable (no `:ro`) for the uid you run as: like Preview, Helm
  writes `Chart.lock` and `charts/` into the deployment folder; the gitops
  repo's `.gitignore` keeps them out ([setup](gitops-repo-setup.md)). A
  read-only mount fails with Helm's `read-only file system`, exit 1.
- Pass the site's labels with `-e` as for `gen-rules --check`, or every
  AlertmanagerConfig is reported as out of date.
- A `routing.yaml` using shared configs is checked with the repo's
  `_shared/notification-configs.yaml` — the one at the root of the git
  checkout the deployment is in, or of the folder given with
  `--repo <root>` (before the deployment). No file above that root is read.
  Pass `--repo /work`, as above: git in the container refuses a checkout
  another uid owns ("dubious ownership" — root included), and a plain copy or
  a worktree mounted alone is no checkout at all. Without `--repo`, when git
  cannot tell the root, it exits 2 with git's own message.
- A deployment on a `_common` chart needs the same root: it tells the
  Template at the bottom of the stack from any other chart. Without `--repo`,
  when git cannot tell it, `check-deployment` exits 2 with git's own message
  rather than check against a smaller folder; given a folder inside the repo
  (`--repo /work/deployments`), one without the `charts/` folder, it exits 2
  saying that is not the repo's root. A deployment that renders its Template
  directly, with no `routing.yaml` using shared configs, needs no root: when
  neither git nor `--repo` gives one, it is checked all the same, and a
  `routing.yaml` that is a link is read wherever it leads, as Helm reads it
  (with a root, a link leading out of it is not read).

To check every deployment, and the rest of the repo, at once, use
`check-repo` (below).

### Check the whole repo

`check-repo.mjs` checks the whole gitops repo the way AlertForge's Commit
checks it — every Template's files, `sync.yaml`, the shared notification
configs, and each deployment's values, Template, `_common` stack and
routing, with the same checks — then renders every deployment with Helm and
runs `promtool` (or `vmalert`) on each rule object, as `check-deployment`
does:

```bash
docker run --rm -u "$(id -u):$(id -g)" -v "$PWD:/work" \
  -e RULE_OBJECT_LABELS -e RULE_OBJECT_ANNOTATIONS \
  -e RULE_OBJECT_LABELS_BY_PROFILE -e RULE_OBJECT_ANNOTATIONS_BY_PROFILE \
  "$IMAGE" node scripts/check-repo.mjs /work
```

`node scripts/check-repo.mjs [[--repo] <repo>] [--jobs N] [--json]`: `<repo>`
(or `--repo <repo>`, as `check-deployment` takes it) is the gitops repo's
root (without it, the git checkout the current folder is in;
in a container pass it, as above: git there refuses a checkout another uid
owns). `--jobs` is how many deployments are rendered at once (4). `--json`
prints the same as data: `problems`, each with `group` (the Template,
deployment or file it is said under), `action` (`refuse` or `warn`),
`notChecked`, `code`, `file` and `message`, and the counts.

It writes nothing into the repo: Helm renders in a copy of it, so the mount
may be read-only (`-v "$PWD:/work:ro"`).

What it does not walk into is said as a warning (`not checked: …`), and
does not change the exit code: a deployment in a hidden folder, a
`Chart.yaml` and `values.yaml` at the repo's root, and a deployment kept
as a `<name>-values.yaml` file (not supported: move it to a folder
deployment).

It refuses everything Commit refuses, and what Commit only names: a value
Helm stops on or reads otherwise than written (`010`), values not under the
chart's name, a `routing.yaml` with problems, a shared configs file with
problems, an AlertmanagerConfig a `_common` chart hands to its deployments,
a Template with a generated file missing, a deployment Helm cannot render or
whose rules the checker refuses. What Helm renders as written is said as a
warning and does not fail: a key written twice, a required cell written
`''`, a value a label cannot take, rows the row identity label cannot tell
apart, a chart not converted to `rules/` yet, a Template's missing
`values.schema.json`, a lint finding of promtool, what a routing's configs
will do that is worth saying.

| Exit | When |
|---|---|
| 0 | nothing refused; warnings do not count; a repo with no deployments is 0 (a folder with no `charts/` and no deployment says `nothing found to check` first, so a wrong path shows in the log) |
| 1 | something refused: a deployment or Template that would not deploy as written — Helm fails on it, a rule check fails, a file of its own cannot be read, or what Commit refuses (values AlertForge cannot tell Helm's reading of included: Helm renders them, and what it renders is checked) |
| 2 | something was not looked at: wrong arguments, a repo that is not there, a folder that is not the repo's root (one inside a git checkout, which names the checkout's root; one with deployments and no `charts/` folder, such as `deployments/`), site settings it cannot read, helm or a checker missing, a folder it cannot list or a `Chart.yaml` it cannot read (whether a deployment is there cannot be told), `sync.yaml` or the shared configs that cannot be read, a file outside every deployment and Template that cannot be read |

It prints one line per problem, under the Template or deployment it belongs
to, refusals before warnings, and the counts last:

```text
charts/mariadb-alerts
  refused      charts/mariadb-alerts: mariadb-alerts: products are out of date (templates/mariadb-traffic-qps-low.yaml) — regenerate before committing
deployments/mariadb-2/production
  refused      deployments/mariadb-2/production/values.yaml: mariadb_latency_slow_queries row 1, "warn_threshold": "abc" is not a number
  refused      deployments/mariadb-2/production: Helm could not render it: Error: values don't meet the specifications of the schema(s) in the following chart(s): | mariadb-alerts: | - at '/mariadb_latency_slow_queries/0/warn_threshold': got string, want number
check-repo: 1 Template, 3 deployments: 3 refused, 0 not checked, 0 warnings
```

A clean repo prints the last line alone. 300 deployments take about a minute
with `--jobs 4`, nearly all of it Helm and the rule checker; more jobs do not
make it faster, since the checker runs at most four at once.

Limits:

- A deployment that depends on a chart from a remote repository
  (`https://…`, not `file://`) is refused: Helm renders with
  `--skip-refresh`, as Preview and `check-deployment` do, and does not fetch
  it.
- It checks the files as they are in the folder it is given, not a git
  commit: what is not committed is checked too.

---

## Platform

### Put your own labels on every generated resource

Set these where the platform is deployed — they are read at startup:

```bash
RULE_OBJECT_LABELS='{"release":"kube-prometheus-stack"}'
RULE_OBJECT_ANNOTATIONS='{"alertforge.io/source":"generated"}'
```

When log alerts need a different value for the same key, add it for their
profile: `RULE_OBJECT_LABELS_BY_PROFILE='{"vlogs":{"release":"vm-logs"}}'`
(and `RULE_OBJECT_ANNOTATIONS_BY_PROFILE`). See
[alert-rules.md](alert-rules.md#different-values-per-output-profile).

Values are literal; one containing `{{ }}` is dropped with a warning. Existing
templates are not rewritten — they turn stale, and commits are refused until
they are regenerated. Opening and saving each chart does it, or
`gen-rules` per chart (see
[Regenerate every chart](#regenerate-every-chart-after-an-upgrade)).

### Let Alertmanager load the notification routing

A deployment's AlertmanagerConfig (`v1alpha1`) is loaded by prometheus-operator
only when the Alertmanager resource selects it. Two settings matter:

```yaml
# the Alertmanager resource (kube-prometheus-stack: alertmanager.alertmanagerSpec)
alertmanagerConfigSelector:
  matchLabels: { release: kps-alertmanager }   # what the routing objects carry
alertmanagerConfigMatcherStrategy:
  type: None
```

- **The selector** must match the labels on the routing objects: set them with
  `RULE_OBJECT_LABELS`, or for routing only with
  `RULE_OBJECT_LABELS_BY_PROFILE='{"routing":{…}}'`, then regenerate. One that
  does not match is ignored silently.
- **`alertmanagerConfigMatcherStrategy: None`**: otherwise the operator adds a
  `namespace` matcher for the namespace the AlertmanagerConfig is in, and
  alerts from anywhere else never reach its routes.
- **`alertmanagerConfigNamespaceSelector`**: an AlertmanagerConfig is read only
  from the namespaces it selects — by default the Alertmanager's own. Set it
  (e.g. `{}` for every namespace) when deployments are released into other
  namespaces; a Secret a config reads must be in the deployment's namespace.

The operator puts each AlertmanagerConfig under Alertmanager's root route with
`continue: true` — the generated file says so too — so it does not stop other
routes from seeing an alert. It also means two deployments under one
Alertmanager whose `routing.yaml` cover the same label combination both notify
for it: keep each deployment's alerts apart by a label, such as one that names
the deployment.
When both pick the same config — a shared one, say — that config gets the
alert once for each: each deployment's receiver has a name of its own, and
Alertmanager does not merge them (measured, Alertmanager 0.28.1; with the
`OnNamespace` strategy, once). The Shared configs page lists such cells
(see [Share a config between deployments](#share-a-config-between-deployments)).

### If rules deploy but never fire

Check whether the evaluator filters by label — Prometheus for metrics alerts
(PrometheusRule), VMAlert for log alerts (VMRule):

```bash
kubectl get prometheus -A -o custom-columns='NAME:.metadata.name,SELECTOR:.spec.ruleSelector'
kubectl get vmalert -A -o custom-columns='NAME:.metadata.name,SELECTOR:.spec.ruleSelector'
```

A `ruleSelector` that your resources do not match means they are ignored
silently — they exist in the cluster, and the evaluator's rules page shows
nothing. Put the matching labels in `RULE_OBJECT_LABELS` — or, for one kind
of alert only, `RULE_OBJECT_LABELS_BY_PROFILE` — and regenerate.

### Run it locally

```bash
npm run dev
```

Vite on 5173, the API on 3001. See [AGENTS.md](../AGENTS.md) for the cluster
workflow.
