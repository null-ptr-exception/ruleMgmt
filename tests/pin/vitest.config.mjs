// `npm run test:pin`: every pin (tests/pin/<slice>/*.pin.test.js), apart from
// `npm test`, which stays about a minute. A slice's pin alone:
//   npm run test:pin -- tests/pin/<slice>
import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'url'

export default defineConfig({
  root: fileURLToPath(new URL('../../', import.meta.url)),
  test: {
    globals: true,
    include: ['tests/pin/**/*.pin.test.js'],
    // A row runs every entry point and Helm several times: under load one
    // can take longer than the default suite's 30 s.
    testTimeout: 300_000,
    hookTimeout: 300_000,
  },
})
