import os
import shutil
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
    run_command,
    run_target,
)


DEPLOYMENT_CHART = "name: prod\ndependencies:\n  - name: cpu-alerts\n    version: '>=0.0.0-0'\n"


def deployment(root: Path, rel: str) -> Path:
    folder = root / rel
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "Chart.yaml").write_text(DEPLOYMENT_CHART, encoding="utf-8")
    (folder / "values.yaml").write_text("cpu-alerts: {}\n", encoding="utf-8")
    return folder


MIXED_PROFILES = """
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata: {name: rel-p2}
spec:
  groups: [{name: p2, rules: [{alert: A, expr: up == 0}]}]
---
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata: {name: rel-p3, annotations: {alertforge.io/profile: prometheus3}}
spec:
  groups: [{name: p3, labels: {team: x}, rules: [{alert: A, expr: up == 0}]}]
---
apiVersion: operator.victoriametrics.com/v1beta1
kind: VMRule
metadata: {name: rel-vm}
spec:
  groups: [{name: vm, type: prometheus, rules: [{alert: A, expr: up == 0}]}]
---
apiVersion: operator.victoriametrics.com/v1beta1
kind: VMRule
metadata: {name: rel-vm-untyped}
spec:
  groups: [{name: vm2, rules: [{alert: A, expr: up == 0}]}]
---
apiVersion: operator.victoriametrics.com/v1beta1
kind: VMRule
metadata: {name: rel-logs}
spec:
  groups: [{name: logs, type: vlogs, rules: [{alert: A, expr: 'error | stats count() as n'}]}]
"""


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
            (deploy_dir / "Chart.yaml").write_text(DEPLOYMENT_CHART, encoding="utf-8")
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
            (deploy_dir / "Chart.yaml").write_text(DEPLOYMENT_CHART, encoding="utf-8")
            (deploy_dir / "values.yaml").write_text("rule: value\n", encoding="utf-8")

            vendored_dir = deploy_dir / "charts" / "cpu-alerts"
            vendored_dir.mkdir(parents=True)
            (vendored_dir / "Chart.yaml").write_text("name: cpu-alerts\n", encoding="utf-8")
            (vendored_dir / "values.yaml").write_text("rule: value\n", encoding="utf-8")

            targets = discover_deployment_targets(root)

        self.assertEqual([target.chart_dir for target in targets], [deploy_dir])

    def test_deployment_discovery_keeps_real_deployment_under_charts_named_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            deploy_dir = root / "teams" / "charts" / "prod"
            deploy_dir.mkdir(parents=True)
            (deploy_dir / "Chart.yaml").write_text(DEPLOYMENT_CHART, encoding="utf-8")
            (deploy_dir / "values.yaml").write_text("rule: value\n", encoding="utf-8")

            targets = discover_deployment_targets(root)

        self.assertEqual([target.chart_dir for target in targets], [deploy_dir])

    def test_deployment_discovery_follows_the_walk_alertforge_lists_and_checks(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            found = [deployment(root, rel) for rel in ["one", "nest/prod", "nest/prod/canary", "app", "app/envs/charts/prod", "team/charts/prod", "deep/a/b/c/d/e/f"]]
            for rel in [".hidden/dep", "x/.cache/dep", "x/node_modules/dep", "nest/prod/templates/inner", "nest/prod/charts/inner2", "charts/tpl", "shop/_common/cpu-alerts"]:
                deployment(root, rel)
            nodeps = root / "nodeps"
            nodeps.mkdir()
            (nodeps / "Chart.yaml").write_text("name: nodeps\n", encoding="utf-8")
            (nodeps / "values.yaml").write_text("{}\n", encoding="utf-8")
            fileish = root / "fileish"
            (fileish / "Chart.yaml").mkdir(parents=True)
            (fileish / "values.yaml").write_text("{}\n", encoding="utf-8")
            shared = root / "_shared"
            shared.mkdir()
            (shared / "notification-configs.yaml").write_text("configs: {}\n", encoding="utf-8")

            targets = discover_deployment_targets(root)

            self.assertEqual(sorted(t.chart_dir for t in targets), sorted(found))

    def test_deployment_discovery_skips_a_common_chart(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            common_dir = root / "shop" / "_common" / "cpu-alerts"
            common_dir.mkdir(parents=True)
            (common_dir / "Chart.yaml").write_text("name: common\n", encoding="utf-8")
            (common_dir / "values.yaml").write_text("rule: value\n", encoding="utf-8")

            deploy_dir = root / "shop" / "prod"
            deploy_dir.mkdir(parents=True)
            (deploy_dir / "Chart.yaml").write_text(DEPLOYMENT_CHART, encoding="utf-8")
            (deploy_dir / "values.yaml").write_text("rule: value\n", encoding="utf-8")

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
                str(Path("charts/cpu-alerts")),
                "-f",
                str(Path("charts/cpu-alerts/values.yaml")),
            ],
        )

    def test_check_rules_invokes_promtool_with_temp_rules_file(self):
        target = RenderTarget("cpu-alerts", Path("."), Path("charts/cpu-alerts"), Path("charts/cpu-alerts/values.yaml"))
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

    def run_check(self, rendered, returncode=0, missing=()):
        """check_rules with a fake run_command: the commands, the exit code and stderr."""
        calls = []

        def fake(command, cwd=None):
            calls.append(command)
            if command[0] in missing:
                return subprocess.CompletedProcess(args=command, returncode=127, stdout="", stderr=f"failed to execute {command[0]}: not found\n")
            return subprocess.CompletedProcess(args=command, returncode=returncode, stdout="", stderr="")

        stderr = StringIO()
        with patch("render_and_check.run_command", side_effect=fake), redirect_stderr(stderr), redirect_stdout(StringIO()):
            code = check_rules(RenderTarget("t", Path("."), Path("c"), Path("c/values.yaml")), rendered, checkers={"promtool": "promtool", "promtool3": "/opt/promtool3", "vmalert": "vmalert"})
        return calls, code, stderr.getvalue()

    def test_check_rules_checks_each_profile_with_its_own_tool(self):
        # As Preview: promtool for prometheus2, promtool 3 for an object
        # marked prometheus3, vmalert for vm (no type is vmalert's
        # prometheus) and vlogs — one file per object for the last two.
        calls, code, _ = self.run_check(MIXED_PROFILES)
        self.assertEqual(code, 0)
        self.assertEqual(sorted(c[0] for c in calls), ["/opt/promtool3", "promtool", "vmalert", "vmalert", "vmalert"])
        self.assertEqual([c[1:3] for c in calls if c[0] == "/opt/promtool3"], [["check", "rules"]])
        self.assertTrue(all(c[1] == "-dryRun" and c[2].startswith("-rule=") for c in calls if c[0] == "vmalert"))

    def test_check_rules_says_a_missing_tool_and_does_not_pass(self):
        calls, code, err = self.run_check(MIXED_PROFILES, missing=("/opt/promtool3",))
        self.assertEqual(code, 2)
        self.assertIn("promtool 3 is not available: /opt/promtool3 — 1 object(s) not checked", err)

    @unittest.skipUnless(shutil.which(os.environ.get("PROMTOOL3_BIN") or "promtool3") and shutil.which("promtool") and shutil.which("vmalert"), "promtool, promtool 3 or vmalert not installed")
    def test_check_rules_with_the_real_tools(self):
        # promtool 2 refuses the group labels; promtool 3 takes them.
        stdout = StringIO()
        with redirect_stdout(stdout), redirect_stderr(StringIO()):
            code = check_rules(RenderTarget("t", Path("."), Path("c"), Path("c/values.yaml")), MIXED_PROFILES)
        self.assertEqual(code, 0, stdout.getvalue())
        self.assertIn("t: promtool 3 check rules passed (1 object(s))", stdout.getvalue())
        self.assertIn("t: vmalert -dryRun passed (3 object(s))", stdout.getvalue())

    def test_check_rules_fails_when_a_checker_refuses_an_object(self):
        _, code, err = self.run_check(MIXED_PROFILES, returncode=255)
        self.assertEqual(code, 1)
        self.assertIn("vmalert -dryRun failed for rel-vm", err)

    def test_check_rules_returns_nonzero_when_promtool_fails(self):
        target = RenderTarget("cpu-alerts", Path("."), Path("charts/cpu-alerts"), Path("charts/cpu-alerts/values.yaml"))
        rendered = """
apiVersion: monitoring.coreos.com/v1
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

        # A failed check is 1; 2 is a checker that is not there.
        self.assertEqual(code, 1)

    def test_run_command_reports_missing_binary_cleanly(self):
        with patch("subprocess.run", side_effect=FileNotFoundError("No such file or directory")):
            result = run_command(["missing-promtool"])

        self.assertEqual(result.returncode, 127)
        self.assertIn("failed to execute missing-promtool", result.stderr)

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
                    self.assertIn("--skip-refresh", command)
                    build_dir = Path(command[-1])
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
apiVersion: monitoring.coreos.com/v1
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
