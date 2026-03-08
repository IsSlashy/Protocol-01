//! STARK prover for Protocol 01 circuits.
//!
//! Generates proofs client-side (browser WASM or mobile WebView).
//! The prover never needs to communicate with any server — spending keys
//! never leave the device.

use winterfell::{
    crypto::{hashers::Blake3_256, DefaultRandomCoin, MerkleTree},
    math::{fields::f64::BaseElement, FieldElement},
    matrix::ColMatrix,
    AuxRandElements, ConstraintCompositionCoefficients, DefaultConstraintEvaluator,
    DefaultTraceLde, FieldExtension, PartitionOptions, Proof, ProofOptions, Prover,
    ProverError, StarkDomain, TraceInfo, TracePolyTable, TraceTable,
};

use crate::air::subscriber_ownership::{
    build_trace, SubscriberOwnershipAir, SubscriberOwnershipPublicInputs,
};

// ============================================================================
// Proof serialization
// ============================================================================

/// Serialized STARK proof bytes, ready for on-chain verification.
#[derive(Clone, Debug)]
pub struct StarkProofBytes {
    /// The serialized proof
    pub proof_bytes: Vec<u8>,
    /// Public inputs (commitment as u64)
    pub commitment: u64,
    /// Approximate proof size in bytes
    pub size: usize,
}

// ============================================================================
// Proof options
// ============================================================================

/// Default proof options for Protocol 01 circuits.
///
/// Tuned for:
/// - 128-bit security
/// - Reasonable proof size (~40-80KB)
/// - Fast client-side proving
fn default_proof_options() -> ProofOptions {
    ProofOptions::new(
        32, // number of queries (security parameter)
        8,  // blowup factor (trace domain / constraint domain)
        0,  // grinding factor (0 = no proof-of-work, faster proving)
        FieldExtension::None, // base field only
        8,  // FRI folding factor
        31, // FRI max remainder polynomial degree
    )
}

// ============================================================================
// Type aliases
// ============================================================================

type P01HashFn = Blake3_256<BaseElement>;
type P01VC = MerkleTree<P01HashFn>;
type P01RandomCoin = DefaultRandomCoin<P01HashFn>;

// ============================================================================
// Subscriber Ownership Prover
// ============================================================================

struct SubscriberOwnershipProver {
    options: ProofOptions,
}

impl SubscriberOwnershipProver {
    fn new() -> Self {
        Self {
            options: default_proof_options(),
        }
    }
}

impl Prover for SubscriberOwnershipProver {
    type BaseField = BaseElement;
    type Air = SubscriberOwnershipAir;
    type Trace = TraceTable<BaseElement>;
    type HashFn = P01HashFn;
    type VC = P01VC;
    type RandomCoin = P01RandomCoin;
    type TraceLde<E: FieldElement<BaseField = BaseElement>> =
        DefaultTraceLde<E, Self::HashFn, Self::VC>;
    type ConstraintEvaluator<'a, E: FieldElement<BaseField = BaseElement>> =
        DefaultConstraintEvaluator<'a, Self::Air, E>;

    fn get_pub_inputs(&self, trace: &Self::Trace) -> SubscriberOwnershipPublicInputs {
        // Extract commitment from the trace: state[0] at row 30
        let commitment = trace.get(0, 30);
        SubscriberOwnershipPublicInputs { commitment }
    }

    fn options(&self) -> &ProofOptions {
        &self.options
    }

    fn new_trace_lde<E: FieldElement<BaseField = BaseElement>>(
        &self,
        trace_info: &TraceInfo,
        main_trace: &ColMatrix<BaseElement>,
        domain: &StarkDomain<BaseElement>,
        partition_option: PartitionOptions,
    ) -> (Self::TraceLde<E>, TracePolyTable<E>) {
        DefaultTraceLde::new(trace_info, main_trace, domain, partition_option)
    }

    fn new_evaluator<'a, E: FieldElement<BaseField = BaseElement>>(
        &self,
        air: &'a Self::Air,
        aux_rand_elements: Option<AuxRandElements<E>>,
        composition_coefficients: ConstraintCompositionCoefficients<E>,
    ) -> Self::ConstraintEvaluator<'a, E> {
        DefaultConstraintEvaluator::new(air, aux_rand_elements, composition_coefficients)
    }
}

/// Generate a STARK proof for subscriber ownership.
///
/// Proves knowledge of `subscriber_secret` such that
/// `Poseidon(subscriber_secret) == commitment` without revealing the secret.
///
/// Returns the proof and public inputs.
pub fn prove_subscriber_ownership(
    subscriber_secret: u64,
) -> Result<(Proof, SubscriberOwnershipPublicInputs), ProverError> {
    let secret = BaseElement::new(subscriber_secret);

    // Build execution trace
    let trace_data = build_trace(secret);
    let trace = TraceTable::init(trace_data);

    // Extract public inputs (commitment) from trace
    let commitment = trace.get(0, 30);
    let pub_inputs = SubscriberOwnershipPublicInputs { commitment };

    // Generate proof
    let prover = SubscriberOwnershipProver::new();
    let proof = prover.prove(trace)?;

    Ok((proof, pub_inputs))
}

