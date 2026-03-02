#!/usr/bin/env python3
"""
inject-apk.py — Inject circuit files into a React Native APK.

When developing ZK apps with React Native, rebuilding via EAS takes 30+ minutes.
This tool replaces the JS bundle and injects circuit files into an existing APK,
reducing the cycle time to 2-3 minutes.

Usage:
    python inject-apk.py --apk base.apk --dist ./dist --output patched.apk
    python inject-apk.py --apk base.apk --dist ./dist --circuit-dir ./circuits --output patched.apk

After running:
    zipalign -f -v 4 patched.apk aligned.apk
    apksigner sign --ks debug.keystore aligned.apk
    adb install -r aligned.apk
"""

import zipfile
import os
import json
import argparse


def main():
    parser = argparse.ArgumentParser(
        description='Inject JS bundle and circuit files into a React Native APK'
    )
    parser.add_argument('--apk', required=True, help='Path to the base APK')
    parser.add_argument('--dist', required=True, help='Path to expo export dist directory')
    parser.add_argument('--output', required=True, help='Output APK path')
    parser.add_argument(
        '--circuit-dir', default=None,
        help='Directory containing circuit files (.wasm, .zkey) to inject into assets/'
    )
    args = parser.parse_args()

    if not os.path.exists(args.apk):
        print(f'Error: Base APK not found: {args.apk}')
        return 1

    if not os.path.exists(args.dist):
        print(f'Error: Dist directory not found: {args.dist}')
        return 1

    if os.path.exists(args.output):
        os.remove(args.output)

    metadata_path = os.path.join(args.dist, 'metadata.json')
    with open(metadata_path, 'r') as f:
        metadata = json.load(f)

    android_meta = metadata['fileMetadata']['android']
    bundle_rel = android_meta['bundle']
    bundle_path = os.path.join(args.dist, bundle_rel)
    print(f'New bundle: {bundle_path} ({os.path.getsize(bundle_path)} bytes)')

    dist_assets = set()
    for asset in android_meta['assets']:
        p = asset['path'].replace('\\', '/')
        dist_assets.add(p)

    print(f'Total dist assets: {len(dist_assets)}')

    old_zip = zipfile.ZipFile(args.apk, 'r')
    base_entries = set(old_zip.namelist())
    print(f'Base APK entries: {len(base_entries)}')

    base_bundle = None
    for name in base_entries:
        if 'index.android.bundle' in name:
            base_bundle = name
            break
    print(f'Base bundle: {base_bundle}')

    new_zip = zipfile.ZipFile(args.output, 'w', zipfile.ZIP_STORED)

    replaced = 0
    kept = 0
    for item in old_zip.infolist():
        if item.filename == base_bundle:
            print(f'Replacing bundle: {base_bundle}')
            with open(bundle_path, 'rb') as f:
                new_zip.writestr(item.filename, f.read())
            replaced += 1
            continue
        data = old_zip.read(item.filename)
        new_zip.writestr(item, data)
        kept += 1

    print(f'Kept {kept} entries, replaced {replaced}')

    added = 0
    for asset_path in dist_assets:
        full_path = os.path.join(args.dist, asset_path)
        if not os.path.exists(full_path) or asset_path in base_entries:
            continue
        with open(full_path, 'rb') as f:
            new_zip.writestr(asset_path, f.read())
        added += 1

    print(f'Added {added} new assets from dist')

    if args.circuit_dir and os.path.isdir(args.circuit_dir):
        circuit_added = 0
        for fname in os.listdir(args.circuit_dir):
            if fname.endswith('.wasm') or fname.endswith('.zkey'):
                src = os.path.join(args.circuit_dir, fname)
                size = os.path.getsize(src)
                with open(src, 'rb') as f:
                    new_zip.writestr(f'assets/{fname}', f.read())
                print(f'  Injected circuit: assets/{fname} ({size} bytes)')
                circuit_added += 1
        print(f'Injected {circuit_added} circuit files')

    old_zip.close()
    new_zip.close()

    size_mb = os.path.getsize(args.output) / 1024 / 1024
    print(f'\nOutput: {args.output} ({size_mb:.1f} MB)')
    print(f'\nNext steps:')
    print(f'  zipalign -f -v 4 {args.output} aligned.apk')
    print(f'  apksigner sign --ks ~/.android/debug.keystore aligned.apk')
    print(f'  adb install -r aligned.apk')

    return 0


if __name__ == '__main__':
    exit(main())
