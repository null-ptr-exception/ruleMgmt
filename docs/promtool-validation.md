# Promtool validation scripts

These scripts implement the standalone validation stage for alert Helm charts and
deployment values. They are intended to run manually first, then be promoted to
CI jobs later.

## Prerequisites

- Python 3 with PyYAML
- Helm 3
- `promtool` available on `PATH`, or pass `--promtool /path/to/promtool`

## Extract rendered rules

`extract_rules.py` converts rendered Helm YAML into the raw rules-file format
accepted by `promtool check rules`:

```bash
helm template cpu-alerts charts/cpu-alerts -f charts/cpu-alerts/values.yaml \
  | python3 scripts/extract_rules.py --require-groups -o /tmp/cpu-alerts-rules.yaml

promtool check rules /tmp/cpu-alerts-rules.yaml
```

The extractor merges `spec.groups` from every rendered `kind: PrometheusRule`
document and ignores non-`PrometheusRule` documents.

## Check chart repo values

From a chart repo with `charts/*/Chart.yaml` and `charts/*/values.yaml`:

```bash
python3 scripts/render_and_check.py chart --root .
```

For this repository's sample chart:

```bash
python3 scripts/render_and_check.py chart --root sample
```

## Check deployment repo values

From a deployment repo with deployment `Chart.yaml` files anywhere under the
validation root and sibling `values.yaml` files:

```bash
python3 scripts/render_and_check.py deployment --root .
```

Deployment discovery scans `**/Chart.yaml` under `--root` and skips chart
templates under `charts/`, vendored dependency charts under any nested
`charts/` directory, `.git`, and `node_modules`.

If deployments reference local file dependencies that are not already vendored,
build dependencies before rendering:

```bash
python3 scripts/render_and_check.py deployment --root . --build-dependencies
```

Dependency builds run against a temporary copy of the validation root, preserving
relative `file://` chart references without writing `Chart.lock` or `charts/`
artifacts back into the working tree.

Any local `file://` dependency must resolve to a path inside `--root`. If a
deployment references chart templates outside `--root`, run the script with a
higher common root that contains both the deployment folders and referenced
templates.

For this repository's sample deployments:

```bash
python3 scripts/render_and_check.py deployment --root sample --build-dependencies
```

## Run chart-level rule tests

Chart repositories can also keep promtool unit tests under
`charts/<name>/tests/*.yaml`:

```bash
scripts/promtool_test.sh .
```

`tests/` should be excluded from packaged charts with `.helmignore`:

```text
tests/
```

This repository keeps sample promtool demo data under `sample/promtool-tests/`
so it does not conflict with the existing helm-unittest tests under chart
`tests/` directories:

```bash
scripts/promtool_test.sh sample
```

`sample/promtool-tests/` is local demo and validation data only. It is excluded
from Docker build context by `.dockerignore`, so it is not copied into the
runtime image.
