import os
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "promtool_test.sh"


class PromtoolTestScriptTest(unittest.TestCase):
    def test_runs_all_chart_test_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            tests_dir = root / "charts" / "cpu-alerts" / "tests"
            tests_dir.mkdir(parents=True)
            (tests_dir / "cpu.yaml").write_text("tests: []\n", encoding="utf-8")
            calls_file = root / "calls.txt"
            fake_promtool = root / "promtool"
            fake_promtool.write_text(
                f"#!/usr/bin/env sh\n"
                f"echo \"$@\" >> {calls_file}\n"
                f"exit 0\n",
                encoding="utf-8",
            )
            fake_promtool.chmod(0o755)

            env = {**os.environ, "PROMTOOL": str(fake_promtool)}
            result = subprocess.run(
                [str(SCRIPT), str(root)],
                check=False,
                text=True,
                capture_output=True,
                env=env,
            )
            calls = calls_file.read_text(encoding="utf-8")

        self.assertEqual(result.returncode, 0)
        self.assertIn("test rules", calls)

    def test_runs_sample_promtool_test_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            tests_dir = root / "promtool-tests" / "cpu-alerts"
            tests_dir.mkdir(parents=True)
            (tests_dir / "cpu.yaml").write_text("tests: []\n", encoding="utf-8")
            calls_file = root / "calls.txt"
            fake_promtool = root / "promtool"
            fake_promtool.write_text(
                f"#!/usr/bin/env sh\n"
                f"echo \"$@\" >> {calls_file}\n"
                f"exit 0\n",
                encoding="utf-8",
            )
            fake_promtool.chmod(0o755)

            env = {**os.environ, "PROMTOOL": str(fake_promtool)}
            result = subprocess.run(
                [str(SCRIPT), str(root)],
                check=False,
                text=True,
                capture_output=True,
                env=env,
            )
            calls = calls_file.read_text(encoding="utf-8")

        self.assertEqual(result.returncode, 0)
        self.assertIn("test rules", calls)

    def test_returns_nonzero_when_promtool_test_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            tests_dir = root / "charts" / "cpu-alerts" / "tests"
            tests_dir.mkdir(parents=True)
            (tests_dir / "cpu.yaml").write_text("tests: []\n", encoding="utf-8")
            fake_promtool = root / "promtool"
            fake_promtool.write_text("#!/usr/bin/env sh\nexit 3\n", encoding="utf-8")
            fake_promtool.chmod(0o755)

            env = {**os.environ, "PROMTOOL": str(fake_promtool)}
            result = subprocess.run(
                [str(SCRIPT), str(root)],
                check=False,
                text=True,
                capture_output=True,
                env=env,
            )

        self.assertEqual(result.returncode, 3)


if __name__ == "__main__":
    unittest.main()
