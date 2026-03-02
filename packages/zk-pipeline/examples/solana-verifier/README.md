# Solana Verifier Example

This example shows how to build a minimal Solana program that verifies a Groth16 proof.

## Architecture

```
Client (mobile/web)
  |-- Generate proof with @p01/react-native-zk
  |-- Convert proof format with @p01/privacy-toolkit
  |-- Send transaction to Solana
       |-- Program verifies with @p01/solana-verifier
```

## Program Structure

```rust
use anchor_lang::prelude::*;
use p01_solana_verifier::{verify_proof, Groth16Proof};

#[program]
pub mod my_verifier {
    use super::*;

    pub fn verify(
        ctx: Context<Verify>,
        proof_bytes: [u8; 256],
        public_inputs: Vec<[u8; 32]>,
    ) -> Result<()> {
        let vk_data = &ctx.accounts.vk_account.data.borrow();
        let proof = Groth16Proof::from_bytes(&proof_bytes)
            .map_err(|_| error!(MyError::InvalidProof))?;

        let valid = verify_proof(vk_data, &proof, &public_inputs)
            .map_err(|_| error!(MyError::VerificationFailed))?;

        require!(valid, MyError::ProofInvalid);

        msg!("Proof verified successfully!");
        Ok(())
    }
}
```

## Client Side

```typescript
import { proofToOnChainBytes, publicInputsToLE } from '@p01/privacy-toolkit';

// Convert snarkjs proof to on-chain format
const proofBytes = proofToOnChainBytes(snarkjsProof);
const inputBytes = publicInputsToLE(publicSignals);

// Send transaction
const ix = new TransactionInstruction({
  programId: PROGRAM_ID,
  keys: [/* ... */],
  data: Buffer.concat([discriminator, Buffer.from(proofBytes), ...inputBytes.map(b => Buffer.from(b))]),
});
```

## Compute Budget

Don't forget to set the compute budget:

```typescript
tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 500_000 }));
```

See `gotchas/compute-budget.md` for the full guide.
