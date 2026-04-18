/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/p01_subscription.json`.
 */
export type P01Subscription = {
  "address": "3eDvPJTK2gryh3GhjFgwz94iBsE3hsqZL9ChAFyiBThW",
  "metadata": {
    "name": "p01Subscription",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "P01 Subscription Program - Delegated recurring payments with on-chain validation"
  },
  "docs": [
    "P01 Subscription Program",
    "",
    "Enables delegated recurring payments with on-chain validation.",
    "The subscriber authorizes a merchant to charge their wallet within",
    "defined limits (amount, interval, max payments).",
    "",
    "Key features:",
    "- No escrow: funds stay in subscriber's wallet until payment",
    "- On-chain validation of payment limits",
    "- Subscriber can pause/resume/cancel anytime",
    "- Merchant (or crank) triggers payments",
    "- Privacy options stored for client-side processing"
  ],
  "instructions": [
    {
      "name": "cancelSubscription",
      "docs": [
        "Cancel subscription permanently (subscriber only)",
        "",
        "No further payments can be processed. This action is irreversible.",
        "Also revokes the token delegation."
      ],
      "discriminator": [
        60,
        139,
        189,
        242,
        191,
        208,
        143,
        18
      ],
      "accounts": [
        {
          "name": "subscriber",
          "signer": true
        },
        {
          "name": "subscription",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  117,
                  98,
                  115,
                  99,
                  114,
                  105,
                  112,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "subscription.subscriber",
                "account": "Subscription"
              },
              {
                "kind": "account",
                "path": "subscription.merchant",
                "account": "Subscription"
              },
              {
                "kind": "account",
                "path": "subscription.subscription_id",
                "account": "Subscription"
              }
            ]
          }
        },
        {
          "name": "subscriberTokenAccount",
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
      "name": "closeSubscription",
      "docs": [
        "Close subscription account and reclaim rent (subscriber only)",
        "",
        "Only possible for cancelled or completed subscriptions."
      ],
      "discriminator": [
        33,
        214,
        169,
        135,
        35,
        127,
        78,
        7
      ],
      "accounts": [
        {
          "name": "subscriber",
          "writable": true,
          "signer": true
        },
        {
          "name": "subscription",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  117,
                  98,
                  115,
                  99,
                  114,
                  105,
                  112,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "subscription.subscriber",
                "account": "Subscription"
              },
              {
                "kind": "account",
                "path": "subscription.merchant",
                "account": "Subscription"
              },
              {
                "kind": "account",
                "path": "subscription.subscription_id",
                "account": "Subscription"
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "createSubscription",
      "docs": [
        "Create a new subscription authorization",
        "",
        "The subscriber authorizes the merchant to charge up to `amount_per_period`",
        "every `interval_seconds` for up to `max_payments` times.",
        "",
        "This also delegates tokens to the subscription PDA, allowing automatic",
        "payment execution by any crank/relayer without subscriber signature."
      ],
      "discriminator": [
        65,
        71,
        10,
        60,
        249,
        82,
        197,
        12
      ],
      "accounts": [
        {
          "name": "subscriber",
          "writable": true,
          "signer": true
        },
        {
          "name": "merchant"
        },
        {
          "name": "mint"
        },
        {
          "name": "subscriberTokenAccount",
          "docs": [
            "Subscriber's token account - will be delegated to subscription PDA"
          ],
          "writable": true
        },
        {
          "name": "subscription",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  117,
                  98,
                  115,
                  99,
                  114,
                  105,
                  112,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "subscriber"
              },
              {
                "kind": "account",
                "path": "merchant"
              },
              {
                "kind": "arg",
                "path": "subscription_id"
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
        }
      ],
      "args": [
        {
          "name": "subscriptionId",
          "type": "string"
        },
        {
          "name": "amountPerPeriod",
          "type": "u64"
        },
        {
          "name": "intervalSeconds",
          "type": "i64"
        },
        {
          "name": "maxPayments",
          "type": "u64"
        },
        {
          "name": "subscriptionName",
          "type": "string"
        },
        {
          "name": "amountNoise",
          "type": "u8"
        },
        {
          "name": "timingNoise",
          "type": "u8"
        },
        {
          "name": "useStealthAddress",
          "type": "bool"
        }
      ]
    },
    {
      "name": "pauseSubscription",
      "docs": [
        "Pause subscription (subscriber only)",
        "",
        "Prevents any further payments until resumed."
      ],
      "discriminator": [
        18,
        180,
        147,
        157,
        114,
        60,
        213,
        241
      ],
      "accounts": [
        {
          "name": "subscriber",
          "signer": true
        },
        {
          "name": "subscription",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  117,
                  98,
                  115,
                  99,
                  114,
                  105,
                  112,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "subscription.subscriber",
                "account": "Subscription"
              },
              {
                "kind": "account",
                "path": "subscription.merchant",
                "account": "Subscription"
              },
              {
                "kind": "account",
                "path": "subscription.subscription_id",
                "account": "Subscription"
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "processPayment",
      "docs": [
        "Process a payment for an active subscription",
        "",
        "Can be called by ANYONE (relayer/crank) - no signature required from subscriber.",
        "The subscription PDA acts as delegate authority for the token transfer.",
        "Validates that payment is within the subscription limits."
      ],
      "discriminator": [
        189,
        81,
        30,
        198,
        139,
        186,
        115,
        23
      ],
      "accounts": [
        {
          "name": "payer",
          "docs": [
            "Anyone can trigger payment execution (relayer/crank)",
            "No signature required - the subscription PDA acts as delegate"
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "subscription",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  117,
                  98,
                  115,
                  99,
                  114,
                  105,
                  112,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "subscription.subscriber",
                "account": "Subscription"
              },
              {
                "kind": "account",
                "path": "subscription.merchant",
                "account": "Subscription"
              },
              {
                "kind": "account",
                "path": "subscription.subscription_id",
                "account": "Subscription"
              }
            ]
          }
        },
        {
          "name": "subscriberTokenAccount",
          "docs": [
            "Subscriber's token account - delegated to subscription PDA"
          ],
          "writable": true
        },
        {
          "name": "merchantTokenAccount",
          "docs": [
            "Merchant's token account to receive payment"
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
          "name": "paymentAmount",
          "type": "u64"
        }
      ]
    },
    {
      "name": "renewDelegation",
      "docs": [
        "Renew/extend token delegation for subscription",
        "",
        "Call this when delegated amount is running low (e.g., for unlimited subscriptions)"
      ],
      "discriminator": [
        190,
        218,
        94,
        126,
        252,
        17,
        68,
        110
      ],
      "accounts": [
        {
          "name": "subscriber",
          "signer": true
        },
        {
          "name": "subscription",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  117,
                  98,
                  115,
                  99,
                  114,
                  105,
                  112,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "subscription.subscriber",
                "account": "Subscription"
              },
              {
                "kind": "account",
                "path": "subscription.merchant",
                "account": "Subscription"
              },
              {
                "kind": "account",
                "path": "subscription.subscription_id",
                "account": "Subscription"
              }
            ]
          }
        },
        {
          "name": "subscriberTokenAccount",
          "writable": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "additionalPayments",
          "type": "u64"
        }
      ]
    },
    {
      "name": "resumeSubscription",
      "docs": [
        "Resume a paused subscription (subscriber only)",
        "",
        "Re-enables payments. Next payment is due immediately or at the",
        "previously scheduled time, whichever is later."
      ],
      "discriminator": [
        122,
        92,
        183,
        0,
        139,
        188,
        185,
        71
      ],
      "accounts": [
        {
          "name": "subscriber",
          "signer": true
        },
        {
          "name": "subscription",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  117,
                  98,
                  115,
                  99,
                  114,
                  105,
                  112,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "subscription.subscriber",
                "account": "Subscription"
              },
              {
                "kind": "account",
                "path": "subscription.merchant",
                "account": "Subscription"
              },
              {
                "kind": "account",
                "path": "subscription.subscription_id",
                "account": "Subscription"
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "updatePrivacySettings",
      "docs": [
        "Update privacy settings (subscriber only)"
      ],
      "discriminator": [
        33,
        79,
        91,
        131,
        24,
        125,
        180,
        78
      ],
      "accounts": [
        {
          "name": "subscriber",
          "signer": true
        },
        {
          "name": "subscription",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  117,
                  98,
                  115,
                  99,
                  114,
                  105,
                  112,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "subscription.subscriber",
                "account": "Subscription"
              },
              {
                "kind": "account",
                "path": "subscription.merchant",
                "account": "Subscription"
              },
              {
                "kind": "account",
                "path": "subscription.subscription_id",
                "account": "Subscription"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "amountNoise",
          "type": "u8"
        },
        {
          "name": "timingNoise",
          "type": "u8"
        },
        {
          "name": "useStealthAddress",
          "type": "bool"
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "subscription",
      "discriminator": [
        64,
        7,
        26,
        135,
        102,
        132,
        98,
        33
      ]
    }
  ],
  "types": [
    {
      "name": "delegationRenewed",
      "type": {
        "fields": [
          {
            "name": "subscription",
            "type": "pubkey"
          },
          {
            "name": "subscriber",
            "type": "pubkey"
          },
          {
            "name": "additionalAmount",
            "type": "u64"
          }
        ],
        "kind": "struct"
      }
    },
    {
      "name": "paymentProcessed",
      "type": {
        "fields": [
          {
            "name": "subscription",
            "type": "pubkey"
          },
          {
            "name": "subscriber",
            "type": "pubkey"
          },
          {
            "name": "merchant",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "paymentNumber",
            "type": "u64"
          },
          {
            "name": "totalPaid",
            "type": "u64"
          }
        ],
        "kind": "struct"
      }
    },
    {
      "name": "privacySettingsUpdated",
      "type": {
        "fields": [
          {
            "name": "subscription",
            "type": "pubkey"
          },
          {
            "name": "amountNoise",
            "type": "u8"
          },
          {
            "name": "timingNoise",
            "type": "u8"
          },
          {
            "name": "useStealthAddress",
            "type": "bool"
          }
        ],
        "kind": "struct"
      }
    },
    {
      "name": "subscription",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "subscriber",
            "docs": [
              "The subscriber (payer) who authorized this subscription"
            ],
            "type": "pubkey"
          },
          {
            "name": "merchant",
            "docs": [
              "The merchant (recipient) who receives payments"
            ],
            "type": "pubkey"
          },
          {
            "name": "mint",
            "docs": [
              "Token mint (SOL represented as system program)"
            ],
            "type": "pubkey"
          },
          {
            "name": "subscriptionId",
            "docs": [
              "Unique subscription ID (from dApp)"
            ],
            "type": "string"
          },
          {
            "name": "subscriptionName",
            "docs": [
              "Human-readable name"
            ],
            "type": "string"
          },
          {
            "name": "amountPerPeriod",
            "docs": [
              "Maximum amount per payment period (in token smallest units)"
            ],
            "type": "u64"
          },
          {
            "name": "intervalSeconds",
            "docs": [
              "Minimum seconds between payments"
            ],
            "type": "i64"
          },
          {
            "name": "maxPayments",
            "docs": [
              "Maximum number of payments (0 = unlimited)"
            ],
            "type": "u64"
          },
          {
            "name": "paymentsMade",
            "docs": [
              "Number of payments already processed"
            ],
            "type": "u64"
          },
          {
            "name": "totalPaid",
            "docs": [
              "Total amount paid so far"
            ],
            "type": "u64"
          },
          {
            "name": "createdAt",
            "docs": [
              "Timestamp when subscription was created"
            ],
            "type": "i64"
          },
          {
            "name": "lastPaymentAt",
            "docs": [
              "Timestamp of last payment"
            ],
            "type": "i64"
          },
          {
            "name": "nextPaymentDue",
            "docs": [
              "Timestamp when next payment is allowed"
            ],
            "type": "i64"
          },
          {
            "name": "status",
            "docs": [
              "Current status"
            ],
            "type": {
              "defined": {
                "name": "subscriptionStatus"
              }
            }
          },
          {
            "name": "amountNoise",
            "docs": [
              "Privacy: amount variation percentage (0-20)"
            ],
            "type": "u8"
          },
          {
            "name": "timingNoise",
            "docs": [
              "Privacy: timing variation hours (0-24)"
            ],
            "type": "u8"
          },
          {
            "name": "useStealthAddress",
            "docs": [
              "Privacy: use stealth addresses"
            ],
            "type": "bool"
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
      "name": "subscriptionCancelled",
      "type": {
        "fields": [
          {
            "name": "subscription",
            "type": "pubkey"
          },
          {
            "name": "subscriber",
            "type": "pubkey"
          },
          {
            "name": "merchant",
            "type": "pubkey"
          },
          {
            "name": "paymentsMade",
            "type": "u64"
          },
          {
            "name": "totalPaid",
            "type": "u64"
          }
        ],
        "kind": "struct"
      }
    },
    {
      "name": "subscriptionClosed",
      "type": {
        "fields": [
          {
            "name": "subscription",
            "type": "pubkey"
          },
          {
            "name": "subscriber",
            "type": "pubkey"
          }
        ],
        "kind": "struct"
      }
    },
    {
      "name": "subscriptionCreated",
      "type": {
        "fields": [
          {
            "name": "subscription",
            "type": "pubkey"
          },
          {
            "name": "subscriber",
            "type": "pubkey"
          },
          {
            "name": "merchant",
            "type": "pubkey"
          },
          {
            "name": "subscriptionId",
            "type": "string"
          },
          {
            "name": "amountPerPeriod",
            "type": "u64"
          },
          {
            "name": "intervalSeconds",
            "type": "i64"
          },
          {
            "name": "maxPayments",
            "type": "u64"
          }
        ],
        "kind": "struct"
      }
    },
    {
      "name": "subscriptionPaused",
      "type": {
        "fields": [
          {
            "name": "subscription",
            "type": "pubkey"
          },
          {
            "name": "subscriber",
            "type": "pubkey"
          }
        ],
        "kind": "struct"
      }
    },
    {
      "name": "subscriptionResumed",
      "type": {
        "fields": [
          {
            "name": "subscription",
            "type": "pubkey"
          },
          {
            "name": "subscriber",
            "type": "pubkey"
          }
        ],
        "kind": "struct"
      }
    },
    {
      "name": "subscriptionStatus",
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
    }
  ],
  "constants": [],
  "events": [
    {
      "discriminator": [
        193,
        109,
        199,
        143,
        48,
        112,
        224,
        161
      ],
      "name": "delegationRenewed"
    },
    {
      "discriminator": [
        22,
        109,
        191,
        213,
        83,
        63,
        120,
        219
      ],
      "name": "paymentProcessed"
    },
    {
      "discriminator": [
        112,
        27,
        71,
        241,
        131,
        194,
        69,
        28
      ],
      "name": "privacySettingsUpdated"
    },
    {
      "discriminator": [
        158,
        216,
        233,
        205,
        138,
        62,
        176,
        239
      ],
      "name": "subscriptionCancelled"
    },
    {
      "discriminator": [
        8,
        104,
        17,
        72,
        113,
        51,
        156,
        92
      ],
      "name": "subscriptionClosed"
    },
    {
      "discriminator": [
        215,
        63,
        169,
        25,
        179,
        200,
        180,
        105
      ],
      "name": "subscriptionCreated"
    },
    {
      "discriminator": [
        102,
        112,
        218,
        248,
        248,
        234,
        67,
        152
      ],
      "name": "subscriptionPaused"
    },
    {
      "discriminator": [
        181,
        238,
        107,
        157,
        132,
        237,
        178,
        98
      ],
      "name": "subscriptionResumed"
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "idTooLong",
      "msg": "Subscription ID too long - max 64 characters"
    },
    {
      "code": 6001,
      "name": "invalidAmount",
      "msg": "Invalid amount - must be greater than 0"
    },
    {
      "code": 6002,
      "name": "invalidInterval",
      "msg": "Invalid interval - must be at least 60 seconds"
    },
    {
      "code": 6003,
      "name": "nameTooLong",
      "msg": "Subscription name too long - max 32 characters"
    },
    {
      "code": 6004,
      "name": "invalidAmountNoise",
      "msg": "Amount noise must be 0-20%"
    },
    {
      "code": 6005,
      "name": "invalidTimingNoise",
      "msg": "Timing noise must be 0-24 hours"
    },
    {
      "code": 6006,
      "name": "subscriptionNotActive",
      "msg": "Subscription is not active"
    },
    {
      "code": 6007,
      "name": "subscriptionNotPaused",
      "msg": "Subscription is not paused"
    },
    {
      "code": 6008,
      "name": "alreadyCancelled",
      "msg": "Subscription is already cancelled"
    },
    {
      "code": 6009,
      "name": "paymentTooEarly",
      "msg": "Payment requested too early - interval not elapsed"
    },
    {
      "code": 6010,
      "name": "amountExceedsLimit",
      "msg": "Payment amount exceeds authorized limit"
    },
    {
      "code": 6011,
      "name": "maxPaymentsReached",
      "msg": "Maximum number of payments reached"
    },
    {
      "code": 6012,
      "name": "overflow",
      "msg": "Arithmetic overflow"
    },
    {
      "code": 6013,
      "name": "unauthorizedSubscriber",
      "msg": "Unauthorized - only subscriber can perform this action"
    },
    {
      "code": 6014,
      "name": "unauthorizedPaymentAuthority",
      "msg": "Unauthorized - only merchant can trigger payments"
    },
    {
      "code": 6015,
      "name": "invalidTokenAccount",
      "msg": "Invalid token account"
    },
    {
      "code": 6016,
      "name": "invalidMint",
      "msg": "Invalid token mint"
    },
    {
      "code": 6017,
      "name": "cannotCloseActiveSubscription",
      "msg": "Cannot close an active subscription"
    },
    {
      "code": 6018,
      "name": "noDelegation",
      "msg": "Token account has no delegation - subscription not properly initialized"
    },
    {
      "code": 6019,
      "name": "invalidDelegation",
      "msg": "Token account delegation does not match subscription PDA"
    },
    {
      "code": 6020,
      "name": "insufficientDelegation",
      "msg": "Insufficient delegated amount for payment"
    }
  ]
};
