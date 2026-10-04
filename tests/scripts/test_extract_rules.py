import io
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

import yaml

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))

from extract_rules import RuleExtractionError, extract_prometheus_rule_groups, main, promtool_rules_yaml, split_rule_groups, skipped_note


class ExtractRulesTest(unittest.TestCase):
    def test_extracts_single_prometheus_rule(self):
        rendered = """
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
spec:
  groups:
    - name: api
      rules:
        - alert: ApiDown
          expr: up == 0
"""

        groups = extract_prometheus_rule_groups(rendered)

        self.assertEqual(groups[0]["name"], "api")
        self.assertEqual(groups[0]["rules"][0]["alert"], "ApiDown")

    def test_merges_multiple_prometheus_rule_documents(self):
        rendered = """
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
spec:
  groups:
    - name: first
---
kind: ConfigMap
metadata:
  name: ignored
---
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
spec:
  groups:
    - name: second
"""

        groups = extract_prometheus_rule_groups(rendered)

        self.assertEqual([group["name"] for group in groups], ["first", "second"])

    def test_ignores_non_prometheus_rule_documents(self):
        rendered = """
kind: Service
metadata:
  name: ignored
"""

        self.assertEqual(extract_prometheus_rule_groups(rendered), [])

    def test_empty_input_returns_empty_groups(self):
        self.assertEqual(extract_prometheus_rule_groups(""), [])
        self.assertEqual(yaml.safe_load(promtool_rules_yaml("")), {"groups": []})

    def test_malformed_yaml_raises_clear_error(self):
        with self.assertRaisesRegex(RuleExtractionError, "failed to parse rendered YAML"):
            extract_prometheus_rule_groups("kind: [")

    def test_invalid_groups_shape_raises_clear_error(self):
        rendered = """
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
spec:
  groups:
    name: not-a-list
"""

        with self.assertRaisesRegex(RuleExtractionError, "spec.groups must be a list"):
            extract_prometheus_rule_groups(rendered)

    def test_empty_groups_mapping_raises_clear_error(self):
        rendered = """
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
spec:
  groups: {}
"""

        with self.assertRaisesRegex(RuleExtractionError, "spec.groups must be a list"):
            extract_prometheus_rule_groups(rendered)

    def test_invalid_spec_shape_raises_clear_error(self):
        rendered = """
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
spec: []
"""

        with self.assertRaisesRegex(RuleExtractionError, "spec must be a mapping"):
            extract_prometheus_rule_groups(rendered)

    def test_main_honors_explicit_empty_argv(self):
        with patch.object(sys, "argv", ["extract_rules.py", "--require-groups"]):
            with patch("sys.stdin.read", return_value="kind: Service\n"):
                with patch("sys.stdout.write"):
                    self.assertEqual(main([]), 0)


MIXED = """
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
spec:
  groups:
    - name: latency
      rules:
        - alert: SlowRequests
          expr: up == 0
---
apiVersion: operator.victoriametrics.com/v1beta1
kind: VMRule
spec:
  groups:
    - name: panics
      type: vlogs
      rules:
        - alert: Panics
          expr: '_time:10m "panic:" | stats count() as panics | filter panics:>0'
"""


class OutputProfilesTest(unittest.TestCase):
    """#65: which resources promtool checks is config/outputs.json's call."""

    def test_skips_and_counts_a_profile_promtool_cannot_check(self):
        groups, skipped = split_rule_groups(MIXED)
        self.assertEqual([g["name"] for g in groups], ["latency"])
        self.assertEqual(skipped, {"vlogs": 1})
        self.assertEqual(skipped_note(skipped), "skipped 1 object(s) promtool cannot check (1 vlogs)")

    def test_a_vmrule_no_profile_produces_is_neither_checked_nor_counted(self):
        rendered = """
apiVersion: operator.victoriametrics.com/v1beta1
kind: VMRule
spec:
  groups:
    - name: other
      rules: []
"""
        self.assertEqual(split_rule_groups(rendered), ([], {}))

    def test_main_says_what_it_skipped(self):
        err = io.StringIO()
        with patch("sys.stdin", io.StringIO(MIXED)), patch("sys.stdout", io.StringIO()), patch("sys.stderr", err):
            self.assertEqual(main([]), 0)
        self.assertIn("skipped 1 object(s) promtool cannot check (1 vlogs)", err.getvalue())


if __name__ == "__main__":
    unittest.main()