// ============================================================================
// Generic prover/verifier (works with any AIR)
// ============================================================================

struct GenericProver<A: winterfell::Air<BaseField = BaseElement> + 'static> {
    options: ProofOptions,
    pub_inputs: A::PublicInputs,
}

impl<A> Prover for GenericProver<A>
where
    A: winterfell::Air<BaseField = BaseElement, PublicInputs: Clone> + 'static,
{
    type BaseField = BaseElement;
    type Air = A;
    type Trace = TraceTable<BaseElement>;
    type HashFn = P01HashFn;
    type VC = P01VC;
    type RandomCoin = P01RandomCoin;
    type TraceLde<E: FieldElement<BaseField = BaseElement>> =
        DefaultTraceLde<E, Self::HashFn, Self::VC>;
    type ConstraintEvaluator<'a, E: FieldElement<BaseField = BaseElement>> =
        DefaultConstraintEvaluator<'a, Self::Air, E>;

    fn get_pub_inputs(&self, _trace: &Self::Trace) -> A::PublicInputs {
        self.pub_inputs.clone()
    }

    fn options(&self) -> &ProofOptions {
        &self.options
    }

    fn new_trace_lde<E: FieldElement<BaseField = BaseElement>>(
        &self,
        trace_info: &TraceInfo,
        main_trace: &ColMatrix<BaseElement>,
        domain: &StarkDomain<BaseElement>,
        partition_option: PartitionOptions,
    ) -> (Self::TraceLde<E>, TracePolyTable<E>) {
        DefaultTraceLde::new(trace_info, main_trace, domain, partition_option)
    }

    fn new_evaluator<'a, E: FieldElement<BaseField = BaseElement>>(
        &self,
        air: &'a Self::Air,
        aux_rand_elements: Option<AuxRandElements<E>>,
        composition_coefficients: ConstraintCompositionCoefficients<E>,
    ) -> Self::ConstraintEvaluator<'a, E> {
        DefaultConstraintEvaluator::new(air, aux_rand_elements, composition_coefficients)
    }
}

/// Generate a proof for any AIR using the standard P01 hash config.
pub fn prove_generic<A>(
    trace_data: Vec<Vec<BaseElement>>,
    pub_inputs: A::PublicInputs,
) -> Result<(Proof, A::PublicInputs), ProverError>
where
    A: winterfell::Air<BaseField = BaseElement, PublicInputs: Clone> + 'static,
{
    let trace = TraceTable::init(trace_data);
    let prover = GenericProver::<A> {
        options: default_proof_options(),
        pub_inputs: pub_inputs.clone(),
    };
    let proof = prover.prove(trace)?;
    Ok((proof, pub_inputs))
}

/// Verify a proof for any AIR using the standard P01 hash config.
#[cfg(feature = "std")]
pub fn verify_generic<A>(
    proof: Proof,
    pub_inputs: A::PublicInputs,
) -> Result<(), winterfell::VerifierError>
where
    A: winterfell::Air<BaseField = BaseElement, PublicInputs: Clone> + 'static,
{
    let acceptable = winterfell::AcceptableOptions::OptionSet(vec![default_proof_options()]);
    winterfell::verify::<A, P01HashFn, P01RandomCoin, P01VC>(proof, pub_inputs, &acceptable)
}

/// Serialize proof to bytes for on-chain submission or transport.
pub fn serialize_proof(
    proof: &Proof,
    pub_inputs: &SubscriberOwnershipPublicInputs,
) -> StarkProofBytes {
    let proof_bytes = proof.to_bytes();
    let size = proof_bytes.len();

    StarkProofBytes {
        proof_bytes,
        commitment: pub_inputs.commitment.as_int(),
        size,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_prove_subscriber_ownership() {
        let secret = 42u64;
        let result = prove_subscriber_ownership(secret);
        assert!(result.is_ok(), "Proof generation should succeed");

        let (proof, pub_inputs) = result.unwrap();
        let proof_bytes = serialize_proof(&proof, &pub_inputs);

        println!("Proof size: {} bytes", proof_bytes.size);
        println!("Commitment: {}", proof_bytes.commitment);

        // Proof should be reasonable size (< 200KB)
        assert!(
            proof_bytes.size < 200_000,
            "Proof too large: {}",
            proof_bytes.size
        );
        assert!(proof_bytes.size > 0, "Proof should not be empty");
    }
}
