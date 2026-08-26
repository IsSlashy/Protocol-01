# -*- coding: utf-8 -*-
"""
Regenerates deck-head.html from the long deck.

The short deck does not carry its own copy of the design system or of the
inlined Newsreader: it takes the head of castle-dao-2026-09-04.html verbatim, so
the two decks cannot drift apart, and so the font is stored once in this repo
rather than twice.

Two print rules are patched on the way through, both measured on a real export:

  1. print-color-adjust: exact. Without it a headless or default print drops
     every background and the deck comes out black on white, unreadable. This is
     the automated equivalent of ticking "Background graphics" in the browser
     print dialog, which the long deck still needs by hand.

  2. min-height: 960px on .plate, with justify-content: center. The long deck's
     print block sets the plate height to auto, which collapses each plate into
     the top half of the page and leaves the bottom half empty. No fixed height
     and no overflow: hidden, so a plate taller than a page still grows onto the
     next one instead of losing its number, which is how the July deck lost two.

Usage, from the repo root:

    python docs/deck/src/make-head.py
"""
import io
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
DECK = os.path.join(HERE, '..', 'castle-dao-2026-09-04.html')
OUT = os.path.join(HERE, 'deck-head.html')

src = io.open(DECK, encoding='utf-8').read()
head = src[:src.index('</head>')]

head = head.replace('<title>Styx at Castle DAO</title>',
                    '<title>Styx, three minutes</title>', 1)

OLD = '''    html, body { background: #070709 !important; }
    .plate {
      min-height: auto !important;
      height: auto !important;'''

NEW = '''    *, *::before, *::after { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
    html, body { background: #070709 !important; }
    .plate {
      min-height: 960px !important;
      height: auto !important;
      justify-content: center !important;'''

if OLD not in head:
    sys.exit('print block not found in the long deck: it was edited, patch make-head.py')

head = head.replace(OLD, NEW, 1)

if 'data:font/woff2;base64' not in head:
    sys.exit('the inlined font is gone from the long deck head, stop and look')

io.open(OUT, 'w', encoding='utf-8').write(head)
print('wrote %s (%d bytes, font inlined)' % (OUT, len(head)))
