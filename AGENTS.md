# AlertForge — Agent Instructions

## Stack

Vite + React frontend, Express backend, Helm chart templates.
Node 22, deployed as JupyterHub singleuser image on minikube.
Gitea provides OAuth2 authentication and git remote (deployed in-cluster).

## Commands

```bash
make up              # build, deploy to minikube, init Gitea, and start local proxy
make deploy          # build image and deploy to minikube via Skaffold
make init            # initialize Gitea (create user, OAuth app, repo) and configure JupyterHub
make proxy           # start local proxy (127.0.0.1:12014 → minikube:30080)
make down            # stop proxy and destroy minikube cluster
make status          # show proxy and pod status
npm test             # vitest unit + integration tests (about a minute; no pins)
STRESS=1 npx vitest run tests/integration/deployment-writes-stress.test.js tests/integration/template-writes-stress.test.js tests/integration/joined-writes-interaction.test.js   # the writes' 20/50-round stress, each side's and the two beside each other (a round or a few of each in npm test)
npm run test:pin     # every pin (tests/pin/<slice>/*.pin.test.js): each entry point against real Helm
npm run test:e2e     # playwright E2E tests
npm run lint         # eslint
node scripts/check-repo.mjs <repo>   # a whole gitops repo, checked as Commit checks it, every deployment rendered; exit 0 / 1 refused / 2 not checked
```

E2E starts its own server on port 3111 (it serves `dist`: `npm run build` first). To run E2E in two worktrees at once, give each its own port: `E2E_PORT=3122 npm run test:e2e`. A server already on the port stops the run ("is already used") rather than being tested, since it may be another worktree's; `E2E_REUSE_SERVER=1` tests it anyway.

**Never** manually docker build / minikube image load / kubectl delete pod. Always use `make deploy`.

Kubectl context: `minikube`. Namespace: `default`.

## Gitea Dev Credentials

After `make init`, the following are available:
- **Gitea admin:** `gitea_admin` / `localdev123`
- **Test user:** `alice` / `alice123`
- **Gitea UI:** `http://localhost:3000` (requires port-forward: `kubectl --context minikube port-forward svc/gitea-http 3000:3000`)
- **JupyterHub:** `http://localhost:12014` (via proxy)

## New machine

Beyond `npm ci`, a fresh Linux / WSL machine needs:

- **Git identity, set globally** — E2E commits into `gitops/`, a separate repo, so a repo-level identity does not reach it:
  `git config --global user.name …` / `user.email …`
- **Chromium's system libraries** for Playwright. When node lives in `~/.local/bin`, `sudo` does not find `npx`:
  `sudo env PATH="$PATH" npx playwright install-deps chromium`, then `npx playwright install chromium`
- **promtool** at the `Dockerfile`'s `PROMETHEUS_VERSION`, built by its `promtool` stage: that version's source with a newer Go and modules, since the official 2.x images carry critical CVEs (#105). Distro packages can be years older. Without it, the tests that run promtool are skipped.
- **promtool3** at the `Dockerfile`'s `PROMETHEUS3_VERSION`, built by its `promtool3` stage the same way, installed as `promtool3` (or pointed to by `PROMTOOL3_BIN`). It checks `prometheus3` groups. Without it, the tests that run it are skipped.
- **vmalert** at the `Dockerfile`'s `VMALERT_VERSION`: `vmalert-prod` from the release's `vmutils-linux-amd64-<version>.tar.gz`, installed as `vmalert`. Without it, the tests that run `vmalert -dryRun` are skipped.
- **amtool** (test only, not in the image) at the `ALERTMANAGER_VERSION` in `scripts/install-checkers.sh`, 0.28 or later: an older one does not read a webhook's `timeout`. The upstream Alertmanager release, checked against the sha256 there (the release's `sha256sums.txt`). Without it, the routing route tests (`amtool config routes test`) are skipped.
- **helm** at the `Dockerfile`'s `HELM_VERSION`: the image, CI and your machine render with the same Helm, or Preview may show what the image does not (a hand-written `null`, an error message, differ between versions). The upstream release from get.helm.sh, checked against the sha256 in `scripts/install-checkers.sh`. A different helm on `PATH` (or `HELM_BIN`) still runs the tests, but is not what the image ships. The image takes Alpine's package of that version: when `node:22-alpine` moves to an Alpine release with another Helm, the image build stops at its version test — move `HELM_VERSION` and its checksum to that Helm after running the tests on it, or install the upstream release in the `Dockerfile` instead. `install-checkers.sh` installs linux-amd64 only, and says so elsewhere.
- With docker, `sudo scripts/install-checkers.sh` installs all five at those versions (CI does the same).
- **helm-unittest** `helm plugin install https://github.com/helm-unittest/helm-unittest --version v0.8.2`, as CI installs it.

