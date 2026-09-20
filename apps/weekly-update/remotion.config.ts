import { Config } from '@remotion/cli/config';
import fs from 'node:fs';
import path from 'node:path';

/**
 * zod, pinned twice in this monorepo, and why the bundle needs a hand.
 *
 * The root package.json overrides zod to 3.25.76 for the whole workspace: the
 * mobile app's Privy SDK uses the zod 3 API and crashed at startup when
 * @expo/eas-build-job hoisted zod 4 to the root (commit 0cb99477). Remotion
 * 4.0.524's @remotion/zod-types imports `zod/mini`, which only exists in zod 4,
 * and does not declare zod as a dependency at all; it takes whichever zod the
 * bundler finds next to it, and next to it, hoisted, is the root's zod 3.
 *
 * So this app carries its own zod 4.5.4 (a scoped `weekly-update>zod` override
 * exempts it from the root pin) and every `zod` request in the bundle is
 * pointed at that copy. Nothing else in this bundle uses zod: only the studio
 * and its schema types do, and both want 4.5.4.
 */
/* Not `require.resolve` and not `__dirname`: Remotion bundles this file with
   esbuild and evaluates it from inside @remotion/cli/dist, from which `zod`
   resolves to the root's zod 3. The CLI and scripts/render-chunked.mjs both run
   from this app's directory, so the working directory is the anchor. */
const zodDir = path.join(process.cwd(), 'node_modules', 'zod');
if (!fs.existsSync(path.join(zodDir, 'mini'))) {
  throw new Error(`weekly-update needs its own zod 4 at ${zodDir}; run pnpm install`);
}

Config.overrideWebpackConfig((config) => ({
  ...config,
  resolve: {
    ...config.resolve,
    alias: {
      ...(config.resolve?.alias ?? {}),
      zod: zodDir,
    },
  },
}));
