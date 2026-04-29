let wasm_bindgen = (function(exports) {
    let script_src;
    if (typeof document !== 'undefined' && document.currentScript !== null) {
        script_src = new URL(document.currentScript.src, location.href).toString();
    }

    /**
     * Compute the Poseidon commitment for a secret (without generating a proof).
     * @param {bigint} subscriber_secret
     * @returns {string}
     */
    function compute_stark_commitment(subscriber_secret) {
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
    exports.compute_stark_commitment = compute_stark_commitment;

    /**
     * Generate a compact STARK proof for balance commitment.
     * Returns JSON: { circuit_id: 2, commitment: string, token_mint: string, proof_hex: string, proof_size: number }
     * @param {bigint} spending_key
     * @param {bigint} balance
     * @param {bigint} salt
     * @param {bigint} token_mint
     * @returns {string}
     */
    function generate_balance_stark_proof(spending_key, balance, salt, token_mint) {
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
    exports.generate_balance_stark_proof = generate_balance_stark_proof;

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
    function generate_confidential_balance_stark_proof(spending_key, old_balance, old_salt, new_balance, new_salt, amount, amount_salt, token_mint) {
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
    exports.generate_confidential_balance_stark_proof = generate_confidential_balance_stark_proof;

    /**
     * Generate a compact STARK proof for Merkle path inclusion.
     * path_elements and path_indices are comma-separated strings.
     * Returns JSON: { circuit_id: 3, leaf: string, root: string, proof_hex: string, proof_size: number }
     * @param {bigint} leaf
     * @param {string} path_elements_csv
     * @param {string} path_indices_csv
     * @returns {string}
     */
    function generate_merkle_path_stark_proof(leaf, path_elements_csv, path_indices_csv) {
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
    exports.generate_merkle_path_stark_proof = generate_merkle_path_stark_proof;

    /**
     * Generate a compact STARK proof for denominated pool commitment.
     * Returns JSON: { circuit_id: 1, nullifier: string, commitment: string, proof_hex: string, proof_size: number }
     * @param {bigint} nullifier_preimage
     * @param {bigint} secret
     * @param {bigint} deposit_epoch
     * @param {bigint} token_mint
     * @returns {string}
     */
    function generate_pool_commitment_stark_proof(nullifier_preimage, secret, deposit_epoch, token_mint) {
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
    exports.generate_pool_commitment_stark_proof = generate_pool_commitment_stark_proof;

    /**
     * Generate a compact STARK proof for subscriber_ownership.
     * Returns JSON: { commitment: string, proof_hex: string, proof_size: number }
     * @param {bigint} subscriber_secret
     * @returns {string}
     */
    function generate_stark_proof(subscriber_secret) {
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
    exports.generate_stark_proof = generate_stark_proof;

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
    function generate_transfer_stark_proof(spending_key, token_mint, in_amount_1, in_rand_1, in_amount_2, in_rand_2, out_amount_1, out_recipient_1, out_rand_1, out_amount_2, out_recipient_2, out_rand_2, public_amount) {
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
    exports.generate_transfer_stark_proof = generate_transfer_stark_proof;

    function __wbg_get_imports() {
        const import0 = {
            __proto__: null,
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
    function decodeText(ptr, len) {
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

        if (module_or_path === undefined && script_src !== undefined) {
            module_or_path = script_src.replace(/\.js$/, "_bg.wasm");
        }
        const imports = __wbg_get_imports();

        if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
            module_or_path = fetch(module_or_path);
        }

        const { instance, module } = await __wbg_load(await module_or_path, imports);

        return __wbg_finalize_init(instance, module);
    }

    return Object.assign(__wbg_init, { initSync }, exports);
})({ __proto__: null });
