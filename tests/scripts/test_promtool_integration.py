import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))

from extract_rules import promtool_rules_yaml


PROMTOOL = shutil.which("promtool")


@unittest.skipUnless(PROMTOOL, "promtool is not installed")
class PromtoolIntegrationTest(unittest.TestCase):
    def test_real_promtool_fails_invalid_promql(self):
        rules = """
groups:
  - name: invalid-promql
    rules:
      - alert: BrokenExpression
        expr: up =
"""
        with tempfile.NamedTemporaryFile("w", suffix=".yaml", encoding="utf-8") as rules_file:
            rules_file.write(rules)
            rules_file.flush()

            result = subprocess.run(
                [PROMTOOL, "check", "rules", rules_file.name],
                check=False,
                text=True,
                capture_output=True,
            )

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("could not parse expression", result.stderr + result.stdout)

    def test_real_promtool_checks_merged_prometheus_rule_documents(self):
        rendered = """
kind: PrometheusRule
spec:
  groups:
    - name: first
      rules:
        - alert: FirstDown
          expr: up == 0
---
kind: ConfigMap
metadata:
  name: ignored
---
kind: PrometheusRule
spec:
  groups:
    - name: second
      rules:
        - alert: SecondDown
          expr: vector(1)
"""
        with tempfile.NamedTemporaryFile("w", suffix=".yaml", encoding="utf-8") as rules_file:
            rules_file.write(promtool_rules_yaml(rendered))
            rules_file.flush()

            result = subprocess.run(
                [PROMTOOL, "check", "rules", rules_file.name],
                check=False,
                text=True,
                capture_output=True,
            )

        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        self.assertIn("SUCCESS: 2 rules found", result.stdout)

    def test_real_promtool_test_rules_fails_on_wrong_expectation(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            rules_file = root / "rules.yaml"
            rules_file.write_text(
                """
groups:
  - name: demo
    rules:
      - alert: AlwaysOn
        expr: vector(1)
        labels:
          severity: warning
""",
                encoding="utf-8",
            )
            test_file = root / "failing_test.yaml"
            test_file.write_text(
                """
rule_files:
  - rules.yaml
evaluation_interval: 1m
tests:
  - interval: 1m
    alert_rule_test:
      - eval_time: 1m
        alertname: AlwaysOn
        exp_alerts: []
""",
                encoding="utf-8",
            )

            result = subprocess.run(
                [PROMTOOL, "test", "rules", str(test_file)],
                check=False,
                text=True,
                capture_output=True,
                cwd=root,
            )

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("FAILED", result.stdout + result.stderr)

    def test_sample_mariadb_promtool_test_rules_passes(self):
        test_file = ROOT / "sample" / "promtool-tests" / "mariadb-alerts" / "mariadb_alerts_test.yaml"

        result = subprocess.run(
            [PROMTOOL, "test", "rules", str(test_file)],
            check=False,
            text=True,
            capture_output=True,
        )

        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        self.assertIn("SUCCESS", result.stdout)

    def test_real_render_check_supports_non_deployments_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            chart_dir = root / "charts" / "demo-alerts"
            templates_dir = chart_dir / "templates"
            templates_dir.mkdir(parents=True)
            (chart_dir / "Chart.yaml").write_text(
                "apiVersion: v2\nname: demo-alerts\nversion: 1.0.0\n",
                encoding="utf-8",
            )
            (chart_dir / "values.yaml").write_text(
                "threshold: 1\n",
                encoding="utf-8",
            )
            (templates_dir / "rules.yaml").write_text(
                """
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: demo-alerts
spec:
  groups:
    - name: demo
      rules:
        - alert: DemoHigh
          expr: vector(2) > {{ .Values.threshold }}
""",
                encoding="utf-8",
            )

            deploy_dir = root / "my-product" / "site-a" / "unit-1" / "PROD"
            deploy_dir.mkdir(parents=True)
            (deploy_dir / "Chart.yaml").write_text(
                """
apiVersion: v2
name: unit-1-prod
version: 1.0.0
dependencies:
  - name: demo-alerts
    version: 1.0.0
    repository: file://../../../../charts/demo-alerts
""",
                encoding="utf-8",
            )
            (deploy_dir / "values.yaml").write_text(
                "demo-alerts:\n  threshold: 1\n",
                encoding="utf-8",
            )

            result = subprocess.run(
                [
                    sys.executable,
                    str(ROOT / "scripts" / "render_and_check.py"),
                    "deployment",
                    "--root",
                    str(root),
                    "--build-dependencies",
                    "--promtool",
                    PROMTOOL,
                ],
                check=False,
                text=True,
                capture_output=True,
            )

            generated_artifacts = list(root.glob("**/Chart.lock")) + list(root.glob("**/charts/*.tgz"))

        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        self.assertIn("prod: promtool check rules passed", result.stdout.lower())
        self.assertEqual(generated_artifacts, [])


if __name__ == "__main__":
    unittest.main()
