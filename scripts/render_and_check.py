#!/usr/bin/env python3
"""Render Helm alert charts and validate extracted rules with promtool."""

from __future__ import annotations

import argparse
import re
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path

import yaml

from extract_rules import RuleExtractionError, extract_prometheus_rule_groups


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


def is_relative_to(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
    except ValueError:
        return False
    return True


def should_skip_deployment_chart(chart_yaml: Path, root: Path) -> bool:
    parts = set(chart_yaml.relative_to(root).parts[:-1])
    if parts.intersection({".git", "node_modules", "__pycache__"}):
        return True

    chart_dir = chart_yaml.parent
    charts_root = root / "charts"
    if is_relative_to(chart_dir, charts_root):
        return True

    # Skip Helm dependency vendor directories inside deployment charts.
    return "charts" in chart_yaml.relative_to(root).parts[:-1]


def discover_deployment_targets(root: Path) -> list[RenderTarget]:
    targets: list[RenderTarget] = []
    for chart_yaml in sorted(root.glob("**/Chart.yaml")):
        if should_skip_deployment_chart(chart_yaml, root):
            continue
        chart_dir = chart_yaml.parent
        values_file = chart_dir / "values.yaml"
        if values_file.exists():
            targets.append(RenderTarget(release_name(chart_dir), root, chart_dir, values_file))
    return targets


def run_command(command: list[str], cwd: Path | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(
        command,
        cwd=cwd,
        check=False,
        text=True,
        capture_output=True,
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
    result = run_command(["helm", "dependency", "build", str(target.chart_dir)])
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
        groups = extract_prometheus_rule_groups(rendered_yaml)
    except RuleExtractionError as exc:
        print(f"{target.name}: {exc}", file=sys.stderr)
        return 1

    if not groups:
        print(f"{target.name}: no PrometheusRule spec.groups found", file=sys.stderr)
        return 1

    with tempfile.NamedTemporaryFile("w", suffix="-rules.yaml", encoding="utf-8") as tmp:
        yaml.safe_dump({"groups": groups}, tmp, default_flow_style=False, sort_keys=False)
        tmp.flush()
        result = run_command([promtool, "check", "rules", tmp.name])

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
    args = parse_args(argv or sys.argv[1:])
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
