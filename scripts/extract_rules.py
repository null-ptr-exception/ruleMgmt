#!/usr/bin/env python3
"""Extract the rule groups promtool can check from Helm output.

Which rendered resources those are is decided by the output profiles in
config/outputs.json (#65) — the same file the generator wraps groups with:
a resource whose profile says `validate: promtool` is extracted, one whose
profile says `none` (LogsQL, for instance) is skipped and counted.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import yaml

OUTPUTS_FILE = Path(__file__).resolve().parent.parent / "config" / "outputs.json"


def load_profiles(path: Path = OUTPUTS_FILE) -> list[dict]:
    """The output profiles, as src/utils/outputs.js reads them (which also validates them)."""

    outputs = json.loads(path.read_text(encoding="utf-8"))["outputs"]
    return [
        {
            "name": name,
            "apiVersion": profile["apiVersion"],
            "kind": profile["kind"],
            "groupFields": profile.get("groupFields", {}),
            "validate": profile["validate"],
        }
        for name, profile in outputs.items()
    ]


def profile_of(document: dict, profiles: list[dict]) -> dict | None:
    """The profile a rendered resource came from, as outputs.js profileOfObject decides it."""

    groups = (document.get("spec") or {}).get("groups")
    first = groups[0] if isinstance(groups, list) and groups and isinstance(groups[0], dict) else {}
    matches = [
        p for p in profiles
        if document.get("apiVersion") == p["apiVersion"]
        and document.get("kind") == p["kind"]
        and all(first.get(k) == v for k, v in p["groupFields"].items())
    ]
    matches.sort(key=lambda p: -len(p["groupFields"]))
    return matches[0] if matches else None


class RuleExtractionError(ValueError):
    """Raised when rendered YAML cannot be converted into a rules file."""


def split_rule_groups(rendered_yaml: str, profiles: list[dict] | None = None) -> tuple[list[dict], dict[str, int]]:
    """The spec.groups promtool can check, and how many resources were skipped, by profile name.

    A resource no profile produces (a ConfigMap, say) is neither.
    """

    profiles = load_profiles() if profiles is None else profiles
    try:
        documents = list(yaml.safe_load_all(rendered_yaml))
    except yaml.YAMLError as exc:
        raise RuleExtractionError(f"failed to parse rendered YAML: {exc}") from exc

    groups: list[dict] = []
    skipped: dict[str, int] = {}
    for document in documents:
        if not isinstance(document, dict):
            continue
        profile = profile_of(document, profiles)
        if profile is None:
            continue
        if profile["validate"] != "promtool":
            skipped[profile["name"]] = skipped.get(profile["name"], 0) + 1
            continue

        kind = profile["kind"]
        spec = document.get("spec")
        if spec is None:
            spec = {}
        if not isinstance(spec, dict):
            raise RuleExtractionError(f"{kind} spec must be a mapping")

        rule_groups = spec.get("groups")
        if rule_groups is None:
            rule_groups = []
        if not isinstance(rule_groups, list):
            raise RuleExtractionError(f"{kind} spec.groups must be a list")

        for group in rule_groups:
            if not isinstance(group, dict):
                raise RuleExtractionError(f"{kind} group entries must be mappings")
        groups.extend(rule_groups)

    return groups, skipped


def skipped_note(skipped: dict[str, int]) -> str:
    """One line naming what promtool did not check, or '' when nothing was skipped."""

    if not skipped:
        return ""
    parts = ", ".join(f"{n} {name}" for name, n in sorted(skipped.items()))
    return f"skipped {sum(skipped.values())} object(s) promtool cannot check ({parts})"


def extract_prometheus_rule_groups(rendered_yaml: str) -> list[dict]:
    """Return the spec.groups entries promtool can check (see split_rule_groups)."""

    return split_rule_groups(rendered_yaml)[0]


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
        groups, skipped = split_rule_groups(content)
        if skipped:
            print(f"extract_rules.py: {skipped_note(skipped)}", file=sys.stderr)
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
