import React, { useEffect, useState } from 'react';
import { continueRender, delayRender, staticFile } from 'remotion';

/**
 * Newsreader, Inter and JetBrains Mono, loaded from public/fonts rather than
 * from a CDN.
 *
 * Local on purpose: a render runs headless, so a network fetch is one more thing
 * that can silently fail into a fallback face, and @remotion/fonts is not
 * installed, so this avoids a dependency for three typefaces. Inter and
 * JetBrains Mono are the latin subsets the printed design document embeds
 * (docs/_styx-print-fonts.css); neither is installed on the render machine, and
 * before 2026-09-13 the sans and mono lines were silently set in Segoe UI and
 * Consolas.
 *
 * WHY THIS IS A COMPONENT AND NOT A MODULE SIDE EFFECT. The first version called
 * `delayRender()` at module scope, which is the old Remotion 3 pattern. It
 * survived `remotion still` and then failed every chunk of the real render:
 * `delayRender` throws when the module is evaluated during bundling, in Node,
 * where there is no render context at all. The stack pointed at
 * webpack/bootstrap, not at a browser frame. Calling it in the first render of a
 * mounted component is the version that works in both.
 *
 * WHY delayRender AT ALL. A webfont load is asynchronous and Remotion screenshots
 * a frame as soon as the tree settles, so without a handle the opening frames
 * render in the fallback serif and the render still reports success. The handle
 * is released on failure too: a handle that is never released hangs the render
 * with no diagnostic, which is worse than one frame in the wrong face.
 *
 * Mount it once, at the top of the composition, above everything that draws type.
 */
export const StyxFonts: React.FC = () => {
  const [handle] = useState(() => delayRender('Loading Styx fonts'));

  useEffect(() => {
    const faces = [
      new FontFace(
        'Newsreader',
        `url(${staticFile('fonts/newsreader-latin.woff2')}) format('woff2')`,
        { weight: '200 800', style: 'normal', display: 'block' },
      ),
      new FontFace(
        'Newsreader',
        `url(${staticFile('fonts/newsreader-latin-italic.woff2')}) format('woff2')`,
        { weight: '200 800', style: 'italic', display: 'block' },
      ),
      new FontFace('Inter', `url(${staticFile('fonts/inter.woff2')}) format('woff2')`, {
        weight: '100 900',
        style: 'normal',
        display: 'block',
      }),
      new FontFace(
        'JetBrains Mono',
        `url(${staticFile('fonts/jetbrains-mono.woff2')}) format('woff2')`,
        { weight: '100 800', style: 'normal', display: 'block' },
      ),
    ];

    let cancelled = false;

    Promise.all(
      faces.map((face) => face.load().then((loaded) => document.fonts.add(loaded))),
    )
      .then(() => {
        if (!cancelled) continueRender(handle);
      })
      .catch((err) => {
        console.error('A Styx font failed to load, rendering in the fallback face', err);
        if (!cancelled) continueRender(handle);
      });

    return () => {
      cancelled = true;
      continueRender(handle);
    };
  }, [handle]);

  return null;
};

export const NEWSREADER =
  'Newsreader, "Iowan Old Style", "Palatino Linotype", Georgia, serif';
