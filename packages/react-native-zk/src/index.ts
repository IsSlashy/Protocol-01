/**
 * `@protocol-01/react-native-zk` — Client-side STARK proof generation for React Native.
 *
 * v2 ships a Goldilocks-field STARK pipeline (`p01_stark_bg.wasm`, ~124 KB,
 * inlined as base64 in `wasmData.ts`). Proofs are quantum-safe, ~5x faster
 * to generate than the v1 Groth16 outputs, and require no trusted setup —
 * the `.zkey` half is gone. Private inputs never leave the device.
 *
 * Compatible with React 18 and 19. For React 19, prefer the hook-based API
 * (`useZKProver` via `<ZKProverProvider>`) which avoids ref-forwarding
 * subtleties.
 *
 * @example
 * ```tsx
 * import { ZKProverProvider, useZKProver } from '@protocol-01/react-native-zk';
 *
 * function App() {
 *   return <ZKProverProvider><Screen /></ZKProverProvider>;
 * }
 *
 * function Screen() {
 *   const { generateBalanceProof, isReady } = useZKProver();
 *   const onPress = async () => {
 *     const r = await generateBalanceProof('req-1', sk, balance, salt, mint);
 *     console.log(r.proofHex);
 *   };
 *   return <Button onPress={onPress} disabled={!isReady} />;
 * }
 * ```
 */
export {
  ZKProver,
  ZKProverProvider,
  useZKProver,
  type ZKProverContextValue,
} from './ZKProver';

export {
  loadFromExpoAsset,
  loadFromApkAssets,
  loadCircuitAssets,
  isCircuitCached,
  clearCircuitCache,
} from './CircuitLoader';

export { STARK_WASM_BASE64 } from './wasmData';

export type {
  ProofResult,
  ProverOptions,
  ZKProverRef,
  CircuitLoadResult,
  StarkCircuitId,
} from './types';
