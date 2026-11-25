# Architecture

A developer's map of the code. For how a chart describes alerts, see
[alert-rules.md](alert-rules.md) and [rules-format.md](rules-format.md); for
how to do things, [how-to.md](how-to.md); for the testing rules,
`AGENTS.md`.

## What AlertForge is

AlertForge edits the alert rules and notification routing kept in a gitops
repo. It has no database: an Express server reads and writes the files of
that repo, renders deployments with `helm template`, checks what Helm
renders with `promtool` and `vmalert`, and serves a React page. The gitops
repo is the only state.

## The repo it manages

```
charts/
  mariadb-alerts/                 a Template (a Helm chart)
    Chart.yaml
    rules/                        the source: one file per group, and _common.yaml
    values.schema.json            generated from rules/
    templates/                    generated from rules/, one file per group
    values.yaml                   the Template's own values
deployments/
  shop/
    _common/mariadb-alerts/       values every deployment under shop/ inherits:
      Chart.yaml                  a small chart named `common`, with a link to
      charts/mariadb-alerts -> ../../../../../charts/mariadb-alerts
                                  the Template, in its own charts/
      values.yaml
    prod/                         a deployment
      Chart.yaml                  depends on the Template, or on a _common
      values.yaml                 its rows
      routing.yaml                who is notified (optional)
      templates/alertmanagerconfig.yaml   generated from routing.yaml
_shared/notification-configs.yaml   notification configs deployments share
sync.yaml                         which deployment is kept identical to which
```

Helm renders a deployment's folder; the rules it renders are
`PrometheusRule` or `VMRule` objects (`config/outputs.json`), the routing an
`AlertmanagerConfig`. The server takes the repo from `GITOPS_DIR`.

## A request's path

```
page  ->  src/utils/chartApi.js  ->  src/lib/apiFetch.js
                    |  /api/v2/...
                    v
server.js                  JSON body parser, mounts one router per area
                    v
server/http/route.js       the route's declared shape: params, query, body
                    |      (does not fit -> 400 naming the field)
                    v
server/routes/*.js         handler(input, { repo, ... })
                    |
        read        |        write
  repo.file, repo.helmYaml,  planChange(repo, change)   on the snapshot
  loaders -> findings        applyChange(plan)          under the commit lock:
  decide(findings, policy)                              compared with what was
  -> refuse / warn / list                               read; all files or none
                    v
            { status, body }
```

## The server's layers

| Directory | What is there |
|---|---|
| `server.js` | Start-up (sample Templates in an empty repo, leftover temp files removed) and the routers under `/api/v2`. Any other `/api` path is a JSON 404 |
| `server/http/` | `route(name, shape, handler)`: every route declares its request as zod schemas, and a value that becomes a path or a name in the repo with `repoPath` / `repoName`. The wrapper parses the request before the handler runs, always answers (a file that cannot be read is a 409 naming it, anything unexpected a 500 with no path of the machine) and lets the commit lock go. A router with a route that declares nothing does not start (`declaredRoutes`). `body.js` is the JSON body parser |
| `server/routes/` | One router per area: `charts`, `templates`, `deployments`, `folders`, `sync`, `render` (Preview), `git`, `routingShared`. A handler reads the request only through its parsed input |
| `server/repo/` | The only code that touches the gitops repo's files: the loader, the findings and policy tables, the writer, the commit lock, the path rules and the git calls that take a value from a request. See below |
| `server/lib/` | What is built on the repo layer and reads the repo only through it: the `_common` stack (`stack.js`), Commit's checks (`commitChecks.js`, `commit/`), sync, migration, the checks of one deployment and of the whole repo (`deploymentCheck.js`, `repoCheck.js`), and the runner of Helm and the checkers (`ruleCheck.js`) |
| `src/utils/` | Pure functions the browser and the server both use: the rules-file model, the generator of `templates/` and `values.schema.json`, the routing generator, the rule checks. The image ships this folder beside `server/` |

The boundary is held by `npm run lint` (`eslint.config.js`):

- `boundary/disk` is an error where `server.js`, `server/` or `scripts/`
  code outside `server/repo/` uses `fs`, a YAML parser or `child_process`;
  in `src/utils/` only parsing text is allowed.
- `boundary/request` is an error where a route file reads `req.params`,
  `req.query` or `req.body` itself.
