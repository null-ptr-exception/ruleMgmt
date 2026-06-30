#!/usr/bin/env python3
"""Extract PrometheusRule groups from Helm output for promtool."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import yaml


class RuleExtractionError(ValueError):
    """Raised when rendered YAML cannot be converted into a rules file."""


def extract_prometheus_rule_groups(rendered_yaml: str) -> list[dict]:
    """Return all spec.groups entries from rendered PrometheusRule documents."""

    try:
        documents = list(yaml.safe_load_all(rendered_yaml))
    except yaml.YAMLError as exc:
        raise RuleExtractionError(f"failed to parse rendered YAML: {exc}") from exc

    groups: list[dict] = []
    for document in documents:
        if document is None:
            continue
        if not isinstance(document, dict):
            continue
        if document.get("kind") != "PrometheusRule":
            continue

        spec = document.get("spec")
        if spec is None:
            spec = {}
        if not isinstance(spec, dict):
            raise RuleExtractionError("PrometheusRule spec must be a mapping")

        rule_groups = spec.get("groups")
        if rule_groups is None:
            rule_groups = []
        if not isinstance(rule_groups, list):
            raise RuleExtractionError("PrometheusRule spec.groups must be a list")

        for group in rule_groups:
            if not isinstance(group, dict):
                raise RuleExtractionError("PrometheusRule group entries must be mappings")
        groups.extend(rule_groups)

    return groups


def promtool_rules_document(rendered_yaml: str) -> dict:
    """Return a promtool-compatible rules document."""

    return {"groups": extract_prometheus_rule_groups(rendered_yaml)}


def promtool_rules_yaml(rendered_yaml: str) -> str:
    """Serialize extracted groups as a promtool-compatible rules file."""

    return yaml.safe_dump(
        promtool_rules_document(rendered_yaml),
        default_flow_style=False,
        sort_keys=False,
    )


def read_input(path: str) -> str:
    if path == "-":
        return sys.stdin.read()
    return Path(path).read_text(encoding="utf-8")


def write_output(path: str, content: str) -> None:
    if path == "-":
        sys.stdout.write(content)
        return
    Path(path).write_text(content, encoding="utf-8")


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Extract PrometheusRule spec.groups from Helm output.",
    )
    parser.add_argument(
        "input",
        nargs="?",
        default="-",
        help="Rendered Helm YAML file. Reads stdin when omitted or set to '-'.",
    )
    parser.add_argument(
        "-o",
        "--output",
        default="-",
        help="Output rules file path. Writes stdout by default.",
    )
    parser.add_argument(
        "--require-groups",
        action="store_true",
        help="Exit non-zero when no PrometheusRule groups are found.",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)

    try:
        content = read_input(args.input)
        groups = extract_prometheus_rule_groups(content)
        if args.require_groups and not groups:
            raise RuleExtractionError("no PrometheusRule spec.groups found")
        output = yaml.safe_dump(
            {"groups": groups},
            default_flow_style=False,
            sort_keys=False,
        )
        write_output(args.output, output)
    except (OSError, RuleExtractionError) as exc:
        print(f"extract_rules.py: {exc}", file=sys.stderr)
        return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
