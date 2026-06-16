/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/p01_quantum_vault.json`.
 */
export type P01QuantumVault = {
  "address": "9yVr79XkwGabckVxedz4UH78twzkgmGqXHBAX7vfJvYv",
  "metadata": {
    "name": "p01QuantumVault",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Protocol 01 - Quantum-safe vault with Winternitz OTS, hash-timelock, and commit-reveal"
  },
  "instructions": [
    {
      "name": "closeWotsSigBuffer",
      "docs": [
        "Close the WOTS+ signature buffer and return rent to the authority.",
        "Callable regardless of whether the signature was consumed — always safe."
      ],
      "discriminator": [
        41,
        239,
        239,
        217,
        202,
        163,
        219,
        203
      ],
      "accounts": [
        {
          "name": "authority",
          "writable": true,
          "signer": true,
          "relations": [
            "buffer"
          ]
        },
        {
          "name": "buffer",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  119,
                  111,
                  116,
                  115,
                  95,
                  115,
                  105,
                  103
                ]
              },
              {
                "kind": "account",
                "path": "buffer.vault",
                "account": "WotsSigBuffer"
              },
              {
                "kind": "account",
                "path": "authority"
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "createCommitment",
      "docs": [
        "Create a commitment (phase 1 of commit-then-reveal)."
      ],
      "discriminator": [
        232,
        31,
        118,
        65,
        229,
        2,
        2,
        170
      ],
      "accounts": [
        {
          "name": "committer",
          "writable": true,
          "signer": true
        },
        {
          "name": "record",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  109,
                  109,
                  105,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "committer"
              },
              {
                "kind": "arg",
                "path": "commitment"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "commitment",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "actionType",
          "type": "u8"
        },
        {
          "name": "revealWindow",
          "type": "u64"
        }
      ]
    },
    {
      "name": "depositHashVault",
      "docs": [
        "Deposit SOL into a hash-timelock vault."
      ],
      "discriminator": [
        48,
        69,
        93,
        141,
        148,
        158,
        252,
        209
      ],
      "accounts": [
        {
          "name": "owner",
          "writable": true,
          "signer": true,
          "relations": [
            "vault"
          ]
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  104,
                  97,
                  115,
                  104,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    },
    {
      "name": "depositWinternitz",
      "docs": [
        "Deposit SOL into a Winternitz vault."
      ],
      "discriminator": [
        246,
        162,
        178,
        171,
        104,
        84,
        195,
        172
      ],
      "accounts": [
        {
          "name": "owner",
          "writable": true,
          "signer": true,
          "relations": [
            "vault"
          ]
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  119,
                  111,
                  116,
                  115,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    },
    {
      "name": "initHashVault",
      "docs": [
        "Initialize a hash-timelock vault for quantum-safe cold storage."
      ],
      "discriminator": [
        81,
        241,
        24,
        231,
        95,
        134,
        233,
        28
      ],
      "accounts": [
        {
          "name": "owner",
          "writable": true,
          "signer": true
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  104,
                  97,
                  115,
                  104,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "commitment",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "unlockAfter",
          "type": "i64"
        },
        {
          "name": "destination",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "initWinternitzVault",
      "docs": [
        "Initialize a Winternitz OTS vault with a WOTS+ public key hash."
      ],
      "discriminator": [
        84,
        65,
        164,
        119,
        110,
        24,
        48,
        11
      ],
      "accounts": [
        {
          "name": "owner",
          "writable": true,
          "signer": true
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  119,
                  111,
                  116,
                  115,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "wotsPubkeyHash",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        }
      ]
    },
    {
      "name": "initWotsSigBuffer",
      "docs": [
        "Initialize a WOTS+ signature buffer PDA.",
        "",
        "The signature (2144 bytes) is too large to fit in a single Solana",
        "transaction's instruction data (1232-byte legacy cap, 1644-byte v0 cap),",
        "so the caller uploads it in chunks via `write_wots_sig_chunk` before",
        "invoking `withdraw_winternitz`. Seeds `[b\"wots_sig\", vault, authority]`",
        "mean each (vault, signer) pair has at most one pending buffer."
      ],
      "discriminator": [
        11,
        189,
        68,
        168,
        125,
        201,
        114,
        168
      ],
      "accounts": [
        {
          "name": "authority",
          "writable": true,
          "signer": true
        },
        {
          "name": "vault",
          "docs": [
            "Target vault. The buffer is bound to a specific (vault, authority) pair",
            "so signatures uploaded here can only withdraw from this vault."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  119,
                  111,
                  116,
                  115,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "vault.owner",
                "account": "WinternitzVault"
              }
            ]
          }
        },
        {
          "name": "buffer",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  119,
                  111,
                  116,
                  115,
                  95,
                  115,
                  105,
                  103
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              },
              {
                "kind": "account",
                "path": "authority"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "sigSize",
          "type": "u32"
        }
      ]
    },
    {
      "name": "revealCommitment",
      "docs": [
        "Reveal a previously committed action (phase 2 of commit-then-reveal)."
      ],
      "discriminator": [
        200,
        115,
        125,
        155,
        74,
        165,
        227,
        150
      ],
      "accounts": [
        {
          "name": "committer",
          "writable": true,
          "signer": true,
          "relations": [
            "record"
          ]
        },
        {
          "name": "record",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  109,
                  109,
                  105,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "committer"
              },
              {
                "kind": "account",
                "path": "record.commitment",
                "account": "CommitRecord"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "actionData",
          "type": "bytes"
        },
        {
          "name": "nonce",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        }
      ]
    },
    {
      "name": "withdrawHashVault",
      "docs": [
        "Withdraw from a hash-timelock vault by revealing the SHA-256 preimage.",
        "Anyone with the preimage can call this — Ed25519 is NOT the security boundary."
      ],
      "discriminator": [
        199,
        138,
        87,
        71,
        48,
        192,
        59,
        35
      ],
      "accounts": [
        {
          "name": "signer",
          "docs": [
            "Signer pays TX fee. NOT the security boundary — preimage is."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  104,
                  97,
                  115,
                  104,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "vault.owner",
                "account": "HashVault"
              }
            ]
          }
        },
        {
          "name": "destination",
          "writable": true
        }
      ],
      "args": [
        {
          "name": "preimage",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    },
    {
      "name": "withdrawWinternitz",
      "docs": [
        "Withdraw from a Winternitz vault using a WOTS+ one-time signature",
        "previously uploaded into a `WotsSigBuffer`.",
        "",
        "Flow:",
        "1. `init_wots_sig_buffer(WOTS_SIG_SIZE)` — create PDA buffer.",
        "2. `write_wots_sig_chunk` × N — upload 2144 bytes (typically 3 chunks).",
        "3. `withdraw_winternitz(amount, next_wots_pubkey_hash)` — verify + transfer.",
        "4. `close_wots_sig_buffer` — rent refund.",
        "",
        "Signature layout: 67 hash-chain values (2144 bytes) = 64 message + 3 checksum.",
        "For each nibble m_i, signer provides `hash^(15-m_i)(secret_i)`.",
        "The program walks each chain `m_i` more hash steps, which yields the",
        "pubkey chain endpoint — streaming these into SHA-256 gives the pubkey",
        "hash, which must equal the stored `vault.wots_pubkey_hash`.",
        "",
        "Checksum encoding: `sum(15 - m_i)` for i in 0..64, MSB-first as 3 nibbles.",
        "Without the checksum, an attacker can forge a signature for any message",
        "whose nibbles are all <= the legitimate message's nibbles — the checksum",
        "forces at least one checksum nibble to DECREASE when any message nibble",
        "decreases, and decreasing a chain requires knowing the secret.",
        "",
        "After withdrawal, the vault's pubkey rotates to `next_wots_pubkey_hash`."
      ],
      "discriminator": [
        194,
        12,
        4,
        198,
        227,
        129,
        145,
        239
      ],
      "accounts": [
        {
          "name": "owner",
          "writable": true,
          "signer": true,
          "relations": [
            "vault"
          ]
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  119,
                  111,
                  116,
                  115,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              }
            ]
          }
        },
        {
          "name": "sigBuffer",
          "docs": [
            "Buffer holding the uploaded WOTS+ signature.",
            "`has_one = authority` binds the buffer to the owner; the separate",
            "`buffer.vault == vault.key()` check inside the handler binds it to",
            "this specific vault."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  119,
                  111,
                  116,
                  115,
                  95,
                  115,
                  105,
                  103
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              },
              {
                "kind": "account",
                "path": "owner"
              }
            ]
          }
        },
        {
          "name": "destination",
          "docs": [
            "(SHA-256(amount || destination || withdrawal_count)), so the WOTS+",
            "signature only verifies for the destination encoded at signing time."
          ],
          "writable": true
        },
        {
          "name": "authority",
          "docs": [
            "Must equal the buffer's authority (= owner for PDA bind)."
          ],
          "signer": true,
          "relations": [
            "sig_buffer"
          ]
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        },
        {
          "name": "nextWotsPubkeyHash",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        }
      ]
    },
    {
      "name": "writeWotsSigChunk",
      "docs": [
        "Write a chunk of signature bytes to the buffer at the given offset.",
        "Uses raw account-data writes (not struct reserialization) to keep",
        "per-chunk CU cost bounded independent of total signature size."
      ],
      "discriminator": [
        230,
        154,
        113,
        234,
        188,
        154,
        90,
        111
      ],
      "accounts": [
        {
          "name": "authority",
          "signer": true,
          "relations": [
            "buffer"
          ]
        },
        {
          "name": "buffer",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  119,
                  111,
                  116,
                  115,
                  95,
                  115,
                  105,
                  103
                ]
              },
              {
                "kind": "account",
                "path": "buffer.vault",
                "account": "WotsSigBuffer"
              },
              {
                "kind": "account",
                "path": "authority"
              }
            ]
          }
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
      "name": "commitRecord",
      "discriminator": [
        80,
        209,
        175,
        51,
        87,
        253,
        14,
        115
      ]
    },
    {
      "name": "hashVault",
      "discriminator": [
        163,
        110,
        78,
        15,
        245,
        178,
        99,
        67
      ]
    },
    {
      "name": "winternitzVault",
      "discriminator": [
        138,
        42,
        139,
        53,
        165,
        81,
        233,
        145
      ]
    },
    {
      "name": "wotsSigBuffer",
      "discriminator": [
        122,
        148,
        245,
        198,
        142,
        112,
        155,
        45
      ]
    }
  ],
  "types": [
    {
      "name": "commitRecord",
      "docs": [
        "Commit-then-reveal record for quantum-safe transaction authorization",
        "",
        "Two-phase protocol:",
        "1. COMMIT: User submits H(action || nonce) on-chain",
        "2. REVEAL: User reveals action + nonce, program verifies hash match",
        "",
        "A quantum attacker who breaks Ed25519 from the COMMIT tx signature",
        "still cannot forge the committed hash (SHA-256 preimage resistance).",
        "They cannot submit a competing action because the hash is already on-chain."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "committer",
            "docs": [
              "Who made the commitment"
            ],
            "type": "pubkey"
          },
          {
            "name": "commitment",
            "docs": [
              "SHA-256(action_data || nonce)"
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "commitSlot",
            "docs": [
              "Slot at which the commitment was made"
            ],
            "type": "u64"
          },
          {
            "name": "minRevealDelay",
            "docs": [
              "Minimum slots to wait before reveal (prevents same-slot front-running)"
            ],
            "type": "u64"
          },
          {
            "name": "maxRevealWindow",
            "docs": [
              "Maximum slots before commitment expires (prevents stale commitments)"
            ],
            "type": "u64"
          },
          {
            "name": "revealed",
            "docs": [
              "Whether this commitment has been revealed/consumed"
            ],
            "type": "bool"
          },
          {
            "name": "actionType",
            "docs": [
              "The action type (0=transfer, 1=unshield, 2=claim)"
            ],
            "type": "u8"
          },
          {
            "name": "bump",
            "docs": [
              "Bump seed for PDA"
            ],
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "hashVault",
      "docs": [
        "Hash-Timelock Vault for quantum-safe cold storage",
        "",
        "Funds are locked behind a SHA-256 preimage challenge with an optional",
        "timelock. Even if Ed25519 is broken by a quantum computer, an attacker",
        "cannot withdraw without knowing the preimage.",
        "",
        "Security: SHA-256 preimage resistance = 128-bit under Grover's algorithm"
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "owner",
            "docs": [
              "Owner who created the vault (for depositing more funds)"
            ],
            "type": "pubkey"
          },
          {
            "name": "commitment",
            "docs": [
              "SHA-256(secret) — the commitment"
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "balance",
            "docs": [
              "Lamports balance held in vault"
            ],
            "type": "u64"
          },
          {
            "name": "unlockAfter",
            "docs": [
              "Unix timestamp after which withdrawal is allowed (0 = no timelock)"
            ],
            "type": "i64"
          },
          {
            "name": "destination",
            "docs": [
              "Destination wallet for withdrawals"
            ],
            "type": "pubkey"
          },
          {
            "name": "drained",
            "docs": [
              "Whether the vault has been drained"
            ],
            "type": "bool"
          },
          {
            "name": "bump",
            "docs": [
              "Bump seed for PDA"
            ],
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "winternitzVault",
      "docs": [
        "Winternitz One-Time Signature (WOTS+) Vault",
        "",
        "Quantum-safe fund protection using hash-based one-time signatures.",
        "Each withdrawal requires a valid WOTS+ signature that a quantum",
        "attacker cannot forge (relies only on SHA-256 preimage resistance).",
        "",
        "Design (unified 67-chain spec, full 256-bit post-quantum security):",
        "- 64 message hash chains + 3 checksum hash chains = 67 total",
        "- Winternitz parameter w=16 (4 bits per chain)",
        "- Each chain: hash 0..15 steps of a secret value",
        "- Public key = hash^15(secret_i) for each chain i",
        "- Signature = hash^(15-m_i)(secret_i) where m_i = nibble i",
        "- Verification: hash^(m_i)(sig_i) == pk_i for all 67 chains",
        "- Checksum = sum(15 - m_i) for i in 0..64, encoded MSB-first as 3 nibbles",
        "",
        "Security: ~256-bit classical (SHA-256 preimage over full 32-byte digest),",
        "~128-bit quantum (Grover on SHA-256). Checksum prevents forgery via",
        "nibble-decrease attack."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "owner",
            "docs": [
              "Owner who can deposit (Ed25519 key, for convenience only)"
            ],
            "type": "pubkey"
          },
          {
            "name": "wotsPubkeyHash",
            "docs": [
              "Current WOTS+ public key root (SHA-256 of all 67 chain endpoints concatenated)"
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "balance",
            "docs": [
              "Lamports balance held in vault"
            ],
            "type": "u64"
          },
          {
            "name": "withdrawalCount",
            "docs": [
              "Number of withdrawals (each consumes a WOTS+ key)"
            ],
            "type": "u64"
          },
          {
            "name": "createdAt",
            "docs": [
              "Vault creation timestamp"
            ],
            "type": "i64"
          },
          {
            "name": "frozen",
            "docs": [
              "Whether the vault is frozen (emergency lockdown)"
            ],
            "type": "bool"
          },
          {
            "name": "bump",
            "docs": [
              "Bump seed for PDA"
            ],
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "wotsSigBuffer",
      "docs": [
        "Buffer account that holds a pending WOTS+ signature uploaded in chunks.",
        "",
        "A single WOTS+ signature is 2144 bytes, which exceeds Solana's 1232-byte",
        "legacy TX cap and the 1644-byte v0 versioned TX cap — the signature",
        "cannot be passed inline in a single withdrawal instruction. Instead, the",
        "authority initializes this buffer, writes the 2144-byte signature in",
        "multiple chunks (typically 3 × ~900 bytes), then invokes the withdrawal",
        "instruction which reads from the buffer and reconstructs the pubkey by",
        "walking each chain `(15 - m_i)` more hash steps.",
        "",
        "The buffer is PDA-seeded by `[b\"wots_sig\", vault, authority]` so each",
        "(vault, signer) pair has at most one pending buffer. The authority must",
        "close the buffer (via `close_wots_sig_buffer`) after use to recover rent."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "authority",
            "docs": [
              "Who initialized the buffer and who must sign the withdrawal."
            ],
            "type": "pubkey"
          },
          {
            "name": "vault",
            "docs": [
              "Which Winternitz vault this signature targets. Binding here prevents",
              "a buffer from being diverted to verify against a different vault's",
              "stored pubkey hash."
            ],
            "type": "pubkey"
          },
          {
            "name": "sigSize",
            "docs": [
              "Expected total signature size (always WOTS_SIG_SIZE = 2144)."
            ],
            "type": "u32"
          },
          {
            "name": "bytesWritten",
            "docs": [
              "Running high-water-mark of bytes written so far."
            ],
            "type": "u32"
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
      "name": "zeroAmount",
      "msg": "Amount must be greater than zero"
    },
    {
      "code": 6001,
      "name": "vaultFrozen",
      "msg": "Vault is frozen"
    },
    {
      "code": 6002,
      "name": "overflow",
      "msg": "Arithmetic overflow"
    },
    {
      "code": 6003,
      "name": "invalidWotsSignature",
      "msg": "Invalid WOTS+ signature"
    },
    {
      "code": 6004,
      "name": "wotsPubkeyMismatch",
      "msg": "WOTS+ public key mismatch"
    },
    {
      "code": 6005,
      "name": "preimageMismatch",
      "msg": "Hash preimage does not match commitment"
    },
    {
      "code": 6006,
      "name": "timelockActive",
      "msg": "Timelock has not expired"
    },
    {
      "code": 6007,
      "name": "alreadyDrained",
      "msg": "Vault already drained"
    },
    {
      "code": 6008,
      "name": "insufficientBalance",
      "msg": "Insufficient vault balance"
    },
    {
      "code": 6009,
      "name": "alreadyRevealed",
      "msg": "Commitment already revealed"
    },
    {
      "code": 6010,
      "name": "commitmentExpired",
      "msg": "Commitment expired"
    },
    {
      "code": 6011,
      "name": "revealTooEarly",
      "msg": "Reveal too early"
    },
    {
      "code": 6012,
      "name": "invalidRevealWindow",
      "msg": "Invalid reveal window"
    },
    {
      "code": 6013,
      "name": "commitmentMismatch",
      "msg": "Commitment hash mismatch"
    },
    {
      "code": 6014,
      "name": "insufficientFundsForRent",
      "msg": "Withdrawal would leave vault below rent-exempt minimum"
    },
    {
      "code": 6015,
      "name": "mustWithdrawFullBalance",
      "msg": "Hash vault requires full withdrawal (amount must equal balance)"
    },
    {
      "code": 6016,
      "name": "chunkOutOfBounds",
      "msg": "WOTS+ signature buffer chunk exceeds declared sig_size"
    },
    {
      "code": 6017,
      "name": "incompleteWotsSignature",
      "msg": "WOTS+ signature buffer has not been fully populated"
    },
    {
      "code": 6018,
      "name": "wotsBufferVaultMismatch",
      "msg": "WOTS+ signature buffer is bound to a different vault"
    }
  ]
};
