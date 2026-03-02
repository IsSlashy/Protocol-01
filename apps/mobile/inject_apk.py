import zipfile, os, shutil, json

base_apk = 'P01-Mobile-v0.4.apk'
output_apk = 'p01-denominated-pool.apk'
dist_dir = 'dist'

# Remove old output
if os.path.exists(output_apk):
    os.remove(output_apk)

# Read metadata to find bundle and assets
with open(os.path.join(dist_dir, 'metadata.json'), 'r') as f:
    metadata = json.load(f)

android_meta = metadata['fileMetadata']['android']
bundle_rel = android_meta['bundle']  # e.g. _expo/static/js/android/index-xxx.hbc
bundle_path = os.path.join(dist_dir, bundle_rel)
print(f'New bundle: {bundle_path} ({os.path.getsize(bundle_path)} bytes)')

# Collect all dist assets (hashed names)
dist_assets = set()
for asset in android_meta['assets']:
    p = asset['path'].replace('\\', '/')
    dist_assets.add(p)

print(f'Total dist assets: {len(dist_assets)}')

# Read base APK entries
old_zip = zipfile.ZipFile(base_apk, 'r')
base_entries = set(old_zip.namelist())
print(f'Base APK entries: {len(base_entries)}')

# Find the JS bundle in base APK
base_bundle = None
for name in base_entries:
    if 'index.android.bundle' in name:
        base_bundle = name
        break
print(f'Base bundle: {base_bundle}')

# Create new APK
new_zip = zipfile.ZipFile(output_apk, 'w', zipfile.ZIP_STORED)

replaced = 0
kept = 0
for item in old_zip.infolist():
    # Replace JS bundle
    if item.filename == base_bundle:
        print(f'Replacing bundle: {base_bundle}')
        with open(bundle_path, 'rb') as f:
            new_zip.writestr(item.filename, f.read())
        replaced += 1
        continue

    # Keep everything else from base
    data = old_zip.read(item.filename)
    new_zip.writestr(item, data)
    kept += 1

print(f'Kept {kept} entries, replaced {replaced}')

# Add new assets from dist that aren't in base APK
added = 0
for asset_path in dist_assets:
    full_path = os.path.join(dist_dir, asset_path)
    if not os.path.exists(full_path):
        continue
    # Check if already in base APK
    if asset_path in base_entries:
        continue
    # New asset - add it
    size = os.path.getsize(full_path)
    with open(full_path, 'rb') as f:
        new_zip.writestr(asset_path, f.read())
    if size > 100000:
        print(f'  Added new asset: {asset_path} ({size} bytes)')
    added += 1

print(f'Added {added} new assets from dist')

# Add circuit files with predictable names for direct file:///android_asset/ access
# (Expo Asset system can't find hash-based names when using APK injection)
circuit_files = {
    'denominated_pool_circuit.wasm': os.path.join('assets', 'circuits', 'denominated_pool', 'denominated_pool.wasm'),
    'denominated_pool_circuit.zkey': os.path.join('assets', 'circuits', 'denominated_pool', 'denominated_pool_final.zkey'),
    'denominated_transfer_circuit.wasm': os.path.join('assets', 'circuits', 'denominated_pool', 'denominated_transfer.wasm'),
    'denominated_transfer_circuit.zkey': os.path.join('assets', 'circuits', 'denominated_pool', 'denominated_transfer_final.zkey'),
}
circuit_added = 0
for dest_name, src_rel in circuit_files.items():
    src_path = os.path.join(dist_dir, src_rel)
    if not os.path.exists(src_path):
        # Try from project root
        src_path = src_rel
    if os.path.exists(src_path):
        size = os.path.getsize(src_path)
        with open(src_path, 'rb') as f:
            new_zip.writestr(f'assets/{dest_name}', f.read())
        print(f'  Added circuit: assets/{dest_name} ({size} bytes)')
        circuit_added += 1
    else:
        print(f'  WARNING: Circuit file not found: {src_rel}')

print(f'Added {circuit_added} circuit files with predictable names')

old_zip.close()
new_zip.close()

size_mb = os.path.getsize(output_apk) / 1024 / 1024
print(f'\nOutput: {output_apk}')
print(f'Size: {size_mb:.1f} MB')
