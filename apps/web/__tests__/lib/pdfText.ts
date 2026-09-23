/**
 * Minimal text extraction for the PDFs this repository prints with headless
 * Chromium (`scripts/render-docs-pdf.mjs`): no dependency, enough to grep a
 * served PDF for a claim.
 *
 * What Chromium (Skia) writes, and what this reads:
 *   - uncompressed object table, no object streams (PDF 1.4);
 *   - page and form content streams, FlateDecode;
 *   - text as hex strings `<0012> Tj` / `[<00>...] TJ` in a font selected by
 *     `/F<n> <size> Tf`, where `/F<n>` resolves through a `/Font << /F<n> m 0 R >>`
 *     resource to font object m, whose `/ToUnicode` CMap maps codes to text.
 *
 * Output: the text of every BT..ET block, concatenated in stream order with a
 * space between blocks. Glyph positioning is ignored, so words inside a block
 * run together; compare with whitespace removed (`squash`).
 */
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

interface CMap {
  bytes: number;
  map: Map<number, string>;
}

function parseCMap(src: string): CMap {
  const map = new Map<number, string>();
  let bytes = 1;
  const range = /begincodespacerange\s*<([0-9a-fA-F]+)>/.exec(src);
  if (range) bytes = range[1].length / 2;
  const hexToText = (h: string) => {
    let s = '';
    for (let i = 0; i + 4 <= h.length; i += 4) s += String.fromCharCode(parseInt(h.slice(i, i + 4), 16));
    return s;
  };
  for (const block of src.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const m of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
      map.set(parseInt(m[1], 16), hexToText(m[2]));
    }
  }
  for (const block of src.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const m of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<([0-9a-fA-F]+)>|\[([^\]]*)\])/g)) {
      const lo = parseInt(m[1], 16);
      const hi = parseInt(m[2], 16);
      if (m[4] !== undefined) {
        const base = hexToText(m[4]);
        const last = base.charCodeAt(base.length - 1);
        for (let c = lo; c <= hi; c++) map.set(c, base.slice(0, -1) + String.fromCharCode(last + (c - lo)));
      } else {
        const items = [...(m[5] ?? '').matchAll(/<([0-9a-fA-F]+)>/g)].map((x) => hexToText(x[1]));
        for (let c = lo; c <= hi && c - lo < items.length; c++) map.set(c, items[c - lo]);
      }
    }
  }
  return { bytes, map };
}

export function pdfText(path: string): string {
  const buf = readFileSync(path);
  const s = buf.toString('latin1');

  // object number -> [dictionary, stream bytes | null]
  const objects = new Map<number, { dict: string; stream: Buffer | null }>();
  const objRe = /(\d+) 0 obj\s*/g;
  let m: RegExpExecArray | null;
  while ((m = objRe.exec(s))) {
    const num = Number(m[1]);
    const start = m.index + m[0].length;
    const end = s.indexOf('endobj', start);
    if (end < 0) break;
    const body = s.slice(start, end);
    const at = body.indexOf('stream');
    let stream: Buffer | null = null;
    let dict = body;
    if (at >= 0 && /\/Length\s+\d+/.test(body.slice(0, at))) {
      dict = body.slice(0, at);
      const len = Number(/\/Length\s+(\d+)/.exec(dict)![1]);
      let dataStart = start + at + 'stream'.length;
      if (s[dataStart] === '\r') dataStart++;
      if (s[dataStart] === '\n') dataStart++;
      const raw = buf.subarray(dataStart, dataStart + len);
      try {
        stream = /FlateDecode/.test(dict) ? inflateSync(raw) : raw;
      } catch {
        stream = null;
      }
    }
    objects.set(num, { dict, stream });
    objRe.lastIndex = end;
  }

  // font object -> its ToUnicode CMap
  const fontCMap = new Map<number, CMap>();
  for (const [num, o] of objects) {
    const tu = /\/ToUnicode\s+(\d+)\s+0\s+R/.exec(o.dict);
    if (!tu) continue;
    const cm = objects.get(Number(tu[1]))?.stream;
    if (cm) fontCMap.set(num, parseCMap(cm.toString('latin1')));
  }
  // resource name -> font object (Skia names are global in practice)
  const fontByName = new Map<string, number>();
  for (const o of objects.values()) {
    for (const block of o.dict.matchAll(/\/Font\s*<<([^>]*)>>/g)) {
      for (const r of block[1].matchAll(/\/(\w+)\s+(\d+)\s+0\s+R/g)) fontByName.set(r[1], Number(r[2]));
    }
  }

  const decode = (hex: string, cmap: CMap | undefined) => {
    if (!cmap) return '';
    let out = '';
    const step = cmap.bytes * 2;
    for (let i = 0; i + step <= hex.length; i += step) out += cmap.map.get(parseInt(hex.slice(i, i + step), 16)) ?? '';
    return out;
  };

  const blocks: string[] = [];
  for (const o of objects.values()) {
    if (!o.stream) continue;
    const content = o.stream.toString('latin1');
    if (!content.includes('BT')) continue;
    for (const bt of content.matchAll(/BT([\s\S]*?)ET/g)) {
      let cmap: CMap | undefined;
      let text = '';
      const tokRe = /\/(\w+)\s+[-\d.]+\s+Tf|<([0-9a-fA-F]*)>\s*Tj|\[([^\]]*)\]\s*TJ/g;
      let t: RegExpExecArray | null;
      while ((t = tokRe.exec(bt[1]))) {
        if (t[1] !== undefined) {
          const obj = fontByName.get(t[1]);
          cmap = obj === undefined ? undefined : fontCMap.get(obj);
        } else if (t[2] !== undefined) {
          text += decode(t[2], cmap);
        } else if (t[3] !== undefined) {
          for (const h of t[3].matchAll(/<([0-9a-fA-F]*)>/g)) text += decode(h[1], cmap);
        }
      }
      if (text) blocks.push(text);
    }
  }
  return blocks.join(' ');
}

/** Whitespace removed and lowercased, for comparing phrases across glyph runs. */
export function squash(s: string): string {
  return s.replace(/\s+/g, '').toLowerCase();
}
