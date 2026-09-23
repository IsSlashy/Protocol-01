# patches/

Patches consumed by the `pnpm.patchedDependencies` field of the root
`package.json`. pnpm applies them on every `pnpm install`:

- `react-native-worklets@0.8.1.patch`

That is the only patch wired today. Anything else dropped in this directory is
not applied unless it is also listed in `pnpm.patchedDependencies`.

Two earlier workarounds no longer live here:

- the `brace-expansion@1` incident of 2026-04-28 is fixed by the root
  `pnpm.overrides` entry `"brace-expansion@1>balanced-match": "1.0.2"`, so the
  loose `.js` backups captured during that incident were removed on 2026-09-23;
- the `react-native-ble-plx` `SafePromise` crash is handled in the Android app
  (`MainApplication.kt`, RxJava error handler); the old `@3.5.0` patch targeted
  a version the lockfile no longer resolves and was removed on 2026-09-23.
