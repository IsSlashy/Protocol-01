/**
 * The web app's pool test config (apps/web/vitest.pool.config.mts, unchanged)
 * plus ONE setup file that timestamps console lines, restricted to the live
 * harnesses. Used only by scripts/bench/run.mts for the live product flows:
 *
 *   cd apps/web
 *   npx vitest run --config ../../scripts/bench/flows/vitest.bench.config.mts <harness file>
 *
 * The live harnesses stay inert unless their arm flag (P01_LIVE_DEVNET=1 or
 * P01_LIVE_BUY=1) is set, and run.mts sets it only after its own key, cluster
 * and RPC checks passed.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import base from '../../../apps/web/vitest.pool.config.mts';

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, '../../../apps/web');

const baseTest = (base as { test?: Record<string, unknown> }).test ?? {};

export default {
  ...base,
  root: webRoot,
  test: {
    ...baseTest,
    include: ['lib/privacy/pool/live*.test.ts'],
    setupFiles: [path.join(here, 'stamp.setup.ts')],
    // One live flow at a time: two harnesses sharing a key would race on its balance.
    fileParallelism: false,
    testTimeout: 20 * 60 * 1000,
  },
};
