/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/p01_whitelist.json`.
 */
export type P01Whitelist = {
  "address": "5PSYrjBKke4gj8BgBgRKZNXgjmLCnojZ5yuDqUvPiG33",
  "metadata": {
    "name": "p01Whitelist",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Protocol 01 Developer Whitelist Program"
  },
  "instructions": [
    {
      "name": "approveRequest",
      "docs": [
        "Admin approves a request"
      ],
      "discriminator": [
        89,
        68,
        167,
        104,
        93,
        25,
        178,
        205
      ],
      "accounts": [
        {
          "name": "whitelist",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  119,
                  104,
                  105,
                  116,
                  101,
                  108,
                  105,
                  115,
                  116
                ]
              }
            ]
          }
        },
        {
          "name": "whitelistEntry",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  110,
                  116,
                  114,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "whitelist_entry.wallet",
                "account": "WhitelistEntry"
              }
            ]
          }
        },
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "whitelist"
          ]
        }
      ],
      "args": []
    },
    {
      "name": "checkAccess",
      "docs": [
        "Check if a wallet has access (view function)"
      ],
      "discriminator": [
        74,
        62,
        42,
        188,
        96,
        229,
        63,
        50
      ],
      "accounts": [
        {
          "name": "whitelistEntry",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  110,
                  116,
                  114,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "wallet"
              }
            ]
          }
        },
        {
          "name": "wallet"
        }
      ],
      "args": [],
      "returns": "bool"
    },
    {
      "name": "initialize",
      "docs": [
        "Initialize the whitelist with an admin"
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
          "name": "whitelist",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  119,
                  104,
                  105,
                  116,
                  101,
                  108,
                  105,
                  115,
                  116
                ]
              }
            ]
          }
        },
        {
          "name": "admin",
          "writable": true,
          "signer": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "rejectRequest",
      "docs": [
        "Admin rejects a request"
      ],
      "discriminator": [
        11,
        232,
        75,
        149,
        197,
        137,
        152,
        208
      ],
      "accounts": [
        {
          "name": "whitelist",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  119,
                  104,
                  105,
                  116,
                  101,
                  108,
                  105,
                  115,
                  116
                ]
              }
            ]
          }
        },
        {
          "name": "whitelistEntry",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  110,
                  116,
                  114,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "whitelist_entry.wallet",
                "account": "WhitelistEntry"
              }
            ]
          }
        },
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "whitelist"
          ]
        }
      ],
      "args": [
        {
          "name": "reason",
          "type": "string"
        }
      ]
    },
    {
      "name": "requestAccess",
      "docs": [
        "Developer requests access (stores encrypted email IPFS CID)"
      ],
      "discriminator": [
        102,
        165,
        38,
        148,
        139,
        189,
        106,
        47
      ],
      "accounts": [
        {
          "name": "whitelist",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  119,
                  104,
                  105,
                  116,
                  101,
                  108,
                  105,
                  115,
                  116
                ]
              }
            ]
          }
        },
        {
          "name": "whitelistEntry",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  110,
                  116,
                  114,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "developer"
              }
            ]
          }
        },
        {
          "name": "developer",
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
          "name": "ipfsCid",
          "type": "string"
        },
        {
          "name": "projectName",
          "type": "string"
        }
      ]
    },
    {
      "name": "revokeAccess",
      "docs": [
        "Admin revokes access"
      ],
      "discriminator": [
        106,
        128,
        38,
        169,
        103,
        238,
        102,
        147
      ],
      "accounts": [
        {
          "name": "whitelist",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  119,
                  104,
                  105,
                  116,
                  101,
                  108,
                  105,
                  115,
                  116
                ]
              }
            ]
          }
        },
        {
          "name": "whitelistEntry",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  110,
                  116,
                  114,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "whitelist_entry.wallet",
                "account": "WhitelistEntry"
              }
            ]
          }
        },
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "whitelist"
          ]
        }
      ],
      "args": []
    }
  ],
  "accounts": [
    {
      "name": "whitelist",
      "discriminator": [
        204,
        176,
        52,
        79,
        146,
        121,
        54,
        247
      ]
    },
    {
      "name": "whitelistEntry",
      "discriminator": [
        51,
        70,
        173,
        81,
        219,
        192,
        234,
        62
      ]
    }
  ],
  "types": [
    {
      "name": "whitelist",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "admin",
            "type": "pubkey"
          },
          {
            "name": "totalRequests",
            "type": "u64"
          },
          {
            "name": "totalApproved",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "whitelistEntry",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "wallet",
            "type": "pubkey"
          },
          {
            "name": "ipfsCid",
            "type": "string"
          },
          {
            "name": "projectName",
            "type": "string"
          },
          {
            "name": "status",
            "type": {
              "defined": {
                "name": "whitelistStatus"
              }
            }
          },
          {
            "name": "requestedAt",
            "type": "i64"
          },
          {
            "name": "reviewedAt",
            "type": "i64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "whitelistStatus",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "pending"
          },
          {
            "name": "approved"
          },
          {
            "name": "rejected"
          },
          {
            "name": "revoked"
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
      "name": "ipfsCidTooLong",
      "msg": "IPFS CID too long (max 64 chars)"
    },
    {
      "code": 6001,
      "name": "projectNameTooLong",
      "msg": "Project name too long (max 64 chars)"
    },
    {
      "code": 6002,
      "name": "reasonTooLong",
      "msg": "Rejection reason too long (max 128 chars)"
    },
    {
      "code": 6003,
      "name": "notPending",
      "msg": "Request is not pending"
    },
    {
      "code": 6004,
      "name": "notApproved",
      "msg": "Request is not approved"
    }
  ]
};
