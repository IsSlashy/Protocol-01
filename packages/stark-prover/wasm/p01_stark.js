/* @ts-self-types="./p01_stark.d.ts" */

/**
 * Compute the Poseidon commitment for a secret (without generating a proof).
 * @param {bigint} subscriber_secret
 * @returns {string}
 */
export function compute_stark_commitment(subscriber_secret) {
    let deferred1_0;
    let deferred1_1;
    try {
        const ret = wasm.compute_stark_commitment(subscriber_secret);
        deferred1_0 = ret[0];
        deferred1_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
    }
}

/**
 * Generate a compact STARK proof for balance commitment.
 * Returns JSON: { circuit_id: 2, commitment: string, token_mint: string, proof_hex: string, proof_size: number }
 * @param {bigint} spending_key
 * @param {bigint} balance
 * @param {bigint} salt
 * @param {bigint} token_mint
 * @returns {string}
 */
export function generate_balance_stark_proof(spending_key, balance, salt, token_mint) {
    let deferred1_0;
    let deferred1_1;
    try {
        const ret = wasm.generate_balance_stark_proof(spending_key, balance, salt, token_mint);
        deferred1_0 = ret[0];
        deferred1_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
    }
}

/**
 * Generate a compact STARK proof for confidential balance update.
 * Returns JSON: { circuit_id: 4, old_commitment, new_commitment, amount_hash, token_mint, proof_hex, proof_size }
 * @param {bigint} spending_key
 * @param {bigint} old_balance
 * @param {bigint} old_salt
 * @param {bigint} new_balance
 * @param {bigint} new_salt
 * @param {bigint} amount
 * @param {bigint} amount_salt
 * @param {bigint} token_mint
 * @returns {string}
 */
export function generate_confidential_balance_stark_proof(spending_key, old_balance, old_salt, new_balance, new_salt, amount, amount_salt, token_mint) {
    let deferred1_0;
    let deferred1_1;
    try {
        const ret = wasm.generate_confidential_balance_stark_proof(spending_key, old_balance, old_salt, new_balance, new_salt, amount, amount_salt, token_mint);
        deferred1_0 = ret[0];
        deferred1_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
    }
}

/**
 * Generate a compact STARK proof for Merkle path inclusion.
 * path_elements and path_indices are comma-separated strings.
 * Returns JSON: { circuit_id: 3, leaf: string, root: string, proof_hex: string, proof_size: number }
 * @param {bigint} leaf
 * @param {string} path_elements_csv
 * @param {string} path_indices_csv
 * @returns {string}
 */