## Testing policy

Every change is held to this; an issue's acceptance criteria refer to it rather than repeat it.

1. **A fix or feature comes with a test that fails without it** — and that failure is actually seen, by running the test against the code before the change.
2. **Pick the layer by what the change is:**
   - pure function → unit (`src/utils/__tests__/`, `tests/unit/`)
   - API behaviour → integration (`tests/integration/`)
   - anything a user sees or does in the UI → Playwright E2E (`tests/e2e/`)
3. **A change to what the generator emits gets a generator blind-test case** (`tests/fixtures/charts/<case>/`, see `tests/blind/harness.js`):
   - `expected/rendered.yaml` is written by hand, before running the generator, and never regenerated by a tool
   - add `promtool-tests.yaml` wherever the output is PromQL promtool can evaluate (it runs with promtool3 for a `prometheus3` case)
   - `expected/templates/` and the sample chart's golden may be regenerated (`node tests/blind/update.mjs`, `gen-rules`), and the diff is then reviewed line by line
4. **Gate before merging:**
   - `npm test`, `npm run test:pin`, `npm run test:e2e` and `npm run lint` all pass. There are no known failures to ignore; a red test is either fixed or the change is not done.
   - CI is green.
   - Every CodeRabbit finding is fixed, or answered with a reason. Reviews are triggered by commenting `@coderabbitai review` (about one per hour).
