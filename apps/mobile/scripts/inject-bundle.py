"""
inject-bundle — a new JS bundle into the last native APK, signed, on the phone.

Founder, 2026-09-13: "du bundle js injection direct signé sans passer par expo,
trop de friction pour vraiment tester l'application". A full `expo run:android`
is ten minutes of Gradle for a one-line copy change. This does what Gradle's
`bundleReleaseJsAndAssets` + `packageRelease` do for the JS half only, in
under a minute:

  1. `expo export:embed` — the same Metro command Gradle runs (build.gradle
     sets bundleCommand = "export:embed"), production, Hermes-ready;
  2. `hermesc -O -emit-binary` — the same compiler Gradle runs, from the same
     react-native/sdks/hermesc binary;
  3. copy the base APK, replace `assets/index.android.bundle` with the .hbc;
  4. `zipalign -p 4` and `apksigner sign` — the release key, with the password
     from android/signing.properties (git-ignored, the same file build.gradle
     loads) or P01_RELEASE_STORE_PASSWORD; else the checked-in debug key;
  5. `adb install -r`, then start the activity.

⚠️ WHAT IT CANNOT DO. Anything native: a new native module, a new permission,
the icon, the app name, and NEW IMAGE ASSETS. Gradle packages images as
`res/drawable-*` resources indexed in resources.arsc, which this script does
not rewrite. An image the base APK never had will not show. Rebuild natively
(`build-android.bat`) when one of those changes; every asset is checked against
the base APK and missing ones are listed before the install, so it cannot fail
silently.

⚠️ SIGNING. An APK signed with a different key than the one installed cannot
upgrade it: `adb install -r` fails with INSTALL_FAILED_UPDATE_INCOMPATIBLE.
The script then stops. Pass --reinstall to uninstall first — that wipes the
wallet on the phone, which is why it is never the default.

Usage (from apps/mobile):
  python scripts/inject-bundle.py [--base path/to/base.apk] [--no-install] [--reinstall]
"""
import argparse, glob, json, os, shutil, subprocess, sys, zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.abspath(os.path.join(HERE, '..'))
ROOT = os.path.abspath(os.path.join(APP, '..', '..'))
OUT = os.path.join(APP, 'out', 'inject')
SDK = os.environ.get('ANDROID_HOME') or os.environ.get('ANDROID_SDK_ROOT') or r'D:\Android\Sdk'
PACKAGE = 'com.protocol01.app'
ACTIVITY = f'{PACKAGE}/.MainActivity'


def run(cmd, **kw):
    print('>', ' '.join(cmd) if isinstance(cmd, list) else cmd, flush=True)
    kw.setdefault('shell', isinstance(cmd, str))
    r = subprocess.run(cmd, **kw)
    if r.returncode != 0:
        sys.exit(f'failed ({r.returncode}): {cmd}')
    return r


