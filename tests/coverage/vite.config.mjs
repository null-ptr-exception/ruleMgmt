// `npm run build:coverage`: the normal build — the same chunks, byte for byte
// (tests/unit/coverage.test.js) — and beside each its source map, which says
// where in src/ the page's code comes from. Only this config writes maps: the
// image is built with `npm run build`.
import { mergeConfig } from 'vite'
import base from '../../vite.config.js'

// 'hidden': no comment naming the map at the end of a chunk.
export default mergeConfig(base, { build: { sourcemap: 'hidden' } })
