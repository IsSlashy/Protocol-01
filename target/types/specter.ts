/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/specter.json`.
 */
export type Specter = {
  "address": "8rywsvheQZPp8efQ4bsZ37J9GWMLY2ER76f3o8opPsYh",
  "metadata": {
    "name": "p01",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Protocol 01 - Privacy-focused Solana program with stealth payments and streaming"
  },
  "instructions": [
    {
      "name": "cancelStream",
      "docs": [
        "Cancel an active stream and return remaining funds to sender"
      ],
      "discriminator": [
        218,
        221,
        38,
        25,
        177,
        207,
        188,
        91
      ],
      "accounts": [
        {
          "name": "sender",
          "docs": [
            "The sender cancelling the stream"
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "streamAccount",
          "docs": [
            "The stream account"
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  116,
                  114,
                  101,
                  97,
                  109
                ]
              },
              {
                "kind": "account",
                "path": "sender"
              },
              {
                "kind": "account",
                "path": "stream_account.recipient",
                "account": "StreamAccount"
              },
              {
                "kind": "account",
                "path": "stream_account.start_time",
                "account": "StreamAccount"
              }
            ]
          }
        },
        {
          "name": "escrowTokenAccount",
          "docs": [
            "Stream escrow token account (source of remaining funds)"
          ],
          "writable": true
        },
        {
          "name": "senderTokenAccount",
          "docs": [
            "Sender's token account (destination for remaining funds)"
          ],
          "writable": true
        },
        {
          "name": "recipientTokenAccount",
          "docs": [
            "Recipient's token account (for unlocked funds)"
          ],
          "writable": true
        },
        {
          "name": "escrowAuthority",
          "docs": [
            "Escrow authority PDA"
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  116,
                  114,
                  101,
                  97,
                  109,
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
                "path": "stream_account"
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "docs": [
            "Token program"
          ],
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": []
    },
    {
      "name": "claimAirdrop",
      "docs": [
        "Claim tokens from a private airdrop using a SHA-256 Merkle proof."
      ],
      "discriminator": [
        137,
        50,
        122,
        111,
        89,
        254,
        8,
        20
      ],
      "accounts": [
        {
          "name": "claimer",
          "docs": [
            "The recipient claiming the airdrop"
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "campaign",
          "docs": [
            "The airdrop campaign"
          ],
          "writable": true
        },
        {
          "name": "nullifier",
          "docs": [
            "The nullifier PDA — init will fail if this leaf was already claimed"
          ],
          "writable": true
        },
        {
          "name": "escrow",
          "docs": [
            "PDA-owned escrow token account"
          ],
          "writable": true
        },
        {
          "name": "escrowAuthority",
          "docs": [
            "Escrow authority PDA (signs transfers out of escrow)"
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  105,
                  114,
                  100,
                  114,
                  111,
                  112,
                  95,
                  101,
                  115,
                  99,
                  114,
                  111,
                  119,
                  95,
                  97,
                  117,
                  116,
                  104
                ]
              },
              {
                "kind": "account",
                "path": "campaign"
              }
            ]
          }
        },
        {
          "name": "claimerTokenAccount",
          "docs": [
            "Claimer's destination token account"
          ],
          "writable": true
        },
        {
          "name": "tokenProgram",
          "docs": [
            "Token program"
          ],
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "systemProgram",
          "docs": [
            "System program"
          ],
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        },
        {
          "name": "salt",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "leafIndex",
          "type": "u32"
        },
        {
          "name": "proofElements",
          "type": {
            "vec": {
              "array": [
                "u8",
                32
              ]
            }
          }
        },
        {
          "name": "proofIndices",
          "type": "bytes"
        }
      ]
    },
    {
      "name": "claimStealth",
      "docs": [
        "Claim a stealth payment by providing proof of ownership (v1)"
      ],
      "discriminator": [
        17,
        104,
        121,
        216,
        192,
        211,
        31,
        28
      ],
      "accounts": [
        {
          "name": "claimer",
          "docs": [
            "The claimer of the payment"
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "claimerWallet",
          "docs": [
            "Claimer's Protocol 01 wallet (verifies ownership)"
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  48,
                  49,
                  95,
                  119,
                  97,
                  108,
                  108,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "claimer"
              }
            ]
          }
        },
        {
          "name": "stealthAccount",
          "docs": [
            "The stealth account being claimed.",
            "Closed after claim — rent returned to claimer."
          ],
          "writable": true
        },
        {
          "name": "escrowTokenAccount",
          "docs": [
            "Escrow token account holding the funds"
          ],
          "writable": true
        },
        {
          "name": "claimerTokenAccount",
          "docs": [
            "Claimer's token account (destination for funds)"
          ],
          "writable": true
        },
        {
          "name": "escrowAuthority",
          "docs": [
            "Escrow authority PDA"
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  115,
                  99,
                  114,
                  111,
                  119,
                  95,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "stealth_account"
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "docs": [
            "Token program"
          ],
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "systemProgram",
          "docs": [
            "System program"
          ],
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "proof",
          "type": {
            "array": [
              "u8",
              64
            ]
          }
        }
      ]
    },
    {
      "name": "claimStealthV2",
      "docs": [
        "Claim a v2 hybrid stealth payment and close the announcement account.",
        "",
        "After the recipient decapsulates the ML-KEM-768 shared secret and",
        "derives the stealth private key, they call this instruction to:",
        "1. Transfer escrowed tokens to their wallet",
        "2. Close the 1220-byte PDA and reclaim ~0.0093 SOL rent",
        "",
        "Emits: `StealthPaymentClaimed` event."
      ],
      "discriminator": [
        202,
        236,
        15,
        179,
        25,
        216,
        41,
        127
      ],
      "accounts": [
        {
          "name": "claimer",
          "docs": [
            "The claimer of the payment (receives funds + rent refund)"
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "claimerWallet",
          "docs": [
            "Claimer's Protocol 01 wallet (verifies ownership via spending key)"
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  48,
                  49,
                  95,
                  119,
                  97,
                  108,
                  108,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "claimer"
              }
            ]
          }
        },
        {
          "name": "originalSender",
          "docs": [
            "The original sender who created this stealth payment.",
            "Required to re-derive the PDA seeds. Not a signer — just used for",
            "address derivation. The claimer knows this from the creation event."
          ]
        },
        {
          "name": "stealthAccount",
          "docs": [
            "The v2 stealth account being claimed.",
            "`close = claimer` returns the rent-exempt lamports (~0.0093 SOL) to",
            "the claimer after the token transfer completes."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  116,
                  101,
                  97,
                  108,
                  116,
                  104,
                  95,
                  118,
                  50
                ]
              },
              {
                "kind": "account",
                "path": "original_sender"
              },
              {
                "kind": "account",
                "path": "stealth_account.stealth_address",
                "account": "StealthAccountV2"
              }
            ]
          }
        },
        {
          "name": "escrowTokenAccount",
          "docs": [
            "Escrow token account holding the funds"
          ],
          "writable": true
        },
        {
          "name": "claimerTokenAccount",
          "docs": [
            "Claimer's token account (destination for funds)"
          ],
          "writable": true
        },
        {
          "name": "escrowAuthority",
          "docs": [
            "Escrow authority PDA"
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  115,
                  99,
                  114,
                  111,
                  119,
                  95,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121,
                  95,
                  118,
                  50
                ]
              },
              {
                "kind": "account",
                "path": "stealth_account"
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "docs": [
            "Token program"
          ],
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "systemProgram",
          "docs": [
            "System program"
          ],
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "proof",
          "type": {
            "array": [
              "u8",
              64
            ]
          }
        }
      ]
    },
    {
      "name": "closeAirdrop",
      "docs": [
        "Close an expired airdrop campaign and reclaim remaining tokens."
      ],
      "discriminator": [
        85,
        138,
        99,
        129,
        104,
        203,
        94,
        4
      ],
      "accounts": [
        {
          "name": "creator",
          "docs": [
            "The creator who funded the airdrop (receives rent + remaining tokens)"
          ],
          "writable": true,
          "signer": true,
          "relations": [
            "campaign"
          ]
        },
        {
          "name": "campaign",
          "docs": [
            "The airdrop campaign to close"
          ],
          "writable": true
        },
        {
          "name": "escrow",
          "docs": [
            "PDA-owned escrow token account"
          ],
          "writable": true,
          "relations": [
            "campaign"
          ]
        },
        {
          "name": "escrowAuthority",
          "docs": [
            "Escrow authority PDA"
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  105,
                  114,
                  100,
                  114,
                  111,
                  112,
                  95,
                  101,
                  115,
                  99,
                  114,
                  111,
                  119,
                  95,
                  97,
                  117,
                  116,
                  104
                ]
              },
              {
                "kind": "account",
                "path": "campaign"
              }
            ]
          }
        },
        {
          "name": "creatorTokenAccount",
          "docs": [
            "Creator's token account for reclaiming remaining tokens"
          ],
          "writable": true
        },
        {
          "name": "tokenProgram",
          "docs": [
            "Token program"
          ],
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "systemProgram",
          "docs": [
            "System program (for closing accounts)"
          ],
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "createAirdrop",
      "docs": [
        "Create a new Merkle-based private airdrop campaign.",
        "Escrows SPL tokens into a PDA; no recipient data stored on-chain."
      ],
      "discriminator": [
        227,
        135,
        208,
        66,
        137,
        177,
        80,
        94
      ],
      "accounts": [
        {
          "name": "creator",
          "docs": [
            "The creator funding the airdrop"
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "campaign",
          "docs": [
            "The campaign PDA"
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  105,
                  114,
                  100,
                  114,
                  111,
                  112
                ]
              },
              {
                "kind": "account",
                "path": "creator"
              },
              {
                "kind": "arg",
                "path": "campaign_nonce"
              }
            ]
          }
        },
        {
          "name": "escrow",
          "docs": [
            "PDA-owned escrow token account"
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  105,
                  114,
                  100,
                  114,
                  111,
                  112,
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
                "path": "campaign"
              }
            ]
          }
        },
        {
          "name": "escrowAuthority",
          "docs": [
            "Escrow authority PDA (signs transfers out of escrow)"
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  105,
                  114,
                  100,
                  114,
                  111,
                  112,
                  95,
                  101,
                  115,
                  99,
                  114,
                  111,
                  119,
                  95,
                  97,
                  117,
                  116,
                  104
                ]
              },
              {
                "kind": "account",
                "path": "campaign"
              }
            ]
          }
        },
        {
          "name": "tokenMint",
          "docs": [
            "Token mint being airdropped"
          ]
        },
        {
          "name": "creatorTokenAccount",
          "docs": [
            "Creator's source token account"
          ],
          "writable": true
        },
        {
          "name": "tokenProgram",
          "docs": [
            "Token program"
          ],
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "systemProgram",
          "docs": [
            "System program"
          ],
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "rent",
          "docs": [
            "Rent sysvar (required for init token account)"
          ],
          "address": "SysvarRent111111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "merkleRoot",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "totalAmount",
          "type": "u64"
        },
        {
          "name": "totalRecipients",
          "type": "u32"
        },
        {
          "name": "name",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "expiresInSeconds",
          "type": "i64"
        },
        {
          "name": "campaignNonce",
          "type": {
            "array": [
              "u8",
              16
            ]
          }
        }
      ]
    },
    {
      "name": "createStream",
      "docs": [
        "Create a new streaming payment"
      ],
      "discriminator": [
        71,
        188,
        111,
        127,
        108,
        40,
        229,
        158
      ],
      "accounts": [
        {
          "name": "sender",
          "docs": [
            "The sender creating the stream"
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "senderWallet",
          "docs": [
            "Sender's Protocol 01 wallet (optional, for private streams)"
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  48,
                  49,
                  95,
                  119,
                  97,
                  108,
                  108,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "sender"
              }
            ]
          }
        },
        {
          "name": "recipient",
          "docs": [
            "The recipient of the stream"
          ]
        },
        {
          "name": "streamAccount",
          "docs": [
            "The stream account PDA to be created"
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  116,
                  114,
                  101,
                  97,
                  109
                ]
              },
              {
                "kind": "account",
                "path": "sender"
              },
              {
                "kind": "account",
                "path": "recipient"
              },
              {
                "kind": "arg",
                "path": "stream_timestamp"
              }
            ]
          }
        },
        {
          "name": "tokenMint",
          "docs": [
            "Token mint for the stream"
          ]
        },
        {
          "name": "senderTokenAccount",
          "docs": [
            "Sender's token account (source of funds)"
          ],
          "writable": true
        },
        {
          "name": "escrowTokenAccount",
          "docs": [
            "Stream escrow token account (holds streamed funds)"
          ],
          "writable": true
        },
        {
          "name": "tokenProgram",
          "docs": [
            "Token program"
          ],
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "systemProgram",
          "docs": [
            "System program"
          ],
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "totalAmount",
          "type": "u64"
        },
        {
          "name": "durationSeconds",
          "type": "i64"
        },
        {
          "name": "isPrivate",
          "type": "bool"
        },
        {
          "name": "streamTimestamp",
          "type": "i64"
        }
      ]
    },
    {
      "name": "initWallet",
      "docs": [
        "Initialize a new Protocol 01 wallet with viewing and spending keys"
      ],
      "discriminator": [
        141,
        132,
        233,
        130,
        168,
        183,
        10,
        119
      ],
      "accounts": [
        {
          "name": "owner",
          "docs": [
            "The user creating the wallet (pays for account creation)"
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "wallet",
          "docs": [
            "The Protocol 01 wallet PDA to be created"
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  48,
                  49,
                  95,
                  119,
                  97,
                  108,
                  108,
                  101,
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
          "docs": [
            "System program for account creation"
          ],
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "viewingKey",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "spendingKey",
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
      "name": "sendPrivate",
      "docs": [
        "Send a private payment using stealth addressing (v1, classical)"
      ],
      "discriminator": [
        209,
        237,
        154,
        164,
        11,
        168,
        154,
        11
      ],
      "accounts": [
        {
          "name": "sender",
          "docs": [
            "The sender of the payment"
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "senderWallet",
          "docs": [
            "Sender's Protocol 01 wallet (for nonce increment)"
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  48,
                  49,
                  95,
                  119,
                  97,
                  108,
                  108,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "sender"
              }
            ]
          }
        },
        {
          "name": "stealthAccount",
          "docs": [
            "The stealth account PDA to be created"
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  116,
                  101,
                  97,
                  108,
                  116,
                  104
                ]
              },
              {
                "kind": "arg",
                "path": "stealth_address"
              }
            ]
          }
        },
        {
          "name": "tokenMint",
          "docs": [
            "Token mint (for SPL tokens, use Pubkey::default() for native SOL)"
          ]
        },
        {
          "name": "senderTokenAccount",
          "docs": [
            "Sender's token account (source of funds)"
          ],
          "writable": true
        },
        {
          "name": "escrowTokenAccount",
          "docs": [
            "Stealth escrow token account (destination for funds)"
          ],
          "writable": true
        },
        {
          "name": "tokenProgram",
          "docs": [
            "Token program"
          ],
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "systemProgram",
          "docs": [
            "System program"
          ],
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        },
        {
          "name": "stealthAddress",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "encryptedAmount",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "decoyLevel",
          "type": "u8"
        }
      ]
    },
    {
      "name": "sendPrivateV2",
      "docs": [
        "Send a hybrid quantum-resistant stealth payment (v2).",
        "",
        "Stores both an X25519 ephemeral public key (32 bytes) and an",
        "ML-KEM-768 ciphertext (1088 bytes) on-chain. The recipient uses",
        "both to derive the stealth private key, ensuring security against",
        "both classical and quantum adversaries.",
        "",
        "PDA size: ~1220 bytes (~0.0093 SOL rent).",
        "The account can be closed after claiming to reclaim rent.",
        "",
        "Emits: `StealthPaymentCreatedV2` event for client-side indexing."
      ],
      "discriminator": [
        175,
        231,
        136,
        235,
        134,
        102,
        54,
        5
      ],
      "accounts": [
        {
          "name": "sender",
          "docs": [
            "The sender of the payment (pays rent + token transfer)"
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "senderWallet",
          "docs": [
            "Sender's Protocol 01 wallet (for nonce increment)"
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  48,
                  49,
                  95,
                  119,
                  97,
                  108,
                  108,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "sender"
              }
            ]
          }
        },
        {
          "name": "stealthAccount",
          "docs": [
            "The v2 stealth account PDA to be created.",
            "~1220 bytes to hold the ML-KEM-768 ciphertext on-chain."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  116,
                  101,
                  97,
                  108,
                  116,
                  104,
                  95,
                  118,
                  50
                ]
              },
              {
                "kind": "account",
                "path": "sender"
              },
              {
                "kind": "arg",
                "path": "stealth_address"
              }
            ]
          }
        },
        {
          "name": "tokenMint",
          "docs": [
            "Token mint (for SPL tokens; use Pubkey::default() for native SOL)"
          ]
        },
        {
          "name": "senderTokenAccount",
          "docs": [
            "Sender's token account (source of funds)"
          ],
          "writable": true
        },
        {
          "name": "escrowTokenAccount",
          "docs": [
            "Stealth escrow token account (destination for funds)"
          ],
          "writable": true
        },
        {
          "name": "tokenProgram",
          "docs": [
            "Token program"
          ],
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "systemProgram",
          "docs": [
            "System program"
          ],
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        },
        {
          "name": "ephemeralPubKey",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "stealthAddress",
          "type": "pubkey"
        },
        {
          "name": "viewTag",
          "type": "u8"
        },
        {
          "name": "kemCiphertext",
          "type": {
            "array": [
              "u8",
              1088
            ]
          }
        }
      ]
    },
    {
      "name": "withdrawStream",
      "docs": [
        "Withdraw available funds from an active stream"
      ],
      "discriminator": [
        211,
        21,
        90,
        92,
        185,
        214,
        88,
        157
      ],
      "accounts": [
        {
          "name": "recipient",
          "docs": [
            "The recipient withdrawing funds"
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "streamAccount",
          "docs": [
            "The stream account"
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  116,
                  114,
                  101,
                  97,
                  109
                ]
              },
              {
                "kind": "account",
                "path": "stream_account.sender",
                "account": "StreamAccount"
              },
              {
                "kind": "account",
                "path": "recipient"
              },
              {
                "kind": "account",
                "path": "stream_account.start_time",
                "account": "StreamAccount"
              }
            ]
          }
        },
        {
          "name": "escrowTokenAccount",
          "docs": [
            "Stream escrow token account (source of funds)"
          ],
          "writable": true
        },
        {
          "name": "recipientTokenAccount",
          "docs": [
            "Recipient's token account (destination for funds)"
          ],
          "writable": true
        },
        {
          "name": "escrowAuthority",
          "docs": [
            "Escrow authority PDA"
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  116,
                  114,
                  101,
                  97,
                  109,
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
                "path": "stream_account"
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "docs": [
            "Token program"
          ],
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": []
    }
  ],
  "accounts": [
    {
      "name": "airdropCampaign",
      "discriminator": [
        235,
        102,
        51,
        70,
        37,
        179,
        248,
        13
      ]
    },
    {
      "name": "airdropNullifier",
      "discriminator": [
        95,
        70,
        126,
        34,
        197,
        63,
        68,
        67
      ]
    },
    {
      "name": "p01Wallet",
      "discriminator": [
        219,
        7,
        56,
        235,
        233,
        113,
        213,
        152
      ]
    },
    {
      "name": "stealthAccount",
      "discriminator": [
        63,
        201,
        251,
        229,
        73,
        101,
        177,
        175
      ]
    },
    {
      "name": "stealthAccountV2",
      "discriminator": [
        48,
        20,
        198,
        61,
        135,
        117,
        154,
        197
      ]
    },
    {
      "name": "streamAccount",
      "discriminator": [
        243,
        60,
        164,
        106,
        199,
        192,
        110,
        53
      ]
    }
  ],
  "types": [
    {
      "name": "airdropCampaign",
      "docs": [
        "An escrow-backed airdrop campaign with a committed Merkle root.",
        "",
        "The recipient list is NEVER stored on-chain. The creator publishes the",
        "Merkle root and escrows tokens; recipients prove inclusion via SHA-256",
        "Merkle proofs at claim time.",
        "",
        "Seeds: `[\"airdrop\", creator, campaign_nonce]`"
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "creator",
            "docs": [
              "Creator who funded the airdrop"
            ],
            "type": "pubkey"
          },
          {
            "name": "tokenMint",
            "docs": [
              "Token mint being airdropped"
            ],
            "type": "pubkey"
          },
          {
            "name": "merkleRoot",
            "docs": [
              "SHA-256 Merkle root of all recipient leaves"
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "totalAmount",
            "docs": [
              "Total amount escrowed"
            ],
            "type": "u64"
          },
          {
            "name": "claimedCount",
            "docs": [
              "Number of recipients who have claimed"
            ],
            "type": "u32"
          },
          {
            "name": "totalRecipients",
            "docs": [
              "Total number of recipients"
            ],
            "type": "u32"
          },
          {
            "name": "escrow",
            "docs": [
              "Escrow token account (PDA-owned)"
            ],
            "type": "pubkey"
          },
          {
            "name": "createdAt",
            "docs": [
              "Campaign creation timestamp"
            ],
            "type": "i64"
          },
          {
            "name": "expiresAt",
            "docs": [
              "Campaign expiry timestamp"
            ],
            "type": "i64"
          },
          {
            "name": "name",
            "docs": [
              "Campaign name (max 32 bytes, UTF-8 padded with zeroes)"
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
              "Whether campaign is active"
            ],
            "type": "bool"
          },
          {
            "name": "bump",
            "docs": [
              "PDA bump"
            ],
            "type": "u8"
          },
          {
            "name": "escrowBump",
            "docs": [
              "Escrow bump"
            ],
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "airdropClaimed",
      "type": {
        "fields": [
          {
            "name": "campaign",
            "type": "pubkey"
          },
          {
            "name": "claimer",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "leafIndex",
            "type": "u32"
          },
          {
            "name": "claimedCount",
            "type": "u32"
          }
        ],
        "kind": "struct"
      }
    },
    {
      "name": "airdropClosed",
      "type": {
        "fields": [
          {
            "name": "campaign",
            "type": "pubkey"
          },
          {
            "name": "creator",
            "type": "pubkey"
          },
          {
            "name": "unclaimedAmount",
            "type": "u64"
          },
          {
            "name": "claimedCount",
            "type": "u32"
          }
        ],
        "kind": "struct"
      }
    },
    {
      "name": "airdropCreated",
      "type": {
        "fields": [
          {
            "name": "campaign",
            "type": "pubkey"
          },
          {
            "name": "creator",
            "type": "pubkey"
          },
          {
            "name": "tokenMint",
            "type": "pubkey"
          },
          {
            "name": "merkleRoot",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "totalAmount",
            "type": "u64"
          },
          {
            "name": "totalRecipients",
            "type": "u32"
          },
          {
            "name": "expiresAt",
            "type": "i64"
          }
        ],
        "kind": "struct"
      }
    },
    {
      "name": "airdropNullifier",
      "docs": [
        "Nullifier PDA that prevents double-claims.",
        "",
        "One is created per (campaign, leaf) pair when a recipient claims.",
        "",
        "Seeds: `[\"airdrop_nullifier\", campaign, nullifier_bytes]`"
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "campaign",
            "docs": [
              "Which campaign this nullifier belongs to"
            ],
            "type": "pubkey"
          },
          {
            "name": "nullifier",
            "docs": [
              "The nullifier hash (SHA-256 of leaf || leaf_index)"
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "claimer",
            "docs": [
              "Who claimed"
            ],
            "type": "pubkey"
          },
          {
            "name": "claimedAt",
            "docs": [
              "When claimed"
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
      "name": "p01Wallet",
      "docs": [
        "P01Wallet - Main wallet account for privacy operations",
        "",
        "This account stores the cryptographic keys needed for stealth addressing",
        "and private payments. The viewing key allows scanning for incoming payments",
        "while the spending key authorizes outgoing transactions."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "owner",
            "docs": [
              "The owner's public key (authority)"
            ],
            "type": "pubkey"
          },
          {
            "name": "viewingKey",
            "docs": [
              "Viewing key for scanning stealth payments (derived from owner's key)",
              "Used to detect incoming stealth payments without revealing the recipient"
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "spendingKey",
            "docs": [
              "Spending key for authorizing outgoing payments",
              "Required to claim stealth payments or send private transactions"
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
              "Nonce for generating unique stealth addresses",
              "Incremented with each outgoing stealth payment"
            ],
            "type": "u64"
          },
          {
            "name": "bump",
            "docs": [
              "PDA bump seed for deterministic address derivation"
            ],
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "stealthAccount",
      "docs": [
        "StealthAccount - One-time stealth payment account (v1, classical)",
        "",
        "This account represents a pending stealth payment that can only be claimed",
        "by the intended recipient who possesses the corresponding private key.",
        "The payment details are encrypted to preserve privacy.",
        "",
        "Rent cost: ~114 bytes total => ~0.0016 SOL rent-exempt minimum"
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "recipientKey",
            "docs": [
              "The derived stealth public key (one-time address)",
              "Generated using ECDH between sender and recipient viewing keys"
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "encryptedAmount",
            "docs": [
              "Encrypted amount using recipient's viewing key",
              "Only the recipient can decrypt this to know the payment amount"
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "tokenMint",
            "docs": [
              "Token mint address (Pubkey::default() for native SOL)"
            ],
            "type": "pubkey"
          },
          {
            "name": "claimed",
            "docs": [
              "Whether this stealth payment has been claimed"
            ],
            "type": "bool"
          },
          {
            "name": "createdAt",
            "docs": [
              "Unix timestamp when the payment was created"
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
    },
    {
      "name": "stealthAccountV2",
      "docs": [
        "StealthAccountV2 - Hybrid quantum-resistant stealth payment account",
        "",
        "Extends the classical stealth payment with an ML-KEM-768 ciphertext so that",
        "payment scanning remains secure even against a cryptographically relevant",
        "quantum computer. The recipient uses both the X25519 ephemeral key AND the",
        "KEM ciphertext to derive the shared secret.",
        "",
        "# Account size breakdown",
        "discriminator                 8",
        "version                       1",
        "ephemeral_pub_key            32   (X25519 ephemeral, used in both v1 & v2)",
        "stealth_address              32   (Pubkey)",
        "view_tag                      1   (quick-scan filter byte, 99.6% rejection)",
        "amount                        8",
        "token_mint                   32   (Pubkey)",
        "slot                          8",
        "claimed                       1",
        "created_at                    8",
        "bump                          1",
        "kem_ciphertext             1088   (ML-KEM-768, fixed per FIPS 203)",
        "─────────────────────────────────",
        "total                      1220 bytes",
        "",
        "Rent cost: ~1220 bytes => ~0.0093 SOL rent-exempt minimum",
        "(vs ~0.0016 SOL for v1 — the KEM ciphertext dominates the cost)",
        "",
        "# Rent reclaim",
        "The KEM ciphertext is only needed until the recipient decapsulates the",
        "shared secret and claims the payment. The `close` attribute on the",
        "claim instruction allows the recipient to close this account and reclaim",
        "the ~0.0093 SOL rent deposit."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "version",
            "docs": [
              "Protocol version — always 2 for this account type"
            ],
            "type": "u8"
          },
          {
            "name": "ephemeralPubKey",
            "docs": [
              "X25519 ephemeral public key generated by the sender.",
              "Used together with `kem_ciphertext` for hybrid key agreement."
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "stealthAddress",
            "docs": [
              "The one-time stealth address (Solana Pubkey) derived by the sender.",
              "The recipient scans for this using their viewing key + view_tag."
            ],
            "type": "pubkey"
          },
          {
            "name": "viewTag",
            "docs": [
              "Single-byte Diffie-Hellman view tag for fast scanning.",
              "Recipients compute view_tag from their viewing key and the ephemeral",
              "key; if it does not match, they skip this payment (99.6% rejection",
              "rate), avoiding expensive KEM decapsulation."
            ],
            "type": "u8"
          },
          {
            "name": "amount",
            "docs": [
              "Payment amount in token base units (lamports for SOL)"
            ],
            "type": "u64"
          },
          {
            "name": "tokenMint",
            "docs": [
              "Token mint address (Pubkey::default() for native SOL)"
            ],
            "type": "pubkey"
          },
          {
            "name": "slot",
            "docs": [
              "Solana slot at which this payment was recorded"
            ],
            "type": "u64"
          },
          {
            "name": "claimed",
            "docs": [
              "Whether this stealth payment has been claimed by the recipient"
            ],
            "type": "bool"
          },
          {
            "name": "createdAt",
            "docs": [
              "Unix timestamp when the payment was created"
            ],
            "type": "i64"
          },
          {
            "name": "bump",
            "docs": [
              "PDA bump seed"
            ],
            "type": "u8"
          },
          {
            "name": "kemCiphertext",
            "docs": [
              "ML-KEM-768 ciphertext (FIPS 203).",
              "Exactly 1088 bytes. The sender encapsulates against the recipient's",
              "ML-KEM public key; the recipient decapsulates to obtain a 32-byte",
              "shared secret that is combined with the X25519 shared secret to derive",
              "the stealth private key."
            ],
            "type": {
              "array": [
                "u8",
                1088
              ]
            }
          }
        ]
      }
    },
    {
      "docs": [
        "Emitted when a stealth payment (v1 or v2) is claimed by the recipient.",
        "The `rent_reclaimed` field indicates whether the account was closed and",
        "rent returned to the claimer."
      ],
      "name": "stealthPaymentClaimed",
      "type": {
        "fields": [
          {
            "docs": [
              "Protocol version of the claimed payment"
            ],
            "name": "version",
            "type": "u8"
          },
          {
            "docs": [
              "The stealth address that was claimed"
            ],
            "name": "stealthAddress",
            "type": "pubkey"
          },
          {
            "docs": [
              "Claimer's wallet address"
            ],
            "name": "claimer",
            "type": "pubkey"
          },
          {
            "docs": [
              "Amount claimed"
            ],
            "name": "amount",
            "type": "u64"
          },
          {
            "docs": [
              "Whether the announcement account was closed (rent reclaimed)"
            ],
            "name": "rentReclaimed",
            "type": "bool"
          }
        ],
        "kind": "struct"
      }
    },
    {
      "docs": [
        "Emitted when a v1 (classical) stealth payment is created.",
        "Clients index these events to find incoming payments without any server."
      ],
      "name": "stealthPaymentCreated",
      "type": {
        "fields": [
          {
            "docs": [
              "Protocol version (always 1 for this event)"
            ],
            "name": "version",
            "type": "u8"
          },
          {
            "docs": [
              "Stealth address (one-time recipient address)"
            ],
            "name": "stealthAddress",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "docs": [
              "Token mint"
            ],
            "name": "tokenMint",
            "type": "pubkey"
          },
          {
            "docs": [
              "Payment amount"
            ],
            "name": "amount",
            "type": "u64"
          },
          {
            "docs": [
              "Block slot"
            ],
            "name": "slot",
            "type": "u64"
          }
        ],
        "kind": "struct"
      }
    },
    {
      "docs": [
        "Emitted when a v2 (hybrid quantum-resistant) stealth payment is created.",
        "",
        "Contains all fields needed for the recipient to:",
        "1. Check view_tag for quick rejection (99.6% filter)",
        "2. Perform X25519 ECDH with ephemeral_pub_key",
        "3. Perform ML-KEM-768 decapsulation on kem_ciphertext",
        "4. Combine both shared secrets to derive the stealth private key",
        "",
        "Clients subscribe to these events with `connection.onLogs()` to find",
        "payments without any relayer or server."
      ],
      "name": "stealthPaymentCreatedV2",
      "type": {
        "fields": [
          {
            "docs": [
              "Protocol version (always 2 for this event)"
            ],
            "name": "version",
            "type": "u8"
          },
          {
            "docs": [
              "X25519 ephemeral public key"
            ],
            "name": "ephemeralPubKey",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "docs": [
              "Derived one-time stealth address"
            ],
            "name": "stealthAddress",
            "type": "pubkey"
          },
          {
            "docs": [
              "View tag for quick scanning (single byte)"
            ],
            "name": "viewTag",
            "type": "u8"
          },
          {
            "docs": [
              "Payment amount in base token units"
            ],
            "name": "amount",
            "type": "u64"
          },
          {
            "docs": [
              "Token mint address"
            ],
            "name": "tokenMint",
            "type": "pubkey"
          },
          {
            "docs": [
              "Block slot"
            ],
            "name": "slot",
            "type": "u64"
          },
          {
            "docs": [
              "ML-KEM-768 ciphertext (1088 bytes)"
            ],
            "name": "kemCiphertext",
            "type": "bytes"
          }
        ],
        "kind": "struct"
      }
    },
    {
      "name": "streamAccount",
      "docs": [
        "StreamAccount - Streaming payment account",
        "",
        "Enables continuous payment streams where funds unlock linearly over time.",
        "Supports both public and private (encrypted) streams."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "sender",
            "docs": [
              "The sender who created and funded the stream"
            ],
            "type": "pubkey"
          },
          {
            "name": "recipient",
            "docs": [
              "The recipient who can withdraw unlocked funds"
            ],
            "type": "pubkey"
          },
          {
            "name": "tokenMint",
            "docs": [
              "Token mint address (Pubkey::default() for native SOL)"
            ],
            "type": "pubkey"
          },
          {
            "name": "totalAmount",
            "docs": [
              "Total amount to be streamed"
            ],
            "type": "u64"
          },
          {
            "name": "withdrawnAmount",
            "docs": [
              "Amount already withdrawn by recipient"
            ],
            "type": "u64"
          },
          {
            "name": "startTime",
            "docs": [
              "Unix timestamp when stream starts"
            ],
            "type": "i64"
          },
          {
            "name": "endTime",
            "docs": [
              "Unix timestamp when stream ends"
            ],
            "type": "i64"
          },
          {
            "name": "isPrivate",
            "docs": [
              "Whether this is a private stream (amount encrypted)"
            ],
            "type": "bool"
          },
          {
            "name": "paused",
            "docs": [
              "Whether the stream is currently paused"
            ],
            "type": "bool"
          },
          {
            "name": "cancelled",
            "docs": [
              "Whether the stream has been cancelled"
            ],
            "type": "bool"
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
  "events": [
    {
      "discriminator": [
        125,
        251,
        195,
        183,
        202,
        126,
        89,
        68
      ],
      "name": "airdropClaimed"
    },
    {
      "discriminator": [
        196,
        85,
        30,
        72,
        165,
        151,
        163,
        126
      ],
      "name": "airdropClosed"
    },
    {
      "discriminator": [
        190,
        219,
        101,
        33,
        208,
        187,
        149,
        96
      ],
      "name": "airdropCreated"
    },
    {
      "discriminator": [
        170,
        22,
        130,
        80,
        233,
        79,
        118,
        6
      ],
      "name": "stealthPaymentClaimed"
    },
    {
      "discriminator": [
        40,
        50,
        97,
        37,
        221,
        150,
        136,
        234
      ],
      "name": "stealthPaymentCreated"
    },
    {
      "discriminator": [
        92,
        215,
        209,
        84,
        64,
        123,
        50,
        238
      ],
      "name": "stealthPaymentCreatedV2"
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "walletAlreadyInitialized",
      "msg": "Wallet already initialized"
    },
    {
      "code": 6001,
      "name": "invalidViewingKey",
      "msg": "Invalid viewing key provided"
    },
    {
      "code": 6002,
      "name": "invalidSpendingKey",
      "msg": "Invalid spending key provided"
    },
    {
      "code": 6003,
      "name": "unauthorizedWalletAccess",
      "msg": "Unauthorized access to wallet"
    },
    {
      "code": 6004,
      "name": "invalidStealthAddress",
      "msg": "Invalid stealth address"
    },
    {
      "code": 6005,
      "name": "stealthAlreadyClaimed",
      "msg": "Stealth payment already claimed"
    },
    {
      "code": 6006,
      "name": "invalidClaimProof",
      "msg": "Invalid claim proof"
    },
    {
      "code": 6007,
      "name": "stealthPaymentExpired",
      "msg": "Stealth payment expired"
    },
    {
      "code": 6008,
      "name": "invalidDecoyLevel",
      "msg": "Invalid decoy level (must be 0-4)"
    },
    {
      "code": 6009,
      "name": "insufficientFundsForStealth",
      "msg": "Insufficient funds for stealth payment"
    },
    {
      "code": 6010,
      "name": "streamNotStarted",
      "msg": "Stream not yet started"
    },
    {
      "code": 6011,
      "name": "streamEnded",
      "msg": "Stream already ended"
    },
    {
      "code": 6012,
      "name": "streamPaused",
      "msg": "Stream is paused"
    },
    {
      "code": 6013,
      "name": "noFundsAvailable",
      "msg": "No funds available to withdraw"
    },
    {
      "code": 6014,
      "name": "streamAlreadyCancelled",
      "msg": "Stream already cancelled"
    },
    {
      "code": 6015,
      "name": "unauthorizedStreamAccess",
      "msg": "Unauthorized stream access"
    },
    {
      "code": 6016,
      "name": "invalidStreamDuration",
      "msg": "Invalid stream duration"
    },
    {
      "code": 6017,
      "name": "invalidStreamAmount",
      "msg": "Invalid stream amount"
    },
    {
      "code": 6018,
      "name": "recipientIsSender",
      "msg": "Stream recipient cannot be sender"
    },
    {
      "code": 6019,
      "name": "streamStillActive",
      "msg": "Stream is still active"
    },
    {
      "code": 6020,
      "name": "invalidTokenMint",
      "msg": "Invalid token mint"
    },
    {
      "code": 6021,
      "name": "tokenTransferFailed",
      "msg": "Token transfer failed"
    },
    {
      "code": 6022,
      "name": "insufficientBalance",
      "msg": "Insufficient token balance"
    },
    {
      "code": 6023,
      "name": "encryptionFailed",
      "msg": "Encryption failed"
    },
    {
      "code": 6024,
      "name": "decryptionFailed",
      "msg": "Decryption failed"
    },
    {
      "code": 6025,
      "name": "invalidSignature",
      "msg": "Invalid signature"
    },
    {
      "code": 6026,
      "name": "proofVerificationFailed",
      "msg": "Proof verification failed"
    },
    {
      "code": 6027,
      "name": "invalidKemCiphertextLength",
      "msg": "Invalid KEM ciphertext length (expected 1088 bytes for ML-KEM-768)"
    },
    {
      "code": 6028,
      "name": "invalidEphemeralPubKey",
      "msg": "Invalid ephemeral public key (must not be all zeros)"
    },
    {
      "code": 6029,
      "name": "invalidViewTag",
      "msg": "Invalid view tag"
    },
    {
      "code": 6030,
      "name": "stealthNotClaimable",
      "msg": "Stealth payment not yet claimable"
    },
    {
      "code": 6031,
      "name": "arithmeticOverflow",
      "msg": "Arithmetic overflow"
    },
    {
      "code": 6032,
      "name": "invalidAccountData",
      "msg": "Invalid account data"
    },
    {
      "code": 6033,
      "name": "accountNotInitialized",
      "msg": "Account not initialized"
    },
    {
      "code": 6034,
      "name": "invalidBumpSeed",
      "msg": "Invalid bump seed"
    }
  ]
};
