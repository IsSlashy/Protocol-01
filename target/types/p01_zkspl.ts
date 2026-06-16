/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/p01_zkspl.json`.
 */
export type P01Zkspl = {
  "address": "AY38smtdsnhmfMCzmnDEefiKCeRTkEPrFXHydAF2FuCT",
  "metadata": {
    "name": "p01Zkspl",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Protocol 01 - zkSPL Confidential Token Balances"
  },
  "instructions": [
    {
      "name": "addViewer",
      "docs": [
        "Add a viewing key (opt-in compliance)."
      ],
      "discriminator": [
        217,
        242,
        179,
        50,
        144,
        27,
        234,
        61
      ],
      "accounts": [
        {
          "name": "owner",
          "signer": true
        },
        {
          "name": "mintConfig",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  122,
                  107,
                  115,
                  112,
                  108,
                  95,
                  109,
                  105,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "mint_config.token_mint",
                "account": "MintConfig"
              }
            ]
          }
        },
        {
          "name": "confidentialAccount",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  122,
                  107,
                  115,
                  112,
                  108,
                  95,
                  97,
                  99,
                  99,
                  111,
                  117,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              },
              {
                "kind": "account",
                "path": "mint_config.token_mint",
                "account": "MintConfig"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "viewer",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "applyPending",
      "docs": [
        "Apply a pending credit to update recipient's balance.",
        "Recipient proves they correctly integrated the amount."
      ],
      "discriminator": [
        88,
        86,
        232,
        48,
        42,
        150,
        180,
        196
      ],
      "accounts": [
        {
          "name": "recipient",
          "docs": [
            "Recipient (account owner)"
          ],
          "signer": true
        },
        {
          "name": "mintConfig",
          "docs": [
            "Mint config"
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  122,
                  107,
                  115,
                  112,
                  108,
                  95,
                  109,
                  105,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "mint_config.token_mint",
                "account": "MintConfig"
              }
            ]
          }
        },
        {
          "name": "confidentialAccount",
          "docs": [
            "Recipient's confidential account"
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  122,
                  107,
                  115,
                  112,
                  108,
                  95,
                  97,
                  99,
                  99,
                  111,
                  117,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "recipient"
              },
              {
                "kind": "account",
                "path": "mint_config.token_mint",
                "account": "MintConfig"
              }
            ]
          }
        },
        {
          "name": "vkData",
          "docs": [
            "Verification key data"
          ]
        }
      ],
      "args": [
        {
          "name": "proof",
          "type": {
            "defined": {
              "name": "groth16Proof"
            }
          }
        },
        {
          "name": "newCommitment",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "amountHash",
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
      "name": "confidentialTransfer",
      "docs": [
        "Private transfer between two confidential accounts.",
        "Amount is hidden — only amount_hash is stored on-chain.",
        "Creates a pending credit for the recipient."
      ],
      "discriminator": [
        97,
        79,
        128,
        58,
        134,
        222,
        73,
        143
      ],
      "accounts": [
        {
          "name": "sender",
          "docs": [
            "Sender"
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "mintConfig",
          "docs": [
            "Mint config"
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  122,
                  107,
                  115,
                  112,
                  108,
                  95,
                  109,
                  105,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "mint_config.token_mint",
                "account": "MintConfig"
              }
            ]
          }
        },
        {
          "name": "senderAccount",
          "docs": [
            "Sender's confidential account"
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  122,
                  107,
                  115,
                  112,
                  108,
                  95,
                  97,
                  99,
                  99,
                  111,
                  117,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "sender"
              },
              {
                "kind": "account",
                "path": "mint_config.token_mint",
                "account": "MintConfig"
              }
            ]
          }
        },
        {
          "name": "recipientAccount",
          "docs": [
            "Recipient's confidential account"
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  122,
                  107,
                  115,
                  112,
                  108,
                  95,
                  97,
                  99,
                  99,
                  111,
                  117,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "recipient_account.owner",
                "account": "ConfidentialAccount"
              },
              {
                "kind": "account",
                "path": "mint_config.token_mint",
                "account": "MintConfig"
              }
            ]
          }
        },
        {
          "name": "vkData",
          "docs": [
            "Verification key data"
          ]
        }
      ],
      "args": [
        {
          "name": "proof",
          "type": {
            "defined": {
              "name": "groth16Proof"
            }
          }
        },
        {
          "name": "newCommitment",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "amountHash",
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
      "name": "createAccount",
      "docs": [
        "Create a confidential account for a (user, token) pair.",
        "Initial commitment = Poseidon(0, salt, owner_pubkey, mint)."
      ],
      "discriminator": [
        99,
        20,
        130,
        119,
        196,
        235,
        131,
        149
      ],
      "accounts": [
        {
          "name": "owner",
          "docs": [
            "The wallet owner"
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "mintConfig",
          "docs": [
            "The mint config (must be active)"
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  122,
                  107,
                  115,
                  112,
                  108,
                  95,
                  109,
                  105,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "mint_config.token_mint",
                "account": "MintConfig"
              }
            ]
          }
        },
        {
          "name": "confidentialAccount",
          "docs": [
            "The confidential account PDA — one per (owner, mint) pair"
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  122,
                  107,
                  115,
                  112,
                  108,
                  95,
                  97,
                  99,
                  99,
                  111,
                  117,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              },
              {
                "kind": "account",
                "path": "mint_config.token_mint",
                "account": "MintConfig"
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
          "name": "initialCommitment",
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
      "name": "deposit",
      "docs": [
        "Deposit SPL tokens into a confidential account.",
        "Amount is public. ZK proof verifies correct commitment update."
      ],
      "discriminator": [
        242,
        35,
        198,
        137,
        82,
        225,
        242,
        182
      ],
      "accounts": [
        {
          "name": "depositor",
          "docs": [
            "User depositing tokens"
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "mintConfig",
          "docs": [
            "The mint config"
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  122,
                  107,
                  115,
                  112,
                  108,
                  95,
                  109,
                  105,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "mint_config.token_mint",
                "account": "MintConfig"
              }
            ]
          }
        },
        {
          "name": "confidentialAccount",
          "docs": [
            "User's confidential account"
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  122,
                  107,
                  115,
                  112,
                  108,
                  95,
                  97,
                  99,
                  99,
                  111,
                  117,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "depositor"
              },
              {
                "kind": "account",
                "path": "mint_config.token_mint",
                "account": "MintConfig"
              }
            ]
          }
        },
        {
          "name": "vkData",
          "docs": [
            "Verification key data account (stores the binary VK for on-chain verification)"
          ]
        },
        {
          "name": "vault",
          "docs": [
            "Pool vault that holds deposited tokens (PDA seeded by mint)"
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  122,
                  107,
                  115,
                  112,
                  108,
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
                "path": "mint_config.token_mint",
                "account": "MintConfig"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "tokenProgram",
          "docs": [
            "Optional: Token program for SPL tokens"
          ],
          "optional": true,
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "userTokenAccount",
          "docs": [
            "Optional: User's token account (for SPL tokens)"
          ],
          "writable": true,
          "optional": true
        },
        {
          "name": "poolVault",
          "docs": [
            "Optional: Pool vault token account (for SPL tokens)"
          ],
          "writable": true,
          "optional": true
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        },
        {
          "name": "proof",
          "type": {
            "defined": {
              "name": "groth16Proof"
            }
          }
        },
        {
          "name": "newCommitment",
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
      "name": "initVkData",
      "docs": [
        "Initialize VK data storage account.",
        "vk_type: 0 = balance circuit VK, 1 = proof circuit VK"
      ],
      "discriminator": [
        192,
        55,
        242,
        142,
        213,
        184,
        203,
        94
      ],
      "accounts": [
        {
          "name": "authority",
          "writable": true,
          "signer": true
        },
        {
          "name": "mintConfig",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  122,
                  107,
                  115,
                  112,
                  108,
                  95,
                  109,
                  105,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "mint_config.token_mint",
                "account": "MintConfig"
              }
            ]
          }
        },
        {
          "name": "vkData",
          "docs": [
            "VK data PDA — stores raw verification key bytes",
            "vk_type: 0 = balance VK, 1 = proof VK"
          ],
          "writable": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "vkType",
          "type": "u8"
        },
        {
          "name": "vkSize",
          "type": "u32"
        }
      ]
    },
    {
      "name": "initializeMint",
      "docs": [
        "Register an SPL token for zkSPL confidential operations.",
        "Creates a MintConfig PDA with verification key hashes."
      ],
      "discriminator": [
        209,
        42,
        195,
        4,
        129,
        85,
        209,
        44
      ],
      "accounts": [
        {
          "name": "authority",
          "docs": [
            "Authority paying for account creation"
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "tokenMint",
          "docs": [
            "The SPL token mint to enable for zkSPL"
          ]
        },
        {
          "name": "mintConfig",
          "docs": [
            "MintConfig PDA — one per token mint"
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  122,
                  107,
                  115,
                  112,
                  108,
                  95,
                  109,
                  105,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "token_mint"
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
          "name": "balanceVkHash",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "proofVkHash",
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
      "name": "proveBalance",
      "docs": [
        "Prove balance >= threshold without revealing the actual balance.",
        "For DeFi composability (DEXes, lending, etc.)."
      ],
      "discriminator": [
        168,
        126,
        148,
        46,
        16,
        58,
        26,
        202
      ],
      "accounts": [
        {
          "name": "prover",
          "docs": [
            "Account owner proving their balance"
          ],
          "signer": true
        },
        {
          "name": "mintConfig",
          "docs": [
            "Mint config (for proof VK hash)"
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  122,
                  107,
                  115,
                  112,
                  108,
                  95,
                  109,
                  105,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "mint_config.token_mint",
                "account": "MintConfig"
              }
            ]
          }
        },
        {
          "name": "confidentialAccount",
          "docs": [
            "The confidential account"
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  122,
                  107,
                  115,
                  112,
                  108,
                  95,
                  97,
                  99,
                  99,
                  111,
                  117,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "prover"
              },
              {
                "kind": "account",
                "path": "mint_config.token_mint",
                "account": "MintConfig"
              }
            ]
          }
        },
        {
          "name": "vkData",
          "docs": [
            "Balance proof verification key data"
          ]
        }
      ],
      "args": [
        {
          "name": "threshold",
          "type": "u64"
        },
        {
          "name": "proof",
          "type": {
            "defined": {
              "name": "groth16Proof"
            }
          }
        }
      ]
    },
    {
      "name": "removeViewer",
      "docs": [
        "Remove a viewing key."
      ],
      "discriminator": [
        18,
        20,
        123,
        71,
        72,
        104,
        161,
        170
      ],
      "accounts": [
        {
          "name": "owner",
          "signer": true
        },
        {
          "name": "mintConfig",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  122,
                  107,
                  115,
                  112,
                  108,
                  95,
                  109,
                  105,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "mint_config.token_mint",
                "account": "MintConfig"
              }
            ]
          }
        },
        {
          "name": "confidentialAccount",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  122,
                  107,
                  115,
                  112,
                  108,
                  95,
                  97,
                  99,
                  99,
                  111,
                  117,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              },
              {
                "kind": "account",
                "path": "mint_config.token_mint",
                "account": "MintConfig"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "viewer",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "withdraw",
      "docs": [
        "Withdraw from confidential account to regular SPL tokens.",
        "Amount is public. ZK proof verifies correct commitment update."
      ],
      "discriminator": [
        183,
        18,
        70,
        156,
        148,
        109,
        161,
        34
      ],
      "accounts": [
        {
          "name": "withdrawer",
          "docs": [
            "User withdrawing tokens"
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "mintConfig",
          "docs": [
            "Mint config"
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  122,
                  107,
                  115,
                  112,
                  108,
                  95,
                  109,
                  105,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "mint_config.token_mint",
                "account": "MintConfig"
              }
            ]
          }
        },
        {
          "name": "confidentialAccount",
          "docs": [
            "User's confidential account"
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  122,
                  107,
                  115,
                  112,
                  108,
                  95,
                  97,
                  99,
                  99,
                  111,
                  117,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "withdrawer"
              },
              {
                "kind": "account",
                "path": "mint_config.token_mint",
                "account": "MintConfig"
              }
            ]
          }
        },
        {
          "name": "vkData",
          "docs": [
            "Verification key data"
          ]
        },
        {
          "name": "vault",
          "docs": [
            "Vault holding the tokens (PDA seeded by mint)"
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  122,
                  107,
                  115,
                  112,
                  108,
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
                "path": "mint_config.token_mint",
                "account": "MintConfig"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "tokenProgram",
          "optional": true,
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "userTokenAccount",
          "writable": true,
          "optional": true
        },
        {
          "name": "poolVault",
          "writable": true,
          "optional": true
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        },
        {
          "name": "proof",
          "type": {
            "defined": {
              "name": "groth16Proof"
            }
          }
        },
        {
          "name": "newCommitment",
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
      "name": "writeVkData",
      "docs": [
        "Write VK data chunk."
      ],
      "discriminator": [
        158,
        131,
        125,
        119,
        246,
        102,
        158,
        162
      ],
      "accounts": [
        {
          "name": "authority",
          "signer": true
        },
        {
          "name": "mintConfig",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  122,
                  107,
                  115,
                  112,
                  108,
                  95,
                  109,
                  105,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "mint_config.token_mint",
                "account": "MintConfig"
              }
            ]
          }
        },
        {
          "name": "vkData",
          "writable": true
        }
      ],
      "args": [
        {
          "name": "vkType",
          "type": "u8"
        },
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
      "name": "confidentialAccount",
      "discriminator": [
        200,
        15,
        153,
        251,
        95,
        46,
        218,
        67
      ]
    },
    {
      "name": "mintConfig",
      "discriminator": [
        168,
        252,
        88,
        182,
        219,
        205,
        39,
        53
      ]
    }
  ],
  "types": [
    {
      "name": "accountCreatedEvent",
      "type": {
        "fields": [
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "timestamp",
            "type": "i64"
          }
        ],
        "kind": "struct"
      }
    },
    {
      "name": "applyPendingEvent",
      "type": {
        "fields": [
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "amountHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "nonce",
            "type": "u64"
          },
          {
            "name": "remainingPending",
            "type": "u8"
          },
          {
            "name": "timestamp",
            "type": "i64"
          }
        ],
        "kind": "struct"
      }
    },
    {
      "name": "balanceProofEvent",
      "type": {
        "fields": [
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "threshold",
            "type": "u64"
          },
          {
            "name": "verified",
            "type": "bool"
          },
          {
            "name": "timestamp",
            "type": "i64"
          }
        ],
        "kind": "struct"
      }
    },
    {
      "name": "confidentialAccount",
      "docs": [
        "A confidential token account.",
        "Holds an encrypted balance as a Poseidon hash commitment.",
        "Nobody can see the actual balance — only the owner knows it.",
        "",
        "Balance commitment = Poseidon(balance, salt, owner_pubkey, token_mint)",
        "where owner_pubkey = Poseidon(spending_key)"
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "owner",
            "docs": [
              "Solana wallet that owns this account"
            ],
            "type": "pubkey"
          },
          {
            "name": "mint",
            "docs": [
              "The SPL token mint"
            ],
            "type": "pubkey"
          },
          {
            "name": "balanceCommitment",
            "docs": [
              "Current balance commitment: Poseidon(balance, salt, owner_pubkey, token_mint)",
              "This is the only on-chain balance representation.",
              "Nobody can determine the actual balance from this hash."
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "nonce",
            "docs": [
              "Anti-replay nonce (incremented on every state change)"
            ],
            "type": "u64"
          },
          {
            "name": "pendingCredits",
            "docs": [
              "Pending credits from incoming private transfers.",
              "Each entry is an amount_hash = Poseidon(amount, amount_salt).",
              "The recipient must apply these to update their balance.",
              "Max 16 pending credits (prevents account bloat)."
            ],
            "type": {
              "vec": {
                "defined": {
                  "name": "pendingCredit"
                }
              }
            }
          },
          {
            "name": "viewerKeys",
            "docs": [
              "Optional viewing keys for compliance.",
              "If a pubkey is listed here, that entity can request a viewing proof.",
              "Entirely opt-in — the owner adds/removes viewers."
            ],
            "type": {
              "vec": "pubkey"
            }
          },
          {
            "name": "isInitialized",
            "docs": [
              "Whether this account is initialized and active"
            ],
            "type": "bool"
          },
          {
            "name": "createdAt",
            "docs": [
              "Creation timestamp"
            ],
            "type": "i64"
          },
          {
            "name": "lastTxAt",
            "docs": [
              "Last operation timestamp"
            ],
            "type": "i64"
          },
          {
            "name": "bump",
            "docs": [
              "PDA bump"
            ],
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "depositEvent",
      "type": {
        "fields": [
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "newCommitment",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "nonce",
            "type": "u64"
          },
          {
            "name": "timestamp",
            "type": "i64"
          }
        ],
        "kind": "struct"
      }
    },
    {
      "name": "groth16Proof",
      "docs": [
        "Groth16 proof structure for on-chain verification"
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "piA",
            "type": {
              "array": [
                "u8",
                64
              ]
            }
          },
          {
            "name": "piB",
            "type": {
              "array": [
                "u8",
                128
              ]
            }
          },
          {
            "name": "piC",
            "type": {
              "array": [
                "u8",
                64
              ]
            }
          }
        ]
      }
    },
    {
      "name": "mintConfig",
      "docs": [
        "Configuration for a zkSPL-enabled token mint.",
        "Created once per SPL token to enable confidential operations.",
        "Stores the verification keys and global settings."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "authority",
            "docs": [
              "Authority that can update settings"
            ],
            "type": "pubkey"
          },
          {
            "name": "tokenMint",
            "docs": [
              "The SPL token mint this config is for"
            ],
            "type": "pubkey"
          },
          {
            "name": "balanceVkHash",
            "docs": [
              "Hash of the confidential_balance verification key"
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "proofVkHash",
            "docs": [
              "Hash of the balance_proof verification key (for DeFi composability)"
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "isActive",
            "docs": [
              "Whether this mint accepts new confidential accounts"
            ],
            "type": "bool"
          },
          {
            "name": "accountCount",
            "docs": [
              "Total number of confidential accounts created"
            ],
            "type": "u64"
          },
          {
            "name": "createdAt",
            "docs": [
              "Creation timestamp"
            ],
            "type": "i64"
          },
          {
            "name": "bump",
            "docs": [
              "PDA bump"
            ],
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "pendingCredit",
      "docs": [
        "A pending credit from an incoming private transfer.",
        "The sender created the amount_hash and the recipient must apply it."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "amountHash",
            "docs": [
              "Poseidon(amount, amount_salt) — matches the sender's proof"
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "sender",
            "docs": [
              "Who sent this credit"
            ],
            "type": "pubkey"
          },
          {
            "name": "timestamp",
            "docs": [
              "When it was received"
            ],
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "transferEvent",
      "type": {
        "fields": [
          {
            "name": "sender",
            "type": "pubkey"
          },
          {
            "name": "recipient",
            "type": "pubkey"
          },
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "amountHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "senderNonce",
            "type": "u64"
          },
          {
            "name": "timestamp",
            "type": "i64"
          }
        ],
        "kind": "struct"
      }
    },
    {
      "name": "withdrawEvent",
      "type": {
        "fields": [
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "newCommitment",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "nonce",
            "type": "u64"
          },
          {
            "name": "timestamp",
            "type": "i64"
          }
        ],
        "kind": "struct"
      }
    }
  ],
  "constants": [],
  "events": [
    {
      "discriminator": [
        94,
        249,
        120,
        147,
        213,
        157,
        65,
        14
      ],
      "name": "accountCreatedEvent"
    },
    {
      "discriminator": [
        240,
        183,
        145,
        88,
        35,
        63,
        122,
        104
      ],
      "name": "applyPendingEvent"
    },
    {
      "discriminator": [
        156,
        254,
        163,
        187,
        61,
        88,
        224,
        217
      ],
      "name": "balanceProofEvent"
    },
    {
      "discriminator": [
        120,
        248,
        61,
        83,
        31,
        142,
        107,
        144
      ],
      "name": "depositEvent"
    },
    {
      "discriminator": [
        100,
        10,
        46,
        113,
        8,
        28,
        179,
        125
      ],
      "name": "transferEvent"
    },
    {
      "discriminator": [
        22,
        9,
        133,
        26,
        160,
        44,
        71,
        192
      ],
      "name": "withdrawEvent"
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "invalidProof",
      "msg": "Invalid ZK proof — verification failed"
    },
    {
      "code": 6001,
      "name": "mintNotActive",
      "msg": "Mint is not active"
    },
    {
      "code": 6002,
      "name": "accountNotInitialized",
      "msg": "Account is not initialized"
    },
    {
      "code": 6003,
      "name": "unauthorized",
      "msg": "Unauthorized — not account owner"
    },
    {
      "code": 6004,
      "name": "invalidAmount",
      "msg": "Invalid amount — must be greater than zero"
    },
    {
      "code": 6005,
      "name": "invalidCommitment",
      "msg": "Invalid commitment format"
    },
    {
      "code": 6006,
      "name": "invalidVerificationKey",
      "msg": "Invalid verification key"
    },
    {
      "code": 6007,
      "name": "invalidPublicInputs",
      "msg": "Invalid public inputs"
    },
    {
      "code": 6008,
      "name": "nonceMismatch",
      "msg": "Nonce mismatch — proof uses stale state"
    },
    {
      "code": 6009,
      "name": "tooManyPendingCredits",
      "msg": "Too many pending credits — apply existing ones first"
    },
    {
      "code": 6010,
      "name": "pendingCreditNotFound",
      "msg": "No pending credit matches this amount_hash"
    },
    {
      "code": 6011,
      "name": "tooManyViewerKeys",
      "msg": "Too many viewer keys"
    },
    {
      "code": 6012,
      "name": "viewerKeyAlreadyExists",
      "msg": "Viewer key already exists"
    },
    {
      "code": 6013,
      "name": "viewerKeyNotFound",
      "msg": "Viewer key not found"
    },
    {
      "code": 6014,
      "name": "arithmeticOverflow",
      "msg": "Arithmetic overflow"
    },
    {
      "code": 6015,
      "name": "missingTokenProgram",
      "msg": "Missing token program for SPL token operation"
    },
    {
      "code": 6016,
      "name": "missingTokenAccount",
      "msg": "Missing user token account"
    },
    {
      "code": 6017,
      "name": "missingPoolVault",
      "msg": "Missing pool vault"
    },
    {
      "code": 6018,
      "name": "invalidTokenMint",
      "msg": "Invalid token mint"
    },
    {
      "code": 6019,
      "name": "invalidTokenOwner",
      "msg": "Invalid token account owner"
    },
    {
      "code": 6020,
      "name": "insufficientVaultBalance",
      "msg": "Insufficient pool vault balance for withdrawal"
    }
  ]
};
