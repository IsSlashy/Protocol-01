import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const dirname =
  typeof __dirname !== 'undefined' ? __dirname : path.dirname(fileURLToPath(import.meta.url));

const requireFrom = createRequire(
  typeof __filename !== 'undefined' ? __filename : import.meta.url,
);

/**
 * The Storybook browser project, or nothing.
 *
 * 🚨 WHY THIS IS CONDITIONAL, AND IT IS NOT TIDINESS.
 *
 * This file used to import `@storybook/addon-vitest/vitest-plugin` at the top
 * level, and that package is not in this workspace. A missing import in a config
 * file does not fail one project — it fails the CONFIG, so vitest never starts
 * and EVERY suite in this package is unrunnable:
 *
 *     failed to load config from packages/p01-js/vitest.config.ts
 *     Error: Cannot find module '@storybook/addon-vitest/vitest-plugin'
 *
 * That is how `src/shielded-pool.test.ts:740` — `expect(MERKLE_TREE_DEPTH)
 * .toBe(15)` — stopped running. It is one of the guards on the constant that
 * must match `DEFAULT_TREE_DEPTH` on chain, and on 2026-08-18 a sibling package
 * was found shipping 20. The guard was correct, present, and silent, and nothing
 * in CI distinguished "this package passes" from "this package never ran".
 *
 * A component-story runner must never be able to take the unit tests down with
 * it. So the browser project is added only when its toolchain actually resolves,
 * and the unit project runs either way. `pnpm add -D @storybook/addon-vitest
 * @vitest/browser-playwright` in this package turns the stories back on; until
 * then they are skipped loudly here rather than silently everywhere.
 */
function storybookProject(): unknown[] {
  const needed = ['@storybook/addon-vitest/vitest-plugin', '@vitest/browser-playwright'];
  for (const mod of needed) {
    try {
      requireFrom.resolve(mod);
    } catch {
      // eslint-disable-next-line no-console
      console.warn(
        `[p01-js] Storybook test project disabled: cannot resolve "${mod}". ` +
          'Unit tests are unaffected. Install @storybook/addon-vitest and ' +
          '@vitest/browser-playwright to run the story tests.',
      );
      return [];
    }
  }

  const { storybookTest } = requireFrom('@storybook/addon-vitest/vitest-plugin');
  const { playwright } = requireFrom('@vitest/browser-playwright');

  return [
    {
      extends: true,
      plugins: [storybookTest({ configDir: path.join(dirname, '.storybook') })],
      test: {
        name: 'storybook',
        browser: {
          enabled: true,
          headless: true,
          provider: playwright({}),
          instances: [{ browser: 'chromium' }],
        },
        setupFiles: ['.storybook/vitest.setup.ts'],
      },
    },
  ];
}

// More info at: https://storybook.js.org/docs/next/writing-tests/integrations/vitest-addon
export default defineConfig({
  test: {
    projects: [
      // Unit tests for SDK core. These must run on their own, always.
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts'],
          environment: 'node',
          globals: true,
        },
      },
      ...(storybookProject() as never[]),
    ],
  },
});
