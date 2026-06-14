'use client';

import { useState, useEffect, useRef } from 'react';
import { Shield, CheckCircle, Lock, Zap, Clock, AlertCircle, Loader2 } from 'lucide-react';
import MugenNavbar from '@/components/MugenNavbar';
import { useP01Wallet } from '@/components/WalletProvider';

type ProofStatus = 'idle' | 'generating' | 'complete';

function GlassCard({ children, style, glow }: { children: React.ReactNode; style?: React.CSSProperties; glow?: string }) {
  return (
    <div style={{
      position: 'relative',
      background: 'rgba(255,255,255,0.03)',
      backdropFilter: 'blur(16px)', WebkitBackdropFilter: 'blur(16px)',
      border: '1px solid rgba(255,255,255,0.06)',
      borderRadius: '20px', overflow: 'hidden',
      boxShadow: glow || '0 8px 32px rgba(0,0,0,0.3)',
      ...style,
    }}>
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: '1px', background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.08), transparent)' }} />
      {children}
    </div>
  );
}

export default function CompliancePage() {
  const { connected, setShowConnectModal, publicKey } = useP01Wallet();
  const [status, setStatus] = useState<ProofStatus>('idle');
  const [progress, setProgress] = useState(0);
  const [logs, setLogs] = useState<string[]>([]);
  const logRef = useRef<HTMLDivElement>(null);

  const addLog = (msg: string) => setLogs(prev => [...prev, `> ${msg}`]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logs]);

  const startProof = async () => {
    if (!connected) { setShowConnectModal(true); return; }

    setStatus('generating');
    setProgress(0);
    setLogs([]);

    // Simulated proof generation — in production this calls sdk.compliance.proveInnocence()
    const steps = [
      { at: 5, msg: 'Initializing snarkjs runtime...' },
      { at: 12, msg: 'Loading sanctions Merkle tree (depth 20, 1M leaves)...' },
      { at: 25, msg: 'Merkle tree loaded — root: 0x6caf9948ed...' },
      { at: 32, msg: 'Computing non-membership path...' },
      { at: 45, msg: 'Path verified — low_leaf: 0x3a1f... high_leaf: 0x3a20...' },
      { at: 55, msg: 'Generating Groth16 witness (compliance_innocence.circom)...' },
      { at: 65, msg: 'Witness computed — 2048 constraints satisfied' },
      { at: 75, msg: 'Building proof (alt_bn128 pairing)...' },
      { at: 85, msg: 'Proof generated — pi_a, pi_b, pi_c computed' },
      { at: 92, msg: 'Verifying proof locally...' },
      { at: 96, msg: 'Building attestation payload (simulated, no on-chain tx)...' },
      { at: 100, msg: 'Demo complete (simulated, no on-chain tx submitted)' },
    ];

    for (const step of steps) {
      await new Promise(r => setTimeout(r, 400 + Math.random() * 300));
      setProgress(step.at);
      addLog(step.msg);
    }

    addLog('✓ Attestation active — expires in 90 days');
    setStatus('complete');
  };

  const attestationExpiry = new Date(Date.now() + 90 * 86400000);

  return (
    <>
      <MugenNavbar />
      <main style={{ position: 'relative', zIndex: 10, minHeight: '100vh', paddingTop: '6rem', paddingBottom: '4rem', paddingLeft: '1.5rem', paddingRight: '1.5rem', boxSizing: 'border-box' }}>
        <div style={{ maxWidth: '52rem', margin: '0 auto', width: '100%' }}>

          {/* Header */}
          <div style={{ textAlign: 'center', marginBottom: '2.5rem' }}>
            <div style={{
              width: '4.5rem', height: '4.5rem', borderRadius: '50%', margin: '0 auto 1.5rem',
              background: 'linear-gradient(135deg, rgba(59,130,246,0.12), rgba(139,92,246,0.08))',
              border: '1px solid rgba(59,130,246,0.15)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              boxShadow: '0 0 40px rgba(59,130,246,0.15)',
            }}>
              <Shield size={28} style={{ color: '#3b82f6' }} />
            </div>
            <h1 style={{ fontFamily: "'Orbitron',sans-serif", fontSize: '2rem', fontWeight: 800, color: 'white', margin: '0 0 0.5rem' }}>
              ZK Compliance
            </h1>
            <p style={{ color: '#8888aa', maxWidth: '32rem', margin: '0 auto', fontSize: '0.9rem', lineHeight: 1.7 }}>
              Prove you&apos;re not sanctioned, without revealing who you are.
              One proof, valid 90 days, enables unlimited trading.
            </p>
            <div style={{ marginTop: '0.9rem' }}>
              <span style={{
                display: 'inline-flex', alignItems: 'center', gap: '0.35rem',
                padding: '0.25rem 0.7rem', borderRadius: '999px',
                background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.3)',
                color: '#fcd34d', fontFamily: "'JetBrains Mono', monospace",
                fontSize: '0.62rem', textTransform: 'uppercase', letterSpacing: '0.12em',
              }}>
                <AlertCircle size={11} />
                Simulated demo (no on-chain tx)
              </span>
            </div>
          </div>

          {/* Main card */}
          <GlassCard style={{ padding: '2.5rem', marginBottom: '1.5rem' }} glow="0 8px 40px rgba(59,130,246,0.1)">
            {status === 'idle' && (
              <div style={{ textAlign: 'center' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem', marginBottom: '1.5rem' }}>
                  <AlertCircle size={20} style={{ color: '#eab308' }} />
                  <span style={{ fontFamily: "'Orbitron',sans-serif", fontSize: '1rem', fontWeight: 700, color: 'white' }}>
                    No Active Attestation
                  </span>
                </div>
                <p style={{ color: '#8888aa', fontSize: '0.85rem', maxWidth: '28rem', margin: '0 auto 2rem', lineHeight: 1.7, fontFamily: "'Inter',sans-serif" }}>
                  Generate a zero-knowledge innocence proof to start trading.
                  The proof runs entirely in your browser — no data leaves your device.
                </p>
                <button onClick={startProof} style={{
                  display: 'inline-flex', alignItems: 'center', gap: '0.5rem',
                  padding: '0.9rem 2.5rem', background: 'linear-gradient(135deg, #3b82f6, #7c3aed)',
                  border: 'none', borderRadius: '12px', color: 'white',
                  fontFamily: "'Orbitron',sans-serif", fontWeight: 700, fontSize: '0.85rem',
                  cursor: 'pointer', textTransform: 'uppercase',
                  boxShadow: '0 4px 20px rgba(59,130,246,0.3)',
                }}>
                  <Zap size={18} />
                  {connected ? 'Generate ZK Proof' : 'Connect Wallet First'}
                </button>
              </div>
            )}

            {status === 'generating' && (
              <div>
                <div style={{ textAlign: 'center', marginBottom: '1.5rem' }}>
                  <Loader2 size={32} style={{ color: '#3b82f6', animation: 'spin 1s linear infinite' }} />
                  <style dangerouslySetInnerHTML={{ __html: '@keyframes spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}' }} />
                  <h3 style={{ fontFamily: "'Orbitron',sans-serif", fontSize: '1rem', fontWeight: 700, color: 'white', marginTop: '0.75rem' }}>
                    Generating Innocence Proof
                  </h3>
                </div>

                {/* Progress bar */}
                <div style={{ width: '100%', height: '6px', background: 'rgba(255,255,255,0.05)', borderRadius: '3px', marginBottom: '0.5rem', overflow: 'hidden' }}>
                  <div style={{
                    height: '100%', borderRadius: '3px', transition: 'width 0.3s ease',
                    width: `${progress}%`,
                    background: 'linear-gradient(90deg, #3b82f6, #7c3aed)',
                    boxShadow: '0 0 10px rgba(59,130,246,0.5)',
                  }} />
                </div>
                <div style={{ textAlign: 'right', marginBottom: '1rem' }}>
                  <span style={{ fontSize: '0.7rem', color: '#555570', fontFamily: "'JetBrains Mono',monospace" }}>{progress}%</span>
                </div>

                {/* Terminal log */}
                <div
                  ref={logRef}
                  style={{
                    background: 'rgba(0,0,0,0.3)', borderRadius: '10px', padding: '1rem',
                    maxHeight: '200px', overflowY: 'auto',
                    fontFamily: "'JetBrains Mono',monospace", fontSize: '0.7rem', lineHeight: 1.8,
                  }}
                >
                  {logs.map((log, i) => (
                    <div key={i} style={{ color: log.includes('✓') ? '#22c55e' : '#8888aa' }}>
                      {log}
                    </div>
                  ))}
                  {progress < 100 && (
                    <div style={{ color: '#3b82f6' }}>
                      <span style={{ animation: 'blink-cursor 1s steps(1) infinite' }}>_</span>
                      <style dangerouslySetInnerHTML={{ __html: '@keyframes blink-cursor{0%,100%{opacity:1}50%{opacity:0}}' }} />
                    </div>
                  )}
                </div>
              </div>
            )}

            {status === 'complete' && (
              <div style={{ textAlign: 'center' }}>
                <div style={{
                  width: '4rem', height: '4rem', borderRadius: '50%', margin: '0 auto 1rem',
                  background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.2)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  boxShadow: '0 0 30px rgba(34,197,94,0.15)',
                }}>
                  <CheckCircle size={28} style={{ color: '#22c55e' }} />
                </div>
                <h3 style={{ fontFamily: "'Orbitron',sans-serif", fontSize: '1.1rem', fontWeight: 700, color: '#22c55e', marginBottom: '0.5rem' }}>
                  Attestation Active (Demo)
                </h3>
                <p style={{ color: '#8888aa', fontSize: '0.8rem', marginBottom: '1.5rem' }}>
                  ZK proof simulated locally. No on-chain attestation tx was submitted in this demo.
                </p>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '1rem', maxWidth: '20rem', margin: '0 auto' }}>
                  {[
                    { label: 'Status', value: 'Simulated', color: '#fcd34d' },
                    { label: 'Type', value: 'Innocence', color: '#8b5cf6' },
                    { label: 'Issued', value: new Date().toLocaleDateString(), color: '#f0f0ff' },
                    { label: 'Expires', value: attestationExpiry.toLocaleDateString(), color: '#f0f0ff' },
                  ].map(item => (
                    <div key={item.label} style={{ textAlign: 'left' }}>
                      <span style={{ fontSize: '0.6rem', color: '#555570', fontFamily: "'JetBrains Mono',monospace", textTransform: 'uppercase', letterSpacing: '0.1em' }}>{item.label}</span>
                      <p style={{ fontSize: '0.85rem', color: item.color, fontFamily: "'JetBrains Mono',monospace", margin: '0.2rem 0 0' }}>{item.value}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </GlassCard>

          {/* Info cards */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '1rem' }}>
            {[
              { icon: Lock, title: 'Zero Knowledge', desc: 'Reveals nothing about you. Only that you\'re not sanctioned.', color: '#3b82f6' },
              { icon: Zap, title: 'Local Computation', desc: 'Runs entirely in your browser. No data leaves your device.', color: '#8b5cf6' },
              { icon: Clock, title: '90-Day Validity', desc: 'One proof enables 90 days of unlimited trading on Mugen.', color: '#60a5fa' },
            ].map(card => (
              <GlassCard key={card.title} style={{ padding: '1.5rem' }}>
                <card.icon size={20} style={{ color: card.color, marginBottom: '0.75rem' }} />
                <h4 style={{ fontFamily: "'Orbitron',sans-serif", fontSize: '0.8rem', fontWeight: 700, color: 'white', marginBottom: '0.4rem' }}>{card.title}</h4>
                <p style={{ fontSize: '0.75rem', color: '#8888aa', lineHeight: 1.6 }}>{card.desc}</p>
              </GlassCard>
            ))}
          </div>
        </div>
      </main>
    </>
  );
}