def latest(pattern):
    files = glob.glob(pattern)
    return max(files, key=os.path.getmtime) if files else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--base', help='base APK (default: the newest release APK Gradle built)')
    ap.add_argument('--no-install', action='store_true')
    ap.add_argument('--reinstall', action='store_true', help='uninstall first (WIPES the wallet on the phone)')
    a = ap.parse_args()

    # build.gradle redirects buildDir to build2/ (NTFS corruption in build/ after a crash).
    base = a.base or latest(os.path.join(APP, 'android', 'app', 'build2', 'outputs', 'apk', 'release', '*.apk'))
    if not base or not os.path.exists(base):
        sys.exit('no base APK; build natively once (build-android.bat) or pass --base')
    print('base APK:', base, os.path.getsize(base), 'bytes')

    build_tools = latest(os.path.join(SDK, 'build-tools', '*'))
    if not build_tools:
        sys.exit(f'no build-tools under {SDK}')
    zipalign = os.path.join(build_tools, 'zipalign.exe')
    apksigner = os.path.join(build_tools, 'apksigner.bat')
    hermesc = os.path.join(ROOT, 'node_modules', 'react-native', 'sdks', 'hermesc', 'win64-bin', 'hermesc.exe')
    for p in (zipalign, apksigner, hermesc):
        if not os.path.exists(p):
            sys.exit(f'missing tool: {p}')

    shutil.rmtree(OUT, ignore_errors=True)
    os.makedirs(os.path.join(OUT, 'res'), exist_ok=True)
    js = os.path.join(OUT, 'index.android.bundle')
    hbc = js + '.hbc'

    # 1. Metro, exactly as Gradle invokes it: through scripts/bundle-fix.js
    #    (cliFile in build.gradle), which makes --entry-file absolute — Metro
    #    resolves a relative entry against the WORKSPACE root in this monorepo
    #    and fails with "Unable to resolve module ./index.js from D:\Protocol-01".
    #    NODE_ENV/BABEL_ENV=production, as Gradle's release bundle task sets
    #    them: babel.config.js strips console.log only under env.production
    #    (privacy item L8), and without it the first injected bundle came out
    #    14.1 MB against Gradle's 9.7 MB — the logs were all still in it.
    env = dict(os.environ, NODE_ENV='production', BABEL_ENV='production')
    run(['node', os.path.join(APP, 'scripts', 'bundle-fix.js'), 'export:embed', '--platform', 'android',
         '--dev', 'false', '--entry-file', os.path.join(APP, 'index.js'),
         '--bundle-output', js, '--assets-dest', os.path.join(OUT, 'res')], cwd=APP, shell=True, env=env)

    # 2. Hermes bytecode, as Gradle's createBundleReleaseJsAndAssets does.
    run([hermesc, '-O', '-emit-binary', '-out', hbc, js, '-w'])
    print('hbc:', os.path.getsize(hbc), 'bytes')

    # 3. The base APK with the bundle swapped. Everything else byte-for-byte.
    unsigned = os.path.join(OUT, 'app-unsigned.apk')
    with zipfile.ZipFile(base) as zin, zipfile.ZipFile(unsigned, 'w') as zout:
        names = set(zin.namelist())
        replaced = False
        for item in zin.infolist():
            if item.filename.startswith('META-INF/') and (
                item.filename.endswith(('.RSA', '.SF', '.MF', '.EC', '.DSA'))
            ):
                continue  # the old signature; apksigner writes a new one
            if item.filename == 'assets/index.android.bundle':
                with open(hbc, 'rb') as f:
                    zout.writestr(item.filename, f.read(), zipfile.ZIP_STORED)
                replaced = True
                continue
            zout.writestr(item, zin.read(item.filename))
        if not replaced:
            sys.exit('assets/index.android.bundle not found in the base APK')

        # Every image Metro emitted must already be in the base APK's resources.
        missing = []
        for dirpath, _, files in os.walk(os.path.join(OUT, 'res')):
            for f in files:
                rel = os.path.relpath(os.path.join(dirpath, f), os.path.join(OUT, 'res')).replace('\\', '/')
                if f'res/{rel}' not in names:
                    missing.append(rel)
        if missing:
            print('\n!! assets the base APK does not carry (need a native build to appear):')
            for m in missing:
                print('   ', m)

    # 4. Align, then sign.
    aligned = os.path.join(OUT, 'app-aligned.apk')
    run([zipalign, '-p', '-f', '4', unsigned, aligned])
    signed = os.path.join(OUT, 'styx-injected.apk')
    # The release password lives in android/signing.properties (git-ignored),
    # which app/build.gradle loads into project properties; the environment is
    # the documented alternative. Same precedence here: file, then environment.
    props = {}
    props_path = os.path.join(APP, 'android', 'signing.properties')
    if os.path.exists(props_path):
        for line in open(props_path, encoding='utf-8'):
            line = line.strip()
            if line and not line.startswith('#') and '=' in line:
                k, v = line.split('=', 1)
                props[k.strip()] = v.strip()
    store_pw = props.get('RELEASE_STORE_PASSWORD') or os.environ.get('P01_RELEASE_STORE_PASSWORD')
    if store_pw:
        ks = os.path.join(APP, 'android', 'app', 'release.keystore')
        key_pw = props.get('RELEASE_KEY_PASSWORD') or os.environ.get('P01_RELEASE_KEY_PASSWORD') or store_pw
        alias = props.get('RELEASE_KEY_ALIAS') or os.environ.get('RELEASE_KEY_ALIAS', 'protocol01')
        print('signing with the RELEASE key')
        run([apksigner, 'sign', '--ks', ks, '--ks-key-alias', alias,
             '--ks-pass', f'pass:{store_pw}', '--key-pass', f'pass:{key_pw}', '--out', signed, aligned], shell=True)
    else:
        ks = os.path.join(APP, 'android', 'app', 'debug.keystore')
        print('signing with the DEBUG key (P01_RELEASE_STORE_PASSWORD not set)')
        run([apksigner, 'sign', '--ks', ks, '--ks-key-alias', 'androiddebugkey',
             '--ks-pass', 'pass:android', '--key-pass', 'pass:android', '--out', signed, aligned], shell=True)
    run([apksigner, 'verify', signed], shell=True)
    print('\nsigned APK:', signed, os.path.getsize(signed), 'bytes')

    if a.no_install:
        return
    # 5. On the phone.
    if a.reinstall:
        subprocess.run(['adb', 'uninstall', PACKAGE])
    r = subprocess.run(['adb', 'install', '-r', signed], capture_output=True, text=True)
    print(r.stdout, r.stderr)
    if r.returncode != 0:
        if 'INSTALL_FAILED_UPDATE_INCOMPATIBLE' in (r.stdout + r.stderr):
            sys.exit('the phone has this app under another signing key; rerun with --reinstall (wipes the wallet)')
        sys.exit('adb install failed')
    run(['adb', 'shell', 'am', 'start', '-n', ACTIVITY])


if __name__ == '__main__':
    main()
