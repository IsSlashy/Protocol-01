/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/p01_relayer.json`.
 */
export type P01Relayer = {
  "address": "Ud2JYaq4frePBy3L2DmddmtPT3nXC1nqxsXEX934Hbw",
  "metadata": {
    "name": "p01Relayer",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Protocol 01 - Decentralized Relayer Network"
  },
  "instructions": [
    {
      "name": "cancelJob",
      "docs": [
        "Cancel a pending job. Only the original submitter can cancel."
      ],
      "discriminator": [
        126,
        241,
        155,
        241,
        50,
        236,
        83,
        118
      ],
      "accounts": [
        {
          "name": "submitter",
          "docs": [
            "Must be the original submitter"
          ],
          "writable": true,
          "signer": true,
          "relations": [
            "job"
          ]
        },
        {
          "name": "job",
          "docs": [
            "The job to cancel — all lamports returned to submitter via close"
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  108,
                  97,
                  121,
                  95,
                  106,
                  111,
                  98
                ]
              },
              {
                "kind": "account",
                "path": "job.job_id",
                "account": "RelayJob"
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "completeJob",
      "docs": [
        "Relayer reports successful job completion with the tx signature."
      ],
      "discriminator": [
        221,
        216,
        225,
        72,
        101,
        250,
        3,
        11
      ],
      "accounts": [
        {
          "name": "operator",
          "docs": [
            "Relayer's operator wallet (receives relayer reward)"
          ],
          "writable": true,
          "signer": true,
          "relations": [
            "relayer_node"
          ]
        },
        {
          "name": "config",
          "docs": [
            "Relayer config (for fee calculation and global stats)"
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  108,
                  97,
                  121,
                  101,
                  114,
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
          "name": "relayerNode",
          "docs": [
            "The relayer node completing the job"
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  108,
                  97,
                  121,
                  101,
                  114,
                  95,
                  110,
                  111,
                  100,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "operator"
              }
            ]
          }
        },
        {
          "name": "job",
          "docs": [
            "The job being completed"
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  108,
                  97,
                  121,
                  95,
                  106,
                  111,
                  98
                ]
              },
              {
                "kind": "account",
                "path": "job.job_id",
                "account": "RelayJob"
              }
            ]
          }
        },
        {
          "name": "protocolFeeWallet",
          "docs": [
            "Protocol fee wallet (receives protocol cut)"
          ],
          "writable": true
        },
        {
          "name": "submitter",
          "docs": [
            "Original job submitter (receives rent back from closed account)"
          ],
          "writable": true
        }
      ],
      "args": [
        {
          "name": "txSignature",
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
      "name": "deactivateRelayer",
      "docs": [
        "Deactivate this relayer (stops accepting jobs, begins cooldown)."
      ],
      "discriminator": [
        225,
        50,
        154,
        4,
        136,
        194,
        35,
        91
      ],
      "accounts": [
        {
          "name": "operator",
          "docs": [
            "Must be the relayer's operator"
          ],
          "signer": true,
          "relations": [
            "relayer_node"
          ]
        },
        {
          "name": "config",
          "docs": [
            "Relayer config (for decrementing active count)"
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  108,
                  97,
                  121,
                  101,
                  114,
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
          "name": "relayerNode",
          "docs": [
            "Relayer node to deactivate"
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  108,
                  97,
                  121,
                  101,
                  114,
                  95,
                  110,
                  111,
                  100,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "operator"
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "expireJob",
      "docs": [
        "Expire a timed-out job. Permissionless — anyone can call this.",
        "Refunds the fee to the submitter and slashes the relayer."
      ],
      "discriminator": [
        127,
        5,
        119,
        250,
        214,
        255,
        102,
        168
      ],
      "accounts": [
        {
          "name": "cranker",
          "docs": [
            "Anyone can call this (cranker / permissionless)"
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "docs": [
            "Relayer config (for slash_amount)"
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  108,
                  97,
                  121,
                  101,
                  114,
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
          "name": "relayerNode",
          "docs": [
            "The relayer that was assigned (gets slashed)"
          ],
          "writable": true
        },
        {
          "name": "job",
          "docs": [
            "The expired job — fee + rent returned to submitter via close"
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  108,
                  97,
                  121,
                  95,
                  106,
                  111,
                  98
                ]
              },
              {
                "kind": "account",
                "path": "job.job_id",
                "account": "RelayJob"
              }
            ]
          }
        },
        {
          "name": "submitter",
          "docs": [
            "Original submitter (receives fee refund + rent + slash)"
          ],
          "writable": true
        }
      ],
      "args": []
    },
    {
      "name": "initializeConfig",
      "docs": [
        "Initialize the global relayer config. Called once by the deployer."
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
          "docs": [
            "Admin who will control the relayer config"
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "docs": [
            "Relayer config PDA (singleton)"
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  108,
                  97,
                  121,
                  101,
                  114,
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
          "docs": [
            "System program"
          ],
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "minStake",
          "type": "u64"
        },
        {
          "name": "maxRelayers",
          "type": "u16"
        },
        {
          "name": "jobFeeLamports",
          "type": "u64"
        },
        {
          "name": "protocolFeeBps",
          "type": "u16"
        },
        {
          "name": "protocolFeeWallet",
          "type": "pubkey"
        },
        {
          "name": "jobTimeoutSlots",
          "type": "u64"
        },
        {
          "name": "slashAmount",
          "type": "u64"
        },
        {
          "name": "cooldownSlots",
          "type": "u64"
        }
      ]
    },
    {
      "name": "registerRelayer",
      "docs": [
        "Register as a relayer by staking SOL and providing encryption key(s).",
        "Provide `kem_encryption_key` (1184 bytes) for hybrid post-quantum encryption."
      ],
      "discriminator": [
        98,
        213,
        0,
        0,
        27,
        134,
        109,
        48
      ],
      "accounts": [
        {
          "name": "operator",
          "docs": [
            "Operator wallet funding the stake"
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "docs": [
            "Relayer config (must be active, must have capacity)"
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  108,
                  97,
                  121,
                  101,
                  114,
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
          "name": "relayerNode",
          "docs": [
            "Relayer node PDA (created on registration)"
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  108,
                  97,
                  121,
                  101,
                  114,
                  95,
                  110,
                  111,
                  100,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "operator"
              }
            ]
          }
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
          "name": "encryptionKey",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "endpointHash",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "kemEncryptionKey",
          "type": {
            "option": "bytes"
          }
        }
      ]
    },
    {
      "name": "submitJob",
      "docs": [
        "Submit an encrypted relay job. The submitter should be an ephemeral",
        "keypair to avoid linking the job to the user's main wallet."
      ],
      "discriminator": [
        250,
        129,
        161,
        132,
        254,
        161,
        34,
        107
      ],
      "accounts": [
        {
          "name": "submitter",
          "docs": [
            "User submitting the relay job (pays fee + rent)"
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "docs": [
            "Relayer config (must be active)"
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  108,
                  97,
                  121,
                  101,
                  114,
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
          "name": "assignedRelayer",
          "docs": [
            "Assigned relayer (must be active and meet minimum reputation)"
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  108,
                  97,
                  121,
                  101,
                  114,
                  95,
                  110,
                  111,
                  100,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "assigned_relayer.operator",
                "account": "RelayerNode"
              }
            ]
          }
        },
        {
          "name": "job",
          "docs": [
            "Relay job PDA (created on submission)"
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  108,
                  97,
                  121,
                  95,
                  106,
                  111,
                  98
                ]
              },
              {
                "kind": "arg",
                "path": "job_id"
              }
            ]
          }
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
          "name": "jobId",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "encryptedTx",
          "type": "bytes"
        }
      ]
    },
    {
      "name": "unstakeRelayer",
      "docs": [
        "Unstake SOL after cooldown period and close the relayer account."
      ],
      "discriminator": [
        31,
        52,
        81,
        89,
        151,
        184,
        210,
        232
      ],
      "accounts": [
        {
          "name": "operator",
          "docs": [
            "Must be the relayer's operator (receives stake + rent)"
          ],
          "writable": true,
          "signer": true,
          "relations": [
            "relayer_node"
          ]
        },
        {
          "name": "config",
          "docs": [
            "Relayer config (for cooldown_slots)"
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  108,
                  97,
                  121,
                  101,
                  114,
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
          "name": "relayerNode",
          "docs": [
            "Relayer node to close. Stake + rent returned to operator."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  108,
                  97,
                  121,
                  101,
                  114,
                  95,
                  110,
                  111,
                  100,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "operator"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "docs": [
            "System program"
          ],
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "updateConfig",
      "docs": [
        "Update protocol configuration parameters."
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
          "name": "authority",
          "docs": [
            "Must be the current config authority"
          ],
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "docs": [
            "Relayer config PDA"
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  108,
                  97,
                  121,
                  101,
                  114,
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
      "args": [
        {
          "name": "minStake",
          "type": {
            "option": "u64"
          }
        },
        {
          "name": "maxRelayers",
          "type": {
            "option": "u16"
          }
        },
        {
          "name": "jobFeeLamports",
          "type": {
            "option": "u64"
          }
        },
        {
          "name": "protocolFeeBps",
          "type": {
            "option": "u16"
          }
        },
        {
          "name": "protocolFeeWallet",
          "type": {
            "option": "pubkey"
          }
        },
        {
          "name": "jobTimeoutSlots",
          "type": {
            "option": "u64"
          }
        },
        {
          "name": "slashAmount",
          "type": {
            "option": "u64"
          }
        },
        {
          "name": "cooldownSlots",
          "type": {
            "option": "u64"
          }
        },
        {
          "name": "isActive",
          "type": {
            "option": "bool"
          }
        }
      ]
    },
    {
      "name": "updateRelayerKey",
      "docs": [
        "Rotate the relayer's encryption key(s).",
        "Provide `new_kem_encryption_key` (1184 bytes) to update the ML-KEM-768 key."
      ],
      "discriminator": [
        221,
        55,
        243,
        128,
        130,
        17,
        93,
        14
      ],
      "accounts": [
        {
          "name": "operator",
          "docs": [
            "Must be the relayer's operator"
          ],
          "signer": true,
          "relations": [
            "relayer_node"
          ]
        },
        {
          "name": "relayerNode",
          "docs": [
            "Relayer node to update"
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  108,
                  97,
                  121,
                  101,
                  114,
                  95,
                  110,
                  111,
                  100,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "operator"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "newEncryptionKey",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "newKemEncryptionKey",
          "type": {
            "option": "bytes"
          }
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "relayJob",
      "discriminator": [
        114,
        75,
        116,
        238,
        235,
        161,
        128,
        202
      ]
    },
    {
      "name": "relayerConfig",
      "discriminator": [
        116,
        239,
        42,
        132,
        218,
        154,
        194,
        20
      ]
    },
    {
      "name": "relayerNode",
      "discriminator": [
        106,
        225,
        66,
        97,
        26,
        244,
        209,
        150
      ]
    }
  ],
  "types": [
    {
      "name": "jobCancelledEvent",
      "type": {
        "fields": [
          {
            "name": "jobId",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "submitter",
            "type": "pubkey"
          }
        ],
        "kind": "struct"
      }
    },
    {
      "name": "jobCompletedEvent",
      "type": {
        "fields": [
          {
            "name": "jobId",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "relayer",
            "type": "pubkey"
          },
          {
            "name": "txSignature",
            "type": {
              "array": [
                "u8",
                64
              ]
            }
          },
          {
            "name": "relayerReward",
            "type": "u64"
          },
          {
            "name": "protocolFee",
            "type": "u64"
          }
        ],
        "kind": "struct"
      }
    },
    {
      "name": "jobExpiredEvent",
      "type": {
        "fields": [
          {
            "name": "jobId",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "relayer",
            "type": "pubkey"
          },
          {
            "name": "slashAmount",
            "type": "u64"
          }
        ],
        "kind": "struct"
      }
    },
    {
      "name": "jobStatus",
      "docs": [
        "Status of a relay job."
      ],
      "repr": {
        "kind": "rust"
      },
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "pending"
          },
          {
            "name": "completed"
          },
          {
            "name": "expired"
          },
          {
            "name": "cancelled"
          }
        ]
      }
    },
    {
      "name": "jobSubmittedEvent",
      "type": {
        "fields": [
          {
            "name": "jobId",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "assignedRelayer",
            "type": "pubkey"
          },
          {
            "name": "fee",
            "type": "u64"
          },
          {
            "name": "deadlineSlot",
            "type": "u64"
          }
        ],
        "kind": "struct"
      }
    },
    {
      "name": "relayJob",
      "docs": [
        "An encrypted relay job submitted by a privacy-seeking user.",
        "The relayer decrypts and submits the transaction on behalf of the submitter.",
        "",
        "PDA seeds: [b\"relay_job\", job_id.as_ref()]"
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "jobId",
            "docs": [
              "Unique job identifier (32 bytes)"
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "encryptedTx",
            "docs": [
              "Encrypted serialized transaction (max ~1232 bytes)"
            ],
            "type": "bytes"
          },
          {
            "name": "assignedRelayer",
            "docs": [
              "Relayer node PDA assigned to this job"
            ],
            "type": "pubkey"
          },
          {
            "name": "submitter",
            "docs": [
              "Ephemeral keypair that posted the job"
            ],
            "type": "pubkey"
          },
          {
            "name": "feeLamports",
            "docs": [
              "Fee deposited (in lamports)"
            ],
            "type": "u64"
          },
          {
            "name": "postedAtSlot",
            "docs": [
              "Slot when the job was posted"
            ],
            "type": "u64"
          },
          {
            "name": "deadlineSlot",
            "docs": [
              "Must be completed by this slot"
            ],
            "type": "u64"
          },
          {
            "name": "status",
            "docs": [
              "Current job status"
            ],
            "type": {
              "defined": {
                "name": "jobStatus"
              }
            }
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
      "name": "relayerConfig",
      "docs": [
        "Global configuration for the relayer network.",
        "Controls registration parameters, fees, slashing, and emergency shutdown.",
        "",
        "PDA seeds: [b\"relayer_config\"]"
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "authority",
            "docs": [
              "Admin who can update config"
            ],
            "type": "pubkey"
          },
          {
            "name": "minStake",
            "docs": [
              "Minimum SOL lamports to register as a relayer (e.g., 5 SOL = 5_000_000_000)"
            ],
            "type": "u64"
          },
          {
            "name": "maxRelayers",
            "docs": [
              "Maximum number of active relayers in the network"
            ],
            "type": "u16"
          },
          {
            "name": "jobFeeLamports",
            "docs": [
              "Base relay fee paid per job (in lamports)"
            ],
            "type": "u64"
          },
          {
            "name": "protocolFeeBps",
            "docs": [
              "Protocol cut from fees in basis points (e.g., 500 = 5%)"
            ],
            "type": "u16"
          },
          {
            "name": "protocolFeeWallet",
            "docs": [
              "Wallet where protocol fees are sent"
            ],
            "type": "pubkey"
          },
          {
            "name": "jobTimeoutSlots",
            "docs": [
              "Slots before a job expires (e.g., 300 = ~2 min at 400ms/slot)"
            ],
            "type": "u64"
          },
          {
            "name": "slashAmount",
            "docs": [
              "Lamports slashed for misbehavior"
            ],
            "type": "u64"
          },
          {
            "name": "cooldownSlots",
            "docs": [
              "Slots to wait after deactivation before unstaking"
            ],
            "type": "u64"
          },
          {
            "name": "activeRelayerCount",
            "docs": [
              "Current count of active relayers"
            ],
            "type": "u16"
          },
          {
            "name": "totalJobsCompleted",
            "docs": [
              "Global stats: total jobs completed across all relayers"
            ],
            "type": "u64"
          },
          {
            "name": "isActive",
            "docs": [
              "Emergency kill switch"
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
    },
    {
      "name": "relayerNode",
      "docs": [
        "A registered relayer node in the network.",
        "Operators stake SOL and receive encrypted relay jobs.",
        "",
        "PDA seeds: [b\"relayer_node\", operator.key().as_ref()]"
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "operator",
            "docs": [
              "Wallet that controls this relayer"
            ],
            "type": "pubkey"
          },
          {
            "name": "encryptionKey",
            "docs": [
              "X25519 public key for classical job encryption (v1)"
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "stake",
            "docs": [
              "SOL lamports staked (held by this PDA)"
            ],
            "type": "u64"
          },
          {
            "name": "jobsCompleted",
            "docs": [
              "Number of successfully completed jobs"
            ],
            "type": "u64"
          },
          {
            "name": "jobsFailed",
            "docs": [
              "Number of failed or expired jobs"
            ],
            "type": "u64"
          },
          {
            "name": "lastActiveSlot",
            "docs": [
              "Last slot at which a job was completed"
            ],
            "type": "u64"
          },
          {
            "name": "registeredAt",
            "docs": [
              "Unix timestamp when this relayer was registered"
            ],
            "type": "i64"
          },
          {
            "name": "deactivatedAtSlot",
            "docs": [
              "Slot when deactivated (0 if currently active)"
            ],
            "type": "u64"
          },
          {
            "name": "isActive",
            "docs": [
              "Whether this relayer is currently accepting jobs"
            ],
            "type": "bool"
          },
          {
            "name": "reputationScore",
            "docs": [
              "Reputation score on a 0-10000 scale"
            ],
            "type": "u32"
          },
          {
            "name": "endpointHash",
            "docs": [
              "SHA-256 hash of the relayer's public endpoint URL"
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "hasKemKey",
            "docs": [
              "Whether this relayer has an ML-KEM-768 public key for hybrid encryption"
            ],
            "type": "bool"
          },
          {
            "name": "kemEncryptionKey",
            "docs": [
              "ML-KEM-768 public key for hybrid post-quantum job encryption (v2)",
              "All zeros if has_kem_key is false."
            ],
            "type": {
              "array": [
                "u8",
                1184
              ]
            }
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
      "name": "relayerRegisteredEvent",
      "type": {
        "fields": [
          {
            "name": "relayer",
            "type": "pubkey"
          },
          {
            "name": "operator",
            "type": "pubkey"
          },
          {
            "name": "stake",
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
        177,
        124,
        38,
        55,
        156,
        135,
        184,
        247
      ],
      "name": "jobCancelledEvent"
    },
    {
      "discriminator": [
        120,
        0,
        106,
        73,
        221,
        122,
        51,
        43
      ],
      "name": "jobCompletedEvent"
    },
    {
      "discriminator": [
        159,
        231,
        204,
        203,
        2,
        117,
        56,
        8
      ],
      "name": "jobExpiredEvent"
    },
    {
      "discriminator": [
        139,
        4,
        31,
        215,
        250,
        11,
        74,
        84
      ],
      "name": "jobSubmittedEvent"
    },
    {
      "discriminator": [
        145,
        107,
        62,
        237,
        228,
        45,
        135,
        112
      ],
      "name": "relayerRegisteredEvent"
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "unauthorized",
      "msg": "Unauthorized: signer is not the authority"
    },
    {
      "code": 6001,
      "name": "relayerNotActive",
      "msg": "Relayer is not active"
    },
    {
      "code": 6002,
      "name": "maxRelayersReached",
      "msg": "Maximum number of relayers reached"
    },
    {
      "code": 6003,
      "name": "insufficientStake",
      "msg": "Insufficient stake amount"
    },
    {
      "code": 6004,
      "name": "jobNotPending",
      "msg": "Job is not in Pending status"
    },
    {
      "code": 6005,
      "name": "jobNotExpired",
      "msg": "Job has not expired yet"
    },
    {
      "code": 6006,
      "name": "jobAlreadyCompleted",
      "msg": "Job is already completed"
    },
    {
      "code": 6007,
      "name": "cooldownNotElapsed",
      "msg": "Cooldown period has not elapsed"
    },
    {
      "code": 6008,
      "name": "invalidFee",
      "msg": "Invalid fee amount"
    },
    {
      "code": 6009,
      "name": "protocolPaused",
      "msg": "Protocol is paused"
    },
    {
      "code": 6010,
      "name": "encryptedTxTooLarge",
      "msg": "Encrypted transaction data exceeds maximum size"
    },
    {
      "code": 6011,
      "name": "invalidRelayerAssignment",
      "msg": "Relayer assignment does not match"
    },
    {
      "code": 6012,
      "name": "relayerStillActive",
      "msg": "Relayer is still active — deactivate first"
    },
    {
      "code": 6013,
      "name": "jobExpired",
      "msg": "Job deadline has passed"
    },
    {
      "code": 6014,
      "name": "invalidSubmitter",
      "msg": "Submitter does not match job submitter"
    },
    {
      "code": 6015,
      "name": "arithmeticOverflow",
      "msg": "Arithmetic overflow"
    },
    {
      "code": 6016,
      "name": "invalidEncryptionKey",
      "msg": "Invalid encryption key size (expected 1184 bytes for ML-KEM-768)"
    },
    {
      "code": 6017,
      "name": "insufficientReputation",
      "msg": "Relayer reputation score is below minimum required for job assignment"
    }
  ]
};
