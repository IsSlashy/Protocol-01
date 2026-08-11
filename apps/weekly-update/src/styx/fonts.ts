import { continueRender, delayRender, staticFile } from 'remotion';

/**
 * Newsreader, loaded from public/fonts rather than from a CDN.
 *
 * Two reasons it is local. A render runs headless and offline-ish, so a network
 * fetch is one more thing that can silently fail into a fallback face; and
 * @remotion/google-fonts is not installed, so a local file avoids adding a
 * dependency for one typeface.
 *
 * THE PART THAT MATTERS: delayRender. Remotion screenshots a frame as soon as
 * the component tree settles, and a webfont load is asynchronous, so without a
 * handle the first frames render in the fallback serif and the render finishes
 * "successfully" with the wrong typography burned in. The handle blocks the
 * renderer until both faces are ready, and is released on failure too, because a
 * never-released handle hangs the render forever with no error.
 *
 * Import this module once, at the top of the composition.
 */
const handle = delayRender('Loading Newsreader');

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

Promise.all(
  faces.map((face) => face.load().then((loaded) => document.fonts.add(loaded))),
)
  .then(() => continueRender(handle))
  .catch((err) => {
    // Release the handle no matter what: a stuck handle is a hung render with no
    // diagnostic, which is far worse than a frame in the fallback face.
    console.error('Newsreader failed to load, rendering in the fallback serif', err);
    continueRender(handle);
  });

export const NEWSREADER = 'Newsreader, "Iowan Old Style", "Palatino Linotype", Georgia, serif';
