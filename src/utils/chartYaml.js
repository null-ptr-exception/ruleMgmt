/**
 * A chart's Chart.yaml, filled in when it is missing — see issue #57.
 *
 * A chart that came in as bare rule files (or an older layout) may have no
 * Chart.yaml. This supplies a minimal valid one; it never overwrites a file
 * that already has content.
 */

import { yamlName } from './yamlScalar.js'

export function ensureChartYaml(existingText, name) {
  if (existingText && existingText.trim()) return { text: existingText, created: false }
  const text =
    `apiVersion: v2\n` +
    // Helm reads Chart.yaml as YAML 1.1: a chart `yes` or `1_000` written
    // bare is named true or 1000.
    `name: ${yamlName(name)}\n` +
    `description: Alert rules for ${name}\n` +
    `version: 0.1.0\n` +
    `type: application\n` +
    // Chart discovery lists only charts marked as ours (server/lib/chartDiscovery.js).
    `annotations:\n` +
    `  app: alertforge\n`
  return { text, created: true }
}
