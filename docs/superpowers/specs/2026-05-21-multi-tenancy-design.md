# Multi-Tenancy Conventions for AlertForge

## Goal

Establish directory and data conventions that enable multiple teams to share a single git repository for Prometheus alert management, using AlertForge's existing UI and folder system with no application code changes.

## Personas

| Persona | Example | Responsibilities |
|---|---|---|
| **Platform team** | MariaDB-as-a-Service (bob) | Authors chart templates, creates initial deployments for consumer teams, reviews PRs |
| **Consumer team** | App team (alice) | Edits deployment values (thresholds, enable/disable alerts), pushes changes via PR |

## Principles

- **Mono-repo, full visibility** — everyone can see all charts and deployments
- **Social governance** — ownership is enforced through PR review, not application-level access control
- **Convention over configuration** — the directory structure and schema design encode the multi-tenancy model; no special metadata or app features required
- **Free-form nesting** — AlertForge makes no restriction on deployment folder structure; corporate teams define their own conventions (by site, stage, region, etc.)

## Repository Structure

```
gitops/
  charts/                          # Platform teams own these
    mariadb-alerts/
      Chart.yaml                   # annotations.app: alertforge
      values.schema.json           # Defines fields including "owner" (required, no default)
      values.yaml                  # Default values (owner left blank)
      templates/
        prometheus-rule.yaml       # Helm template using {{ .owner }} in labels

  deployments/                     # Consumer teams edit these
    mariadb-1/                     # Instance for app-a
      site-1/
        test/
          Chart.yaml               # Depends on mariadb-alerts chart
          values.yaml              # owner: app-a, test-env thresholds
        staging/
          Chart.yaml
          values.yaml
        production/
          Chart.yaml
          values.yaml
      site-2/
        production/
          Chart.yaml
          values.yaml
    mariadb-2/                     # Instance for app-b
      Chart.yaml
      values.yaml
    redis-1/                       # Different chart, same pattern
      Chart.yaml
      values.yaml
```

Each deployment is a directory containing:
- `Chart.yaml` — declares a dependency on the parent template chart (scaffolded by AlertForge's folder init endpoint)
- `values.yaml` — alert rows keyed by alert group name, with all schema fields filled in

The nesting under each deployment instance (site, stage, etc.) is free-form. AlertForge discovers deployments by finding `Chart.yaml` + `values.yaml` pairs anywhere under the selected folder.

## Owner Field

The `owner` field is a regular chart schema variable, not special metadata. It is:
- Defined in `values.schema.json` as a required string with no default value
- Included in every alert row in `values.yaml`
- Rendered into Prometheus alert labels via the Helm template
- Enforced at render time: `helm template` fails if `owner` is missing

Example schema entry (within each alert group's item properties):
```json
"owner": {
  "type": "string",
  "description": "Application team that owns this alert instance",
  "x-var-type": "selector"
}
```

Example values:
```yaml
mariadb_latency_slow_queries:
  - owner: app-a
    instance_name: mariadb-primary
    namespace: prod-db
    warn_threshold: 0.5
    critical_threshold: 3
```

Example rendered label in the Prometheus rule:
```yaml
labels:
  owner: "{{ .owner }}"
```

Because `owner` has no default value and is required, creating a deployment with blank owner will produce a render error — forcing the platform team to set it during initial setup.

## Scenarios

### 1. Platform team creates a chart template

Bob (MariaDB platform team) uses the **Templates** page to create the `mariadb-alerts` chart. He defines the schema with alert groups, thresholds, selectors, and includes `owner` as a required field with no default. The template renders `owner` into Prometheus alert labels.

### 2. App team obtains a MariaDB instance

App-a gets `mariadb-1` provisioned. This happens outside AlertForge.

### 3. Platform team creates the deployment

Bob uses the **Alerts** page folder selector to create `deployments/mariadb-1/site-1/production/`. He initializes it with the `mariadb-alerts` chart (which scaffolds `Chart.yaml` with the dependency). He fills in the values: sets `owner: app-a`, configures instance names, namespaces, and sensible default thresholds. He commits and pushes.

### 4. Consumer team customizes their alerts

Alice navigates to `deployments/mariadb-1/site-1/production/` using the folder selector. She sees the alert table with all groups. She adjusts thresholds, adds or removes alert instances for her environment. She commits and opens a PR. Bob reviews and merges.

## What Already Works

| Capability | Existing feature |
|---|---|
| Chart authoring | Templates page — create/edit charts with schema editor |
| Folder navigation | FolderSelector component — tree view of all directories |
| Deployment initialization | `POST /api/v2/folders/init` — scaffolds Chart.yaml with dependency |
| Deployment editing | Alerts page — alert table with per-row value editing |
| Schema-enforced fields | `values.schema.json` with `required` array |
| Commit and push | Git panel — commit, push, pull |
| Free-form nesting | Folder selector imposes no structure; any path works |

## What Needs Verification

The conventions above should work with the current app. The following needs hands-on verification:

1. **Owner as required field** — Update sample chart schema to include `owner` as required with no default. Confirm the template editor and alert table handle it correctly. Confirm render fails when owner is blank.

2. **Deployment samples** — Replace flat `deployments/mariadb-alerts/` samples with nested structure (`deployments/mariadb-1/site-1/production/`, etc.) to illustrate the convention. Add multiple instances to show multi-tenancy.

3. **End-to-end flow** — Deploy to JupyterHub, walk through all four scenarios, verify UX is smooth: folder creation, init, editing, rendering, committing.

## Out of Scope

- Application-level access control or role-based permissions
- Alertmanager routing configuration (to be designed separately)
- Global deployment index or cross-chart search
- Alert enable/disable toggle (to be designed separately)
