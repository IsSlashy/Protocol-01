/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/p01_stream.json`.
 */
export type P01Stream = {
  "address": "C92xDDAtd21ED3MitZJ9dhuyGeig5xVx8Dgg6qrxA3vx",
  "metadata": {
    "name": "p01Stream",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Protocol 01 Stream Payments - Recurring subscription payments on Solana"
  },
  "instructions": [
    {
      "name": "cancelStream",
      "docs": [
        "Cancel stream: first pay accrued intervals to recipient, then refund remainder to sender"
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
          "writable": true,
          "signer": true
        },
        {
          "name": "stream",
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
                "path": "stream.sender",
                "account": "Stream"
              },
              {
                "kind": "account",
                "path": "stream.recipient",
                "account": "Stream"
              },
              {
                "kind": "account",
                "path": "stream.mint",
                "account": "Stream"
              }
            ]
          }
        },
        {
          "name": "escrowTokenAccount",
          "writable": true
        },
        {
          "name": "senderTokenAccount",
          "writable": true
        },
        {
          "name": "recipientTokenAccount",
          "docs": [
            "Recipient's token account — receives accrued but unclaimed intervals on cancel"
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
      "name": "createStream",
      "docs": [
        "Create a new payment stream (subscription)"
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
          "writable": true,
          "signer": true
        },
        {
          "name": "recipient"
        },
        {
          "name": "mint"
        },
        {
          "name": "stream",
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
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "senderTokenAccount",
          "writable": true
        },
        {
          "name": "escrowTokenAccount",
          "writable": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "amountPerInterval",
          "type": "u64"
        },
        {
          "name": "intervalSeconds",
          "type": "i64"
        },
        {
          "name": "totalIntervals",
          "type": "u64"
        },
        {
          "name": "streamName",
          "type": "string"
        }
      ]
    },
    {
      "name": "withdrawFromStream",
      "docs": [
        "Withdraw available funds from stream (called by recipient)"
      ],
      "discriminator": [
        212,
        121,
        131,
        162,
        71,
        89,
        64,
        177
      ],
      "accounts": [
        {
          "name": "recipient",
          "writable": true,
          "signer": true
        },
        {
          "name": "stream",
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
                "path": "stream.sender",
                "account": "Stream"
              },
              {
                "kind": "account",
                "path": "stream.recipient",
                "account": "Stream"
              },
              {
                "kind": "account",
                "path": "stream.mint",
                "account": "Stream"
              }
            ]
          }
        },
        {
          "name": "escrowTokenAccount",
          "writable": true
        },
        {
          "name": "recipientTokenAccount",
          "writable": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": []
    }
  ],
  "accounts": [
    {
      "name": "stream",
      "discriminator": [
        166,
        224,
        59,
        4,
        202,
        10,
        186,
        83
      ]
    }
  ],
  "types": [
    {
      "name": "stream",
      "type": {
        "kind": "struct",
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
            "name": "amountPerInterval",
            "type": "u64"
          },
          {
            "name": "intervalSeconds",
            "type": "i64"
          },
          {
            "name": "totalIntervals",
            "type": "u64"
          },
          {
            "name": "intervalsPaid",
            "type": "u64"
          },
          {
            "name": "createdAt",
            "type": "i64"
          },
          {
            "name": "lastWithdrawalAt",
            "type": "i64"
          },
          {
            "name": "status",
            "type": {
              "defined": {
                "name": "streamStatus"
              }
            }
          },
          {
            "name": "streamName",
            "type": "string"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "streamCancelled",
      "type": {
        "fields": [
          {
            "name": "stream",
            "type": "pubkey"
          },
          {
            "name": "sender",
            "type": "pubkey"
          },
          {
            "name": "refundAmount",
            "type": "u64"
          },
          {
            "name": "accruedAmount",
            "type": "u64"
          }
        ],
        "kind": "struct"
      }
    },
    {
      "name": "streamCreated",
      "type": {
        "fields": [
          {
            "name": "stream",
            "type": "pubkey"
          },
          {
            "name": "sender",
            "type": "pubkey"
          },
          {
            "name": "recipient",
            "type": "pubkey"
          },
          {
            "name": "amountPerInterval",
            "type": "u64"
          },
          {
            "name": "intervalSeconds",
            "type": "i64"
          },
          {
            "name": "totalIntervals",
            "type": "u64"
          },
          {
            "name": "streamName",
            "type": "string"
          }
        ],
        "kind": "struct"
      }
    },
    {
      "name": "streamStatus",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "active"
          },
          {
            "name": "paused"
          },
          {
            "name": "cancelled"
          },
          {
            "name": "completed"
          }
        ]
      }
    },
    {
      "name": "streamWithdrawal",
      "type": {
        "fields": [
          {
            "name": "stream",
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
            "name": "intervalsPaid",
            "type": "u64"
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
        91,
        215,
        29,
        237,
        194,
        6,
        184,
        92
      ],
      "name": "streamCancelled"
    },
    {
      "discriminator": [
        93,
        150,
        91,
        15,
        166,
        8,
        251,
        166
      ],
      "name": "streamCreated"
    },
    {
      "discriminator": [
        184,
        220,
        223,
        250,
        124,
        200,
        202,
        86
      ],
      "name": "streamWithdrawal"
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "invalidAmount",
      "msg": "Invalid amount - must be greater than 0"
    },
    {
      "code": 6001,
      "name": "invalidInterval",
      "msg": "Invalid interval - must be greater than 0"
    },
    {
      "code": 6002,
      "name": "invalidIntervals",
      "msg": "Invalid total intervals - must be greater than 0"
    },
    {
      "code": 6003,
      "name": "nameTooLong",
      "msg": "Stream name too long - max 32 characters"
    },
    {
      "code": 6004,
      "name": "overflow",
      "msg": "Arithmetic overflow"
    },
    {
      "code": 6005,
      "name": "streamNotActive",
      "msg": "Stream is not active"
    },
    {
      "code": 6006,
      "name": "nothingToWithdraw",
      "msg": "Nothing to withdraw yet"
    },
    {
      "code": 6007,
      "name": "invalidEscrowOwner",
      "msg": "Escrow token account owner must be the stream PDA"
    }
  ]
};
