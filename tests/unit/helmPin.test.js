import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

/**
 * One Helm version for the image, CI and a developer's machine: a values
 * file Helm reads differently between versions (a `null`, an error) would
 * otherwise render one way in Preview and another where the same chart is
 * checked or deployed. The Dockerfile's HELM_VERSION is the one; the image
 * installs it, scripts/install-checkers.sh installs it for CI and a machine,
 * and CI checks the helm it runs is that one.
 */

const read = rel => fs.readFileSync(path.resolve(rel), 'utf-8')
const version = () => /^ARG HELM_VERSION=(\S+)$/m.exec(read('Dockerfile'))?.[1]

describe('the pinned Helm', () => {
  it('the Dockerfile names one version, and the runtime stage installs exactly it', () => {
    expect(version()).toMatch(/^3\.19\.\d+$/)
    const lines = read('Dockerfile').split('\n')
    const runtime = lines.slice(lines.map((l, i) => (/^FROM\s/i.test(l) ? i : -1)).filter(i => i >= 0).pop()).join('\n')
    expect(runtime).toMatch(/^ARG HELM_VERSION$/m)
    expect(runtime).toContain('"helm~${HELM_VERSION}"')
    expect(runtime).toContain(`test "$(helm version --template '{{.Version}}')" = "v\${HELM_VERSION}"`)
    // No unversioned helm left beside it.
    expect(runtime).not.toMatch(/apk add[^\n]*\shelm(\s|$)/)
  })

  it('install-checkers.sh installs that version, with a checksum for it', () => {
    const script = read('scripts/install-checkers.sh')
    expect(script).toContain('HELM_VERSION="$(arg HELM_VERSION)"')
    expect(script).toMatch(new RegExp(`^\\s*${version().replace(/\./g, '\\.')}\\) echo [0-9a-f]{64} ;;$`, 'm'))
    expect(script).toContain('sha256sum -c')
    // Another machine is told, not given a binary that does not run.
    expect(script).toContain('"$(uname -s)-$(uname -m)" != "Linux-x86_64"')
  })

  it('CI installs no helm of its own, and checks the one it runs', () => {
    const ci = read('.github/workflows/ci.yml')
    expect(ci).not.toContain('setup-helm')
    const checks = ci.match(/test "\$\(helm version --template '\{\{\.Version\}\}'\)" = "v\$\(sed -n 's\/\^ARG HELM_VERSION=\/\/p' Dockerfile\)"/g) || []
    // The unit-test job and the E2E job.
    expect(checks.length).toBe(2)
  })
})
