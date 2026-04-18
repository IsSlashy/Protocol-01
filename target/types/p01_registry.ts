/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/p01_registry.json`.
 */
export type P01Registry = {
  "address": "ET9NrX6RCaNi4Ghr5HsySxMpm4GXQSSw7qZByW5cpLnr",
  "metadata": {
    "name": "p01Registry",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Protocol 01 - Stealth meta-address registry (on-chain address book)"
  },
  "instructions": [
    {
      "name": "deregister",
      "docs": [
        "Close the registry entry and reclaim rent.",
        "Only the owner can delete their own entry."
      ],
      "discriminator": [
        161,
        178,
        39,
        189,
        231,
        224,
        13,
        187
      ],
      "accounts": [
        {
          "name": "owner",
          "writable": true,
          "signer": true,
          "relations": [
            "entry"
          ]
        },
        {
          "name": "entry",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  117,
                  115,
                  101,
                  114,
                  95,
                  114,
                  101,
                  103,
                  105,
                  115,
                  116,
                  114,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "registerV1",
      "docs": [
        "Register a v1 stealth meta-address (classical X25519 only).",
        "",
        "Creates a PDA keyed by the owner's wallet address, storing their",
        "spending and viewing public keys. Anyone can look this up to send",
        "the owner a stealth payment."
      ],
      "discriminator": [
        164,
        207,
        179,
        58,
        126,
        14,
        192,
        139
      ],
      "accounts": [
        {
          "name": "owner",
          "writable": true,
          "signer": true
        },
        {
          "name": "entry",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  117,
                  115,
                  101,
                  114,
                  95,
                  114,
                  101,
                  103,
                  105,
                  115,
                  116,
                  114,
                  121
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
          "name": "spendingPubKey",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "viewingPubKey",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "name",
          "type": "string"
        }
      ]
    },
    {
      "name": "registerV2",
      "docs": [
        "Register a v2 stealth meta-address (hybrid X25519 + ML-KEM-768).",
        "",
        "Same as v1 but also stores the ML-KEM-768 public key for",
        "post-quantum-resistant stealth payments."
      ],
      "discriminator": [
        225,
        250,
        193,
        26,
        37,
        179,
        205,
        76
      ],
      "accounts": [
        {
          "name": "owner",
          "writable": true,
          "signer": true
        },
        {
          "name": "entry",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  117,
                  115,
                  101,
                  114,
                  95,
                  114,
                  101,
                  103,
                  105,
                  115,
                  116,
                  114,
                  121
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
          "name": "spendingPubKey",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "viewingPubKey",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "kemPubKey",
          "type": "bytes"
        },
        {
          "name": "name",
          "type": "string"
        }
      ]
    },
    {
      "name": "updateKeysV1",
      "docs": [
        "Update the stealth meta-address keys (v1).",
        "Only the owner can update their own entry."
      ],
      "discriminator": [
        180,
        120,
        213,
        115,
        213,
        80,
        165,
        10
      ],
      "accounts": [
        {
          "name": "owner",
          "writable": true,
          "signer": true,
          "relations": [
            "entry"
          ]
        },
        {
          "name": "entry",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  117,
                  115,
                  101,
                  114,
                  95,
                  114,
                  101,
                  103,
                  105,
                  115,
                  116,
                  114,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "spendingPubKey",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "viewingPubKey",
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
      "name": "updateKeysV2",
      "docs": [
        "Update the stealth meta-address keys (v2 hybrid).",
        "Only the owner can update their own entry."
      ],
      "discriminator": [
        109,
        4,
        77,
        151,
        180,
        92,
        83,
        101
      ],
      "accounts": [
        {
          "name": "owner",
          "writable": true,
          "signer": true,
          "relations": [
            "entry"
          ]
        },
        {
          "name": "entry",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  117,
                  115,
                  101,
                  114,
                  95,
                  114,
                  101,
                  103,
                  105,
                  115,
                  116,
                  114,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "spendingPubKey",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "viewingPubKey",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "kemPubKey",
          "type": "bytes"
        }
      ]
    },
    {
      "name": "updateName",
      "docs": [
        "Update the display name."
      ],
      "discriminator": [
        70,
        146,
        141,
        213,
        58,
        44,
        119,
        169
      ],
      "accounts": [
        {
          "name": "owner",
          "writable": true,
          "signer": true,
          "relations": [
            "entry"
          ]
        },
        {
          "name": "entry",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  117,
                  115,
                  101,
                  114,
                  95,
                  114,
                  101,
                  103,
                  105,
                  115,
                  116,
                  114,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "name",
          "type": "string"
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "userRegistry",
      "discriminator": [
        37,
        84,
        98,
        14,
        130,
        63,
        210,
        138
      ]
    }
  ],
  "types": [
    {
      "name": "userRegistry",
      "docs": [
        "UserRegistry entry — on-chain stealth meta-address record.",
        "",
        "Allows anyone to look up a user's stealth meta-address by their wallet",
        "address, enabling private payments without out-of-band coordination.",
        "",
        "Supports both v1 (classical X25519 only) and v2 (hybrid X25519 + ML-KEM-768).",
        "",
        "# Account size breakdown",
        "discriminator             8",
        "owner                    32",
        "spending_pub_key         32",
        "viewing_pub_key          32",
        "version                   1",
        "has_kem_key               1",
        "kem_pub_key            1184   (ML-KEM-768, zeroed if v1)",
        "name_len                  4   (u32 Borsh length prefix)",
        "name                     32   (max 32 bytes UTF-8)",
        "created_at                8",
        "updated_at                8",
        "bump                      1",
        "─────────────────────────────",
        "total                  1343 bytes"
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "owner",
            "docs": [
              "The wallet that owns this registry entry"
            ],
            "type": "pubkey"
          },
          {
            "name": "spendingPubKey",
            "docs": [
              "Spending public key (Ed25519, 32 bytes)",
              "Used to derive stealth addresses for this recipient"
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "viewingPubKey",
            "docs": [
              "Viewing public key (X25519, 32 bytes)",
              "Used in ECDH to derive shared secrets for stealth scanning"
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "version",
            "docs": [
              "Meta-address version: 1 = classical, 2 = hybrid (X25519 + ML-KEM)"
            ],
            "type": "u8"
          },
          {
            "name": "hasKemKey",
            "docs": [
              "Whether the KEM public key is populated"
            ],
            "type": "bool"
          },
          {
            "name": "kemPubKey",
            "docs": [
              "ML-KEM-768 public key (1184 bytes, FIPS 203)",
              "Zeroed if version == 1"
            ],
            "type": {
              "array": [
                "u8",
                1184
              ]
            }
          },
          {
            "name": "name",
            "docs": [
              "Optional display name (max 32 bytes UTF-8)"
            ],
            "type": "string"
          },
          {
            "name": "createdAt",
            "docs": [
              "Unix timestamp when this entry was first created"
            ],
            "type": "i64"
          },
          {
            "name": "updatedAt",
            "docs": [
              "Unix timestamp when this entry was last updated"
            ],
            "type": "i64"
          },
          {
            "name": "bump",
            "docs": [
              "PDA bump seed"
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
      "name": "invalidKey",
      "msg": "Key must not be all zeros"
    },
    {
      "code": 6001,
      "name": "invalidKemKey",
      "msg": "ML-KEM-768 public key must be exactly 1184 bytes"
    },
    {
      "code": 6002,
      "name": "nameTooLong",
      "msg": "Display name exceeds 32 bytes"
    }
  ]
};
