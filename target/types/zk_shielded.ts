/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/zk_shielded.json`.
 */
export type ZkShielded = {
  "address": "GbVM5yvetrSD194Hnn1BXnR56F8ZWNKnij7DoVP9j27c",
  "metadata": {
    "name": "zkShielded",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Protocol 01 - ZK Shielded Pool with Groth16 verification"
  },
  "instructions": [
    {
      "name": "acceptAuthorityTransfer",
      "docs": [
        "Accept a pending authority transfer (proposed authority only)"
      ],
      "discriminator": [
        239,
        248,
        177,
        2,
        206,
        97,
        46,
        255
      ],
      "accounts": [
        {
          "name": "newAuthority",
          "docs": [
            "The proposed new authority (must match pending_authority)"
          ],
          "signer": true
        },
        {
          "name": "shieldedPool",
          "docs": [
            "Shielded pool with pending transfer"
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  104,
                  105,
                  101,
                  108,
                  100,
                  101,
                  100,
                  95,
                  112,
                  111,
                  111,
                  108
                ]
              },
              {
                "kind": "account",
                "path": "shielded_pool.token_mint",
                "account": "ShieldedPool"
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "cancelNormal",
      "docs": [
        "Cancel a normal subscription vault, refund remaining to subscriber"
      ],
      "discriminator": [
        202,
        166,
        254,
        74,
        18,
        84,
        99,
        206
      ],
      "accounts": [
        {
          "name": "subscriber",
          "docs": [
            "Subscriber cancelling the vault"
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "retailer",
          "docs": [
            "Retailer receives any outstanding claimable periods"
          ],
          "writable": true
        },
        {
          "name": "vault",
          "docs": [
            "Subscription vault (closed after cancellation)"
          ],
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
                "path": "vault.retailer",
                "account": "SubscriptionVault"
              },
              {
                "kind": "account",
                "path": "vault"
              },
              {
                "kind": "account",
                "path": "vault.token_mint",
                "account": "SubscriptionVault"
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
          "name": "vaultTokenAccount",
          "docs": [
            "Vault's token account (optional, only for SPL tokens)"
          ],
          "writable": true,
          "optional": true
        },
        {
          "name": "subscriberTokenAccount",
          "docs": [
            "Subscriber's token account (optional, only for SPL tokens)"
          ],
          "writable": true,
          "optional": true
        },
        {
          "name": "retailerTokenAccount",
          "docs": [
            "Retailer's token account (optional, only for SPL tokens)"
          ],
          "writable": true,
          "optional": true
        }
      ],
      "args": []
    },
    {
      "name": "cancelPrivateStark",
      "docs": [
        "Cancel a private subscription vault using STARK proof (quantum-resistant).",
        "Re-shields remaining funds back into the source denominated pool."
      ],
      "discriminator": [
        148,
        95,
        195,
        37,
        192,
        187,
        155,
        218
      ],
      "accounts": [
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "retailer",
          "docs": [
            "Retailer receives outstanding claimable periods"
          ],
          "writable": true
        },
        {
          "name": "vault",
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
                "path": "vault.retailer",
                "account": "SubscriptionVault"
              },
              {
                "kind": "account",
                "path": "vault"
              },
              {
                "kind": "account",
                "path": "vault.token_mint",
                "account": "SubscriptionVault"
              }
            ]
          }
        },
        {
          "name": "denominatedPool",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  100,
                  101,
                  110,
                  111,
                  109,
                  105,
                  110,
                  97,
                  116,
                  101,
                  100,
                  95,
                  112,
                  111,
                  111,
                  108
                ]
              },
              {
                "kind": "account",
                "path": "denominated_pool.token_mint",
                "account": "DenominatedPool"
              },
              {
                "kind": "account",
                "path": "denominated_pool.denomination",
                "account": "DenominatedPool"
              }
            ]
          }
        },
        {
          "name": "merkleTree",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  101,
                  114,
                  107,
                  108,
                  101,
                  95,
                  116,
                  114,
                  101,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "denominated_pool"
              }
            ]
          }
        },
        {
          "name": "starkProofBuffer",
          "docs": [
            "STARK proof buffer from p01_stark_verifier (circuit 0: subscriber_ownership).",
            "- Owner is p01_stark_verifier program",
            "- Discriminator matches ProofBuffer",
            "- Authority matches payer",
            "- Circuit ID is 0 (subscriber_ownership)",
            "- Verified flag is true",
            "- Public inputs hash matches vault commitment"
          ],
          "writable": true
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
          "name": "vaultTokenAccount",
          "writable": true,
          "optional": true
        },
        {
          "name": "poolVault",
          "writable": true,
          "optional": true
        },
        {
          "name": "retailerTokenAccount",
          "writable": true,
          "optional": true
        }
      ],
      "args": [
        {
          "name": "newCommitments",
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
          "name": "newRoots",
          "type": {
            "vec": {
              "array": [
                "u8",
                32
              ]
            }
          }
        }
      ]
    },
    {
      "name": "checkCompliance",
      "docs": [
        "Check whether a compliance attestation is currently valid.",
        "Returns Ok(true) if valid, or an error if expired/revoked/unverified."
      ],
      "discriminator": [
        233,
        217,
        116,
        46,
        226,
        224,
        62,
        42
      ],
      "accounts": [
        {
          "name": "attestation",
          "docs": [
            "The attestation to check (read-only)"
          ]
        }
      ],
      "args": [],
      "returns": "bool"
    },
    {
      "name": "claimPeriod",
      "docs": [
        "Claim accrued periods from a subscription vault (retailer only)"
      ],
      "discriminator": [
        72,
        126,
        164,
        101,
        190,
        210,
        66,
        82
      ],
      "accounts": [
        {
          "name": "retailer",
          "docs": [
            "Retailer claiming the payment"
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "vault",
          "docs": [
            "Subscription vault"
          ],
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
                "path": "vault.retailer",
                "account": "SubscriptionVault"
              },
              {
                "kind": "account",
                "path": "vault"
              },
              {
                "kind": "account",
                "path": "vault.token_mint",
                "account": "SubscriptionVault"
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
            "Token program (optional, for SPL token transfers)"
          ],
          "optional": true,
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "vaultTokenAccount",
          "docs": [
            "Vault's token account (optional, only for SPL tokens)"
          ],
          "writable": true,
          "optional": true
        },
        {
          "name": "retailerTokenAccount",
          "docs": [
            "Retailer's token account (optional, only for SPL tokens)"
          ],
          "writable": true,
          "optional": true
        }
      ],
      "args": []
    },
    {
      "name": "emergencyUnshieldDenominatedStark",
      "docs": [
        "Emergency unshield from a denominated pool using STARK (quantum-resistant).",
        "Bypasses the on-chain maturity check. Emits is_emergency=true — reduces",
        "anonymity set for this withdrawal."
      ],
      "discriminator": [
        212,
        58,
        186,
        224,
        37,
        212,
        143,
        4
      ],
      "accounts": [
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "recipient",
          "writable": true
        },
        {
          "name": "denominatedPool",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  100,
                  101,
                  110,
                  111,
                  109,
                  105,
                  110,
                  97,
                  116,
                  101,
                  100,
                  95,
                  112,
                  111,
                  111,
                  108
                ]
              },
              {
                "kind": "account",
                "path": "denominated_pool.token_mint",
                "account": "DenominatedPool"
              },
              {
                "kind": "account",
                "path": "denominated_pool.denomination",
                "account": "DenominatedPool"
              }
            ]
          }
        },
        {
          "name": "merkleTree",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  101,
                  114,
                  107,
                  108,
                  101,
                  95,
                  116,
                  114,
                  101,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "denominated_pool"
              }
            ]
          }
        },
        {
          "name": "nullifierRecord",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  110,
                  117,
                  108,
                  108,
                  105,
                  102,
                  105,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "denominated_pool"
              },
              {
                "kind": "arg",
                "path": "nullifier"
              }
            ]
          }
        },
        {
          "name": "starkProofBuffer",
          "docs": [
            "STARK proof buffer from p01_stark_verifier (circuit 1: pool_commitment)."
          ]
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
          "name": "poolVault",
          "writable": true,
          "optional": true
        },
        {
          "name": "recipientTokenAccount",
          "writable": true,
          "optional": true
        },
        {
          "name": "protocolFeeWallet",
          "docs": [
            "Protocol fee wallet — receives unshield fee (0.5%)"
          ],
          "writable": true
        }
      ],
      "args": [
        {
          "name": "nullifier",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
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
          "name": "minEpoch",
          "type": "u64"
        },
        {
          "name": "starkCommitment",
          "type": "u64"
        }
      ]
    },
    {
      "name": "escrowRelease",
      "docs": [
        "Release an auction escrow after the Arcium MPC settles the auction.",
        "Inserts the correct commitment (pay or refund) into the Merkle tree.",
        "Permissionless: anyone can crank once outcome is set."
      ],
      "discriminator": [
        121,
        64,
        131,
        15,
        26,
        229,
        125,
        230
      ],
      "accounts": [
        {
          "name": "payer",
          "docs": [
            "Anyone can crank (permissionless)"
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "denominatedPool",
          "docs": [
            "Denominated pool"
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  100,
                  101,
                  110,
                  111,
                  109,
                  105,
                  110,
                  97,
                  116,
                  101,
                  100,
                  95,
                  112,
                  111,
                  111,
                  108
                ]
              },
              {
                "kind": "account",
                "path": "denominated_pool.token_mint",
                "account": "DenominatedPool"
              },
              {
                "kind": "account",
                "path": "denominated_pool.denomination",
                "account": "DenominatedPool"
              }
            ]
          }
        },
        {
          "name": "merkleTree",
          "docs": [
            "Merkle tree state (mutable — commitment is inserted)"
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  101,
                  114,
                  107,
                  108,
                  101,
                  95,
                  116,
                  114,
                  101,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "denominated_pool"
              }
            ]
          }
        },
        {
          "name": "auctionEscrow",
          "docs": [
            "Auction escrow PDA"
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  117,
                  99,
                  116,
                  105,
                  111,
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
                "path": "auction_escrow.auction_id",
                "account": "AuctionEscrow"
              },
              {
                "kind": "account",
                "path": "auction_escrow.nullifier",
                "account": "AuctionEscrow"
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
          "name": "newRoot",
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
      "name": "escrowShield",
      "docs": [
        "Lock a denominated pool note into escrow for a sealed-bid auction.",
        "Consumes the old note (nullifier) and stores two conditional commitments:",
        "pay_commitment (seller wins) and refund_commitment (bidder loses)."
      ],
      "discriminator": [
        251,
        10,
        81,
        89,
        55,
        114,
        95,
        223
      ],
      "accounts": [
        {
          "name": "payer",
          "docs": [
            "Transaction submitter (bidder or relayer)"
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "denominatedPool",
          "docs": [
            "Denominated pool"
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  100,
                  101,
                  110,
                  111,
                  109,
                  105,
                  110,
                  97,
                  116,
                  101,
                  100,
                  95,
                  112,
                  111,
                  111,
                  108
                ]
              },
              {
                "kind": "account",
                "path": "denominated_pool.token_mint",
                "account": "DenominatedPool"
              },
              {
                "kind": "account",
                "path": "denominated_pool.denomination",
                "account": "DenominatedPool"
              }
            ]
          }
        },
        {
          "name": "merkleTree",
          "docs": [
            "Merkle tree state (read-only — no insertion during escrow)"
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  101,
                  114,
                  107,
                  108,
                  101,
                  95,
                  116,
                  114,
                  101,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "denominated_pool"
              }
            ]
          }
        },
        {
          "name": "nullifierRecord",
          "docs": [
            "Nullifier record PDA — marks old note as spent"
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  110,
                  117,
                  108,
                  108,
                  105,
                  102,
                  105,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "denominated_pool"
              },
              {
                "kind": "arg",
                "path": "nullifier"
              }
            ]
          }
        },
        {
          "name": "auctionEscrow",
          "docs": [
            "Auction escrow PDA — stores both conditional commitments"
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  117,
                  99,
                  116,
                  105,
                  111,
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
                "kind": "arg",
                "path": "auction_id"
              },
              {
                "kind": "arg",
                "path": "nullifier"
              }
            ]
          }
        },
        {
          "name": "verificationKeyData",
          "docs": [
            "Escrow circuit verification key data account"
          ]
        },
        {
          "name": "systemProgram",
          "docs": [
            "System program (required for PDA creation)"
          ],
          "address": "11111111111111111111111111111111"
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
          "name": "nullifier",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
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
          "name": "minEpoch",
          "type": "u64"
        },
        {
          "name": "auctionId",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "payCommitment",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "refundCommitment",
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
      "name": "initDenominatedPool",
      "docs": [
        "Initialize a denominated shielded pool for a specific token + denomination",
        "Each pool enforces a fixed deposit/withdrawal amount for maximum anonymity"
      ],
      "discriminator": [
        110,
        80,
        50,
        183,
        183,
        189,
        124,
        227
      ],
      "accounts": [
        {
          "name": "authority",
          "docs": [
            "Authority that will manage the pool"
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "denominatedPool",
          "docs": [
            "Denominated pool account (PDA)"
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  100,
                  101,
                  110,
                  111,
                  109,
                  105,
                  110,
                  97,
                  116,
                  101,
                  100,
                  95,
                  112,
                  111,
                  111,
                  108
                ]
              },
              {
                "kind": "arg",
                "path": "token_mint"
              },
              {
                "kind": "arg",
                "path": "denomination"
              }
            ]
          }
        },
        {
          "name": "merkleTree",
          "docs": [
            "Merkle tree state account (PDA derived from pool key)"
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  101,
                  114,
                  107,
                  108,
                  101,
                  95,
                  116,
                  114,
                  101,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "denominated_pool"
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
        },
        {
          "name": "rent",
          "docs": [
            "Rent sysvar"
          ],
          "address": "SysvarRent111111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "vkHash",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "tokenMint",
          "type": "pubkey"
        },
        {
          "name": "denomination",
          "type": "u64"
        },
        {
          "name": "epochDelay",
          "type": "u64"
        }
      ]
    },
    {
      "name": "initEscrowVkData",
      "docs": [
        "Initialize escrow VK data account (PDA owned by this program)."
      ],
      "discriminator": [
        113,
        76,
        143,
        192,
        217,
        118,
        141,
        105
      ],
      "accounts": [
        {
          "name": "authority",
          "writable": true,
          "signer": true
        },
        {
          "name": "denominatedPool",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  100,
                  101,
                  110,
                  111,
                  109,
                  105,
                  110,
                  97,
                  116,
                  101,
                  100,
                  95,
                  112,
                  111,
                  111,
                  108
                ]
              },
              {
                "kind": "account",
                "path": "denominated_pool.token_mint",
                "account": "DenominatedPool"
              },
              {
                "kind": "account",
                "path": "denominated_pool.denomination",
                "account": "DenominatedPool"
              }
            ]
          }
        },
        {
          "name": "vkDataAccount",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  107,
                  95,
                  100,
                  97,
                  116,
                  97,
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
                "path": "denominated_pool"
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
          "name": "vkSize",
          "type": "u32"
        }
      ]
    },
    {
      "name": "initVkData",
      "docs": [
        "Initialize VK data account (admin only)",
        "Creates a PDA for storing verification key bytes"
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
          "docs": [
            "Pool authority (must sign)"
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "shieldedPool",
          "docs": [
            "Shielded pool"
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  104,
                  105,
                  101,
                  108,
                  100,
                  101,
                  100,
                  95,
                  112,
                  111,
                  111,
                  108
                ]
              },
              {
                "kind": "account",
                "path": "shielded_pool.token_mint",
                "account": "ShieldedPool"
              }
            ]
          }
        },
        {
          "name": "vkDataAccount",
          "docs": [
            "VK data account (PDA owned by this program)"
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  107,
                  95,
                  100,
                  97,
                  116,
                  97
                ]
              },
              {
                "kind": "account",
                "path": "shielded_pool"
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
          "name": "vkSize",
          "type": "u32"
        }
      ]
    },
    {
      "name": "initializePool",
      "docs": [
        "Initialize a new shielded pool for a specific token",
        "For native SOL, pass System Program ID as token_mint"
      ],
      "discriminator": [
        95,
        180,
        10,
        172,
        84,
        174,
        232,
        40
      ],
      "accounts": [
        {
          "name": "authority",
          "docs": [
            "Authority that will manage the pool"
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "shieldedPool",
          "docs": [
            "Shielded pool account (PDA)"
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  104,
                  105,
                  101,
                  108,
                  100,
                  101,
                  100,
                  95,
                  112,
                  111,
                  111,
                  108
                ]
              },
              {
                "kind": "arg",
                "path": "token_mint"
              }
            ]
          }
        },
        {
          "name": "merkleTree",
          "docs": [
            "Merkle tree state account (PDA)"
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  101,
                  114,
                  107,
                  108,
                  101,
                  95,
                  116,
                  114,
                  101,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "shielded_pool"
              }
            ]
          }
        },
        {
          "name": "nullifierSet",
          "docs": [
            "Nullifier set account (PDA) - zero-copy for large bloom filter"
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  110,
                  117,
                  108,
                  108,
                  105,
                  102,
                  105,
                  101,
                  114,
                  95,
                  115,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "shielded_pool"
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
        },
        {
          "name": "rent",
          "docs": [
            "Rent sysvar"
          ],
          "address": "SysvarRent111111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "vkHash",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "tokenMint",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "pauseNormal",
      "docs": [
        "Pause a normal subscription vault (subscriber wallet signature)"
      ],
      "discriminator": [
        43,
        231,
        246,
        191,
        150,
        44,
        145,
        217
      ],
      "accounts": [
        {
          "name": "subscriber",
          "docs": [
            "Subscriber pausing the vault"
          ],
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
                "path": "vault.retailer",
                "account": "SubscriptionVault"
              },
              {
                "kind": "account",
                "path": "vault"
              },
              {
                "kind": "account",
                "path": "vault.token_mint",
                "account": "SubscriptionVault"
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "pausePrivateStark",
      "docs": [
        "Pause a private subscription vault using STARK proof (quantum-resistant)"
      ],
      "discriminator": [
        250,
        28,
        28,
        225,
        119,
        226,
        122,
        125
      ],
      "accounts": [
        {
          "name": "payer",
          "docs": [
            "Transaction payer (can be anyone — enables relayer pattern)"
          ],
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
                "path": "vault.retailer",
                "account": "SubscriptionVault"
              },
              {
                "kind": "account",
                "path": "vault"
              },
              {
                "kind": "account",
                "path": "vault.token_mint",
                "account": "SubscriptionVault"
              }
            ]
          }
        },
        {
          "name": "starkProofBuffer",
          "docs": [
            "STARK proof buffer from p01_stark_verifier (circuit 0: subscriber_ownership).",
            "Must be verified (verified == true) and owned by the payer.",
            "- Owner is p01_stark_verifier program",
            "- Discriminator matches ProofBuffer",
            "- Authority matches payer",
            "- Circuit ID is 0 (subscriber_ownership)",
            "- Verified flag is true",
            "- Public inputs hash matches vault commitment",
            "Marked mut because we invalidate (set verified=false) after use."
          ],
          "writable": true
        }
      ],
      "args": []
    },
    {
      "name": "proposeAuthorityTransfer",
      "docs": [
        "Propose a two-step authority transfer (current authority only)"
      ],
      "discriminator": [
        57,
        206,
        225,
        129,
        35,
        111,
        174,
        145
      ],
      "accounts": [
        {
          "name": "authority",
          "docs": [
            "Current pool authority"
          ],
          "signer": true
        },
        {
          "name": "shieldedPool",
          "docs": [
            "Shielded pool to transfer"
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  104,
                  105,
                  101,
                  108,
                  100,
                  101,
                  100,
                  95,
                  112,
                  111,
                  111,
                  108
                ]
              },
              {
                "kind": "account",
                "path": "shielded_pool.token_mint",
                "account": "ShieldedPool"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "newAuthority",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "resizeDenominatedPool",
      "docs": [
        "Resize an existing denominated pool to accommodate new fields"
      ],
      "discriminator": [
        209,
        62,
        156,
        226,
        191,
        178,
        38,
        78
      ],
      "accounts": [
        {
          "name": "authority",
          "docs": [
            "Pool authority (pays for realloc rent)"
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "denominatedPool",
          "writable": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "resumeNormal",
      "docs": [
        "Resume a normal subscription vault (subscriber wallet signature)"
      ],
      "discriminator": [
        162,
        100,
        129,
        11,
        23,
        108,
        21,
        208
      ],
      "accounts": [
        {
          "name": "subscriber",
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
                "path": "vault.retailer",
                "account": "SubscriptionVault"
              },
              {
                "kind": "account",
                "path": "vault"
              },
              {
                "kind": "account",
                "path": "vault.token_mint",
                "account": "SubscriptionVault"
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "resumePrivateStark",
      "docs": [
        "Resume a private subscription vault using STARK proof (quantum-resistant)"
      ],
      "discriminator": [
        70,
        90,
        69,
        143,
        17,
        191,
        82,
        130
      ],
      "accounts": [
        {
          "name": "payer",
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
                "path": "vault.retailer",
                "account": "SubscriptionVault"
              },
              {
                "kind": "account",
                "path": "vault"
              },
              {
                "kind": "account",
                "path": "vault.token_mint",
                "account": "SubscriptionVault"
              }
            ]
          }
        },
        {
          "name": "starkProofBuffer",
          "docs": [
            "STARK proof buffer from p01_stark_verifier (circuit 0: subscriber_ownership).",
            "Must be verified (verified == true) and owned by the payer.",
            "- Owner is p01_stark_verifier program",
            "- Discriminator matches ProofBuffer",
            "- Authority matches payer",
            "- Circuit ID is 0 (subscriber_ownership)",
            "- Verified flag is true",
            "- Public inputs hash matches vault commitment",
            "Marked mut because we invalidate (set verified=false) after use."
          ],
          "writable": true
        }
      ],
      "args": []
    },
    {
      "name": "revokeAttestation",
      "docs": [
        "Revoke a previously issued compliance attestation (authority only)."
      ],
      "discriminator": [
        12,
        156,
        103,
        161,
        194,
        246,
        211,
        179
      ],
      "accounts": [
        {
          "name": "authority",
          "docs": [
            "Only the original authority can revoke"
          ],
          "signer": true
        },
        {
          "name": "attestation",
          "docs": [
            "The attestation to revoke"
          ],
          "writable": true
        }
      ],
      "args": []
    },
    {
      "name": "shield",
      "docs": [
        "Shield tokens: deposit transparent tokens into the shielded pool",
        "Creates a new note commitment and adds it to the Merkle tree",
        "The new_root is computed off-chain (Poseidon syscall not yet enabled on devnet)"
      ],
      "discriminator": [
        220,
        198,
        253,
        246,
        231,
        84,
        147,
        98
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
          "name": "shieldedPool",
          "docs": [
            "Shielded pool"
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  104,
                  105,
                  101,
                  108,
                  100,
                  101,
                  100,
                  95,
                  112,
                  111,
                  111,
                  108
                ]
              },
              {
                "kind": "account",
                "path": "shielded_pool.token_mint",
                "account": "ShieldedPool"
              }
            ]
          }
        },
        {
          "name": "merkleTree",
          "docs": [
            "Merkle tree state"
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  101,
                  114,
                  107,
                  108,
                  101,
                  95,
                  116,
                  114,
                  101,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "shielded_pool"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "docs": [
            "System program (required for native SOL transfers)"
          ],
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "tokenProgram",
          "docs": [
            "Token program (optional, for SPL token transfers)"
          ],
          "optional": true,
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "userTokenAccount",
          "docs": [
            "User's token account (optional, only for SPL tokens)"
          ],
          "writable": true,
          "optional": true
        },
        {
          "name": "poolVault",
          "docs": [
            "Pool's token vault (optional, only for SPL tokens)",
            "When present, ownership is validated in handler (vault authority must be pool PDA)."
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
          "name": "commitment",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "newRoot",
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
      "name": "shieldDenominated",
      "docs": [
        "Shield tokens into a denominated pool (deposit exactly denomination amount)",
        "Commitment = Poseidon(nullifier_preimage, secret, deposit_epoch, token_mint)",
        "No amount in the commitment — denomination enforced at program level"
      ],
      "discriminator": [
        149,
        186,
        236,
        93,
        191,
        61,
        119,
        100
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
          "name": "denominatedPool",
          "docs": [
            "Denominated pool"
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  100,
                  101,
                  110,
                  111,
                  109,
                  105,
                  110,
                  97,
                  116,
                  101,
                  100,
                  95,
                  112,
                  111,
                  111,
                  108
                ]
              },
              {
                "kind": "account",
                "path": "denominated_pool.token_mint",
                "account": "DenominatedPool"
              },
              {
                "kind": "account",
                "path": "denominated_pool.denomination",
                "account": "DenominatedPool"
              }
            ]
          }
        },
        {
          "name": "merkleTree",
          "docs": [
            "Merkle tree state"
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  101,
                  114,
                  107,
                  108,
                  101,
                  95,
                  116,
                  114,
                  101,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "denominated_pool"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "docs": [
            "System program (required for native SOL transfers)"
          ],
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "tokenProgram",
          "docs": [
            "Token program (optional, for SPL token transfers)"
          ],
          "optional": true,
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "userTokenAccount",
          "docs": [
            "User's token account (optional, only for SPL tokens)"
          ],
          "writable": true,
          "optional": true
        },
        {
          "name": "poolVault",
          "docs": [
            "Pool's token vault (optional, only for SPL tokens)"
          ],
          "writable": true,
          "optional": true
        },
        {
          "name": "protocolFeeWallet",
          "docs": [
            "Protocol fee wallet — receives shield fee (0.3%)"
          ],
          "writable": true
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
          "name": "newRoot",
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
      "name": "splitNoteStark",
      "docs": [
        "Split a note into multiple notes in a lower-denomination pool using STARK",
        "(quantum-resistant). Uses circuit 1 for source ownership; output commitments",
        "are bound by the payer's signature on the instruction data."
      ],
      "discriminator": [
        46,
        174,
        111,
        191,
        110,
        189,
        159,
        82
      ],
      "accounts": [
        {
          "name": "payer",
          "docs": [
            "Transaction submitter — must be the note owner (signs to bind output commitments)."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "sourcePool",
          "docs": [
            "SOURCE pool — the high-denomination pool where the note is consumed."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  100,
                  101,
                  110,
                  111,
                  109,
                  105,
                  110,
                  97,
                  116,
                  101,
                  100,
                  95,
                  112,
                  111,
                  111,
                  108
                ]
              },
              {
                "kind": "account",
                "path": "source_pool.token_mint",
                "account": "DenominatedPool"
              },
              {
                "kind": "account",
                "path": "source_pool.denomination",
                "account": "DenominatedPool"
              }
            ]
          }
        },
        {
          "name": "sourceMerkleTree",
          "docs": [
            "SOURCE Merkle tree (read-only)"
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  101,
                  114,
                  107,
                  108,
                  101,
                  95,
                  116,
                  114,
                  101,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "source_pool"
              }
            ]
          }
        },
        {
          "name": "targetPool",
          "docs": [
            "TARGET pool — the lower-denomination pool where new notes are created."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  100,
                  101,
                  110,
                  111,
                  109,
                  105,
                  110,
                  97,
                  116,
                  101,
                  100,
                  95,
                  112,
                  111,
                  111,
                  108
                ]
              },
              {
                "kind": "account",
                "path": "target_pool.token_mint",
                "account": "DenominatedPool"
              },
              {
                "kind": "account",
                "path": "target_pool.denomination",
                "account": "DenominatedPool"
              }
            ]
          }
        },
        {
          "name": "targetMerkleTree",
          "docs": [
            "TARGET Merkle tree (mutated — new commitments are inserted here)."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  101,
                  114,
                  107,
                  108,
                  101,
                  95,
                  116,
                  114,
                  101,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "target_pool"
              }
            ]
          }
        },
        {
          "name": "nullifierRecord",
          "docs": [
            "Nullifier record PDA — created (init) on first use."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  110,
                  117,
                  108,
                  108,
                  105,
                  102,
                  105,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "source_pool"
              },
              {
                "kind": "arg",
                "path": "nullifier"
              }
            ]
          }
        },
        {
          "name": "starkProofBuffer",
          "docs": [
            "STARK proof buffer from p01_stark_verifier (circuit 1: pool_commitment)."
          ]
        },
        {
          "name": "protocolFeeWallet",
          "docs": [
            "Protocol fee wallet — receives split fee (0.3%)."
          ],
          "writable": true
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
          "name": "sourcePoolVault",
          "writable": true,
          "optional": true
        },
        {
          "name": "targetPoolVault",
          "writable": true,
          "optional": true
        }
      ],
      "args": [
        {
          "name": "nullifier",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
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
          "name": "minEpoch",
          "type": "u64"
        },
        {
          "name": "starkCommitment",
          "type": "u64"
        },
        {
          "name": "numOutputs",
          "type": "u8"
        },
        {
          "name": "outputCommitments",
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
          "name": "newRoots",
          "type": {
            "vec": {
              "array": [
                "u8",
                32
              ]
            }
          }
        }
      ]
    },
    {
      "name": "subscribeNormal",
      "docs": [
        "Create a normal (wallet-based) subscription vault",
        "Deposits funds from subscriber wallet into vault PDA"
      ],
      "discriminator": [
        209,
        213,
        161,
        124,
        160,
        102,
        28,
        139
      ],
      "accounts": [
        {
          "name": "subscriber",
          "docs": [
            "Subscriber depositing funds"
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "retailer",
          "docs": [
            "Retailer who will receive periodic payments"
          ]
        },
        {
          "name": "vault",
          "docs": [
            "Subscription vault PDA"
          ],
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
                "path": "retailer"
              },
              {
                "kind": "account",
                "path": "subscriber"
              },
              {
                "kind": "arg",
                "path": "token_mint"
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
            "Token program (optional, for SPL token transfers)"
          ],
          "optional": true,
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "subscriberTokenAccount",
          "docs": [
            "Subscriber's token account (optional, only for SPL tokens)"
          ],
          "writable": true,
          "optional": true
        },
        {
          "name": "vaultTokenAccount",
          "docs": [
            "Vault's token account (optional, only for SPL tokens)"
          ],
          "writable": true,
          "optional": true
        }
      ],
      "args": [
        {
          "name": "rate",
          "type": "u64"
        },
        {
          "name": "intervalSlots",
          "type": "u64"
        },
        {
          "name": "amount",
          "type": "u64"
        },
        {
          "name": "tokenMint",
          "type": "pubkey"
        },
        {
          "name": "vkHashSubscriber",
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
      "name": "subscribePrivateStark",
      "docs": [
        "Create a private subscription vault using STARK proof (quantum-resistant)"
      ],
      "discriminator": [
        187,
        165,
        242,
        211,
        209,
        19,
        26,
        162
      ],
      "accounts": [
        {
          "name": "payer",
          "docs": [
            "Transaction payer"
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "retailer",
          "docs": [
            "Retailer who will receive periodic payments"
          ]
        },
        {
          "name": "vault",
          "docs": [
            "Subscription vault PDA (keyed by commitment instead of pubkey)"
          ],
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
                "path": "retailer"
              },
              {
                "kind": "arg",
                "path": "subscriber_commitment"
              },
              {
                "kind": "account",
                "path": "denominated_pool.token_mint",
                "account": "DenominatedPool"
              }
            ]
          }
        },
        {
          "name": "denominatedPool",
          "docs": [
            "Source denominated pool"
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  100,
                  101,
                  110,
                  111,
                  109,
                  105,
                  110,
                  97,
                  116,
                  101,
                  100,
                  95,
                  112,
                  111,
                  111,
                  108
                ]
              },
              {
                "kind": "account",
                "path": "denominated_pool.token_mint",
                "account": "DenominatedPool"
              },
              {
                "kind": "account",
                "path": "denominated_pool.denomination",
                "account": "DenominatedPool"
              }
            ]
          }
        },
        {
          "name": "merkleTree",
          "docs": [
            "Merkle tree state (read-only for unshield)"
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  101,
                  114,
                  107,
                  108,
                  101,
                  95,
                  116,
                  114,
                  101,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "denominated_pool"
              }
            ]
          }
        },
        {
          "name": "nullifierRecord",
          "docs": [
            "Nullifier record PDA — init for double-spend prevention"
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  110,
                  117,
                  108,
                  108,
                  105,
                  102,
                  105,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "denominated_pool"
              },
              {
                "kind": "arg",
                "path": "nullifier"
              }
            ]
          }
        },
        {
          "name": "starkProofBuffer",
          "docs": [
            "STARK proof buffer from p01_stark_verifier (circuit 1: pool_commitment).",
            "Must be verified (verified == true) and owned by the payer.",
            "- Owner is p01_stark_verifier program",
            "- Discriminator matches ProofBuffer",
            "- Authority matches payer",
            "- Circuit ID is 1 (pool_commitment)",
            "- Verified flag is true",
            "- Public inputs hash matches expected value",
            "Marked mut because we invalidate (set verified=false) after use."
          ],
          "writable": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "tokenProgram",
          "docs": [
            "Token program (optional, for SPL tokens)"
          ],
          "optional": true,
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "poolVault",
          "docs": [
            "Pool's token vault (optional, only for SPL tokens)"
          ],
          "writable": true,
          "optional": true
        },
        {
          "name": "vaultTokenAccount",
          "docs": [
            "Vault's token account (optional, only for SPL tokens)"
          ],
          "writable": true,
          "optional": true
        }
      ],
      "args": [
        {
          "name": "nullifier",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
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
          "name": "minEpoch",
          "type": "u64"
        },
        {
          "name": "subscriberCommitment",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "rate",
          "type": "u64"
        },
        {
          "name": "intervalSlots",
          "type": "u64"
        },
        {
          "name": "vkHashSubscriber",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "starkCommitment",
          "type": "u64"
        }
      ]
    },
    {
      "name": "transfer",
      "docs": [
        "Transfer shielded tokens privately",
        "Spends input notes (via nullifiers) and creates new output notes",
        "Requires a valid ZK proof"
      ],
      "discriminator": [
        163,
        52,
        200,
        231,
        140,
        3,
        69,
        186
      ],
      "accounts": [
        {
          "name": "payer",
          "docs": [
            "Transaction submitter (can be anyone, including relayer)"
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "shieldedPool",
          "docs": [
            "Shielded pool"
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  104,
                  105,
                  101,
                  108,
                  100,
                  101,
                  100,
                  95,
                  112,
                  111,
                  111,
                  108
                ]
              },
              {
                "kind": "account",
                "path": "shielded_pool.token_mint",
                "account": "ShieldedPool"
              }
            ]
          }
        },
        {
          "name": "merkleTree",
          "docs": [
            "Merkle tree state"
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  101,
                  114,
                  107,
                  108,
                  101,
                  95,
                  116,
                  114,
                  101,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "shielded_pool"
              }
            ]
          }
        },
        {
          "name": "nullifierRecord1",
          "docs": [
            "Nullifier 1 PDA — created on first use.",
            "If this PDA already exists, `init` fails → atomic double-spend rejection."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  110,
                  117,
                  108,
                  108,
                  105,
                  102,
                  105,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "shielded_pool"
              },
              {
                "kind": "arg",
                "path": "nullifier_1"
              }
            ]
          }
        },
        {
          "name": "nullifierRecord2",
          "docs": [
            "Nullifier 2 PDA — created on first use.",
            "If this PDA already exists, `init` fails → atomic double-spend rejection."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  110,
                  117,
                  108,
                  108,
                  105,
                  102,
                  105,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "shielded_pool"
              },
              {
                "kind": "arg",
                "path": "nullifier_2"
              }
            ]
          }
        },
        {
          "name": "verificationKeyData",
          "docs": [
            "Verification key data account (stores the VK bytes)"
          ]
        },
        {
          "name": "systemProgram",
          "docs": [
            "System program (required for PDA creation)"
          ],
          "address": "11111111111111111111111111111111"
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
          "name": "nullifier1",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "nullifier2",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "outputCommitment1",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "outputCommitment2",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
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
          "name": "newRoot",
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
      "name": "transferDenominatedStark",
      "docs": [
        "Transfer a note within a denominated pool using STARK proof (quantum-resistant).",
        "The old note is nullified and a new commitment is inserted into the tree.",
        "No funds move — same pool, same denomination."
      ],
      "discriminator": [
        195,
        123,
        146,
        73,
        75,
        115,
        252,
        14
      ],
      "accounts": [
        {
          "name": "payer",
          "docs": [
            "Transaction submitter — must be the note owner (signs to bind new_commitment)."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "denominatedPool",
          "docs": [
            "Denominated pool"
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  100,
                  101,
                  110,
                  111,
                  109,
                  105,
                  110,
                  97,
                  116,
                  101,
                  100,
                  95,
                  112,
                  111,
                  111,
                  108
                ]
              },
              {
                "kind": "account",
                "path": "denominated_pool.token_mint",
                "account": "DenominatedPool"
              },
              {
                "kind": "account",
                "path": "denominated_pool.denomination",
                "account": "DenominatedPool"
              }
            ]
          }
        },
        {
          "name": "merkleTree",
          "docs": [
            "Merkle tree state (mutable — new commitment is inserted)"
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  101,
                  114,
                  107,
                  108,
                  101,
                  95,
                  116,
                  114,
                  101,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "denominated_pool"
              }
            ]
          }
        },
        {
          "name": "nullifierRecord",
          "docs": [
            "Nullifier record PDA — created (init) on first use."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  110,
                  117,
                  108,
                  108,
                  105,
                  102,
                  105,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "denominated_pool"
              },
              {
                "kind": "arg",
                "path": "nullifier"
              }
            ]
          }
        },
        {
          "name": "starkProofBuffer",
          "docs": [
            "STARK proof buffer from p01_stark_verifier (circuit 1: pool_commitment).",
            "- Owner is p01_stark_verifier program",
            "- Discriminator matches ProofBuffer",
            "- Authority matches payer",
            "- Circuit ID is 1 (pool_commitment)",
            "- Verified flag is true",
            "- Public inputs hash matches sha256([nullifier_u64_le || stark_commitment_u64_le])"
          ]
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "nullifier",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
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
          "name": "minEpoch",
          "type": "u64"
        },
        {
          "name": "starkCommitment",
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
          "name": "newRoot",
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
      "name": "unshield",
      "docs": [
        "Unshield tokens: withdraw from shielded pool to transparent address",
        "Requires a valid ZK proof showing ownership of the notes"
      ],
      "discriminator": [
        21,
        228,
        55,
        24,
        194,
        10,
        21,
        22
      ],
      "accounts": [
        {
          "name": "payer",
          "docs": [
            "Transaction submitter (can be anyone)"
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "recipient",
          "docs": [
            "Recipient of the unshielded tokens"
          ],
          "writable": true
        },
        {
          "name": "shieldedPool",
          "docs": [
            "Shielded pool"
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  104,
                  105,
                  101,
                  108,
                  100,
                  101,
                  100,
                  95,
                  112,
                  111,
                  111,
                  108
                ]
              },
              {
                "kind": "account",
                "path": "shielded_pool.token_mint",
                "account": "ShieldedPool"
              }
            ]
          }
        },
        {
          "name": "merkleTree",
          "docs": [
            "Merkle tree state"
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  101,
                  114,
                  107,
                  108,
                  101,
                  95,
                  116,
                  114,
                  101,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "shielded_pool"
              }
            ]
          }
        },
        {
          "name": "nullifierRecord1",
          "docs": [
            "Nullifier 1 PDA — created on first use.",
            "If this PDA already exists, `init` fails → atomic double-spend rejection."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  110,
                  117,
                  108,
                  108,
                  105,
                  102,
                  105,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "shielded_pool"
              },
              {
                "kind": "arg",
                "path": "nullifier_1"
              }
            ]
          }
        },
        {
          "name": "nullifierRecord2",
          "docs": [
            "Nullifier 2 PDA — created on first use.",
            "If this PDA already exists, `init` fails → atomic double-spend rejection."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  110,
                  117,
                  108,
                  108,
                  105,
                  102,
                  105,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "shielded_pool"
              },
              {
                "kind": "arg",
                "path": "nullifier_2"
              }
            ]
          }
        },
        {
          "name": "verificationKeyData",
          "docs": [
            "Verification key data account"
          ]
        },
        {
          "name": "systemProgram",
          "docs": [
            "System program (required for PDA creation + native SOL transfers)"
          ],
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "tokenProgram",
          "docs": [
            "Token program (optional, for SPL token transfers)"
          ],
          "optional": true,
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "poolVault",
          "docs": [
            "Pool's token vault (optional, only for SPL tokens)"
          ],
          "writable": true,
          "optional": true
        },
        {
          "name": "recipientTokenAccount",
          "docs": [
            "Recipient's token account (optional, only for SPL tokens)"
          ],
          "writable": true,
          "optional": true
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
          "name": "nullifier1",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "nullifier2",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "outputCommitment1",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "outputCommitment2",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
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
          "name": "amount",
          "type": "u64"
        },
        {
          "name": "newRoot",
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
      "name": "unshieldDenominatedStark",
      "docs": [
        "Unshield from denominated pool using STARK proof (quantum-resistant).",
        "Requires a pre-verified STARK proof buffer from p01_stark_verifier.",
        "The STARK proof replaces Groth16 — no elliptic curve pairings needed."
      ],
      "discriminator": [
        94,
        95,
        79,
        48,
        195,
        183,
        41,
        160
      ],
      "accounts": [
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "recipient",
          "writable": true
        },
        {
          "name": "denominatedPool",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  100,
                  101,
                  110,
                  111,
                  109,
                  105,
                  110,
                  97,
                  116,
                  101,
                  100,
                  95,
                  112,
                  111,
                  111,
                  108
                ]
              },
              {
                "kind": "account",
                "path": "denominated_pool.token_mint",
                "account": "DenominatedPool"
              },
              {
                "kind": "account",
                "path": "denominated_pool.denomination",
                "account": "DenominatedPool"
              }
            ]
          }
        },
        {
          "name": "merkleTree",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  101,
                  114,
                  107,
                  108,
                  101,
                  95,
                  116,
                  114,
                  101,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "denominated_pool"
              }
            ]
          }
        },
        {
          "name": "nullifierRecord",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  110,
                  117,
                  108,
                  108,
                  105,
                  102,
                  105,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "denominated_pool"
              },
              {
                "kind": "arg",
                "path": "nullifier"
              }
            ]
          }
        },
        {
          "name": "starkProofBuffer",
          "docs": [
            "STARK proof buffer from p01_stark_verifier (circuit 1: pool_commitment).",
            "Must be verified (verified == true) and owned by the payer.",
            "Marked mut because we invalidate (set verified=false) after use.",
            "- Owner is p01_stark_verifier program",
            "- Discriminator matches ProofBuffer",
            "- Authority matches payer",
            "- Circuit ID is 1 (pool_commitment)",
            "- Verified flag is true",
            "- Public inputs hash matches expected value"
          ]
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
          "name": "poolVault",
          "writable": true,
          "optional": true
        },
        {
          "name": "recipientTokenAccount",
          "writable": true,
          "optional": true
        },
        {
          "name": "protocolFeeWallet",
          "docs": [
            "Protocol fee wallet — receives unshield fee (0.5%)"
          ],
          "writable": true
        }
      ],
      "args": [
        {
          "name": "nullifier",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
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
          "name": "minEpoch",
          "type": "u64"
        },
        {
          "name": "starkCommitment",
          "type": "u64"
        }
      ]
    },
    {
      "name": "updateEscrowVk",
      "docs": [
        "Update the escrow bid verification key hash on a denominated pool (admin only)."
      ],
      "discriminator": [
        32,
        233,
        195,
        71,
        226,
        19,
        114,
        132
      ],
      "accounts": [
        {
          "name": "authority",
          "docs": [
            "Pool authority"
          ],
          "signer": true
        },
        {
          "name": "denominatedPool",
          "docs": [
            "Denominated pool to update"
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
          "name": "newVkHash",
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
      "name": "updateVerificationKey",
      "docs": [
        "Update the verification key (admin only)"
      ],
      "discriminator": [
        137,
        144,
        60,
        6,
        206,
        144,
        18,
        216
      ],
      "accounts": [
        {
          "name": "authority",
          "docs": [
            "Pool authority"
          ],
          "signer": true
        },
        {
          "name": "shieldedPool",
          "docs": [
            "Shielded pool to update"
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  104,
                  105,
                  101,
                  108,
                  100,
                  101,
                  100,
                  95,
                  112,
                  111,
                  111,
                  108
                ]
              },
              {
                "kind": "account",
                "path": "shielded_pool.token_mint",
                "account": "ShieldedPool"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "newVkHash",
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
      "name": "verifyComplianceInnocence",
      "docs": [
        "Verify a Groth16 innocence proof and create a ComplianceAttestation.",
        "Proves: user identity is NOT in the sanctions Merkle tree."
      ],
      "discriminator": [
        63,
        79,
        1,
        237,
        232,
        196,
        66,
        63
      ],
      "accounts": [
        {
          "name": "authority",
          "docs": [
            "Authority requesting compliance verification (pays for PDA creation)"
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "user",
          "docs": [
            "User proving innocence"
          ],
          "signer": true
        },
        {
          "name": "attestation",
          "docs": [
            "ComplianceAttestation PDA: [\"compliance\", user, 1u8, attestation_nonce]"
          ],
          "writable": true
        },
        {
          "name": "vkData",
          "docs": [
            "VK data for the compliance_innocence circuit."
          ]
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
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
          "name": "sanctionsRoot",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "userCommitment",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "attestationNonce",
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
        }
      ]
    },
    {
      "name": "verifyComplianceRange",
      "docs": [
        "Verify a Groth16 range proof and create a ComplianceAttestation.",
        "Proves: min_bound <= secret_balance <= max_bound"
      ],
      "discriminator": [
        240,
        182,
        136,
        54,
        101,
        184,
        158,
        225
      ],
      "accounts": [
        {
          "name": "authority",
          "docs": [
            "Authority requesting compliance verification (pays for PDA creation)"
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "user",
          "docs": [
            "User whose balance is being attested"
          ],
          "signer": true
        },
        {
          "name": "attestation",
          "docs": [
            "ComplianceAttestation PDA: [\"compliance\", user, 0u8, attestation_nonce]"
          ],
          "writable": true
        },
        {
          "name": "confidentialAccount",
          "docs": [
            "The confidential account whose balance commitment we verify against."
          ]
        },
        {
          "name": "vkData",
          "docs": [
            "VK data for the compliance_range circuit."
          ]
        },
        {
          "name": "tokenMint",
          "docs": [
            "Token mint associated with the balance commitment."
          ]
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
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
          "name": "minBound",
          "type": "u64"
        },
        {
          "name": "maxBound",
          "type": "u64"
        },
        {
          "name": "attestationNonce",
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
        }
      ]
    },
    {
      "name": "writeEscrowOutcome",
      "docs": [
        "Write the auction outcome to an escrow PDA by reading the finalized",
        "Auction account from p01_arcium. Permissionless cranker."
      ],
      "discriminator": [
        185,
        124,
        9,
        180,
        108,
        16,
        108,
        193
      ],
      "accounts": [
        {
          "name": "payer",
          "docs": [
            "Anyone can crank (permissionless)"
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "auctionEscrow",
          "docs": [
            "Auction escrow PDA (mutable — outcome is written)"
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  117,
                  99,
                  116,
                  105,
                  111,
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
                "path": "auction_escrow.auction_id",
                "account": "AuctionEscrow"
              },
              {
                "kind": "account",
                "path": "auction_escrow.nullifier",
                "account": "AuctionEscrow"
              }
            ]
          }
        },
        {
          "name": "auctionAccount",
          "docs": [
            "The Auction PDA from p01_arcium program."
          ]
        }
      ],
      "args": []
    },
    {
      "name": "writeEscrowVkData",
      "docs": [
        "Write chunk of escrow VK data."
      ],
      "discriminator": [
        55,
        36,
        115,
        146,
        53,
        33,
        175,
        224
      ],
      "accounts": [
        {
          "name": "authority",
          "signer": true
        },
        {
          "name": "denominatedPool",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  100,
                  101,
                  110,
                  111,
                  109,
                  105,
                  110,
                  97,
                  116,
                  101,
                  100,
                  95,
                  112,
                  111,
                  111,
                  108
                ]
              },
              {
                "kind": "account",
                "path": "denominated_pool.token_mint",
                "account": "DenominatedPool"
              },
              {
                "kind": "account",
                "path": "denominated_pool.denomination",
                "account": "DenominatedPool"
              }
            ]
          }
        },
        {
          "name": "vkDataAccount",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  107,
                  95,
                  100,
                  97,
                  116,
                  97,
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
                "path": "denominated_pool"
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
    },
    {
      "name": "writeVkData",
      "docs": [
        "Write chunk of VK data (admin only)",
        "Used to upload VK data in multiple transactions"
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
          "docs": [
            "Pool authority (must sign)"
          ],
          "signer": true
        },
        {
          "name": "shieldedPool",
          "docs": [
            "Shielded pool"
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  104,
                  105,
                  101,
                  108,
                  100,
                  101,
                  100,
                  95,
                  112,
                  111,
                  111,
                  108
                ]
              },
              {
                "kind": "account",
                "path": "shielded_pool.token_mint",
                "account": "ShieldedPool"
              }
            ]
          }
        },
        {
          "name": "vkDataAccount",
          "docs": [
            "VK data account (PDA owned by this program)"
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  107,
                  95,
                  100,
                  97,
                  116,
                  97
                ]
              },
              {
                "kind": "account",
                "path": "shielded_pool"
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
      "name": "auctionEscrow",
      "discriminator": [
        219,
        16,
        234,
        116,
        247,
        132,
        116,
        213
      ]
    },
    {
      "name": "complianceAttestation",
      "discriminator": [
        217,
        11,
        238,
        202,
        182,
        245,
        67,
        217
      ]
    },
    {
      "name": "denominatedPool",
      "discriminator": [
        16,
        21,
        198,
        35,
        177,
        92,
        68,
        140
      ]
    },
    {
      "name": "merkleTreeState",
      "discriminator": [
        110,
        93,
        37,
        106,
        12,
        80,
        172,
        23
      ]
    },
    {
      "name": "nullifierRecord",
      "discriminator": [
        56,
        18,
        57,
        175,
        69,
        202,
        189,
        70
      ]
    },
    {
      "name": "nullifierSet",
      "discriminator": [
        251,
        219,
        17,
        100,
        208,
        102,
        127,
        25
      ]
    },
    {
      "name": "shieldedPool",
      "discriminator": [
        104,
        47,
        208,
        0,
        63,
        250,
        170,
        103
      ]
    },
    {
      "name": "subscriptionVault",
      "discriminator": [
        96,
        90,
        247,
        202,
        157,
        16,
        86,
        190
      ]
    }
  ],
  "types": [
    {
      "name": "auctionEscrow",
      "docs": [
        "Auction escrow: holds two conditional commitments for a sealed-bid auction.",
        "",
        "When a bidder places a bid, their denominated pool note is consumed (nullified)",
        "and both possible outcomes are recorded:",
        "- pay_commitment:    note for the seller (if bidder wins)",
        "- refund_commitment: note for the bidder (if bidder loses)",
        "",
        "After the Arcium MPC settles the auction and writes the outcome,",
        "a permissionless `escrow_release` instruction inserts the correct",
        "commitment into the Merkle tree. The other commitment is discarded.",
        "",
        "PDA seeds: [b\"auction_escrow\", auction_id, nullifier]"
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "auctionId",
            "docs": [
              "Auction identifier: Poseidon(auction_pubkey, nonce) or hash of Auction PDA"
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "pool",
            "docs": [
              "The denominated pool this escrow belongs to"
            ],
            "type": "pubkey"
          },
          {
            "name": "nullifier",
            "docs": [
              "Nullifier of the consumed source note (serves as bidder handle)"
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "payCommitment",
            "docs": [
              "Commitment that pays the seller (winner outcome)"
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "refundCommitment",
            "docs": [
              "Commitment that refunds the bidder (loser outcome)"
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "outcome",
            "docs": [
              "0 = unsettled, 1 = pay (winner), 2 = refund (loser)"
            ],
            "type": "u8"
          },
          {
            "name": "isReleased",
            "docs": [
              "Whether the escrow has been released (commitment inserted into tree)"
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
      "name": "authorityTransferAccepted",
      "type": {
        "fields": [
          {
            "name": "pool",
            "type": "pubkey"
          },
          {
            "name": "oldAuthority",
            "type": "pubkey"
          },
          {
            "name": "newAuthority",
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
      "name": "authorityTransferProposed",
      "type": {
        "fields": [
          {
            "name": "pool",
            "type": "pubkey"
          },
          {
            "name": "currentAuthority",
            "type": "pubkey"
          },
          {
            "name": "proposedAuthority",
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
      "name": "cancelNormalEvent",
      "type": {
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "subscriber",
            "type": "pubkey"
          },
          {
            "name": "retailer",
            "type": "pubkey"
          },
          {
            "name": "retailerAmount",
            "type": "u64"
          },
          {
            "name": "refundAmount",
            "type": "u64"
          },
          {
            "name": "slot",
            "type": "i64"
          }
        ],
        "kind": "struct"
      }
    },
    {
      "name": "cancelPrivateStarkEvent",
      "type": {
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "retailer",
            "type": "pubkey"
          },
          {
            "name": "sourcePool",
            "type": "pubkey"
          },
          {
            "name": "retailerAmount",
            "type": "u64"
          },
          {
            "name": "reshieldAmount",
            "type": "u64"
          },
          {
            "name": "notesReshielded",
            "type": "u64"
          },
          {
            "name": "dustForfeited",
            "type": "u64"
          },
          {
            "name": "slot",
            "type": "i64"
          }
        ],
        "kind": "struct"
      }
    },
    {
      "name": "claimPeriodEvent",
      "type": {
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "retailer",
            "type": "pubkey"
          },
          {
            "name": "periodsClaimed",
            "type": "u64"
          },
          {
            "name": "amountClaimed",
            "type": "u64"
          },
          {
            "name": "totalClaimedPeriods",
            "type": "u64"
          },
          {
            "name": "slot",
            "type": "i64"
          }
        ],
        "kind": "struct"
      }
    },
    {
      "name": "complianceAttestation",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "authority",
            "docs": [
              "Authority who can revoke this attestation"
            ],
            "type": "pubkey"
          },
          {
            "name": "user",
            "docs": [
              "User this attestation is about"
            ],
            "type": "pubkey"
          },
          {
            "name": "attestationType",
            "docs": [
              "0 = range proof, 1 = innocence proof"
            ],
            "type": "u8"
          },
          {
            "name": "isVerified",
            "docs": [
              "Whether the ZK proof was verified"
            ],
            "type": "bool"
          },
          {
            "name": "issuedAt",
            "docs": [
              "Unix timestamp of issuance"
            ],
            "type": "i64"
          },
          {
            "name": "expiresAt",
            "docs": [
              "Unix timestamp of expiry (e.g., +30 days)"
            ],
            "type": "i64"
          },
          {
            "name": "revoked",
            "docs": [
              "Whether authority has revoked"
            ],
            "type": "bool"
          },
          {
            "name": "sanctionsRoot",
            "docs": [
              "For innocence: which sanctions list version was proven against"
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "minBound",
            "docs": [
              "For range: the threshold/bound proven (public input, not the secret balance)"
            ],
            "type": "u64"
          },
          {
            "name": "maxBound",
            "type": "u64"
          },
          {
            "name": "circuitVkHash",
            "docs": [
              "Hash of the circuit verification key used"
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "attestationNonce",
            "docs": [
              "Attestation nonce (anti-replay)"
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
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
      "name": "complianceInnocenceEvent",
      "type": {
        "fields": [
          {
            "name": "user",
            "type": "pubkey"
          },
          {
            "name": "authority",
            "type": "pubkey"
          },
          {
            "name": "sanctionsRoot",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "attestation",
            "type": "pubkey"
          },
          {
            "name": "issuedAt",
            "type": "i64"
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
      "name": "complianceRangeEvent",
      "type": {
        "fields": [
          {
            "name": "user",
            "type": "pubkey"
          },
          {
            "name": "authority",
            "type": "pubkey"
          },
          {
            "name": "minBound",
            "type": "u64"
          },
          {
            "name": "maxBound",
            "type": "u64"
          },
          {
            "name": "tokenMint",
            "type": "pubkey"
          },
          {
            "name": "attestation",
            "type": "pubkey"
          },
          {
            "name": "issuedAt",
            "type": "i64"
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
      "name": "complianceRevokedEvent",
      "type": {
        "fields": [
          {
            "name": "attestation",
            "type": "pubkey"
          },
          {
            "name": "authority",
            "type": "pubkey"
          },
          {
            "name": "revokedAt",
            "type": "i64"
          }
        ],
        "kind": "struct"
      }
    },
    {
      "name": "denominatedPool",
      "docs": [
        "A shielded pool where every note has a fixed denomination.",
        "Commitment = Poseidon(nullifier_preimage, secret, deposit_epoch, token_mint)",
        "No amount in the commitment — denomination enforced at program level.",
        "",
        "Dynamic time delay: The pool adjusts the withdrawal delay based on the",
        "anonymity set size (mature notes). More notes = shorter delay because the",
        "anonymity set is large enough to resist timing analysis.",
        "",
        "Lazy maturity tracking: A circular buffer `epoch_note_counts` records how",
        "many notes were deposited in each epoch. On every shield/unshield, the",
        "`update_maturity()` method walks the buffer to graduate old epochs into",
        "`mature_note_count`. This avoids scanning all notes — O(buffer_size) worst",
        "case, which is bounded at 32."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "authority",
            "docs": [
              "Authority that can update pool settings"
            ],
            "type": "pubkey"
          },
          {
            "name": "tokenMint",
            "docs": [
              "Token mint address (system program for SOL)"
            ],
            "type": "pubkey"
          },
          {
            "name": "denomination",
            "docs": [
              "Fixed denomination per note (in lamports / atomic units)"
            ],
            "type": "u64"
          },
          {
            "name": "epochDelay",
            "docs": [
              "Minimum epochs that must pass between deposit and withdrawal"
            ],
            "type": "u64"
          },
          {
            "name": "merkleRoot",
            "docs": [
              "Current Merkle tree root"
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "treeDepth",
            "docs": [
              "Depth of the Merkle tree (20 = ~1M notes)"
            ],
            "type": "u8"
          },
          {
            "name": "nextLeafIndex",
            "docs": [
              "Index of the next leaf to insert"
            ],
            "type": "u64"
          },
          {
            "name": "vkHash",
            "docs": [
              "Hash of the verification key for proof validation"
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "totalShielded",
            "docs": [
              "Total amount currently shielded (= note_count * denomination)"
            ],
            "type": "u64"
          },
          {
            "name": "noteCount",
            "docs": [
              "Number of notes in pool (anonymity set size)"
            ],
            "type": "u64"
          },
          {
            "name": "isActive",
            "docs": [
              "Whether the pool is accepting new deposits"
            ],
            "type": "bool"
          },
          {
            "name": "historicalRoots",
            "docs": [
              "Historical roots (last 100 roots for flexibility)"
            ],
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
            "name": "maxHistoricalRoots",
            "docs": [
              "Maximum size of historical roots array"
            ],
            "type": "u8"
          },
          {
            "name": "createdAt",
            "docs": [
              "Pool creation timestamp"
            ],
            "type": "i64"
          },
          {
            "name": "lastTxAt",
            "docs": [
              "Last transaction timestamp"
            ],
            "type": "i64"
          },
          {
            "name": "bump",
            "docs": [
              "Bump seed for PDA"
            ],
            "type": "u8"
          },
          {
            "name": "matureNoteCount",
            "docs": [
              "Number of notes that have been in the pool longer than `epoch_delay` epochs.",
              "Drives `get_dynamic_delay()`: more mature notes = shorter withdrawal delay."
            ],
            "type": "u64"
          },
          {
            "name": "lastMaturityUpdateEpoch",
            "docs": [
              "The last epoch at which `update_maturity()` was called.",
              "Used to determine how many new epochs to graduate."
            ],
            "type": "u64"
          },
          {
            "name": "epochNoteCounts",
            "docs": [
              "Circular buffer: number of notes deposited in each epoch.",
              "Index `i` corresponds to epoch `epoch_note_start + i`.",
              "Size 32 provides a lookback window of 32 epochs (~32 hours)."
            ],
            "type": {
              "array": [
                "u64",
                32
              ]
            }
          },
          {
            "name": "epochNoteStart",
            "docs": [
              "The absolute epoch number corresponding to index 0 of `epoch_note_counts`.",
              "When time advances, old entries are graduated (added to mature_note_count)",
              "and the start is shifted forward."
            ],
            "type": "u64"
          },
          {
            "name": "vkHashTransfer",
            "docs": [
              "Hash of the verification key for transfer circuit validation.",
              "Separate from vk_hash because unshield and transfer are different circuits",
              "with different public inputs."
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "vkUpdateSlot",
            "docs": [
              "Timestamp of the last VK update (for 24h cooldown enforcement)"
            ],
            "type": "i64"
          },
          {
            "name": "rootWriteIndex",
            "docs": [
              "Write index for the historical_roots circular buffer.",
              "Decoupled from next_leaf_index so root history is not corrupted",
              "when next_leaf_index diverges (e.g., transfer_denominated)."
            ],
            "type": "u64"
          },
          {
            "name": "vkHashEscrow",
            "docs": [
              "Hash of the verification key for escrow bid circuit validation.",
              "Separate from vk_hash and vk_hash_transfer because escrow_bid",
              "has 7 public inputs (adds auction_id, pay_commitment, refund_commitment)."
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          }
        ]
      }
    },
    {
      "name": "emergencyUnshieldDenominatedStarkEvent",
      "type": {
        "fields": [
          {
            "name": "pool",
            "type": "pubkey"
          },
          {
            "name": "recipient",
            "type": "pubkey"
          },
          {
            "name": "denomination",
            "type": "u64"
          },
          {
            "name": "protocolFee",
            "type": "u64"
          },
          {
            "name": "nullifier",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "minEpoch",
            "type": "u64"
          },
          {
            "name": "currentEpoch",
            "type": "u64"
          },
          {
            "name": "isEmergency",
            "type": "bool"
          },
          {
            "name": "matureNoteCount",
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
      "name": "escrowOutcomeEvent",
      "type": {
        "fields": [
          {
            "name": "auctionId",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "nullifier",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "outcome",
            "type": "u8"
          },
          {
            "name": "winnerNullifier",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          }
        ],
        "kind": "struct"
      }
    },
    {
      "name": "escrowReleaseEvent",
      "type": {
        "fields": [
          {
            "name": "pool",
            "type": "pubkey"
          },
          {
            "name": "auctionId",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "nullifier",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "outcome",
            "type": "u8"
          },
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
            "name": "leafIndex",
            "type": "u64"
          },
          {
            "name": "newRoot",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
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
      "name": "escrowShieldEvent",
      "type": {
        "fields": [
          {
            "name": "pool",
            "type": "pubkey"
          },
          {
            "name": "auctionId",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "nullifier",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "payCommitment",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "refundCommitment",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "currentEpoch",
            "type": "u64"
          },
          {
            "name": "dynamicDelay",
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
      "docs": [
        "Event emitted whenever the Merkle root changes.",
        "Off-chain monitors should watch for unexpected root transitions to detect",
        "potential root poisoning attempts."
      ],
      "name": "merkleRootChanged",
      "type": {
        "fields": [
          {
            "name": "pool",
            "type": "pubkey"
          },
          {
            "name": "oldRoot",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "newRoot",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "leafIndex",
            "type": "u64"
          },
          {
            "name": "leaf",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          }
        ],
        "kind": "struct"
      }
    },
    {
      "name": "merkleTreeState",
      "docs": [
        "Merkle tree state stored on-chain",
        "Uses sparse storage for efficiency - only stores non-empty nodes"
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "pool",
            "docs": [
              "Associated shielded pool"
            ],
            "type": "pubkey"
          },
          {
            "name": "root",
            "docs": [
              "Current root hash"
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "leafCount",
            "docs": [
              "Number of leaves inserted"
            ],
            "type": "u64"
          },
          {
            "name": "depth",
            "docs": [
              "Tree depth"
            ],
            "type": "u8"
          },
          {
            "name": "filledSubtrees",
            "docs": [
              "Filled subtrees (optimization for insertion)",
              "Stores the rightmost filled node at each level"
            ],
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
      "name": "nullifierRecord",
      "docs": [
        "A tiny PDA account whose existence proves a nullifier has been spent.",
        "Seeds: [b\"nullifier\", pool_key, nullifier_bytes]",
        "No false positives, no size limits, scales to millions of nullifiers.",
        "Rent (~0.00089 SOL) paid by the withdrawer."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "pool",
            "docs": [
              "The pool this nullifier belongs to"
            ],
            "type": "pubkey"
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
      "name": "nullifierSet",
      "docs": [
        "Nullifier set for preventing double-spending",
        "Uses a Bloom filter for fast probabilistic checking",
        "plus an on-chain list for definitive verification",
        "",
        "Uses zero-copy to avoid stack overflow during deserialization"
      ],
      "serialization": "bytemuck",
      "repr": {
        "kind": "c"
      },
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "pool",
            "docs": [
              "Associated shielded pool"
            ],
            "type": "pubkey"
          },
          {
            "name": "count",
            "docs": [
              "Number of nullifiers stored"
            ],
            "type": "u64"
          },
          {
            "name": "numHashFunctions",
            "docs": [
              "Number of hash functions for bloom filter"
            ],
            "type": "u8"
          },
          {
            "name": "bump",
            "docs": [
              "Bump seed for PDA"
            ],
            "type": "u8"
          },
          {
            "name": "padding",
            "docs": [
              "Padding for alignment"
            ],
            "type": {
              "array": [
                "u8",
                6
              ]
            }
          },
          {
            "name": "bloomFilter",
            "docs": [
              "Bloom filter for fast probabilistic checking (2KB)",
              "False positives possible, false negatives impossible"
            ],
            "type": {
              "array": [
                "u64",
                256
              ]
            }
          }
        ]
      }
    },
    {
      "name": "pauseVaultEvent",
      "type": {
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "pausedAtSlot",
            "type": "i64"
          },
          {
            "name": "isPrivate",
            "type": "bool"
          }
        ],
        "kind": "struct"
      }
    },
    {
      "name": "pauseVaultPrivateStarkEvent",
      "type": {
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "pausedAtSlot",
            "type": "i64"
          }
        ],
        "kind": "struct"
      }
    },
    {
      "name": "resumeVaultEvent",
      "type": {
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "resumedAtSlot",
            "type": "i64"
          },
          {
            "name": "pausedDuration",
            "type": "i64"
          },
          {
            "name": "totalPausedSlots",
            "type": "i64"
          },
          {
            "name": "isPrivate",
            "type": "bool"
          }
        ],
        "kind": "struct"
      }
    },
    {
      "name": "resumeVaultPrivateStarkEvent",
      "type": {
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "resumedAtSlot",
            "type": "i64"
          },
          {
            "name": "pausedDuration",
            "type": "i64"
          },
          {
            "name": "totalPausedSlots",
            "type": "i64"
          }
        ],
        "kind": "struct"
      }
    },
    {
      "name": "shieldDenominatedEvent",
      "type": {
        "fields": [
          {
            "name": "pool",
            "type": "pubkey"
          },
          {
            "name": "depositor",
            "type": "pubkey"
          },
          {
            "name": "denomination",
            "type": "u64"
          },
          {
            "name": "protocolFee",
            "type": "u64"
          },
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
            "name": "leafIndex",
            "type": "u64"
          },
          {
            "name": "newRoot",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "depositEpoch",
            "type": "u64"
          },
          {
            "name": "matureNoteCount",
            "type": "u64"
          },
          {
            "name": "dynamicDelay",
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
      "docs": [
        "Event emitted when tokens are shielded"
      ],
      "name": "shieldEvent",
      "type": {
        "fields": [
          {
            "name": "pool",
            "type": "pubkey"
          },
          {
            "name": "depositor",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
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
            "name": "leafIndex",
            "type": "u64"
          },
          {
            "name": "newRoot",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
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
      "name": "shieldedPool",
      "docs": [
        "Configuration and state of a shielded pool",
        "Each pool handles one token type (SOL or SPL token)"
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "authority",
            "docs": [
              "Authority that can update pool settings"
            ],
            "type": "pubkey"
          },
          {
            "name": "tokenMint",
            "docs": [
              "Token mint address (system program for SOL)"
            ],
            "type": "pubkey"
          },
          {
            "name": "merkleRoot",
            "docs": [
              "Current Merkle tree root"
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "treeDepth",
            "docs": [
              "Depth of the Merkle tree (20 = ~1M notes)"
            ],
            "type": "u8"
          },
          {
            "name": "nextLeafIndex",
            "docs": [
              "Index of the next leaf to insert"
            ],
            "type": "u64"
          },
          {
            "name": "vkHash",
            "docs": [
              "Hash of the verification key for proof validation"
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "totalShielded",
            "docs": [
              "Total amount currently shielded in the pool"
            ],
            "type": "u64"
          },
          {
            "name": "isActive",
            "docs": [
              "Whether the pool is accepting new deposits/transfers"
            ],
            "type": "bool"
          },
          {
            "name": "historicalRoots",
            "docs": [
              "Historical roots (last 100 roots for flexibility)"
            ],
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
            "name": "maxHistoricalRoots",
            "docs": [
              "Maximum size of historical roots array"
            ],
            "type": "u8"
          },
          {
            "name": "createdAt",
            "docs": [
              "Pool creation timestamp"
            ],
            "type": "i64"
          },
          {
            "name": "lastTxAt",
            "docs": [
              "Last transaction timestamp"
            ],
            "type": "i64"
          },
          {
            "name": "relayerFeeBps",
            "docs": [
              "Relayer fee in basis points (100 = 1%)"
            ],
            "type": "u16"
          },
          {
            "name": "relayer",
            "docs": [
              "Relayer pubkey that receives fees"
            ],
            "type": "pubkey"
          },
          {
            "name": "bump",
            "docs": [
              "Bump seed for PDA"
            ],
            "type": "u8"
          },
          {
            "name": "vkUpdateSlot",
            "docs": [
              "Timestamp of the last VK update (for 24h cooldown enforcement)"
            ],
            "type": "i64"
          },
          {
            "name": "pendingAuthority",
            "docs": [
              "Pending new authority for two-step authority transfer"
            ],
            "type": {
              "option": "pubkey"
            }
          }
        ]
      }
    },
    {
      "name": "splitNoteStarkEvent",
      "type": {
        "fields": [
          {
            "name": "sourcePool",
            "type": "pubkey"
          },
          {
            "name": "targetPool",
            "type": "pubkey"
          },
          {
            "name": "sourceDenomination",
            "type": "u64"
          },
          {
            "name": "targetDenomination",
            "type": "u64"
          },
          {
            "name": "numOutputs",
            "type": "u8"
          },
          {
            "name": "protocolFee",
            "type": "u64"
          },
          {
            "name": "nullifier",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
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
      "name": "subscribeNormalEvent",
      "type": {
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "subscriber",
            "type": "pubkey"
          },
          {
            "name": "retailer",
            "type": "pubkey"
          },
          {
            "name": "tokenMint",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "rate",
            "type": "u64"
          },
          {
            "name": "intervalSlots",
            "type": "u64"
          },
          {
            "name": "startSlot",
            "type": "i64"
          }
        ],
        "kind": "struct"
      }
    },
    {
      "name": "subscribePrivateStarkEvent",
      "type": {
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "subscriberCommitment",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "retailer",
            "type": "pubkey"
          },
          {
            "name": "tokenMint",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "rate",
            "type": "u64"
          },
          {
            "name": "intervalSlots",
            "type": "u64"
          },
          {
            "name": "sourcePool",
            "type": "pubkey"
          },
          {
            "name": "nullifier",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "startSlot",
            "type": "i64"
          }
        ],
        "kind": "struct"
      }
    },
    {
      "name": "subscriptionVault",
      "docs": [
        "Subscription vault: holds funds deposited by a subscriber for periodic",
        "claims by a retailer. Supports two modes:",
        "",
        "**Normal mode**: `subscriber_pubkey` is set, vault actions require wallet signature.",
        "**Private mode**: `subscriber_commitment` is set (Poseidon(secret)), vault actions",
        "require a ZK proof of knowledge of the secret.",
        "",
        "PDA: [b\"subscription_vault\", retailer, subscriber_id_bytes, token_mint]",
        "where subscriber_id_bytes = subscriber_pubkey (normal) or subscriber_commitment (private)"
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "subscriberPubkey",
            "docs": [
              "Subscriber wallet (normal mode only)"
            ],
            "type": {
              "option": "pubkey"
            }
          },
          {
            "name": "subscriberCommitment",
            "docs": [
              "Subscriber commitment = Poseidon(secret) (private mode only)"
            ],
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
            "name": "retailer",
            "docs": [
              "Retailer who receives periodic payments"
            ],
            "type": "pubkey"
          },
          {
            "name": "tokenMint",
            "docs": [
              "Token mint (system program ID for native SOL)"
            ],
            "type": "pubkey"
          },
          {
            "name": "totalDeposited",
            "docs": [
              "Total amount deposited into the vault"
            ],
            "type": "u64"
          },
          {
            "name": "rate",
            "docs": [
              "Amount paid per period (in lamports / atomic units)"
            ],
            "type": "u64"
          },
          {
            "name": "intervalSlots",
            "docs": [
              "Number of slots between each claimable period"
            ],
            "type": "u64"
          },
          {
            "name": "startSlot",
            "docs": [
              "Slot at which the subscription started"
            ],
            "type": "i64"
          },
          {
            "name": "claimedPeriods",
            "docs": [
              "Number of periods already claimed by the retailer"
            ],
            "type": "u64"
          },
          {
            "name": "isActive",
            "docs": [
              "Whether the vault is active (accepting claims)"
            ],
            "type": "bool"
          },
          {
            "name": "isPaused",
            "docs": [
              "Whether the vault is paused (no claims while paused)"
            ],
            "type": "bool"
          },
          {
            "name": "pauseSlot",
            "docs": [
              "Slot at which the vault was paused (if paused)"
            ],
            "type": {
              "option": "i64"
            }
          },
          {
            "name": "totalPausedSlots",
            "docs": [
              "Total slots spent in paused state (accumulated over pause/resume cycles)"
            ],
            "type": "i64"
          },
          {
            "name": "vkHashSubscriber",
            "docs": [
              "VK hash for subscriber ownership circuit (private mode)"
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "sourcePool",
            "docs": [
              "Source denominated pool (for cancel_private re-shield)"
            ],
            "type": {
              "option": "pubkey"
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
      "name": "transferDenominatedStarkEvent",
      "type": {
        "fields": [
          {
            "name": "pool",
            "type": "pubkey"
          },
          {
            "name": "nullifier",
            "type": {
              "array": [
                "u8",
                32
              ]
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
            "name": "leafIndex",
            "type": "u64"
          },
          {
            "name": "newRoot",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "minEpoch",
            "type": "u64"
          },
          {
            "name": "currentEpoch",
            "type": "u64"
          },
          {
            "name": "dynamicDelay",
            "type": "u64"
          },
          {
            "name": "matureNoteCount",
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
      "docs": [
        "Event emitted on shielded transfer"
      ],
      "name": "transferEvent",
      "type": {
        "fields": [
          {
            "name": "pool",
            "type": "pubkey"
          },
          {
            "name": "nullifier1",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "nullifier2",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "outputCommitment1",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "outputCommitment2",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "leafIndex1",
            "type": "u64"
          },
          {
            "name": "leafIndex2",
            "type": "u64"
          },
          {
            "name": "newRoot",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
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
      "name": "unshieldDenominatedStarkEvent",
      "type": {
        "fields": [
          {
            "name": "pool",
            "type": "pubkey"
          },
          {
            "name": "recipient",
            "type": "pubkey"
          },
          {
            "name": "denomination",
            "type": "u64"
          },
          {
            "name": "protocolFee",
            "type": "u64"
          },
          {
            "name": "nullifier",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "minEpoch",
            "type": "u64"
          },
          {
            "name": "currentEpoch",
            "type": "u64"
          },
          {
            "name": "dynamicDelay",
            "type": "u64"
          },
          {
            "name": "matureNoteCount",
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
      "docs": [
        "Event emitted when tokens are unshielded"
      ],
      "name": "unshieldEvent",
      "type": {
        "fields": [
          {
            "name": "pool",
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
            "name": "nullifier1",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "nullifier2",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "changeCommitment",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "changeLeafIndex",
            "type": {
              "option": "u64"
            }
          },
          {
            "name": "newRoot",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
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
      "docs": [
        "Event emitted when verification key is updated"
      ],
      "name": "vKUpdateEvent",
      "type": {
        "fields": [
          {
            "name": "pool",
            "type": "pubkey"
          },
          {
            "name": "oldVkHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "newVkHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "authority",
            "type": "pubkey"
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
        149,
        165,
        140,
        221,
        104,
        203,
        239,
        121
      ],
      "name": "authorityTransferAccepted"
    },
    {
      "discriminator": [
        103,
        244,
        27,
        116,
        177,
        4,
        100,
        119
      ],
      "name": "authorityTransferProposed"
    },
    {
      "discriminator": [
        197,
        20,
        175,
        83,
        134,
        240,
        121,
        118
      ],
      "name": "cancelNormalEvent"
    },
    {
      "discriminator": [
        20,
        86,
        111,
        207,
        9,
        41,
        239,
        171
      ],
      "name": "cancelPrivateStarkEvent"
    },
    {
      "discriminator": [
        208,
        192,
        66,
        107,
        204,
        123,
        169,
        193
      ],
      "name": "claimPeriodEvent"
    },
    {
      "discriminator": [
        171,
        12,
        115,
        224,
        174,
        58,
        65,
        86
      ],
      "name": "complianceInnocenceEvent"
    },
    {
      "discriminator": [
        188,
        80,
        78,
        48,
        139,
        196,
        48,
        77
      ],
      "name": "complianceRangeEvent"
    },
    {
      "discriminator": [
        180,
        158,
        195,
        25,
        82,
        168,
        241,
        110
      ],
      "name": "complianceRevokedEvent"
    },
    {
      "discriminator": [
        149,
        174,
        150,
        219,
        247,
        145,
        32,
        80
      ],
      "name": "emergencyUnshieldDenominatedStarkEvent"
    },
    {
      "discriminator": [
        38,
        246,
        60,
        173,
        91,
        171,
        52,
        136
      ],
      "name": "escrowOutcomeEvent"
    },
    {
      "discriminator": [
        174,
        132,
        185,
        57,
        1,
        40,
        80,
        217
      ],
      "name": "escrowReleaseEvent"
    },
    {
      "discriminator": [
        11,
        214,
        176,
        18,
        239,
        81,
        213,
        6
      ],
      "name": "escrowShieldEvent"
    },
    {
      "discriminator": [
        160,
        201,
        36,
        63,
        37,
        193,
        181,
        252
      ],
      "name": "merkleRootChanged"
    },
    {
      "discriminator": [
        181,
        156,
        148,
        108,
        32,
        28,
        238,
        12
      ],
      "name": "pauseVaultEvent"
    },
    {
      "discriminator": [
        109,
        14,
        52,
        1,
        74,
        46,
        35,
        110
      ],
      "name": "pauseVaultPrivateStarkEvent"
    },
    {
      "discriminator": [
        130,
        4,
        184,
        227,
        168,
        156,
        107,
        185
      ],
      "name": "resumeVaultEvent"
    },
    {
      "discriminator": [
        73,
        113,
        172,
        183,
        168,
        77,
        227,
        6
      ],
      "name": "resumeVaultPrivateStarkEvent"
    },
    {
      "discriminator": [
        39,
        76,
        79,
        219,
        67,
        39,
        15,
        10
      ],
      "name": "shieldDenominatedEvent"
    },
    {
      "discriminator": [
        63,
        189,
        150,
        76,
        39,
        180,
        65,
        230
      ],
      "name": "shieldEvent"
    },
    {
      "discriminator": [
        168,
        230,
        80,
        102,
        244,
        6,
        227,
        135
      ],
      "name": "splitNoteStarkEvent"
    },
    {
      "discriminator": [
        125,
        242,
        127,
        107,
        210,
        159,
        23,
        93
      ],
      "name": "subscribeNormalEvent"
    },
    {
      "discriminator": [
        6,
        63,
        155,
        154,
        255,
        75,
        191,
        161
      ],
      "name": "subscribePrivateStarkEvent"
    },
    {
      "discriminator": [
        133,
        189,
        147,
        133,
        147,
        8,
        70,
        127
      ],
      "name": "transferDenominatedStarkEvent"
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
        231,
        163,
        68,
        238,
        216,
        158,
        141,
        167
      ],
      "name": "unshieldDenominatedStarkEvent"
    },
    {
      "discriminator": [
        241,
        158,
        74,
        33,
        108,
        246,
        131,
        79
      ],
      "name": "unshieldEvent"
    },
    {
      "discriminator": [
        121,
        108,
        229,
        103,
        186,
        253,
        101,
        130
      ],
      "name": "vKUpdateEvent"
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "invalidProof",
      "msg": "Invalid ZK proof - verification failed"
    },
    {
      "code": 6001,
      "name": "nullifierAlreadySpent",
      "msg": "Nullifier has already been spent"
    },
    {
      "code": 6002,
      "name": "invalidMerkleRoot",
      "msg": "Invalid Merkle root - not a known root"
    },
    {
      "code": 6003,
      "name": "poolNotActive",
      "msg": "Pool is not active"
    },
    {
      "code": 6004,
      "name": "unauthorized",
      "msg": "Unauthorized - not pool authority"
    },
    {
      "code": 6005,
      "name": "invalidAmount",
      "msg": "Invalid amount - must be greater than zero"
    },
    {
      "code": 6006,
      "name": "merkleTreeFull",
      "msg": "Merkle tree is full"
    },
    {
      "code": 6007,
      "name": "insufficientBalance",
      "msg": "Insufficient shielded balance"
    },
    {
      "code": 6008,
      "name": "invalidCommitment",
      "msg": "Invalid commitment format"
    },
    {
      "code": 6009,
      "name": "invalidVerificationKey",
      "msg": "Invalid verification key"
    },
    {
      "code": 6010,
      "name": "bloomFilterHit",
      "msg": "Bloom filter indicates potential double spend"
    },
    {
      "code": 6011,
      "name": "tokenMintMismatch",
      "msg": "Token mint mismatch"
    },
    {
      "code": 6012,
      "name": "relayerFeeExceedsMax",
      "msg": "Relayer fee exceeds maximum allowed"
    },
    {
      "code": 6013,
      "name": "invalidPublicInputs",
      "msg": "Invalid public inputs"
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
      "msg": "Missing user token account for SPL token operation"
    },
    {
      "code": 6017,
      "name": "missingPoolVault",
      "msg": "Missing pool vault for SPL token operation"
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
      "name": "insufficientPoolBalance",
      "msg": "Insufficient pool balance for withdrawal"
    },
    {
      "code": 6021,
      "name": "invalidDenomination",
      "msg": "Denomination must be greater than zero"
    },
    {
      "code": 6022,
      "name": "amountMustEqualDenomination",
      "msg": "Deposit amount must equal pool denomination"
    },
    {
      "code": 6023,
      "name": "epochDelayNotMet",
      "msg": "Epoch delay not met - note is too young"
    },
    {
      "code": 6024,
      "name": "invalidEpochDelay",
      "msg": "Epoch delay must be greater than zero"
    },
    {
      "code": 6025,
      "name": "vaultNotActive",
      "msg": "Subscription vault is not active"
    },
    {
      "code": 6026,
      "name": "vaultAlreadyPaused",
      "msg": "Subscription vault is already paused"
    },
    {
      "code": 6027,
      "name": "vaultNotPaused",
      "msg": "Subscription vault is not paused"
    },
    {
      "code": 6028,
      "name": "unauthorizedVaultSubscriber",
      "msg": "Unauthorized vault subscriber"
    },
    {
      "code": 6029,
      "name": "noClaimablePeriods",
      "msg": "No claimable periods available"
    },
    {
      "code": 6030,
      "name": "insufficientVaultBalance",
      "msg": "Insufficient vault balance for claim"
    },
    {
      "code": 6031,
      "name": "invalidVaultMode",
      "msg": "Invalid vault mode for this operation"
    },
    {
      "code": 6032,
      "name": "invalidRate",
      "msg": "Subscription rate must be greater than zero"
    },
    {
      "code": 6033,
      "name": "invalidInterval",
      "msg": "Subscription interval must be greater than zero"
    },
    {
      "code": 6034,
      "name": "expectedNormalMode",
      "msg": "Expected normal (wallet) mode vault"
    },
    {
      "code": 6035,
      "name": "expectedPrivateMode",
      "msg": "Expected private (ZK) mode vault"
    },
    {
      "code": 6036,
      "name": "invalidFeeWallet",
      "msg": "Invalid protocol fee wallet"
    },
    {
      "code": 6037,
      "name": "vkUpdateCooldown",
      "msg": "VK update cooldown period has not elapsed (24h between updates)"
    },
    {
      "code": 6038,
      "name": "noPendingAuthority",
      "msg": "No pending authority transfer"
    },
    {
      "code": 6039,
      "name": "pendingAuthorityMismatch",
      "msg": "Pending authority does not match signer"
    },
    {
      "code": 6040,
      "name": "invalidSplitDenomination",
      "msg": "Invalid split denomination — source denomination must equal num_outputs * target denomination"
    },
    {
      "code": 6041,
      "name": "tooManyOutputs",
      "msg": "Too many split outputs — maximum is 20"
    },
    {
      "code": 6042,
      "name": "invalidOutputCount",
      "msg": "Invalid output count — must be between 1 and 20"
    },
    {
      "code": 6043,
      "name": "routeNotActive",
      "msg": "Privacy route is not active"
    },
    {
      "code": 6044,
      "name": "unauthorizedRoute",
      "msg": "Unauthorized route access — not route authority"
    },
    {
      "code": 6045,
      "name": "escrowAlreadySettled",
      "msg": "Auction escrow has already been settled"
    },
    {
      "code": 6046,
      "name": "escrowOutcomeNotSet",
      "msg": "Auction escrow outcome has not been determined yet"
    },
    {
      "code": 6047,
      "name": "escrowAlreadyReleased",
      "msg": "Auction escrow has already been released"
    },
    {
      "code": 6048,
      "name": "invalidAuctionId",
      "msg": "Invalid auction ID — does not match escrow"
    },
    {
      "code": 6049,
      "name": "auctionNotFinalized",
      "msg": "Auction has not been finalized by MPC"
    }
  ]
};
