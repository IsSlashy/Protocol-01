/**
 * Example: @p01/react-native-zk
 *
 * Minimal Expo app demonstrating client-side ZK proof generation.
 */
import React, { useRef, useState } from 'react';
import { View, Text, Button, StyleSheet, ScrollView } from 'react-native';
import { ZKProver, type ZKProverRef } from '@p01/react-native-zk';

export default function App() {
  const proverRef = useRef<ZKProverRef>(null);
  const [status, setStatus] = useState('Ready');
  const [result, setResult] = useState<string | null>(null);

  const handleLoadCircuit = async () => {
    setStatus('Loading circuit...');
    try {
      const loaded = await proverRef.current?.loadCircuit('example', {
        wasmUri: 'example_circuit.wasm',
        zkeyUri: 'example_circuit_final.zkey',
      });
      setStatus(loaded ? 'Circuit loaded!' : 'Failed to load circuit');
    } catch (err: any) {
      setStatus(`Error: ${err.message}`);
    }
  };

  const handleProve = async () => {
    setStatus('Generating proof...');
    const start = Date.now();
    try {
      const proof = await proverRef.current?.prove('example', {
        // Your circuit's private inputs
        secret: '123456789',
        nullifier: '987654321',
      });
      const ms = Date.now() - start;
      setStatus(`Proof generated in ${ms}ms`);
      setResult(JSON.stringify(proof?.publicSignals, null, 2));
    } catch (err: any) {
      setStatus(`Error: ${err.message}`);
    }
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>@p01/react-native-zk Demo</Text>
      <Text style={styles.status}>{status}</Text>

      <Button title="Load Circuit" onPress={handleLoadCircuit} />
      <View style={{ height: 12 }} />
      <Button title="Generate Proof" onPress={handleProve} />

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
