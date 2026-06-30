import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from io import StringIO
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))

from render_and_check import (
    RenderTarget,
    check_rules,
    discover_chart_targets,
    discover_deployment_targets,
    render_target,
    run_target,
)


class RenderAndCheckTest(unittest.TestCase):
    def test_discovers_chart_targets(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            chart_dir = root / "charts" / "cpu-alerts"
            chart_dir.mkdir(parents=True)
            (chart_dir / "Chart.yaml").write_text("name: cpu-alerts\n", encoding="utf-8")
            (chart_dir / "values.yaml").write_text("rule: value\n", encoding="utf-8")

            targets = discover_chart_targets(root)

        self.assertEqual(len(targets), 1)
        self.assertEqual(targets[0].name, "cpu-alerts")
        self.assertEqual(targets[0].values_file.name, "values.yaml")

    def test_discovers_nested_deployment_targets_anywhere_under_root(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            deploy_dir = root / "my-product" / "site-a" / "unit-1" / "PROD"
            deploy_dir.mkdir(parents=True)
            (deploy_dir / "Chart.yaml").write_text("name: prod\n", encoding="utf-8")
            (deploy_dir / "values.yaml").write_text("rule: value\n", encoding="utf-8")

            targets = discover_deployment_targets(root)

        self.assertEqual(len(targets), 1)
        self.assertEqual(targets[0].name, "prod")

    def test_deployment_discovery_skips_chart_templates_and_vendored_charts(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            template_dir = root / "charts" / "cpu-alerts"
            template_dir.mkdir(parents=True)
            (template_dir / "Chart.yaml").write_text("name: cpu-alerts\n", encoding="utf-8")
            (template_dir / "values.yaml").write_text("rule: value\n", encoding="utf-8")

            deploy_dir = root / "teams" / "alpha" / "prod"
            deploy_dir.mkdir(parents=True)
            (deploy_dir / "Chart.yaml").write_text("name: prod\n", encoding="utf-8")
            (deploy_dir / "values.yaml").write_text("rule: value\n", encoding="utf-8")

            vendored_dir = deploy_dir / "charts" / "cpu-alerts"
            vendored_dir.mkdir(parents=True)
            (vendored_dir / "Chart.yaml").write_text("name: cpu-alerts\n", encoding="utf-8")
            (vendored_dir / "values.yaml").write_text("rule: value\n", encoding="utf-8")

            targets = discover_deployment_targets(root)

        self.assertEqual([target.chart_dir for target in targets], [deploy_dir])

    def test_render_target_invokes_helm_template_with_values_file(self):
        target = RenderTarget("cpu-alerts", Path("."), Path("charts/cpu-alerts"), Path("charts/cpu-alerts/values.yaml"))

        with patch("render_and_check.run_command") as run_command:
            run_command.return_value = subprocess.CompletedProcess(
                args=[],
                returncode=0,
                stdout="kind: PrometheusRule\nspec:\n  groups: []\n",
                stderr="",
            )

            code, rendered = render_target(target)

        self.assertEqual(code, 0)
        self.assertIn("PrometheusRule", rendered)
        run_command.assert_called_once_with(
            [
                "helm",
                "template",
                "cpu-alerts",
                "charts/cpu-alerts",
                "-f",
                "charts/cpu-alerts/values.yaml",
            ],
        )

    def test_check_rules_invokes_promtool_with_temp_rules_file(self):
        target = RenderTarget("cpu-alerts", Path("."), Path("charts/cpu-alerts"), Path("charts/cpu-alerts/values.yaml"))
        rendered = """
kind: PrometheusRule
spec:
  groups:
    - name: api
      rules:
        - alert: ApiDown
          expr: up == 0
"""
        calls = []

        def fake_run_command(command, cwd=None):
            calls.append(command)
            rules_file = Path(command[-1])
            self.assertTrue(rules_file.exists())
            self.assertIn("ApiDown", rules_file.read_text(encoding="utf-8"))
            return subprocess.CompletedProcess(args=command, returncode=0, stdout="", stderr="")

        with patch("render_and_check.run_command", side_effect=fake_run_command):
            with redirect_stdout(StringIO()):
                code = check_rules(target, rendered, "promtool")

        self.assertEqual(code, 0)
        self.assertEqual(calls[0][:3], ["promtool", "check", "rules"])

    def test_check_rules_fails_when_no_groups_are_rendered(self):
        target = RenderTarget("cpu-alerts", Path("."), Path("charts/cpu-alerts"), Path("charts/cpu-alerts/values.yaml"))

        with redirect_stderr(StringIO()):
            code = check_rules(target, "kind: Service\nmetadata:\n  name: api\n", "promtool")

        self.assertEqual(code, 1)

    def test_check_rules_returns_nonzero_when_promtool_fails(self):
        target = RenderTarget("cpu-alerts", Path("."), Path("charts/cpu-alerts"), Path("charts/cpu-alerts/values.yaml"))
        rendered = """
kind: PrometheusRule
spec:
  groups:
    - name: api
      rules:
        - alert: ApiDown
          expr: up =
"""

        def fake_run_command(command, cwd=None):
            return subprocess.CompletedProcess(
                args=command,
                returncode=2,
                stdout="",
                stderr="bad_data: invalid promql\n",
            )

        with patch("render_and_check.run_command", side_effect=fake_run_command):
            with redirect_stderr(StringIO()):
                code = check_rules(target, rendered, "promtool")

        self.assertEqual(code, 2)

    def test_build_dependencies_uses_temporary_chart_copy(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            chart_dir = root / "deployments" / "prod"
            chart_dir.mkdir(parents=True)
            (chart_dir / "Chart.yaml").write_text(
                """
apiVersion: v2
name: prod
version: 1.0.0
dependencies:
  - name: cpu-alerts
    version: 1.0.0
    repository: file://../../charts/cpu-alerts
""",
                encoding="utf-8",
            )
            (chart_dir / "values.yaml").write_text("cpu-alerts: {}\n", encoding="utf-8")
            target = RenderTarget("prod", root, chart_dir, chart_dir / "values.yaml")
            commands = []

            def fake_run_command(command, cwd=None):
                commands.append(command)
                if command[:3] == ["helm", "dependency", "build"]:
                    build_dir = Path(command[3])
                    self.assertNotEqual(build_dir, chart_dir)
                    (build_dir / "Chart.lock").write_text("generated\n", encoding="utf-8")
                    (build_dir / "charts").mkdir()
                    return subprocess.CompletedProcess(args=command, returncode=0, stdout="", stderr="")
                if command[:2] == ["helm", "template"]:
                    render_dir = Path(command[3])
                    self.assertNotEqual(render_dir, chart_dir)
                    self.assertTrue((render_dir / "Chart.lock").exists())
                    return subprocess.CompletedProcess(
                        args=command,
                        returncode=0,
                        stdout="""
kind: PrometheusRule
spec:
  groups:
    - name: api
      rules:
        - alert: ApiDown
          expr: up == 0
""",
                        stderr="",
                    )
                if command[:3] == ["promtool", "check", "rules"]:
                    return subprocess.CompletedProcess(args=command, returncode=0, stdout="", stderr="")
                raise AssertionError(f"unexpected command: {command}")

            with patch("render_and_check.run_command", side_effect=fake_run_command):
                with redirect_stdout(StringIO()):
                    code = run_target(target, "promtool", build_deps=True)

            self.assertEqual(code, 0)
            self.assertFalse((chart_dir / "Chart.lock").exists())
            self.assertFalse((chart_dir / "charts").exists())
            self.assertEqual(commands[0][:3], ["helm", "dependency", "build"])


if __name__ == "__main__":
    unittest.main()
