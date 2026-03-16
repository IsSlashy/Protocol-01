const fs = require('fs');
for (const ext of ['mjs', 'cjs']) {
  const p = 'node_modules/@arcium-hq/client/build/index.' + ext;
  let code = fs.readFileSync(p, 'utf8');
  code = code.replace(
    'if (isBrowser()) {
        throw new Error('Arcium local env is not available in browser.');',
    'if (false) { // P01 RN patch
        throw new Error('Arcium local env is not available in browser.');'
  );
  code = code.replace(
    'const arciumClusterOffset = Number(process.env.ARCIUM_CLUSTER_OFFSET);',
    'const arciumClusterOffset = 456; // P01: hardcoded for RN'
  );
  fs.writeFileSync(p, code);
}
console.log('[postinstall] @arcium-hq/client patched for React Native');
