# Assembles the three minute deck from deck-head.html + deck-extra.css + plates.py
# The head carries the Styx design system and the inlined Newsreader, byte for byte
# from the Castle DAO deck, so the new deck cannot drift from the old one.
import io, re, sys, json

SP = sys.argv[1] if len(sys.argv) > 1 else '.'
OUT = sys.argv[2] if len(sys.argv) > 2 else SP + '/styx-3min.html'

head = io.open(SP + '/deck-head.html', encoding='utf-8').read()
extra = io.open(SP + '/deck-extra.css', encoding='utf-8').read()

# splice the additions into the last style block, before its closing tag
i = head.rindex('</style>')
head = head[:i] + extra + '\n' + head[i:]

sys.path.insert(0, SP)
from plates import SPINE, APPENDIX, DIVIDER  # noqa: E402

WORD_RE = re.compile(r'<[^>]+>')


# The cap governs PROSE: the eyebrow, the headline, and the supporting line.
# Two things are excluded and reported separately, because neither is narrated:
#   .foot   the standing disclaimer, which is legal chrome and never spoken
#   pre.term the demo transcript, which is the object under inspection, not text
#            the room is asked to read while the presenter talks over it.
EXCLUDE = re.compile(r'<pre class="term">.*?</pre>|<p class="foot">.*?</p>', re.S)


def strip_tags(fragment):
    text = WORD_RE.sub(' ', fragment)
    for ent, rep in (('&middot;', ' '), ('&nbsp;', ' '), ('&mdash;', ' '),
                     ('&hellip;', ''), ('&lt;', '<'), ('&gt;', '>'), ('&amp;', '&')):
        text = text.replace(ent, rep)
    return [w for w in text.split() if w.strip()]


def visible_words(html_fragment):
    """Prose words the room is asked to read."""
    return strip_tags(EXCLUDE.sub(' ', html_fragment))


def excluded_words(html_fragment):
    return sum(len(strip_tags(m.group(0))) for m in EXCLUDE.finditer(html_fragment))


def plate_html(p, appendix=False):
    cls = 'plate' + (' band' if p.get('band') else '') + (' appx' if appendix else '')
    no = p['no']
    clock = f'<span class="t">{p["clock"]}</span>' if p.get('clock') else ''
    parts = [f'  <section class="{cls}">',
             f'    <span class="plate-no">{no}{clock}</span>']
    # No re-indent here: the demo transcript lives in a <pre>, where leading
    # whitespace is content. The first render indented every line of it.
    parts.append(p['body'].strip())
    parts.append('  </section>')
    return '\n'.join(parts)


chunks = ['\n<div class="deck">\n']
report = []

for p in SPINE:
    chunks.append(plate_html(p))
    words = visible_words(p['body'])
    report.append((p['no'], p['role'], len(words), p.get('cap'), p.get('seconds'),
                   len(p.get('spoken', '').split()), excluded_words(p['body'])))

chunks.append(plate_html(DIVIDER))

for p in APPENDIX:
    chunks.append(plate_html(p, appendix=True))

chunks.append('</div>\n\n</body>\n</html>\n')

io.open(OUT, 'w', encoding='utf-8').write(head + '</head>\n<body>\n' + '\n\n'.join(chunks))

print(f'wrote {OUT}')
print()
print(f'{"plate":<6}{"role":<24}{"prose":>7}{"cap":>5}{"artifact":>10}{"secs":>6}{"spoken":>8}{"budget":>8}')
total_w = total_s = total_sec = 0
ok = True
for no, role, w, cap, secs, spoken, excl in report:
    flag = ''
    if cap is not None and w > cap:
        flag = '  PROSE OVER'
        ok = False
    # 145 words per minute is the pitch pace the template analysis used
    budget = round(secs / 60 * 145) if secs else 0
    if spoken > budget:
        flag += '  SPOKEN OVER'
        ok = False
    print(f'{no:<6}{role:<24}{w:>7}{cap if cap is not None else "-":>5}'
          f'{(excl or "-"):>10}{secs:>6}{spoken:>8}{budget:>8}{flag}')
    total_w += w
    total_s += spoken
    total_sec += secs or 0
print('-' * 68)
print(f'{"":<6}{"SPINE TOTAL":<24}{total_w:>7}{"":>5}{"":>10}{total_sec:>6}{total_s:>8}{round(total_sec/60*145):>8}')
print(f'spoken {total_s} words = {total_s / 145 * 60:.0f} s at 145 wpm, budget {total_sec} s')
appx_words = sum(len(visible_words(p['body'])) for p in APPENDIX)
print(f'appendix: {len(APPENDIX)} plates, {appx_words} words, never presented')
print('WORD CAPS: ' + ('all respected' if ok else 'VIOLATED, see OVER above'))