- An exception is one line of `ALLOWED` there, naming the file, what it may
  use and why: each is for something that is not the repo (Helm's output, a
  temp folder for a checker, the app's own files).
- `tests/unit/boundaryLint.test.js` plants a read, a parse, a child process
  and a request read in each place and fails when lint lets one through.

## `server/repo/`

**Loader.** `openRepo(root)` (`openRepo.js`) gives one snapshot of the repo
for one request or one command. A file is read once, however many checks
look at it. Every read gives a `Loaded` (`loaded.js`): `absent`,
`unreadable` (with why), `invalid` (with findings) or `ok` (the value and
its findings); only `ok` has a value, and reading the value of another
state throws. `repo.helmYaml` reads a values file the way Helm reads it
(`helmYaml.js`), or says it cannot tell. The loaders built on it —
`template.js`, `deployment.js` (a deployment's values as Helm coalesces
them over its `_common` layers and the Template), `routing.js`,
`shared.js`, `sync.js`, and `walk.js` (which folder is a deployment) — are
what every entry point asks, so opening, saving, Commit, Preview and the
command line see the same file the same way.

**Findings and policy.** A loader says what is in a file as findings
(`finding.js`): a code, the file, a message, and what Helm does with it
(`fails`, `renders`, `renders-differently`, `n/a`, `unknown`). A finding
never says whether a caller refuses. That is a policy table, one per entry
point (`policy.js`, `routingPolicy.js`, `findings/template.js`): by
default a table refuses what Helm fails on, renders differently or what
AlertForge cannot tell, and lets the rest through; each row that changes
this (`refuse`, `warn`, `list`, `ignore`) carries its reason.
`decide(findings, policy)` gives the three lists.

**Writer.** A route that saves, moves or deletes files of the repo does it
as a change (`write.js`), with one file per kind of change under
`server/repo/changes/`. Commit, Discard, Push and Pull run git instead, and
start-up scaffolding (`setup.js`) writes before any request.

1. `planChange(repo, change)` works out, on a snapshot, every file to
   write, the repo as it will be after, and the findings of that. It writes
   nothing.
2. `applyChange(plan, { policy, expect })` answers a refusal (the plan's
   own, or the policy's) without taking the lock.
3. Under the commit lock (`lock.js`) it opens the repo again and compares
   every file and folder the plan read. A change to the file the write is
   about is a 409 and nothing is written; a change elsewhere is planned
   once more, under the lock.
4. The files are written one after another, each to a temp file beside it
   and renamed over it. One that cannot be written puts back those written
   before it and answers 409 naming that file.

The lock is one per repo, inside the server's process: every write, and
Commit, Push, Pull and Discard, take it. A program outside the server is
not held by it.

## Command-line tools

All of them open the repo with the same loader and decide with a policy
table, so they answer as the server does.

| Tool | What it does | Shared with the server |
|---|---|---|
| `scripts/gen-rules.mjs` | Regenerates a Template's schema and `templates/` from `rules/` (or converts an older chart); `--check` only compares | The Template loader, the generator, the Template's `cli` policy table; writes with the writer's all-or-none file write, without the lock |
| `scripts/gen-chart.mjs` | Regenerates `templates/` only | The same |
| `scripts/import-rules.mjs` | Imports Prometheus rules into a Template's `rules/` | The same, and the editor's import |
| `scripts/check-deployment.mjs` | Checks one deployment: what it renders, and its routing | Preview's render and checkers, the routing loader, the `checkDeployment` tables |
| `scripts/check-repo.mjs` | Checks the whole repo as Commit does, then renders every deployment | Commit's checks under its own `checkRepo` table, which refuses what Commit only lists; Helm renders in a copy of the repo, so nothing is written |

The image ships `gen-rules`, `import-rules`, `check-deployment` and
`check-repo`. The other files in `scripts/` are development helpers.

## Front end

React and Ant Design, built by Vite; in development Vite proxies `/api` to
the server. `src/App.jsx` switches between three pages — Templates
(`src/pages/TemplateDevEditor.jsx`), Alerts (`AlertUserView.jsx`) and
Routing (`RoutingView.jsx`) — and the Git panel
(`src/components/GitPanel.jsx`). `src/lib/apiFetch.js` is the only module
that calls `fetch`. The pages call the server through
`src/utils/chartApi.js`, which says for each call whether the answer was
ok, refused or could not be read; the Git panel's components use `apiFetch`
directly.

## How it is tested

| Layer | Where | What it holds |
|---|---|---|
| Unit | `tests/unit/`, `src/**/__tests__/` | Pure functions, the repo layer's parts, the lint rules |
| Integration | `tests/integration/` | The API and the command-line tools on a temp repo, many beside real Helm, promtool, vmalert and amtool |
| E2E | `tests/e2e/` (Playwright) | What a user sees and does, on a server serving the built page |
| Generator blind tests | `tests/blind/`, `tests/fixtures/charts/<case>/` | What the generator emits, against an `expected/rendered.yaml` written by hand |
| Pins | `tests/pin/<slice>/` | Every entry point for one kind of file, run on every input of a table (`cases.mjs`), each answer recorded (`baseline.tsv`) — where the slice renders, next to what Helm does with the same files. A cell whose answer changes fails; a cell that disagrees with Helm, or breaks what the slice holds every cell to, fails unless it is listed by hand with its reason (`allowlist.tsv`) |

`npm test` runs unit and integration; `npm run test:pin` the pins;
`npm run test:e2e` Playwright. The pin slices are `deployment-values`,
`template-files`, `routing`, `walk-sync`, `display`, `requests` (bad values
for everything a route turns into a path, a name or a git ref) and
`writes` (every path that writes the repo, on every situation: an old tab,
two at once, a file in the way); these two run no Helm. `tests/pin/counts.mjs` counts what lint
does not see (YAML parse sites, catches that swallow a failed read) and a
test fails when a number goes up.

## Where to start reading

1. `server/http/route.js` — how a route declares and receives its request
2. `server/routes/deployments/values.js` — a small route that reads and writes
3. `server/repo/openRepo.js` and `server/repo/loaded.js` — the snapshot and what a read gives
4. `server/repo/finding.js` and `server/repo/policy.js` — findings and the tables
5. `server/repo/write.js` with `server/repo/changes/set-values.js` — the writer and one kind of change
6. `eslint.config.js` (`ALLOWED`) — the boundary and its exceptions
7. `tests/pin/writes/` (`cases.mjs`, `compare.mjs`, `baseline.tsv`) — one pin
