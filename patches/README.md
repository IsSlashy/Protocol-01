# patches/

This directory holds two categories of files.

## pnpm patchedDependencies

Patches consumed by the `pnpm.patchedDependencies` field in the root
`package.json`. They are applied automatically on every `pnpm install`:

- `llama.rn@0.11.2.patch`
- `react-native-worklets@0.8.1.patch`
- `react-native-ble-plx@3.5.0.patch`

The companion script `patch-arcium-client.js` is a postinstall step that
patches `@arcium-hq/client` after dependencies are resolved.

## Brace-expansion runtime backups (incident 2026-04-28)

The following loose `.js` files are backups of an in-memory fix applied
during a gradle build incident in late April 2026, where `balanced-match@4`
was hoisted under `brace-expansion@1` and broke its function-export
contract:

- `brace-expansion-codegen.js` — patched `index.js` for `brace-expansion@1`
- `babel-helper-compilation-targets-index.js` — Babel internal CommonJS
  module captured at the time of the incident
- `babel-plugin-module-resolver-normalizeOptions.js` — same

These files are NOT yet wired into `pnpm.patchedDependencies`. Promoting
the brace-expansion fix to a formal `pnpm patch brace-expansion@1.1.12`
is a TODO for the next maintenance pass; until then, keep these as
historical references for anyone debugging a similar regression.