export function generate_merkle_path_stark_proof(leaf, path_elements_csv, path_indices_csv) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(path_elements_csv, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(path_indices_csv, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.generate_merkle_path_stark_proof(leaf, ptr0, len0, ptr1, len1);
        deferred3_0 = ret[0];
        deferred3_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Generate a compact STARK proof for a Merkle leaf update.
 * path_elements and path_indices are comma-separated strings.
 * Returns JSON: { circuit_id: 6, old_leaf, new_leaf, old_root, new_root, depth, proof_hex, proof_size }
 * @param {bigint} old_leaf
 * @param {bigint} new_leaf
 * @param {string} path_elements_csv
 * @param {string} path_indices_csv
 * @returns {string}
 */
export function generate_merkle_update_stark_proof(old_leaf, new_leaf, path_elements_csv, path_indices_csv) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(path_elements_csv, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(path_indices_csv, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.generate_merkle_update_stark_proof(old_leaf, new_leaf, ptr0, len0, ptr1, len1);
        deferred3_0 = ret[0];
        deferred3_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Generate a compact STARK proof for denominated pool commitment.
 * Returns JSON: { circuit_id: 1, nullifier: string, commitment: string, proof_hex: string, proof_size: number }
 * @param {bigint} nullifier_preimage
 * @param {bigint} secret
 * @param {bigint} deposit_epoch
 * @param {bigint} token_mint
 * @returns {string}
 */
export function generate_pool_commitment_stark_proof(nullifier_preimage, secret, deposit_epoch, token_mint) {
    let deferred1_0;
    let deferred1_1;
    try {
        const ret = wasm.generate_pool_commitment_stark_proof(nullifier_preimage, secret, deposit_epoch, token_mint);
        deferred1_0 = ret[0];
        deferred1_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
    }
}

/**
 * [C7] Generate a compact STARK proof for an unlinkable denominated spend.
 *
 * Returns JSON: { circuit_id: 7, nullifier, root, recipient_hash[4],
 *                 proof_hex, proof_size }
 *
 * 🚨 THE COMMITMENT IS NOT IN THAT LIST, AND MUST NEVER BE ADDED. C7 exists
 * so the withdrawal stops publishing it; a caller that wants it back has
 * misunderstood the circuit, and every other field here is safe to log.
 *
 * ⛔ DO NOT SHIP A BLOB BUILT FROM THIS UNTIL THE VERIFIER THAT ACCEPTS
 * CIRCUIT 7 IS DEPLOYED. Adding this export changes the wasm the three
 * surfaces carry, and a prover the deployed verifier does not recognise
 * fails at the END of a ~150 transaction upload, never early. See
 * `stark/src/air/mod.rs`.
 * @param {bigint} nullifier_preimage
 * @param {bigint} secret
 * @param {bigint} blinding
 * @param {bigint} token_mint
 * @param {string} path_elements_csv
 * @param {string} path_indices_csv
 * @param {string} recipient_hash_csv
 * @returns {string}
 */
export function generate_spend_stark_proof(nullifier_preimage, secret, blinding, token_mint, path_elements_csv, path_indices_csv, recipient_hash_csv) {
    let deferred4_0;
    let deferred4_1;
    try {
        const ptr0 = passStringToWasm0(path_elements_csv, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(path_indices_csv, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(recipient_hash_csv, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len2 = WASM_VECTOR_LEN;
        const ret = wasm.generate_spend_stark_proof(nullifier_preimage, secret, blinding, token_mint, ptr0, len0, ptr1, len1, ptr2, len2);
        deferred4_0 = ret[0];
        deferred4_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
}

/**
 * Generate a compact STARK proof for subscriber_ownership.
 * Returns JSON: { commitment: string, proof_hex: string, proof_size: number }
 * @param {bigint} subscriber_secret
 * @returns {string}
 */
export function generate_stark_proof(subscriber_secret) {
    let deferred1_0;
    let deferred1_1;
    try {
        const ret = wasm.generate_stark_proof(subscriber_secret);
        deferred1_0 = ret[0];
        deferred1_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
    }
}

/**
 * Generate a compact STARK proof for a 2-in-2-out shielded transfer.
 * Returns JSON: { circuit_id: 5, nullifier_1, nullifier_2, output_commitment_1, output_commitment_2,
 *                  public_amount, token_mint, proof_hex, proof_size }
 * @param {bigint} spending_key
 * @param {bigint} token_mint
 * @param {bigint} in_amount_1
 * @param {bigint} in_rand_1
 * @param {bigint} in_amount_2
 * @param {bigint} in_rand_2
 * @param {bigint} out_amount_1
 * @param {bigint} out_recipient_1
 * @param {bigint} out_rand_1
 * @param {bigint} out_amount_2
 * @param {bigint} out_recipient_2
 * @param {bigint} out_rand_2
 * @param {bigint} public_amount
 * @returns {string}
 */
export function generate_transfer_stark_proof(spending_key, token_mint, in_amount_1, in_rand_1, in_amount_2, in_rand_2, out_amount_1, out_recipient_1, out_rand_1, out_amount_2, out_recipient_2, out_rand_2, public_amount) {
    let deferred1_0;
    let deferred1_1;
    try {
        const ret = wasm.generate_transfer_stark_proof(spending_key, token_mint, in_amount_1, in_rand_1, in_amount_2, in_rand_2, out_amount_1, out_recipient_1, out_rand_1, out_amount_2, out_recipient_2, out_rand_2, public_amount);
        deferred1_0 = ret[0];
        deferred1_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
    }
}

function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg___wbindgen_is_function_3c846841762788c1: function(arg0) {
            const ret = typeof(arg0) === 'function';
            return ret;
        },
        __wbg___wbindgen_is_object_781bc9f159099513: function(arg0) {
            const val = arg0;
            const ret = typeof(val) === 'object' && val !== null;
            return ret;
        },
        __wbg___wbindgen_is_string_7ef6b97b02428fae: function(arg0) {
            const ret = typeof(arg0) === 'string';
            return ret;
        },
        __wbg___wbindgen_is_undefined_52709e72fb9f179c: function(arg0) {
            const ret = arg0 === undefined;
            return ret;
        },
        __wbg___wbindgen_throw_6ddd609b62940d55: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbg_call_2d781c1f4d5c0ef8: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = arg0.call(arg1, arg2);
            return ret;
        }, arguments); },
        __wbg_crypto_38df2bab126b63dc: function(arg0) {
            const ret = arg0.crypto;
            return ret;
        },
        __wbg_getRandomValues_c44a50d8cfdaebeb: function() { return handleError(function (arg0, arg1) {
            arg0.getRandomValues(arg1);
        }, arguments); },
        __wbg_length_ea16607d7b61445b: function(arg0) {
            const ret = arg0.length;
            return ret;
        },
        __wbg_msCrypto_bd5a034af96bcba6: function(arg0) {
            const ret = arg0.msCrypto;
            return ret;
        },
        __wbg_new_with_length_825018a1616e9e55: function(arg0) {
            const ret = new Uint8Array(arg0 >>> 0);
            return ret;
        },
        __wbg_node_84ea875411254db1: function(arg0) {
            const ret = arg0.node;
            return ret;
        },
        __wbg_process_44c7a14e11e9f69e: function(arg0) {
            const ret = arg0.process;
            return ret;
        },
        __wbg_prototypesetcall_d62e5099504357e6: function(arg0, arg1, arg2) {
            Uint8Array.prototype.set.call(getArrayU8FromWasm0(arg0, arg1), arg2);
        },
        __wbg_randomFillSync_6c25eac9869eb53c: function() { return handleError(function (arg0, arg1) {
            arg0.randomFillSync(arg1);
        }, arguments); },
        __wbg_require_b4edbdcf3e2a1ef0: function() { return handleError(function () {
            const ret = module.require;
            return ret;
        }, arguments); },
        __wbg_static_accessor_GLOBAL_8adb955bd33fac2f: function() {
            const ret = typeof global === 'undefined' ? null : global;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_GLOBAL_THIS_ad356e0db91c7913: function() {
            const ret = typeof globalThis === 'undefined' ? null : globalThis;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_SELF_f207c857566db248: function() {
            const ret = typeof self === 'undefined' ? null : self;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_WINDOW_bb9f1ba69d61b386: function() {
            const ret = typeof window === 'undefined' ? null : window;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_subarray_a068d24e39478a8a: function(arg0, arg1, arg2) {
            const ret = arg0.subarray(arg1 >>> 0, arg2 >>> 0);
            return ret;
        },
        __wbg_versions_276b2795b1c6a219: function(arg0) {
            const ret = arg0.versions;
            return ret;
        },
        __wbindgen_cast_0000000000000001: function(arg0, arg1) {
            // Cast intrinsic for `Ref(Slice(U8)) -> NamedExternref("Uint8Array")`.
            const ret = getArrayU8FromWasm0(arg0, arg1);
            return ret;
        },
        __wbindgen_cast_0000000000000002: function(arg0, arg1) {
            // Cast intrinsic for `Ref(String) -> Externref`.
            const ret = getStringFromWasm0(arg0, arg1);
            return ret;
        },
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            const offset = table.grow(4);
            table.set(0, undefined);
            table.set(offset + 0, undefined);
            table.set(offset + 1, null);
            table.set(offset + 2, true);
            table.set(offset + 3, false);
        },
    };
    return {
        __proto__: null,
        "./p01_stark_bg.js": import0,
    };
}

function addToExternrefTable0(obj) {
    const idx = wasm.__externref_table_alloc();
    wasm.__wbindgen_externrefs.set(idx, obj);
    return idx;
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

function getStringFromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return decodeText(ptr, len);
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function handleError(f, args) {
    try {
        return f.apply(this, args);
    } catch (e) {
        const idx = addToExternrefTable0(e);
        wasm.__wbindgen_exn_store(idx);
    }
}

function isLikeNone(x) {
    return x === undefined || x === null;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasm;
function __wbg_finalize_init(instance, module) {
    wasm = instance.exports;
    wasmModule = module;
    cachedUint8ArrayMemory0 = null;
    wasm.__wbindgen_start();
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = module.ok && expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('p01_stark_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
