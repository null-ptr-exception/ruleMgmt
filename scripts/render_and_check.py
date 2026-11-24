#!/usr/bin/env python3
"""Render Helm alert charts and validate extracted rules with promtool."""

from __future__ import annotations

import argparse
import os
import re
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path

import yaml

from extract_rules import RuleExtractionError, skipped_note, split_rule_groups


@dataclass(frozen=True)
class RenderTarget:
    name: str
    root: Path
    chart_dir: Path
    values_file: Path


def release_name(path: Path) -> str:
    name = re.sub(r"[^a-z0-9-]+", "-", path.name.lower()).strip("-")
    return name or "alert-rules"


def discover_chart_targets(root: Path) -> list[RenderTarget]:
    charts_dir = root / "charts"
    targets: list[RenderTarget] = []
    for chart_yaml in sorted(charts_dir.glob("*/Chart.yaml")):
        chart_dir = chart_yaml.parent
        values_file = chart_dir / "values.yaml"
        if values_file.exists():
            targets.append(RenderTarget(release_name(chart_dir), root, chart_dir, values_file))
    return targets


# The same rules as AlertForge's own walk (server/lib/deploymentWalk.js), so
# what this renders is what AlertForge lists and checks:
# - a deployment is a folder with a Chart.yaml naming a dependency and a
#   values.yaml; a folder right inside a _common/ is a _common chart, which
#   renders as part of the deployments under it, never on its own;
# - hidden folders and node_modules are not looked into, nor the Templates
#   folder at the root, nor the shared notification configs' folder;
# - right inside a deployment or a _common chart, its templates/ and
#   charts/ are its own, not folders of the tree; deeper they are.
CHART_OWN_DIRS = {"templates", "charts"}
SHARED_DIR = "_shared"
SHARED_FILE = "notification-configs.yaml"


def chart_dependencies(folder: Path) -> list:
    chart_yaml = folder / "Chart.yaml"
    if not chart_yaml.is_file():
        return []
    try:
        chart = yaml.safe_load(chart_yaml.read_text(encoding="utf-8")) or {}
    except (OSError, yaml.YAMLError):
        return []
    deps = chart.get("dependencies") if isinstance(chart, dict) else None
    return deps if isinstance(deps, list) else []


def is_common_chart(folder: Path) -> bool:
    return folder.parent.name == "_common" and (folder / "Chart.yaml").is_file()


def is_deployment(folder: Path) -> bool:
    if folder.parent.name == "_common":
        return False
    return bool(chart_dependencies(folder)) and (folder / "values.yaml").is_file()


def is_shared_dir(folder: Path) -> bool:
    try:
        names = [p.name for p in folder.iterdir()]
    except OSError:
        return False
    return all(n == SHARED_FILE or n.startswith(f"_{SHARED_FILE}.") for n in names)


def skipped(entry: Path, root: Path, in_chart: bool) -> bool:
    name = entry.name
    if name.startswith(".") or name == "node_modules":
        return True
    if in_chart and name in CHART_OWN_DIRS:
        return True
    charts_dir = root / os.environ.get("CHARTS_DIR", "charts")
    if entry.resolve() == charts_dir.resolve():
        return True
    if entry.parent == root and name == SHARED_DIR and is_shared_dir(entry):
        return True
    return False


def discover_deployment_targets(root: Path) -> list[RenderTarget]:
    targets: list[RenderTarget] = []

    def walk(folder: Path, in_chart: bool) -> None:
        try:
            entries = sorted(folder.iterdir())
        except OSError as exc:
            print(f"{folder.relative_to(root)}: cannot be read ({exc.strerror}); not checked", file=sys.stderr)
            return
        for entry in entries:
            # A link is not followed, as AlertForge does not.
            if entry.is_symlink() or not entry.is_dir() or skipped(entry, root, in_chart):
                continue
            if is_common_chart(entry):
                walk(entry, True)
                continue
            deployment = is_deployment(entry)
            if deployment:
                targets.append(RenderTarget(release_name(entry), root, entry, entry / "values.yaml"))
            walk(entry, deployment)

    walk(root, False)
    return sorted(targets, key=lambda t: t.chart_dir)


def run_command(command: list[str], cwd: Path | None = None) -> subprocess.CompletedProcess:
    try:
        return subprocess.run(
            command,
            cwd=cwd,
            check=False,
            text=True,
            capture_output=True,
        )
    except OSError as exc:
        return subprocess.CompletedProcess(
            args=command,
            returncode=127,
            stdout="",
            stderr=f"failed to execute {command[0]}: {exc}\n",
        )


def chart_has_dependencies(target: RenderTarget) -> bool:
    chart_yaml = target.chart_dir / "Chart.yaml"
    try:
        chart = yaml.safe_load(chart_yaml.read_text(encoding="utf-8")) or {}
    except (OSError, yaml.YAMLError) as exc:
        print(f"{target.name}: failed to read Chart.yaml: {exc}", file=sys.stderr)
        raise RuleExtractionError("failed to read chart metadata") from exc

    return bool(chart.get("dependencies"))


