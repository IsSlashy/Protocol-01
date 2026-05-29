// React Native autolinking config for pnpm 10 monorepo.
//
// pnpm 10 keeps `apps/mobile/node_modules` sparse — it only links direct
// deps, not the full transitive set. The RN community autolinker walks
// from `projectRoot` and only finds what's locally linked, which is why a
// default `pnpm install` build crashes at boot with:
//
//     Error: [@RNC/AsyncStorage]: NativeModule: AsyncStorage is null.
//
// We programmatically discover native modules in the workspace root's
// `node_modules` and inject them as explicit `dependencies` so RN's
// autolinker codegens them into PackageList.java.
const fs = require('fs');
const path = require('path');

const ROOT_NODE_MODULES = path.resolve(__dirname, '..', '..', 'node_modules');

// Heuristic: a package is a RN native module if its package.json declares
// either a `react-native.config.js` sibling, an `android` directory, or an
// `rnPackage` field. We scan the workspace-root node_modules and pick up
// anything that looks like a native module.
function discoverNativeModules() {
  const deps = {};
  let scoped = [];
  try {
    scoped = fs.readdirSync(ROOT_NODE_MODULES, { withFileTypes: true });
  } catch {
    return deps;
  }

  const entries = [];
  for (const e of scoped) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith('.')) continue;
    if (e.name.startsWith('@')) {
      // Scoped namespace — recurse one level.
      try {
        const inner = fs.readdirSync(path.join(ROOT_NODE_MODULES, e.name), {
          withFileTypes: true,
        });
        for (const i of inner) {
          if (i.isDirectory()) entries.push(`${e.name}/${i.name}`);
        }
      } catch {}
    } else {
      entries.push(e.name);
    }
  }

  for (const pkg of entries) {
    const pkgDir = path.join(ROOT_NODE_MODULES, pkg);
    const androidDir = path.join(pkgDir, 'android');
    const buildGradle = path.join(androidDir, 'build.gradle');
    if (!fs.existsSync(buildGradle)) continue;

    // Skip Expo modules — they're handled by expo-modules-autolinking via
    // settings.gradle. Adding them here would duplicate the Gradle subprojects.
    if (pkg.startsWith('expo-') || pkg.startsWith('expo/') || pkg === 'expo') continue;
    if (pkg.startsWith('@expo/')) continue;
    // Skip RN itself and its gradle plugin.
    if (pkg === 'react-native' || pkg.startsWith('@react-native/')) continue;

    // root MUST be absolute (resolveReactNativeModule uses it directly).
    // Do NOT set platforms.android.sourceDir — leave it undefined so the
    // default ('android' relative to root) kicks in. Passing an absolute
    // sourceDir breaks Windows path.join in resolveDependencyConfigImplAndroidAsync.
    deps[pkg] = {
      root: pkgDir,
      platforms: { ios: null },
    };
  }
  return deps;
}

const deps = discoverNativeModules();
process.stderr.write(`[react-native.config.js] loaded ${Object.keys(deps).length} deps, cwd=${process.cwd()}, dirname=${__dirname}\n`);

module.exports = {
  dependencies: deps,
  reactNativePath: path.join(ROOT_NODE_MODULES, 'react-native'),
};
