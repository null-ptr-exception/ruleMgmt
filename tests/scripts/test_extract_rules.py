import sys
import unittest
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))

from extract_rules import RuleExtractionError, extract_prometheus_rule_groups, promtool_rules_yaml


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
kind: PrometheusRule
spec:
  groups:
    - name: first
---
kind: ConfigMap
metadata:
  name: ignored
---
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
kind: PrometheusRule
spec:
  groups:
    name: not-a-list
"""

        with self.assertRaisesRegex(RuleExtractionError, "spec.groups must be a list"):
            extract_prometheus_rule_groups(rendered)


if __name__ == "__main__":
    unittest.main()
