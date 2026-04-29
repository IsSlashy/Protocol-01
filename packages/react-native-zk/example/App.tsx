/**
 * Example: @protocol-01/react-native-zk v2 (STARK)
 *
 * Minimal Expo app demonstrating client-side STARK proof generation.
 * The WASM is bundled inside the package as base64 — no asset registration,
 * no CDN load, no zkey. Private inputs never leave the device.
 */
import React, { useRef, useState } from 'react';
import { View, Text, Button, StyleSheet, ScrollView } from 'react-native';
import { ZKProver, type ZKProverRef } from '@protocol-01/react-native-zk';

export default function App() {
  const proverRef = useRef<ZKProverRef>(null);
  const [status, setStatus] = useState('Ready');
  const [result, setResult] = useState<string | null>(null);

  const handleLoadWasm = async () => {
    setStatus('Loading STARK WASM...');
    try {
      const ok = await proverRef.current?.loadWasm();
      setStatus(ok ? 'WASM loaded — ready to prove' : 'Failed to load WASM');
    } catch (err: unknown) {
      setStatus(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleProve = async () => {
    setStatus('Generating proof...');
    const start = Date.now();
    try {
      // Circuit 1 (POOL_COMMITMENT) — proves knowledge of (nullifierPreimage,
      // secret) for a given (epoch, mint). Returns nullifier + commitment.
      const proof = await proverRef.current?.generatePoolCommitmentProof(
        'demo-1',
        '123456789',         // nullifierPreimage
        '987654321',         // secret
        '1',                 // depositEpoch
        '1',                 // tokenMint
      );
      const ms = Date.now() - start;
      setStatus(`Proof generated in ${ms}ms (${proof?.proofSize ?? 0} bytes)`);
      setResult(JSON.stringify(proof?.publicInputs, null, 2));
    } catch (err: unknown) {
      setStatus(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>@protocol-01/react-native-zk Demo (STARK)</Text>
      <Text style={styles.status}>{status}</Text>

      <Button title="Load WASM" onPress={handleLoadWasm} />
      <View style={{ height: 12 }} />
      <Button title="Generate Pool Commitment Proof" onPress={handleProve} />

      {result && (
        <ScrollView style={styles.result}>
          <Text style={styles.code}>{result}</Text>
        </ScrollView>
      )}

      <ZKProver ref={proverRef} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 24, paddingTop: 60 },
  title: { fontSize: 24, fontWeight: 'bold', marginBottom: 16 },
  status: { fontSize: 16, marginBottom: 16, color: '#666' },
  result: { marginTop: 16, maxHeight: 200, backgroundColor: '#f0f0f0', borderRadius: 8, padding: 12 },
  code: { fontFamily: 'monospace', fontSize: 12 },
});
