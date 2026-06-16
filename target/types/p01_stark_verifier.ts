/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/p01_stark_verifier.json`.
 */
export type P01StarkVerifier = {
  "address": "EXmAQqmkQmq1vnSmKXY2rnUUrrWHqxddjXaJv8aNEL4Z",
  "metadata": {
    "name": "p01StarkVerifier",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Protocol 01 - On-chain STARK proof verifier (quantum-resistant)"
  },
  "instructions": [
    {
      "name": "closeProofBuffer",
      "docs": [
        "Close the proof buffer and return rent to authority."
      ],
      "discriminator": [
        130,
        150,
        6,
        35,
        193,
        34,
        243,
        87
      ],
      "accounts": [
        {
          "name": "proofBuffer",
          "writable": true
        },
        {
          "name": "authority",
          "writable": true,
          "signer": true,
          "relations": [
            "proof_buffer"
          ]
        }
      ],
      "args": []
    },
    {
      "name": "initProofBuffer",
      "docs": [
        "Initialize a proof buffer PDA to hold STARK proof bytes."
      ],
      "discriminator": [
        49,
        27,
        28,
        88,
        19,
        99,
        133,
        194
      ],
      "accounts": [
        {
          "name": "proofBuffer",
          "writable": true
        },
        {
          "name": "authority",
          "writable": true,
          "signer": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "proofSize",
          "type": "u32"
        },
        {
          "name": "circuitId",
          "type": "u8"
        }
      ]
    },
    {
      "name": "resizeProofBuffer",
      "docs": [
        "Resize a proof buffer to accommodate larger proofs (>10KB).",
        "Must be called after init_proof_buffer when proof_size > 10190."
      ],
      "discriminator": [
        187,
        39,
        46,
        173,
        247,
        90,
        178,
        205
      ],
      "accounts": [
        {
          "name": "proofBuffer",
          "writable": true
        },
        {
          "name": "authority",
          "writable": true,
          "signer": true,
          "relations": [
            "proof_buffer"
          ]
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "verifyDeepAliPhase2",
      "docs": [
        "[P2.2a/P2.2e/P2.2g] Phase 2: DEEP-ALI check at OOD for any generic",
        "circuit (3-6). Must run AFTER `verify_stark_proof_v2` has marked",
        "`verified = true` — split into a second instruction because phase 1",
        "(Merkle + FRI + per-query transitions) alone already approaches or",
        "exceeds Solana's 1.4M CU per-instruction cap for width=6 trace=512",
        "and width=10 circuits.",
        "",
        "DEEP-ALI binds the full AIR's transition constraints (10-23 depending",
        "on circuit) to the opened OOD trace via Schwartz–Zippel over a random",
        "z, closing the soundness gap left by trace-aligned-only per-query",
        "checks (only ~24% of blowup-16 query positions land on trace-aligned",
        "rows — without OOD RLC, the prover could fabricate non-honest",
        "transitions on the unopened 76% of rows).",
        "",
        "Public inputs must be supplied again (not stored in the buffer to save",
        "space) and must equal those used in phase 1 — the transcript binding",
        "in `derive_rlc_alpha_with_tag` means any mismatch changes α and fails",
        "the DEEP-ALI identity."
      ],
      "discriminator": [
        217,
        239,
        203,
        65,
        109,
        182,
        70,
        115
      ],
      "accounts": [
        {
          "name": "proofBuffer",
          "writable": true
        },
        {
          "name": "authority",
          "signer": true,
          "relations": [
            "proof_buffer"
          ]
        }
      ],
      "args": [
        {
          "name": "publicInputs",
          "type": {
            "vec": "u64"
          }
        }
      ]
    },
    {
      "name": "verifyMerkleUpdateDeepAli",
      "docs": [
        "[P2.2a/P2.2e] Legacy name for `verify_deep_ali_phase2`, pinned to",
        "circuit 6 for existing clients that already built txs against this",
        "discriminator. New code should use `verify_deep_ali_phase2`."
      ],
      "discriminator": [
        32,
        153,
        189,
        232,
        187,
        32,
        161,
        142
      ],
      "accounts": [
        {
          "name": "proofBuffer",
          "writable": true
        },
        {
          "name": "authority",
          "signer": true,
          "relations": [
            "proof_buffer"
          ]
        }
      ],
      "args": [
        {
          "name": "publicInputs",
          "type": {
            "vec": "u64"
          }
        }
      ]
    },
    {
      "name": "verifyStarkProof",
      "docs": [
        "Verify the STARK proof stored in the buffer.",
        "",
        "For circuit 0 (subscriber_ownership): public_inputs = [commitment]",
        "For circuit 1 (pool_commitment): public_inputs = [nullifier, commitment]",
        "For circuit 2 (balance_proof): public_inputs = [commitment, token_mint]",
        "For circuit 3 (merkle_path): public_inputs = [leaf, root]"
      ],
      "discriminator": [
        208,
        216,
        183,
        38,
        47,
        69,
        156,
        138
      ],
      "accounts": [
        {
          "name": "proofBuffer",
          "writable": true
        },
        {
          "name": "authority",
          "signer": true,
          "relations": [
            "proof_buffer"
          ]
        }
      ],
      "args": [
        {
          "name": "commitment",
          "type": "u64"
        }
      ]
    },
    {
      "name": "verifyStarkProofV2",
      "docs": [
        "Verify a STARK proof with multiple public inputs.",
        "",
        "Used for circuits that need more than one public input value."
      ],
      "discriminator": [
        149,
        18,
        96,
        15,
        144,
        68,
        8,
        233
      ],
      "accounts": [
        {
          "name": "proofBuffer",
          "writable": true
        },
        {
          "name": "authority",
          "signer": true,
          "relations": [
            "proof_buffer"
          ]
        }
      ],
      "args": [
        {
          "name": "publicInputs",
          "type": {
            "vec": "u64"
          }
        }
      ]
    },
    {
      "name": "writeProofChunk",
      "docs": [
        "Write a chunk of proof bytes to the buffer."
      ],
      "discriminator": [
        183,
        3,
        171,
        138,
        153,
        138,
        133,
        147
      ],
      "accounts": [
        {
          "name": "proofBuffer",
          "writable": true
        },
        {
          "name": "authority",
          "signer": true,
          "relations": [
            "proof_buffer"
          ]
        }
      ],
      "args": [
        {
          "name": "offset",
          "type": "u32"
        },
        {
          "name": "data",
          "type": "bytes"
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "proofBuffer",
      "discriminator": [
        71,
        133,
        225,
        94,
        9,
        130,
        40,
        161
      ]
    }
  ],
  "types": [
    {
      "name": "proofBuffer",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "authority",
            "type": "pubkey"
          },
          {
            "name": "circuitId",
            "type": "u8"
          },
          {
            "name": "proofSize",
            "type": "u32"
          },
          {
            "name": "bytesWritten",
            "type": "u32"
          },
          {
            "name": "verified",
            "type": "bool"
          },
          {
            "name": "publicInputsHash",
            "docs": [
              "Blake3 hash of the verified public inputs.",
              "Set after successful verification so consumers can confirm",
              "which inputs were actually proven."
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "deepAliVerified",
            "docs": [
              "[P2.2a] Phase-2 DEEP-ALI verification flag. For circuits that need a",
              "separate DEEP-ALI instruction (currently circuit 6 only) this is",
              "advanced by `verify_merkle_update_deep_ali` after phase 1 has marked",
              "`verified = true`. Consumers (zk_shielded, etc.) must require both",
              "`verified` and `deep_ali_verified` for circuit 6 proofs."
            ],
            "type": "bool"
          }
        ]
      }
    }
  ],
  "constants": [],
  "events": [],
  "errors": [
    {
      "code": 6000,
      "name": "alreadyVerified",
      "msg": "Proof has already been verified"
    },
    {
      "code": 6001,
      "name": "chunkOutOfBounds",
      "msg": "Proof chunk exceeds buffer bounds"
    },
    {
      "code": 6002,
      "name": "incompleteProof",
      "msg": "Proof upload incomplete"
    },
    {
      "code": 6003,
      "name": "invalidProof",
      "msg": "Invalid proof: verification failed"
    },
    {
      "code": 6004,
      "name": "deserializationError",
      "msg": "Failed to deserialize proof bytes"
    },
    {
      "code": 6005,
      "name": "unsupportedCircuit",
      "msg": "Unsupported circuit ID"
    },
    {
      "code": 6006,
      "name": "notYetVerified",
      "msg": "Proof has not been verified yet"
    }
  ]
};
