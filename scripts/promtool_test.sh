#!/usr/bin/env sh
set -eu

ROOT="${1:-.}"
PROMTOOL="${PROMTOOL:-promtool}"

found=0
for tests_dir in "$ROOT"/charts/*/tests; do
  [ -d "$tests_dir" ] || continue
  for test_file in "$tests_dir"/*.yaml "$tests_dir"/*.yml; do
    [ -f "$test_file" ] || continue
    found=1
    echo "==> $test_file"
    "$PROMTOOL" test rules "$test_file"
  done
done

for tests_dir in "$ROOT"/promtool-tests/*; do
  [ -d "$tests_dir" ] || continue
  for test_file in "$tests_dir"/*.yaml "$tests_dir"/*.yml; do
    [ -f "$test_file" ] || continue
    found=1
    echo "==> $test_file"
    "$PROMTOOL" test rules "$test_file"
  done
done

if [ "$found" -eq 0 ]; then
  echo "No promtool rule test files found under $ROOT/charts/*/tests or $ROOT/promtool-tests/*"
fi