def copy_target_root_to_temp(target: RenderTarget, temp_root: Path) -> RenderTarget:
    source_root = target.root.resolve()
    copied_root = temp_root / "repo"
    shutil.copytree(
        source_root,
        copied_root,
        ignore=shutil.ignore_patterns(".git", "node_modules", "__pycache__"),
    )
    copied_chart_dir = copied_root / target.chart_dir.resolve().relative_to(source_root)
    copied_values_file = copied_root / target.values_file.resolve().relative_to(source_root)
    return RenderTarget(target.name, copied_root, copied_chart_dir, copied_values_file)


def build_dependencies(target: RenderTarget) -> int:
    # --skip-refresh: dependencies are file:// charts, so there is no repo index
    # to fetch — without it helm refreshes every repo configured on the machine
    # first, which is seconds (tens on a slow link) per chart.
    result = run_command(["helm", "dependency", "build", "--skip-refresh", str(target.chart_dir)])
    if result.returncode != 0:
        print(f"{target.name}: helm dependency build failed", file=sys.stderr)
        if result.stderr:
            print(result.stderr, file=sys.stderr, end="")
        return result.returncode
    return 0


def render_target(target: RenderTarget) -> tuple[int, str]:
    result = run_command(
        [
            "helm",
            "template",
            target.name,
            str(target.chart_dir),
            "-f",
            str(target.values_file),
        ],
    )
    if result.returncode != 0:
        print(f"{target.name}: helm template failed", file=sys.stderr)
        if result.stderr:
            print(result.stderr, file=sys.stderr, end="")
        return result.returncode, ""
    return 0, result.stdout


def check_rules(target: RenderTarget, rendered_yaml: str, promtool: str) -> int:
    try:
        groups, skipped = split_rule_groups(rendered_yaml)
    except RuleExtractionError as exc:
        print(f"{target.name}: {exc}", file=sys.stderr)
        return 1
    if skipped:
        print(f"{target.name}: {skipped_note(skipped)}", file=sys.stderr)

    if not groups:
        # Rules that all opt out of promtool (validate: none, e.g. vlogs) are
        # fine — the note above says so. Rendering no rules at all is not.
        if skipped:
            return 0
        print(f"{target.name}: no PrometheusRule spec.groups found", file=sys.stderr)
        return 1

    with tempfile.TemporaryDirectory(prefix="alertforge-rules-") as tmp:
        rules_path = Path(tmp) / "rules.yaml"
        rules_path.write_text(
            yaml.safe_dump({"groups": groups}, default_flow_style=False, sort_keys=False),
            encoding="utf-8",
        )
        result = run_command([promtool, "check", "rules", str(rules_path)])

    if result.stdout:
        print(result.stdout, end="")
    if result.stderr:
        print(result.stderr, file=sys.stderr, end="")
    if result.returncode != 0:
        print(f"{target.name}: promtool check rules failed", file=sys.stderr)
        return result.returncode

    print(f"{target.name}: promtool check rules passed")
    return 0


def run_target(target: RenderTarget, promtool: str, build_deps: bool) -> int:
    print(f"==> {target.name}")
    if build_deps:
        try:
            has_dependencies = chart_has_dependencies(target)
        except RuleExtractionError:
            return 1

        if has_dependencies:
            with tempfile.TemporaryDirectory(prefix="alertforge-promtool-") as tmp:
                temp_target = copy_target_root_to_temp(target, Path(tmp))
                dependency_code = build_dependencies(temp_target)
                if dependency_code != 0:
                    return dependency_code

                render_code, rendered_yaml = render_target(temp_target)
                if render_code != 0:
                    return render_code

                return check_rules(target, rendered_yaml, promtool)

    render_code, rendered_yaml = render_target(target)
    if render_code != 0:
        return render_code

    return check_rules(target, rendered_yaml, promtool)


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Render alert charts and run promtool check rules.",
    )
    parser.add_argument(
        "mode",
        choices=["chart", "deployment"],
        help="Use charts/*/values.yaml or deployment Chart.yaml files anywhere under root.",
    )
    parser.add_argument(
        "--root",
        default=".",
        help="Repository root containing charts/ or deployments/. Defaults to current directory.",
    )
    parser.add_argument(
        "--promtool",
        default="promtool",
        help="promtool binary path. Defaults to PATH lookup.",
    )
    parser.add_argument(
        "--build-dependencies",
        action="store_true",
        help="Run helm dependency build before rendering charts with dependencies.",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    root = Path(args.root)

    targets = (
        discover_chart_targets(root)
        if args.mode == "chart"
        else discover_deployment_targets(root)
    )
    if not targets:
        print(f"render_and_check.py: no {args.mode} targets found under {root}", file=sys.stderr)
        return 1

    failures = 0
    for target in targets:
        if run_target(target, args.promtool, args.build_dependencies) != 0:
            failures += 1

    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
