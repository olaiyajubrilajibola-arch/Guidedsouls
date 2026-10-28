'use strict';
// A small dependency-free PDF writer: A4 pages, Helvetica text, lines, boxes and one JPEG image.
const zlib = require('zlib');

// Standard Helvetica and Helvetica-Bold advance widths for ASCII 32–126 (per 1000 units).
const W_REG = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
const W_BOLD = [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584];
const SPECIAL = { '‘': [0x91, 222], '’': [0x92, 222], '“': [0x93, 333], '”': [0x94, 333], '•': [0x95, 350], '–': [0x96, 556], '—': [0x97, 1000], '…': [0x85, 1000], '€': [0x80, 556] };

function encodeChar(ch, bold) {
  const c = ch.codePointAt(0);
  if (c >= 32 && c <= 126) return [c, (bold ? W_BOLD : W_REG)[c - 32]];
  if (SPECIAL[ch]) return SPECIAL[ch];
  if (c >= 0xa0 && c <= 0xff) return [c, 556];
  return [0x3f, 556]; // "?"
}

function textWidth(str, size, bold) {
  let w = 0;
  for (const ch of String(str)) w += encodeChar(ch, bold)[1];
  return (w * size) / 1000;
}

function pdfString(str, bold) {
  const bytes = [];
  for (const ch of String(str)) bytes.push(encodeChar(ch, bold)[0]);
  let out = '(';
  for (const b of bytes) {
    if (b === 0x28 || b === 0x29 || b === 0x5c) out += '\\' + String.fromCharCode(b);
    else if (b < 32 || b > 126) out += '\\' + b.toString(8).padStart(3, '0');
    else out += String.fromCharCode(b);
  }
  return out + ')';
}

function hexColor(c) {
  const h = (c || '#000000').replace('#', '');
  return [0, 2, 4].map((i) => (parseInt(h.slice(i, i + 2), 16) / 255).toFixed(3)).join(' ');
}

class PDF {
  constructor() { this.W = 595.28; this.H = 841.89; this.pages = []; this.image = null; }
  page() { this.cur = []; this.pages.push(this.cur); return this; }
  wrap(text, width, size, bold) {
    const lines = [];
    for (const para of String(text ?? '').split('\n')) {
      let line = '';
      for (const word of para.split(/\s+/).filter(Boolean)) {
        const test = line ? line + ' ' + word : word;
        if (textWidth(test, size, bold) <= width || !line) line = test;
        else { lines.push(line); line = word; }
      }
      lines.push(line);
    }
    return lines;
  }
  text(x, y, str, o = {}) {
    const size = o.size || 10, bold = !!o.bold;
    let tx = x;
    if (o.align === 'center') tx = x + ((o.width || 0) - textWidth(str, size, bold)) / 2;
    if (o.align === 'right') tx = x + (o.width || 0) - textWidth(str, size, bold);
    this.cur.push(`BT ${hexColor(o.color)} rg /${bold ? 'F2' : 'F1'} ${size} Tf ${tx.toFixed(2)} ${(this.H - y - size).toFixed(2)} Td ${pdfString(str, bold)} Tj ET`);
    return this;
  }
  // Writes wrapped text; returns the y below the last line.
  para(x, y, str, width, o = {}) {
    const size = o.size || 10, lh = o.lineHeight || size * 1.35;
    for (const ln of this.wrap(str, width, size, o.bold)) { this.text(x, y, ln, { ...o, width }); y += lh; }
    return y;
  }
  line(x1, y1, x2, y2, o = {}) {
    this.cur.push(`${hexColor(o.color || '#999999')} RG ${(o.width || 0.6)} w ${x1.toFixed(2)} ${(this.H - y1).toFixed(2)} m ${x2.toFixed(2)} ${(this.H - y2).toFixed(2)} l S`);
    return this;
  }
  rect(x, y, w, h, o = {}) {
    const r = `${x.toFixed(2)} ${(this.H - y - h).toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re`;
    if (o.fill) this.cur.push(`${hexColor(o.fill)} rg ${r} f`);
    if (o.stroke) this.cur.push(`${hexColor(o.stroke)} RG ${(o.width || 0.6)} w ${r} S`);
    return this;
  }
  jpeg(buf, x, y, w, h, pxW, pxH) {
    this.image = { buf, pxW, pxH };
    this.cur.push(`q ${w.toFixed(2)} 0 0 ${h.toFixed(2)} ${x.toFixed(2)} ${(this.H - y - h).toFixed(2)} cm /Im1 Do Q`);
    return this;
  }
  toBuffer() {
    const objs = [];
    const add = (body) => { objs.push(body); return objs.length; };
    const catalog = add(null), pagesObj = add(null);
    const f1 = add(Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'));
    const f2 = add(Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>'));
    let img = null;
    if (this.image) {
      const { buf, pxW, pxH } = this.image;
      img = add(Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${pxW} /Height ${pxH} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${buf.length} >>\nstream\n`), buf, Buffer.from('\nendstream')]));
    }
    const kids = [];
    for (const p of this.pages) {
      const data = zlib.deflateSync(Buffer.from(p.join('\n'), 'latin1'));
      const content = add(Buffer.concat([Buffer.from(`<< /Length ${data.length} /Filter /FlateDecode >>\nstream\n`), data, Buffer.from('\nendstream')]));
      const res = `<< /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >>${img ? ` /XObject << /Im1 ${img} 0 R >>` : ''} >>`;
      kids.push(add(Buffer.from(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${this.W} ${this.H}] /Resources ${res} /Contents ${content} 0 R >>`)));
    }
    objs[catalog - 1] = Buffer.from(`<< /Type /Catalog /Pages ${pagesObj} 0 R >>`);
    objs[pagesObj - 1] = Buffer.from(`<< /Type /Pages /Kids [${kids.map((k) => k + ' 0 R').join(' ')}] /Count ${kids.length} >>`);
    const parts = [Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'latin1')];
    let offset = parts[0].length;
    const offsets = [];
    objs.forEach((body, i) => {
      offsets.push(offset);
      const chunk = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), body, Buffer.from('\nendobj\n')]);
      parts.push(chunk); offset += chunk.length;
    });
    const xref = ['xref', `0 ${objs.length + 1}`, '0000000000 65535 f '].concat(offsets.map((o) => String(o).padStart(10, '0') + ' 00000 n ')).join('\n');
    parts.push(Buffer.from(`${xref}\ntrailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${offset}\n%%EOF\n`));
    return Buffer.concat(parts);
  }
}

module.exports = { PDF, textWidth };
