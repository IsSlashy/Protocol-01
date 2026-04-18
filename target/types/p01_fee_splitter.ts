/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/p01_fee_splitter.json`.
 */
export type P01FeeSplitter = {
  "address": "UdxXEvcAzmGsqUtoBgnNkbmfnky4En2kLxNnsVQU5BM",
  "metadata": {
    "name": "p01FeeSplitter",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "P-01 Network Fee Splitter - Automatically takes 0.5% fee on transactions"
  },
  "instructions": [
    {
      "name": "initialize",
      "docs": [
        "Initialize the global fee configuration",
        "Only called once by the program authority"
      ],
      "discriminator": [
        175,
        175,
        109,
        31,
        13,
        152,
        155,
        237
      ],
      "accounts": [
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  48,
                  49,
                  45,
                  102,
                  101,
                  101,
                  45,
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
          "name": "feeBps",
          "type": "u16"
        },
        {
          "name": "feeWallet",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "splitSol",
      "docs": [
        "Split a SOL transfer: take fee and forward rest to recipient"
      ],
      "discriminator": [
        222,
        101,
        57,
        197,
        58,
        135,
        45,
        26
      ],
      "accounts": [
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  48,
                  49,
                  45,
                  102,
                  101,
                  101,
                  45,
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
          "name": "sender",
          "writable": true,
          "signer": true
        },
        {
          "name": "recipient",
          "writable": true
        },
        {
          "name": "feeWallet",
          "writable": true
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
      "name": "splitSolDirect",
      "docs": [
        "Direct transfer with inline fee (no config account needed)",
        "Useful for simple integrations"
      ],
      "discriminator": [
        9,
        74,
        138,
        12,
        20,
        240,
        29,
        200
      ],
      "accounts": [
        {
          "name": "sender",
          "writable": true,
          "signer": true
        },
        {
          "name": "recipient",
          "writable": true
        },
        {
          "name": "feeWallet",
          "writable": true
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
          "name": "feeBps",
          "type": "u16"
        }
      ]
    },
    {
      "name": "splitToken",
      "docs": [
        "Split an SPL token transfer: take fee and forward rest to recipient"
      ],
      "discriminator": [
        79,
        128,
        211,
        182,
        238,
        142,
        237,
        104
      ],
      "accounts": [
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  48,
                  49,
                  45,
                  102,
                  101,
                  101,
                  45,
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
          "name": "sender",
          "writable": true,
          "signer": true
        },
        {
          "name": "senderTokenAccount",
          "writable": true
        },
        {
          "name": "recipientTokenAccount",
          "writable": true
        },
        {
          "name": "feeTokenAccount",
          "docs": [
            "Fee wallet's token account for this mint"
          ],
          "writable": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
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
      "name": "updateConfig",
      "docs": [
        "Update fee configuration (authority only)"
      ],
      "discriminator": [
        29,
        158,
        252,
        191,
        10,
        83,
        219,
        99
      ],
      "accounts": [
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  48,
                  49,
                  45,
                  102,
                  101,
                  101,
                  45,
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
          "name": "authority",
          "signer": true,
          "relations": [
            "config"
          ]
        }
      ],
      "args": [
        {
          "name": "newFeeBps",
          "type": {
            "option": "u16"
          }
        },
        {
          "name": "newFeeWallet",
          "type": {
            "option": "pubkey"
          }
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "feeConfig",
      "discriminator": [
        143,
        52,
        146,
        187,
        219,
        123,
        76,
        155
      ]
    }
  ],
  "types": [
    {
      "name": "feeConfig",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "authority",
            "docs": [
              "Authority that can update the config"
            ],
            "type": "pubkey"
          },
          {
            "name": "feeWallet",
            "docs": [
              "Wallet that receives fees"
            ],
            "type": "pubkey"
          },
          {
            "name": "feeBps",
            "docs": [
              "Fee in basis points (50 = 0.5%)"
            ],
            "type": "u16"
          },
          {
            "name": "totalFeesCollected",
            "docs": [
              "Total fees collected (for stats)"
            ],
            "type": "u64"
          },
          {
            "name": "totalTransfers",
            "docs": [
              "Total number of transfers processed"
            ],
            "type": "u64"
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
      "name": "splitEvent",
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
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "feeAmount",
            "type": "u64"
          },
          {
            "name": "recipientAmount",
            "type": "u64"
          },
          {
            "name": "tokenMint",
            "type": {
              "option": "pubkey"
            }
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
        125,
        26,
        187,
        212,
        51,
        173,
        228,
        1
      ],
      "name": "splitEvent"
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "feeTooHigh",
      "msg": "Fee exceeds maximum allowed (5%)"
    },
    {
      "code": 6001,
      "name": "amountTooSmall",
      "msg": "Transfer amount too small"
    },
    {
      "code": 6002,
      "name": "mathOverflow",
      "msg": "Math overflow"
    },
    {
      "code": 6003,
      "name": "invalidFeeWallet",
      "msg": "Invalid fee wallet"
    }
  ]
};