5. **No high or critical advisory in a runtime dependency.** CI runs `npm audit --omit=dev --audit-level=high`; a fix is a dependency upgrade, and this check is its failing test. A new advisory turns every CI run after it red until main is fixed.
6. **No fixable high or critical CVE in the image.** CI builds the image on every PR and scans it with trivy (`docker` job); it fails on one that has a fix. A CVE that cannot be fixed yet goes into `.trivyignore.yaml` with its reason, its issue and the binary it is in.
7. **Anything the server imports must be in the runtime image.** `tests/unit/dockerImage.test.js` fails when a server import is outside what the `Dockerfile` copies.
8. **A change in behaviour updates the docs in the same PR** (`doc/rules-format.md`, `doc/alert-rules.md`, `doc/how-to.md`).
9. **The pins** (`npm run test:pin`, not part of `npm test`) run every entry point of one kind of file on every input of a table, next to what real Helm (and promtool) does with the same files. The expected side is what Helm does, never what the code does. Each slice is `tests/pin/<slice>/`: `cases.mjs` (the inputs), `harness.mjs` (how a row runs each entry point), `compare.mjs` (how a cell is judged against Helm), `<slice>.pin.test.js`, `baseline.tsv`, `allowlist.tsv`; what they share is `tests/pin/lib/` (`definePin`). Run your slice's pin and the deployment-values one before a commit (`npm run test:pin -- tests/pin/<slice>`); every pin runs after each merge on both Helm versions. A pin test may take up to 300 s (`tests/pin/vitest.config.mjs`), not the 30 s of `npm test`: under load one row runs every entry point and Helm several times. `PIN_POOL=<n>` sets how many rows run side by side (8); use 4 on a busy machine.
   - The deployment-values pin runs open, list, save as text and as JSON, sync, a `_common`'s plan and write, a new deployment, the migration check and a migration, Commit, Preview, `check-deployment`, `check-repo` and `gen-rules` on every input in `tests/pin/deployment-values/cases.mjs`.
   - The requests pin (`tests/pin/requests/`) puts every value a route turns into a path, a name or a git ref (`routes.mjs` lists each route and those inputs; a route the routers have and the table has not fails it) through bad values, each beside a legitimate twin, and every write route through bad bodies. It needs no Helm: what must hold is that nothing outside the repo or in its `.git` is read or changed, no 5xx, the commit lock is let go and no server path is answered, a legitimate value is taken, a ref is taken exactly when git takes it, and a bad body is refused naming its field.
   - The writes pin (`tests/pin/writes/`) runs every path that writes the repo — the API's saves, syncs, `_common` moves, new deployments and Templates, migrations, routing and shared configs, Commit, Discard and the three CLIs that write — on every situation in its `cases.mjs` (an old tab, two at once, a save beside a Commit, a file or folder in the way, a link, nothing writable). It runs no Helm: each cell records the answer, the sha256 of every file in and around the repo before and after, `git status` and whether the commit lock is free again, and is held to what any write must keep (`compare.mjs`: a refusal changes nothing, nothing outside the repo changes, a 2xx changes only what it was about, no 5xx, no server path, the lock let go).
   - The display pin (`tests/pin/display/`) takes the same inputs and records what each place that shows an alert count, values or a mark shows — the folder tree (its marks: it shows no count), the Sync dialogs' list, the rule owner page, Preview's summary (summed as the modal sums it) and a `_common`'s users — next to the rows and alerts Helm renders and the Template's `.Values`; each count is also set beside the other entries' for the same input (`vsEntries`).
   - `baseline.tsv` holds today's answer of every cell (class, status, file named, server path shown, files changed, and Helm's exit, alert count and rendered value). A cell whose answer changes fails the test, naming it. When the change is meant: `PIN_UPDATE=1 npm run test:pin -- tests/pin/<slice>`, then review the diff of `baseline.tsv` line by line. `PIN_RECORD=<file>` also writes each cell with its message.
   - `allowlist.tsv` lists every cell that disagrees with Helm today (accepts what Helm fails, what promtool refuses, or values whose rows do not all render — fewer alerts than the rows written, as with values not under the chart's name; refuses what Helm renders; a 5xx, the editor showing another value), each with a category — `bug` (its issue, or "no issue yet"), `policy` (deliberate), `out-of-scope` — and a reason. It is edited by hand only. A new disagreement fails until it is fixed or listed; a fix fails until its line is removed, so the list only shrinks visibly.
   - Run it with each Helm version (`HELM_BIN`); the baseline is the same for both, so a difference fails. Without helm or promtool every cell is skipped, and the count is printed; skipped is not passed.

## Disk boundary

Only the repo loader and writer (`server/repo/`) touch the gitops repo's files: they read them, parse their YAML and write them, so every entry point sees an unreadable or broken file the same way. This is held by `npm run lint`, not by convention:

- `boundary/disk` (in `eslint.config.js`) is an **error** wherever code in `server.js`, `server/`, `scripts/` outside `server/repo/` uses `fs`, a YAML parser or `child_process`; in `src/` (which also runs in the browser) only parsing text is allowed. `boundary/request` is an error where a route file reads `req.query`, `req.params` or `req.body` itself instead of its route's parsed input.
- Code that needs a file of the repo asks the snapshot (`openRepo`: `repo.file`, `repo.dir`, `repo.helmYaml`, …) or a function of `server/repo/`; a write is a change of the writer (`server/repo/changes/`). A new kind of read is added to `server/repo/`, not allowed where it is.
- **An exception** is for what is not the gitops repo (a temp folder for Helm or a checker, Helm's output, the app's own files). It is one line of `ALLOWED` in `eslint.config.js`: the file by name (no folder), the kinds it may use (`allow`) or the only `fs` functions it may call (`fsCalls`), and a `why` saying what it touches. `tests/unit/boundaryLint.test.js` plants a read, a parse, a child process and a request read in each place and fails when lint lets one through, when an exception has no reason or names a folder.
- What lint does not see is counted: `tests/pin/counts.mjs` counts YAML parse sites, catches that swallow a failed read and own `ENOENT` checks outside `server/repo/`; `tests/pin/counts.json` holds the numbers and the same test fails when one goes up. One that stays carries its reason on the line. When your change lowers a number, run `node tests/pin/counts.mjs --write` and commit `counts.json` with it; `--list` shows each site.

## Test output

Never pipe test output through grep. Redirect to a temp file first, then grep the file:
```bash
npm test > /tmp/test-output.log 2>&1; grep -E 'Tests|PASS|FAIL' /tmp/test-output.log
```
