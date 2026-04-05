/**
 * Inline HTML for the ZK Prover WebView.
 *
 * This is the runtime copy of assets/prover.html, exported as a string
 * constant so it can be passed to react-native-webview's `source={{ html }}`.
 *
 * Metro does not bundle .html files as WebView-loadable sources, so we
 * keep the HTML inline here (same pattern used by DenominatedPoolProver).
 *
 * If you edit the proving logic, update BOTH this file AND assets/prover.html.
 */

export const PROVER_HTML = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'wasm-unsafe-eval' file: blob:; worker-src blob:; style-src 'unsafe-inline'; connect-src 'none';">
</head>
<body>
<script>
/**
 * ZK Prover Bridge
 *
 * Protocol:
 *   RN -> WebView:
 *     { type: 'loadCircuit', circuit: string, wasm: base64, zkey: base64 }
 *     { type: 'loadFromAssets', circuit: string }
 *     { type: 'prove', id: string, circuit: string, inputs: {...} }
 *     { type: 'ping' }
 *
 *   WebView -> RN:
 *     { type: 'ready' }
 *     { type: 'snarkjsLoaded' }
 *     { type: 'circuitLoaded', success: bool, circuit: string, ... }
 *     { type: 'circuitLoadFailed', circuit: string, error: string }
 *     { type: 'proof', id, proof, publicSignals, durationMs }
 *     { type: 'error', id, error }
 *     { type: 'pong', snarkjsReady, loadedCircuits }
 */

var circuits = {};
var snarkjsReady = false;

document.addEventListener('message', handleMessage);
window.addEventListener('message', handleMessage);

function handleMessage(event) {
  try {
    var data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
    if (data.type === 'loadCircuit')        loadCircuitFromBase64(data);
    else if (data.type === 'loadFromAssets') loadCircuitFromAssets(data.circuit || 'transfer');
    else if (data.type === 'prove')          prove(data);
    else if (data.type === 'ping')           pong();
  } catch (e) {
    window.ReactNativeWebView.postMessage(JSON.stringify({
      type: 'error', id: 'parse', error: 'Message parse error: ' + e.message
    }));
  }
}

function pong() {
  window.ReactNativeWebView.postMessage(JSON.stringify({
    type: 'pong', snarkjsReady: snarkjsReady, loadedCircuits: Object.keys(circuits)
  }));
}

// ------------------------------------------------------------------
// Load circuit from base64 data sent by React Native
// ------------------------------------------------------------------
async function loadCircuitFromBase64(data) {
  var ct = data.circuit || 'transfer';
  try {
    var wasmBin = Uint8Array.from(atob(data.wasm), function(c) { return c.charCodeAt(0); });
    var zkeyBin = Uint8Array.from(atob(data.zkey), function(c) { return c.charCodeAt(0); });
    circuits[ct] = { wasm: wasmBin, zkey: zkeyBin };
    window.ReactNativeWebView.postMessage(JSON.stringify({
      type: 'circuitLoaded', success: true, source: 'base64', circuit: ct,
      wasmSize: wasmBin.length, zkeySize: zkeyBin.length
    }));
  } catch (error) {
    window.ReactNativeWebView.postMessage(JSON.stringify({
      type: 'circuitLoaded', success: false, circuit: ct, error: error.message
    }));
  }
}

// ------------------------------------------------------------------
// Load circuit from APK assets via XHR
// ------------------------------------------------------------------
function loadFileXHR(url) {
  return new Promise(function(resolve, reject) {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', url, true);
    xhr.responseType = 'arraybuffer';
    xhr.onload = function() {
      if (xhr.status === 0 || xhr.status === 200) {
        if (xhr.response && xhr.response.byteLength > 0) resolve(xhr.response);
        else reject(new Error('Empty response for ' + url));
      } else {
        reject(new Error('XHR failed: status ' + xhr.status + ' for ' + url));
      }
    };
    xhr.onerror = function() { reject(new Error('XHR network error for ' + url)); };
    xhr.send();
  });
}

var ASSET_NAMES = {
  transfer:             { wasm: 'transfer_circuit.wasm',             zkey: 'transfer_circuit.zkey' },
  pool:                 { wasm: 'denominated_pool_circuit.wasm',     zkey: 'denominated_pool_circuit.zkey' },
  denominated_transfer: { wasm: 'denominated_transfer_circuit.wasm', zkey: 'denominated_transfer_circuit.zkey' }
};

async function loadCircuitFromAssets(ct) {
  try {
    var names = ASSET_NAMES[ct];
    if (!names) throw new Error('Unknown circuit type: ' + ct);
    var wasmBuf = await loadFileXHR(names.wasm);
    var zkeyBuf = await loadFileXHR(names.zkey);
    circuits[ct] = { wasm: new Uint8Array(wasmBuf), zkey: new Uint8Array(zkeyBuf) };
    window.ReactNativeWebView.postMessage(JSON.stringify({
      type: 'circuitLoaded', success: true, source: 'apk_assets', circuit: ct,
      wasmSize: circuits[ct].wasm.length, zkeySize: circuits[ct].zkey.length
    }));
  } catch (error) {
    window.ReactNativeWebView.postMessage(JSON.stringify({
      type: 'circuitLoadFailed', circuit: ct, error: error.message
    }));
  }
}

// ------------------------------------------------------------------
// Proof generation
// ------------------------------------------------------------------
async function prove(data) {
  var id = data.id;
  var ct = data.circuit || 'transfer';
  try {
    if (!snarkjsReady || typeof snarkjs === 'undefined')
      throw new Error('snarkjs not loaded yet');
    var c = circuits[ct];
    if (!c || !c.wasm || !c.zkey)
      throw new Error('Circuit "' + ct + '" not loaded');

    var start = performance.now();

    // Parse JSON array inputs
    var parsed = {};
    for (var k in data.inputs) {
      var v = data.inputs[k];
      if (typeof v === 'string' && v.charAt(0) === '[') {
        try { parsed[k] = JSON.parse(v); } catch (_) { parsed[k] = v; }
      } else {
        parsed[k] = v;
      }
    }

    var result = await snarkjs.groth16.fullProve(parsed, c.wasm, c.zkey);
    var durationMs = Math.round(performance.now() - start);

    window.ReactNativeWebView.postMessage(JSON.stringify({
      type: 'proof', id: id,
      proof: result.proof, publicSignals: result.publicSignals,
      durationMs: durationMs
    }));
  } catch (error) {
    window.ReactNativeWebView.postMessage(JSON.stringify({
      type: 'error', id: id, error: error.message || 'Proof generation failed'
    }));
  }
}

// ------------------------------------------------------------------
// Bootstrap
// ------------------------------------------------------------------
window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'ready' }));

// SECURITY: Load snarkjs from APK-bundled asset (file:///android_asset/) instead of CDN.
// The baseUrl in WebViewProver is set to 'file:///android_asset/' so relative paths resolve there.
// Ensure snarkjs.min.js is placed in android/app/src/main/assets/ at build time.
var script = document.createElement('script');
script.src = 'snarkjs.min.js';
script.onload = function() {
  snarkjsReady = true;
  window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'snarkjsLoaded' }));
};
script.onerror = function() {
  window.ReactNativeWebView.postMessage(JSON.stringify({
    type: 'error', id: 'snarkjs_load',
    error: 'Failed to load snarkjs from local assets. Ensure snarkjs.min.js is bundled in android/app/src/main/assets/.'
  }));
};
document.head.appendChild(script);
</script>
<p style="color:#666;font-family:monospace;font-size:10px;">P-01 ZK Prover Active</p>
</body>
</html>
`;
