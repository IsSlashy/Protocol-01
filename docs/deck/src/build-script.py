# -*- coding: utf-8 -*-
"""
Generate `three-minute-script.md` from `plates.py`.

🚨 WHY THIS FILE EXISTS. The README has claimed since it was written that the
spoken script is "generated from src/plates.py, so it cannot drift from the
deck". Nothing generated it. MEASURED 2026-08-28: the checked-in script still
said "every deployed spend republishes its deposit's commitment" — a sentence
plates.py names in its own header and forbids reinstating, because C7 stopped it
being true on 25 August. The document that could not drift had drifted, and it
had drifted into the exact claim the deck exists to refuse.

A generated file is only ungrafted from its source while something regenerates
it. This is that something.

    python docs/deck/src/build-script.py docs/deck/src docs/deck/three-minute-script.md
"""

import io
import re
import sys

SP = sys.argv[1] if len(sys.argv) > 1 else '.'
OUT = sys.argv[2] if len(sys.argv) > 2 else SP + '/three-minute-script.md'

sys.path.insert(0, SP)
from plates import SPINE, APPENDIX  # noqa: E402

WPM = 145  # the pitch pace the template analysis used, brisk and not comfortable


def strip_tags(fragment):
    """Visible text of a plate body, entities resolved the way a reader sees them."""
    text = re.sub(r'<[^>]+>', ' ', fragment)
    for entity, char in [
        ('&nbsp;', ' '), ('&thinsp;', ' '), ('&mdash;', '—'), ('&ndash;', '–'),
        ('&rsquo;', '’'), ('&lsquo;', '‘'), ('&ldquo;', '“'), ('&rdquo;', '”'),
        ('&hellip;', '…'), ('&amp;', '&'), ('&lt;', '<'), ('&gt;', '>'),
        ('&#9888;', '⚠'),
    ]:
        text = text.replace(entity, char)
    return re.sub(r'\s+', ' ', text).strip()


def words(fragment):
    return len(strip_tags(fragment).split())


out = []
out.append('# The three minute script')
out.append('')
out.append('⚠️ GENERATED from `src/plates.py` by `src/build-script.py`. Edit the plates,')
out.append('then regenerate — an edit made here is lost on the next build, and a plate')
out.append('edited without regenerating leaves this file saying something the deck no')
out.append('longer says. That happened: this file carried "every deployed spend')
out.append('republishes its deposit\'s commitment" for three days after C7 made it false.')
out.append('')
out.append(f'Budget is {WPM} words a minute. The totals at the bottom are measured, not')
out.append('estimated.')
out.append('')
out.append('Read the **spoken** block out loud. What is on the plate is the evidence you')
out.append('are pointing at, not a script to read back to the room.')
out.append('')

total_spoken = 0
total_secs = 0
for p in SPINE:
    clock = p.get('clock') or ''
    role = p.get('role') or ''
    out.append(f"## {p['no']} · {role} · {clock}".rstrip(' ·'))
    out.append('')
    plate_words = words(p['body'])
    out.append(f"**On the plate ({plate_words} words):** {strip_tags(p['body'])}")
    out.append('')
    spoken = p.get('spoken') or ''
    if spoken:
        n = len(spoken.split())
        secs = p.get('seconds') or 0
        budget = round(secs / 60 * WPM) if secs else 0
        total_spoken += n
        total_secs += secs
        flag = '  ⛔ OVER BUDGET' if budget and n > budget else ''
        out.append(f"**Spoken ({n} words, budget {budget}){flag}:**")
        out.append('')
        out.append(f'> {spoken}')
        out.append('')

out.append('---')
out.append('')
out.append('## Totals, measured')
out.append('')
out.append('| | |')
out.append('|---|---|')
out.append(f'| spoken words | {total_spoken} |')
out.append(f'| at {WPM} wpm | {total_spoken / WPM * 60:.0f} s |')
out.append(f'| budget | {total_secs} s |')
appx = sum(words(p['body']) for p in APPENDIX)
out.append(f'| appendix | {len(APPENDIX)} plates, {appx} words, never presented |')
out.append('')

io.open(OUT, 'w', encoding='utf-8', newline='\n').write('\n'.join(out))
print(f'wrote {OUT}')
print(f'spoken {total_spoken} words = {total_spoken / WPM * 60:.0f} s at {WPM} wpm, '
      f'budget {total_secs} s')
