import React from 'react';
import { interpolate, useCurrentFrame, useVideoConfig } from 'remotion';
import { Eyebrow, Frame, Lede, Mono, Numeral, Rule, Stack } from '../../styx/kit';
import { space, styx, styxFonts, type } from '../../styx/theme';
import type { Beat as BeatData } from './script';

/**
 * One beat of the film.
 *
 * Deliberately generic rather than nine bespoke scenes. The old pitch had a
 * separate component per scene and they drifted: different margins, different
 * entrances, a different idea of what a title was. Here the layout IS the design
 * system, so a beat can only differ in its words, and the eye is never asked to
 * relearn the frame.
 *
 * Beats alternate ground: the act's first beat sits on ink, the next on panel.
 * That is the same alternating-band device the site uses to read as chapters.
 */
export const Beat: React.FC<{ beat: BeatData; band?: boolean; index: number }> = ({
  beat,
  band,
  index,
}) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();

  /* Everything leaves together in the last 18 frames, so a cut never happens on
     a half-faded element. */
  const out = interpolate(frame, [durationInFrames - 18, durationInFrames], [1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  return (
    <Frame band={band}>
      <div style={{ opacity: out, display: 'flex', gap: space.gapLg }}>
        {/* The margin: the act number, and nothing else. */}
        <div style={{ width: 420, flex: 'none' }}>
          {beat.act ? <Numeral delay={6}>{beat.act}</Numeral> : null}
        </div>

        <Stack gap={space.gap}>
          <Eyebrow delay={0}>{beat.eyebrow}</Eyebrow>

          <Statementish beat={beat} index={index} />

          <Rule delay={30} width={2400} />

          {beat.lede ? <Lede delay={44}>{beat.lede}</Lede> : null}

          {beat.evidence ? (
            <Mono delay={62} size={type.body} color={styx.faint}>
              {beat.evidence}
            </Mono>
          ) : null}
        </Stack>
      </div>
    </Frame>
  );
};

/**
 * The statement, sized to the line rather than to a constant.
 *
 * A fixed display size makes a short line look timid and a long one wrap into
 * four cramped rows, which is exactly what went wrong on the first cut. This
 * picks a size band from the character count. It is a blunt rule and it is
 * better than one number for every sentence.
 */
const Statementish: React.FC<{ beat: BeatData; index: number }> = ({ beat, index }) => {
  const frame = useCurrentFrame();
  const len = beat.statement.length;
  const size = len < 46 ? type.display : len < 70 ? type.h1 : type.h2;

  const t = interpolate(frame, [10, 44], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  return (
    <div
      style={{
        opacity: t,
        transform: `translateY(${(1 - t) * 44}px)`,
        fontFamily: styxFonts.serif,
        fontWeight: size >= type.h1 ? 300 : 400,
        fontSize: size,
        lineHeight: 1.05,
        letterSpacing: '-0.022em',
        maxWidth: 2500,
        // The first beat of each act carries the italic, so the ornament appears
        // three times in two minutes rather than in every shot.
        fontStyle: 'normal',
      }}
      data-beat={index}
    >
      {beat.statement}
    </div>
  );
};
