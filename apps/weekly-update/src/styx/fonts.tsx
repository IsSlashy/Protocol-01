import React, { useEffect, useState } from 'react';
import { continueRender, delayRender, staticFile } from 'remotion';

/**
 * Newsreader, loaded from public/fonts rather than from a CDN.
 *
 * Local on purpose: a render runs headless, so a network fetch is one more thing
 * that can silently fail into a fallback face, and @remotion/fonts is not
 * installed, so this avoids a dependency for one typeface.
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
  const [handle] = useState(() => delayRender('Loading Newsreader'));

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
    ];

    let cancelled = false;

    Promise.all(
      faces.map((face) => face.load().then((loaded) => document.fonts.add(loaded))),
    )
      .then(() => {
        if (!cancelled) continueRender(handle);
      })
      .catch((err) => {
        console.error('Newsreader failed to load, rendering in the fallback serif', err);
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
