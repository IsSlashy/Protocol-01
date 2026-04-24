import React from 'react';
import { AbsoluteFill, useCurrentFrame, spring, useVideoConfig } from 'remotion';
import { GlowBackground, ScanLine } from '../../components/Background';
import { TextReveal, Typewriter, Badge } from '../../components/Typography';
import { CyanLine, StatCard } from '../../components/Shapes';
import { Narrative } from '../../components/TextBlock';
import { colors, fonts } from '../../theme';

/**
 * Scene 6 — 1:33 → 1:50 (1020 frames @ 60fps)
 *
 * Voiceover: "Why me? Because I'm cybersecurity first, crypto builder second.
 * Fourteen Anchor programs, twelve SDKs, three clients, a P2P exchange — all
 * in three months, solo, on zero funding. Not because I'm faster than teams.
 * Because I own every layer from the circuit up to the mobile UX. No handoff.
 * Just me — and that compresses the feedback loop to hours."
 */
export const WhyMe: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const stats = [
    { value: '14', label: 'Anchor Programs', color: colors.cyan },
    { value: '12', label: 'TypeScript SDKs', color: colors.brightCyan },
    { value: '3', label: 'Clients', color: colors.pink },
    { value: '1', label: 'Engineer', color: colors.yellow },
  ];

  return (
    <AbsoluteFill>
      <GlowBackground />
      <ScanLine />

      <AbsoluteFill
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 100,
          gap: 44,
        }}
      >
        <Badge text="Why me" delay={0} color={colors.pink} />

        <TextReveal
          text="Cybersecurity first. Crypto builder second."
          delay={10}
          fontSize={80}
          maxWidth="2800px"
        />

        <CyanLine delay={25} width="600px" />

        {/* Stat grid */}
        <div style={{ display: 'flex', gap: 32, flexWrap: 'wrap', justifyContent: 'center' }}>
          {stats.map((s, i) => (
            <StatCard key={i} value={s.value} label={s.label} delay={40 + i * 10} color={s.color} />
          ))}
        </div>

        <Narrative
          lines={[
            'Three months. Solo. Zero funding.',
            'I own every layer — from the circuit up to the mobile UX.',
            'No handoff. The feedback loop compresses to hours.',
          ]}
          delay={130}
          fontSize={44}
          lineDelay={22}
          highlight={[0]}
        />

        <Typewriter
          text="// this is what one engineer ships when the stakes are clear"
          delay={240}
          fontSize={28}
          color={colors.textDim}
        />
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
