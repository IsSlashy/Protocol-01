/**
 * Generate base64-encoded circuit data for mobile app bundling
 */
const fs = require('fs');
const path = require('path');

const WASM_PATH = path.join(__dirname, '../circuits/build/transfer_js/transfer.wasm');
const ZKEY_PATH = path.join(__dirname, '../circuits/build/transfer_final.zkey');
const OUTPUT_PATH = path.join(__dirname, '../apps/mobile/assets/circuits/circuitData.ts');

console.log('Reading circuit files...');

const wasmData = fs.readFileSync(WASM_PATH);
const zkeyData = fs.readFileSync(ZKEY_PATH);

console.log(`WASM size: ${(wasmData.length / 1024 / 1024).toFixed(2)} MB`);
console.log(`ZKEY size: ${(zkeyData.length / 1024 / 1024).toFixed(2)} MB`);

const wasmBase64 = wasmData.toString('base64');
const zkeyBase64 = zkeyData.toString('base64');

console.log(`WASM base64 size: ${(wasmBase64.length / 1024 / 1024).toFixed(2)} MB`);
console.log(`ZKEY base64 size: ${(zkeyBase64.length / 1024 / 1024).toFixed(2)} MB`);

const output = `/**
 * Pre-generated circuit data for mobile bundling
 * Generated: ${new Date().toISOString()}
 *
 * This file contains base64-encoded WASM and ZKEY for the transfer circuit.
 * It avoids React Native asset loading issues on various platforms.
 */

export const TRANSFER_WASM_BASE64 = '${wasmBase64}';

export const TRANSFER_ZKEY_BASE64 = '${zkeyBase64}';
`;

console.log('Writing circuitData.ts...');
fs.writeFileSync(OUTPUT_PATH, output);
console.log('Done! Output:', OUTPUT_PATH);
