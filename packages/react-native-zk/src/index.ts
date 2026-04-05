/**
 * @protocol-01/react-native-zk - Client-side Groth16 ZK proof generation for React Native
 *
 * Runs snarkjs inside a hidden WebView for on-device proof generation.
 * Private inputs never leave the phone.
 *
 * Compatible with React 18 and React 19. For React 19, prefer the hook-based
 * API (`useZKProver` via `ZKProverProvider`) which avoids ref forwarding changes.
 *
 * @example
 * ```tsx
 * import { ZKProverProvider, useZKProver } from '@protocol-01/react-native-zk';
 *
 * function App() {
 *   return (
 *     <ZKProverProvider>
 *       <MyScreen />
 *     </ZKProverProvider>
 *   );
 * }
 *
 * function MyScreen() {
 *   const { loadCircuit, prove, isProving } = useZKProver();
 *   // ...
 * }
 * ```
 */
export { ZKProver, ZKProverProvider, useZKProver } from './ZKProver';
export { loadCircuitAssets, isCircuitCached, clearCircuitCache } from './CircuitLoader';
export type {
  CircuitConfig,
  ProofResult,
  ProverOptions,
  ZKProverRef,
  CircuitLoadResult,
} from './types';
