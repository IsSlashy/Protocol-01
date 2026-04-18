/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/p01_mugen.json`.
 */
export type P01Mugen = {
  "address": "EURLevwgmunRQU5piF7QLB1ithMPfxYFXp6jp6eGEAJN",
  "metadata": {
    "name": "p01Mugen",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Mugen Exchange — P2P fiat-to-crypto escrow with ZK compliance, no KYC"
  },
  "instructions": [
    {
      "name": "cancelOrder",
      "docs": [
        "Cancel an open order (maker only)."
      ],
      "discriminator": [
        95,
        129,
        237,
        240,
        8,
        49,
        223,
        132
      ],
      "accounts": [
        {
          "name": "maker",
          "writable": true,
          "signer": true
        },
        {
          "name": "order",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  117,
                  103,
                  101,
                  110,
                  95,
                  111,
                  114,
                  100,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "maker"
              },
              {
                "kind": "account",
                "path": "order.nonce",
                "account": "MugenOrder"
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "closeConfig",
      "docs": [
        "Close the config account (authority only, devnet migration)."
      ],
      "discriminator": [
        145,
        9,
        72,
        157,
        95,
        125,
        61,
        85
      ],
      "accounts": [
        {
          "name": "authority",
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  117,
                  103,
                  101,
                  110,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "confirmPayment",
      "docs": [
        "Buyer confirms fiat payment was sent."
      ],
      "discriminator": [
        221,
        23,
        112,
        126,
        29,
        23,
        159,
        223
      ],
      "accounts": [
        {
          "name": "buyer",
          "signer": true
        },
        {
          "name": "escrow",
          "writable": true
        }
      ],
      "args": []
    },
    {
      "name": "createOrder",
      "docs": [
        "Create a new P2P buy/sell order.",
        "Requires a valid ZK compliance attestation (no KYC)."
      ],
      "discriminator": [
        141,
        54,
        37,
        207,
        237,
        210,
        250,
        215
      ],
      "accounts": [
        {
          "name": "maker",
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  117,
                  103,
                  101,
                  110,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "order",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  117,
                  103,
                  101,
                  110,
                  95,
                  111,
                  114,
                  100,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "maker"
              },
              {
                "kind": "arg",
                "path": "params.nonce"
              }
            ]
          }
        },
        {
          "name": "complianceAttestation",
          "docs": [
            "The maker's compliance attestation account (from zk_shielded program)."
          ]
        },
        {
          "name": "tokenMint",
          "docs": [
            "The token mint being traded."
          ]
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "params",
          "type": {
            "defined": {
              "name": "createOrderParams"
            }
          }
        }
      ]
    },
    {
      "name": "disputeEscrow",
      "docs": [
        "Either party opens a dispute on the escrow."
      ],
      "discriminator": [
        198,
        174,
        139,
        70,
        87,
        79,
        181,
        139
      ],
      "accounts": [
        {
          "name": "disputer",
          "signer": true
        },
        {
          "name": "escrow",
          "writable": true
        }
      ],
      "args": [
        {
          "name": "reason",
          "type": "u8"
        }
      ]
    },
    {
      "name": "expireEscrow",
      "docs": [
        "Permissionless: expire and refund an escrow past its timeout."
      ],
      "discriminator": [
        49,
        150,
        54,
        201,
        45,
        106,
        39,
        175
      ],
      "accounts": [
        {
          "name": "cranker",
          "docs": [
            "Permissionless — anyone can crank expired escrows."
          ],
          "signer": true
        },
        {
          "name": "escrow",
          "writable": true
        },
        {
          "name": "order",
          "writable": true
        },
        {
          "name": "escrowVault",
          "docs": [
            "The escrow vault holding the crypto."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  117,
                  103,
                  101,
                  110,
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
                "path": "escrow"
              }
            ]
          }
        },
        {
          "name": "sellerTokenAccount",
          "docs": [
            "The seller's token account (refund destination).",
            "Must match the seller_token_account bound at escrow creation."
          ],
          "writable": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": []
    },
    {
      "name": "initReputation",
      "docs": [
        "Initialize an anonymous reputation PDA (permissionless).",
        "Anyone can create a reputation for a given Poseidon commitment."
      ],
      "discriminator": [
        236,
        239,
        233,
        112,
        220,
        149,
        26,
        175
      ],
      "accounts": [
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "authority",
          "docs": [
            "Designated attestation authority — gates reputation creation so that",
            "anyone can't squat an arbitrary commitment. Must co-sign."
          ],
          "signer": true,
          "address": "7gWpzSZALYz3Um8G7yUxaT6Av2tvw1Cn6VAhSZSB6QmU"
        },
        {
          "name": "reputation",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  117,
                  103,
                  101,
                  110,
                  95,
                  114,
                  101,
                  112
                ]
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
        }
      ]
    },
    {
      "name": "initializeConfig",
      "docs": [
        "Initialize the global exchange configuration (one-time)."
      ],
      "discriminator": [
        208,
        127,
        21,
        1,
        194,
        190,
        196,
        70
      ],
      "accounts": [
        {
          "name": "authority",
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  117,
                  103,
                  101,
                  110,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
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
          "name": "params",
          "type": {
            "defined": {
              "name": "initConfigParams"
            }
          }
        }
      ]
    },
    {
      "name": "releaseEscrow",
      "docs": [
        "Seller releases escrowed crypto after confirming fiat receipt.",
        "Protocol fee deducted. Reputation updated for both parties."
      ],
      "discriminator": [
        146,
        253,
        129,
        233,
        20,
        145,
        181,
        206
      ],
      "accounts": [
        {
          "name": "seller",
          "docs": [
            "The seller (crypto provider) who confirms fiat was received."
          ],
          "signer": true
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  117,
                  103,
                  101,
                  110,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "escrow",
          "writable": true
        },
        {
          "name": "order",
          "docs": [
            "The parent order — needed to derive the seller role from order_type."
          ]
        },
        {
          "name": "escrowVault",
          "docs": [
            "The escrow vault token account holding the crypto."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  117,
                  103,
                  101,
                  110,
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
                "path": "escrow"
              }
            ]
          }
        },
        {
          "name": "buyerTokenAccount",
          "docs": [
            "The buyer's token account (receives the crypto minus fees).",
            "Must match the token account bound at escrow creation."
          ],
          "writable": true
        },
        {
          "name": "p01FeeAccount",
          "docs": [
            "P01 Protocol fee wallet token account."
          ],
          "writable": true
        },
        {
          "name": "mugenFeeAccount",
          "docs": [
            "Mugen Exchange fee wallet token account."
          ],
          "writable": true
        },
        {
          "name": "treasuryFeeAccount",
          "docs": [
            "Treasury fee wallet token account."
          ],
          "writable": true
        },
        {
          "name": "noiseFundAccount",
          "docs": [
            "Noise fund token account (auto-feeds noise engine wallets)."
          ],
          "writable": true
        },
        {
          "name": "makerReputation",
          "docs": [
            "Maker reputation PDA (gets updated on completion)."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  117,
                  103,
                  101,
                  110,
                  95,
                  114,
                  101,
                  112
                ]
              },
              {
                "kind": "account",
                "path": "maker_reputation.commitment",
                "account": "MugenReputation"
              }
            ]
          }
        },
        {
          "name": "takerReputation",
          "docs": [
            "Taker reputation PDA (gets updated on completion)."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  117,
                  103,
                  101,
                  110,
                  95,
                  114,
                  101,
                  112
                ]
              },
              {
                "kind": "account",
                "path": "taker_reputation.commitment",
                "account": "MugenReputation"
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": []
    },
    {
      "name": "resolveDispute",
      "docs": [
        "Authority resolves a disputed escrow.",
        "outcome: 0 = release to buyer, 1 = refund to seller."
      ],
      "discriminator": [
        231,
        6,
        202,
        6,
        96,
        103,
        12,
        230
      ],
      "accounts": [
        {
          "name": "authority",
          "docs": [
            "Config authority resolves the dispute (MVP: centralized, later: MPC/DAO)."
          ],
          "signer": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  117,
                  103,
                  101,
                  110,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "escrow",
          "writable": true
        },
        {
          "name": "escrowVault",
          "docs": [
            "The escrow vault holding the crypto."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  117,
                  103,
                  101,
                  110,
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
                "path": "escrow"
              }
            ]
          }
        },
        {
          "name": "recipientTokenAccount",
          "docs": [
            "Recipient of the resolved funds (buyer or seller depending on outcome).",
            "Must match one of the token accounts bound at escrow creation — prevents",
            "an attacker from passing an arbitrary token account to siphon funds."
          ],
          "writable": true
        },
        {
          "name": "loserReputation",
          "docs": [
            "Loser reputation PDA (gets dispute count incremented)."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  117,
                  103,
                  101,
                  110,
                  95,
                  114,
                  101,
                  112
                ]
              },
              {
                "kind": "account",
                "path": "loser_reputation.commitment",
                "account": "MugenReputation"
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "outcome",
          "type": "u8"
        }
      ]
    },
    {
      "name": "takeOrder",
      "docs": [
        "Take an open order — locks crypto in escrow.",
        "Both parties must hold valid ZK compliance attestations."
      ],
      "discriminator": [
        163,
        208,
        20,
        172,
        223,
        65,
        255,
        228
      ],
      "accounts": [
        {
          "name": "taker",
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  117,
                  103,
                  101,
                  110,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "order",
          "writable": true
        },
        {
          "name": "escrow",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  117,
                  103,
                  101,
                  110,
                  95,
                  101,
                  115,
                  99,
                  114,
                  111,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "order"
              },
              {
                "kind": "account",
                "path": "taker"
              }
            ]
          }
        },
        {
          "name": "escrowVault",
          "docs": [
            "The PDA-owned token account to hold escrowed crypto."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  117,
                  103,
                  101,
                  110,
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
                "path": "escrow"
              }
            ]
          }
        },
        {
          "name": "sellerTokenAccount",
          "docs": [
            "The seller's token account (source of crypto to escrow).",
            "Bound to the `seller` signer below so a caller cannot pass an unrelated",
            "token account on finalization paths (resolve_dispute, expire_escrow)."
          ],
          "writable": true
        },
        {
          "name": "buyerTokenAccount",
          "docs": [
            "The buyer's token account (destination for `release_escrow` / `resolve_dispute`).",
            "Captured at escrow creation so later finalization cannot be redirected."
          ]
        },
        {
          "name": "seller",
          "docs": [
            "The seller must sign if they are depositing crypto."
          ],
          "signer": true
        },
        {
          "name": "tokenMint"
        },
        {
          "name": "takerAttestation",
          "docs": [
            "Taker's compliance attestation."
          ]
        },
        {
          "name": "makerReputation",
          "docs": [
            "Maker reputation PDA — snapshotted into escrow at trade time."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  117,
                  103,
                  101,
                  110,
                  95,
                  114,
                  101,
                  112
                ]
              },
              {
                "kind": "account",
                "path": "maker_reputation.commitment",
                "account": "MugenReputation"
              }
            ]
          }
        },
        {
          "name": "takerReputation",
          "docs": [
            "Taker reputation PDA — snapshotted into escrow at trade time."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  117,
                  103,
                  101,
                  110,
                  95,
                  114,
                  101,
                  112
                ]
              },
              {
                "kind": "account",
                "path": "taker_reputation.commitment",
                "account": "MugenReputation"
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "rent",
          "address": "SysvarRent111111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "stealthRecipient",
          "type": {
            "option": {
              "array": [
                "u8",
                32
              ]
            }
          }
        },
        {
          "name": "paymentMethod",
          "type": "u16"
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "mugenConfig",
      "discriminator": [
        2,
        73,
        67,
        62,
        56,
        162,
        136,
        248
      ]
    },
    {
      "name": "mugenEscrow",
      "discriminator": [
        131,
        226,
        208,
        143,
        239,
        131,
        178,
        21
      ]
    },
    {
      "name": "mugenOrder",
      "discriminator": [
        241,
        225,
        205,
        126,
        204,
        207,
        238,
        125
      ]
    },
    {
      "name": "mugenReputation",
      "discriminator": [
        155,
        28,
        49,
        207,
        127,
        207,
        182,
        66
      ]
    }
  ],
  "types": [
    {
      "name": "createOrderParams",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "orderType",
            "type": "u8"
          },
          {
            "name": "cryptoAmount",
            "type": "u64"
          },
          {
            "name": "fiatAmount",
            "type": "u64"
          },
          {
            "name": "fiatCurrency",
            "type": {
              "array": [
                "u8",
                3
              ]
            }
          },
          {
            "name": "paymentMethods",
            "type": "u16"
          },
          {
            "name": "minAmount",
            "type": "u64"
          },
          {
            "name": "maxAmount",
            "type": "u64"
          },
          {
            "name": "reputationCommitment",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "nonce",
            "type": {
              "array": [
                "u8",
                16
              ]
            }
          },
          {
            "name": "expiresIn",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "initConfigParams",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "feeBps",
            "docs": [
              "Total fee in basis points (e.g. 150 = 1.5%)."
            ],
            "type": "u16"
          },
          {
            "name": "p01FeeWallet",
            "docs": [
              "P01 Protocol wallet (app/infra revenue)."
            ],
            "type": "pubkey"
          },
          {
            "name": "mugenFeeWallet",
            "docs": [
              "Mugen Exchange wallet (exchange revenue)."
            ],
            "type": "pubkey"
          },
          {
            "name": "treasuryWallet",
            "docs": [
              "Treasury wallet (DAO/governance)."
            ],
            "type": "pubkey"
          },
          {
            "name": "p01FeeShare",
            "docs": [
              "P01 share in bps out of 10000 (e.g. 2000 = 20%)."
            ],
            "type": "u16"
          },
          {
            "name": "mugenFeeShare",
            "docs": [
              "Mugen share in bps out of 10000 (e.g. 6500 = 65%)."
            ],
            "type": "u16"
          },
          {
            "name": "noiseFundWallet",
            "docs": [
              "Noise fund wallet (auto-feeds noise wallets from trade fees)."
            ],
            "type": "pubkey"
          },
          {
            "name": "noiseFeeShare",
            "docs": [
              "Noise fund share in bps out of 10000 (e.g. 1500 = 15%)."
            ],
            "type": "u16"
          },
          {
            "name": "minTradeAmount",
            "type": "u64"
          },
          {
            "name": "maxTradeAmount",
            "type": "u64"
          },
          {
            "name": "escrowTimeout",
            "type": "i64"
          },
          {
            "name": "disputeTimeout",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "mugenConfig",
      "docs": [
        "Global exchange configuration (singleton PDA).",
        "",
        "Seeds: `[\"mugen_config\"]`"
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "authority",
            "docs": [
              "Admin authority who can update config and resolve disputes."
            ],
            "type": "pubkey"
          },
          {
            "name": "feeBps",
            "docs": [
              "Total protocol fee in basis points (e.g. 150 = 1.5%).",
              "This is split across 3 wallets: P01 + Mugen + Treasury."
            ],
            "type": "u16"
          },
          {
            "name": "p01FeeWallet",
            "docs": [
              "P01 Protocol fee wallet (app, extension, infra revenue)."
            ],
            "type": "pubkey"
          },
          {
            "name": "mugenFeeWallet",
            "docs": [
              "Mugen Exchange fee wallet (exchange operation revenue)."
            ],
            "type": "pubkey"
          },
          {
            "name": "treasuryWallet",
            "docs": [
              "Treasury wallet (DAO / future governance)."
            ],
            "type": "pubkey"
          },
          {
            "name": "p01FeeShare",
            "docs": [
              "P01 share of fees in basis points out of 10000 (e.g. 2000 = 20%)."
            ],
            "type": "u16"
          },
          {
            "name": "mugenFeeShare",
            "docs": [
              "Mugen share of fees in basis points out of 10000 (e.g. 6500 = 65%)."
            ],
            "type": "u16"
          },
          {
            "name": "noiseFundWallet",
            "docs": [
              "Treasury share = 10000 - p01_share - mugen_share - noise_share.",
              "Not stored — computed on-chain as remainder.",
              "Noise fund wallet (auto-feeds noise engine ephemeral wallets)."
            ],
            "type": "pubkey"
          },
          {
            "name": "noiseFeeShare",
            "docs": [
              "Noise fund share of fees in bps out of 10000 (e.g. 1500 = 15%)."
            ],
            "type": "u16"
          },
          {
            "name": "minTradeAmount",
            "docs": [
              "Minimum trade amount in base token units."
            ],
            "type": "u64"
          },
          {
            "name": "maxTradeAmount",
            "docs": [
              "Maximum trade amount in base token units."
            ],
            "type": "u64"
          },
          {
            "name": "escrowTimeout",
            "docs": [
              "Escrow timeout in seconds (default: 3600 = 1 hour)."
            ],
            "type": "i64"
          },
          {
            "name": "disputeTimeout",
            "docs": [
              "Dispute timeout in seconds (default: 86400 = 24 hours)."
            ],
            "type": "i64"
          },
          {
            "name": "totalTrades",
            "docs": [
              "Total number of completed trades."
            ],
            "type": "u64"
          },
          {
            "name": "totalVolume",
            "docs": [
              "Total volume traded (in lamports/base units)."
            ],
            "type": "u64"
          },
          {
            "name": "totalFeesCollected",
            "docs": [
              "Total fees collected (in lamports/base units)."
            ],
            "type": "u64"
          },
          {
            "name": "isActive",
            "docs": [
              "Whether the exchange is accepting new orders."
            ],
            "type": "bool"
          },
          {
            "name": "bump",
            "docs": [
              "PDA bump."
            ],
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "mugenEscrow",
      "docs": [
        "Escrow holding crypto during an active trade.",
        "",
        "Seeds: `[\"mugen_escrow\", order, taker]`"
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "order",
            "docs": [
              "The parent order PDA."
            ],
            "type": "pubkey"
          },
          {
            "name": "maker",
            "docs": [
              "The order maker (crypto seller in sell_crypto, buyer in buy_crypto)."
            ],
            "type": "pubkey"
          },
          {
            "name": "taker",
            "docs": [
              "The counterparty who took the order."
            ],
            "type": "pubkey"
          },
          {
            "name": "tokenMint",
            "docs": [
              "Token mint."
            ],
            "type": "pubkey"
          },
          {
            "name": "cryptoAmount",
            "docs": [
              "Amount of crypto locked in escrow."
            ],
            "type": "u64"
          },
          {
            "name": "fiatAmount",
            "docs": [
              "Expected fiat amount in cents."
            ],
            "type": "u64"
          },
          {
            "name": "escrowVault",
            "docs": [
              "PDA token account holding the escrowed crypto."
            ],
            "type": "pubkey"
          },
          {
            "name": "makerAttestation",
            "docs": [
              "Maker's compliance attestation."
            ],
            "type": "pubkey"
          },
          {
            "name": "takerAttestation",
            "docs": [
              "Taker's compliance attestation."
            ],
            "type": "pubkey"
          },
          {
            "name": "stealthRecipient",
            "docs": [
              "Optional stealth address for settlement (zero = direct transfer)."
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "paymentMethod",
            "docs": [
              "Selected payment method for this trade."
            ],
            "type": "u16"
          },
          {
            "name": "status",
            "docs": [
              "Escrow status."
            ],
            "type": "u8"
          },
          {
            "name": "createdAt",
            "docs": [
              "Unix timestamp of creation."
            ],
            "type": "i64"
          },
          {
            "name": "expiresAt",
            "docs": [
              "Unix timestamp of expiry."
            ],
            "type": "i64"
          },
          {
            "name": "paymentConfirmedAt",
            "docs": [
              "Unix timestamp when payment was confirmed (0 if not yet)."
            ],
            "type": "i64"
          },
          {
            "name": "disputeInitiator",
            "docs": [
              "Who initiated the dispute (None if no dispute)."
            ],
            "type": "pubkey"
          },
          {
            "name": "disputeReason",
            "docs": [
              "Dispute reason code (0 = none)."
            ],
            "type": "u8"
          },
          {
            "name": "buyerTokenAccount",
            "docs": [
              "Buyer's token account bound at escrow creation. Used by `resolve_dispute`",
              "to prevent passing an arbitrary recipient token account."
            ],
            "type": "pubkey"
          },
          {
            "name": "sellerTokenAccount",
            "docs": [
              "Seller's token account bound at escrow creation. Used by `resolve_dispute`",
              "and `expire_escrow` to prevent passing an arbitrary recipient token account."
            ],
            "type": "pubkey"
          },
          {
            "name": "makerReputationSnapshot",
            "docs": [
              "Maker reputation snapshot at trade time — prevents race between",
              "reputation updates and escrow finalization."
            ],
            "type": "u64"
          },
          {
            "name": "takerReputationSnapshot",
            "docs": [
              "Taker reputation snapshot at trade time."
            ],
            "type": "u64"
          },
          {
            "name": "bump",
            "docs": [
              "PDA bump."
            ],
            "type": "u8"
          },
          {
            "name": "vaultBump",
            "docs": [
              "Vault token account bump."
            ],
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "mugenOrder",
      "docs": [
        "A P2P buy/sell order listing.",
        "",
        "Seeds: `[\"mugen_order\", maker, nonce]`"
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "maker",
            "docs": [
              "Order creator's wallet."
            ],
            "type": "pubkey"
          },
          {
            "name": "orderType",
            "docs": [
              "0 = buy_crypto (fiat→crypto), 1 = sell_crypto (crypto→fiat)."
            ],
            "type": "u8"
          },
          {
            "name": "tokenMint",
            "docs": [
              "Token mint being traded."
            ],
            "type": "pubkey"
          },
          {
            "name": "cryptoAmount",
            "docs": [
              "Amount of crypto in base units."
            ],
            "type": "u64"
          },
          {
            "name": "fiatAmount",
            "docs": [
              "Fiat price in cents (e.g. 15000 = $150.00)."
            ],
            "type": "u64"
          },
          {
            "name": "fiatCurrency",
            "docs": [
              "ISO 4217 currency code (e.g. b\"USD\", b\"EUR\")."
            ],
            "type": {
              "array": [
                "u8",
                3
              ]
            }
          },
          {
            "name": "paymentMethods",
            "docs": [
              "Bitfield of accepted payment methods."
            ],
            "type": "u16"
          },
          {
            "name": "minAmount",
            "docs": [
              "Minimum partial fill amount (0 = no partial fills)."
            ],
            "type": "u64"
          },
          {
            "name": "maxAmount",
            "docs": [
              "Maximum fill amount per trade."
            ],
            "type": "u64"
          },
          {
            "name": "complianceAttestation",
            "docs": [
              "Maker's compliance attestation PDA (from zk_shielded)."
            ],
            "type": "pubkey"
          },
          {
            "name": "reputationCommitment",
            "docs": [
              "Poseidon(maker_pubkey, salt) for anonymous reputation."
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
              "Unique 16-byte nonce for PDA derivation."
            ],
            "type": {
              "array": [
                "u8",
                16
              ]
            }
          },
          {
            "name": "status",
            "docs": [
              "Order status."
            ],
            "type": "u8"
          },
          {
            "name": "createdAt",
            "docs": [
              "Unix timestamp of creation."
            ],
            "type": "i64"
          },
          {
            "name": "expiresAt",
            "docs": [
              "Unix timestamp of expiry."
            ],
            "type": "i64"
          },
          {
            "name": "bump",
            "docs": [
              "PDA bump."
            ],
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "mugenReputation",
      "docs": [
        "Anonymous on-chain reputation tied to a Poseidon commitment.",
        "",
        "Seeds: `[\"mugen_rep\", commitment]`"
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "commitment",
            "docs": [
              "Poseidon(pubkey_field, salt) — anonymous, unlinkable."
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "tradesCompleted",
            "docs": [
              "Number of successfully completed trades."
            ],
            "type": "u32"
          },
          {
            "name": "tradesDisputed",
            "docs": [
              "Number of disputed trades."
            ],
            "type": "u32"
          },
          {
            "name": "totalVolume",
            "docs": [
              "Cumulative volume traded (base units)."
            ],
            "type": "u64"
          },
          {
            "name": "avgPaymentTime",
            "docs": [
              "Average time to confirm payment in seconds."
            ],
            "type": "u32"
          },
          {
            "name": "positiveFeedback",
            "docs": [
              "Positive feedback count."
            ],
            "type": "u32"
          },
          {
            "name": "negativeFeedback",
            "docs": [
              "Negative feedback count."
            ],
            "type": "u32"
          },
          {
            "name": "firstTradeAt",
            "docs": [
              "Timestamp of first trade."
            ],
            "type": "i64"
          },
          {
            "name": "lastTradeAt",
            "docs": [
              "Timestamp of most recent trade."
            ],
            "type": "i64"
          },
          {
            "name": "bump",
            "docs": [
              "PDA bump."
            ],
            "type": "u8"
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
      "name": "exchangeNotActive",
      "msg": "Exchange is not active"
    },
    {
      "code": 6001,
      "name": "invalidFeeBps",
      "msg": "Invalid fee basis points (max 1000 = 10%)"
    },
    {
      "code": 6002,
      "name": "invalidTradeLimits",
      "msg": "Invalid trade amount limits"
    },
    {
      "code": 6003,
      "name": "orderNotOpen",
      "msg": "Order is not open"
    },
    {
      "code": 6004,
      "name": "orderExpired",
      "msg": "Order has expired"
    },
    {
      "code": 6005,
      "name": "invalidOrderType",
      "msg": "Order type invalid (0 = buy_crypto, 1 = sell_crypto)"
    },
    {
      "code": 6006,
      "name": "amountBelowMinimum",
      "msg": "Trade amount below minimum"
    },
    {
      "code": 6007,
      "name": "amountAboveMaximum",
      "msg": "Trade amount above maximum"
    },
    {
      "code": 6008,
      "name": "noPaymentMethods",
      "msg": "No payment methods specified"
    },
    {
      "code": 6009,
      "name": "invalidFiatCurrency",
      "msg": "Invalid fiat currency code"
    },
    {
      "code": 6010,
      "name": "cannotTakeOwnOrder",
      "msg": "Cannot take own order"
    },
    {
      "code": 6011,
      "name": "escrowNotAwaitingPayment",
      "msg": "Escrow is not in awaiting_payment status"
    },
    {
      "code": 6012,
      "name": "escrowNotPaymentConfirmed",
      "msg": "Escrow is not in payment_confirmed status"
    },
    {
      "code": 6013,
      "name": "escrowExpired",
      "msg": "Escrow has expired"
    },
    {
      "code": 6014,
      "name": "escrowNotExpired",
      "msg": "Escrow has not expired yet"
    },
    {
      "code": 6015,
      "name": "escrowNotDisputable",
      "msg": "Escrow is not disputable in current status"
    },
    {
      "code": 6016,
      "name": "escrowNotDisputed",
      "msg": "Escrow is not in disputed status"
    },
    {
      "code": 6017,
      "name": "invalidDisputeOutcome",
      "msg": "Invalid dispute resolution outcome"
    },
    {
      "code": 6018,
      "name": "attestationNotVerified",
      "msg": "Compliance attestation is not verified"
    },
    {
      "code": 6019,
      "name": "attestationExpired",
      "msg": "Compliance attestation has expired"
    },
    {
      "code": 6020,
      "name": "attestationRevoked",
      "msg": "Compliance attestation has been revoked"
    },
    {
      "code": 6021,
      "name": "unauthorizedMaker",
      "msg": "Unauthorized — not the order maker"
    },
    {
      "code": 6022,
      "name": "unauthorizedBuyer",
      "msg": "Unauthorized — not the escrow buyer"
    },
    {
      "code": 6023,
      "name": "unauthorizedSeller",
      "msg": "Unauthorized — not the escrow seller"
    },
    {
      "code": 6024,
      "name": "unauthorizedParticipant",
      "msg": "Unauthorized — not a trade participant"
    },
    {
      "code": 6025,
      "name": "unauthorizedAuthority",
      "msg": "Unauthorized — not the config authority"
    },
    {
      "code": 6026,
      "name": "mathOverflow",
      "msg": "Arithmetic overflow"
    }
  ]
};
