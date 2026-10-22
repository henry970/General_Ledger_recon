/* ReconCheck — minimal .xlsx reader (first worksheet → table).
 * Uses the browser's built-in DecompressionStream, so no third-party library is needed.
 * Supports shared strings, inline strings, numbers, booleans and date-formatted cells. */
(function (root) {
  'use strict';

  // ---------- ZIP ----------
  function u16(b, o) { return b[o] | (b[o + 1] << 8); }
  function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }

  function listEntries(bytes) {
    let eocd = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
      if (u32(bytes, i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('Not a valid .xlsx file (zip directory not found).');
    const count = u16(bytes, eocd + 10);
    let p = u32(bytes, eocd + 16);
    const entries = {};
    const dec = new TextDecoder();
    for (let k = 0; k < count; k++) {
      if (u32(bytes, p) !== 0x02014b50) break;
      const method = u16(bytes, p + 10);
      const csize = u32(bytes, p + 20);
      const nameLen = u16(bytes, p + 28), extraLen = u16(bytes, p + 30), commentLen = u16(bytes, p + 32);
      const localOff = u32(bytes, p + 42);
      const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
      entries[name] = { method, csize, localOff };
      p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  }

  async function readEntry(bytes, entry) {
    const p = entry.localOff;
    const nameLen = u16(bytes, p + 26), extraLen = u16(bytes, p + 28);
    const start = p + 30 + nameLen + extraLen;
    const data = bytes.subarray(start, start + entry.csize);
    if (entry.method === 0) return new TextDecoder().decode(data);
    if (entry.method !== 8) throw new Error('Unsupported compression in .xlsx file.');
    const ds = new DecompressionStream('deflate-raw');
    const stream = new Blob([data]).stream().pipeThrough(ds);
    return await new Response(stream).text();
  }

  // ---------- XML helpers ----------
  function decodeXml(s) {
    return s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (m, e) => {
      switch (e) {
        case 'lt': return '<'; case 'gt': return '>'; case 'amp': return '&';
        case 'quot': return '"'; case 'apos': return "'";
        default: return e[1] === 'x' ? String.fromCodePoint(parseInt(e.slice(2), 16)) : String.fromCodePoint(parseInt(e.slice(1), 10));
      }
    });
  }
  function attr(attrs, name) {
    const m = new RegExp('(?:^|\\s)' + name + '="([^"]*)"').exec(attrs);
    return m ? decodeXml(m[1]) : null;
  }
  function textOf(xml) {
    let out = '';
    const re = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
    let m;
    while ((m = re.exec(xml))) out += m[1];
    return decodeXml(out);
  }
  function colIndex(ref) {
    const letters = /^[A-Z]+/.exec(ref || '');
    if (!letters) return -1;
    let n = 0;
    for (const ch of letters[0]) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n - 1;
  }

  // ---------- styles: which cell styles are dates ----------
  const BUILTIN_DATE_IDS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 30, 36, 45, 46, 47, 50, 57]);
  function isDateFormat(code) {
    if (!code) return false;
    const cleaned = code.replace(/"[^"]*"/g, '').replace(/\\./g, '').replace(/\[[^\]]*\]/g, '');
    return /[dmyhs]/i.test(cleaned) && !/^general$/i.test(cleaned.trim());
  }
  function dateStyles(stylesXml) {
    const result = [];
    if (!stylesXml) return result;
    const custom = {};
    const fmtRe = /<numFmt\b([^>]*)\/?>/g;
    let m;
    while ((m = fmtRe.exec(stylesXml))) custom[attr(m[1], 'numFmtId')] = attr(m[1], 'formatCode');
    const xfsBlock = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(stylesXml);
    if (!xfsBlock) return result;
    const xfRe = /<xf\b([^>]*?)(?:\/>|>[\s\S]*?<\/xf>)/g;
    while ((m = xfRe.exec(xfsBlock[1]))) {
      const id = parseInt(attr(m[1], 'numFmtId') || '0', 10);
      result.push(BUILTIN_DATE_IDS.has(id) || isDateFormat(custom[id]));
    }
    return result;
  }
  function serialToIso(serial) {
    const ms = Math.round((serial - 25569) * 86400000);
    const d = new Date(ms);
    if (isNaN(d)) return String(serial);
    const iso = d.toISOString();
    const hasTime = Math.abs(serial % 1) > 1e-9;
    return hasTime ? iso.slice(0, 19).replace('T', ' ') : iso.slice(0, 10);
  }

  // ---------- workbook ----------
  async function read(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);
    const entries = listEntries(bytes);
    const get = async name => (entries[name] ? readEntry(bytes, entries[name]) : null);

    // Resolve the first sheet's path via workbook relationships.
    let sheetPath = 'xl/worksheets/sheet1.xml';
    let sheetName = 'Sheet1';
    const wb = await get('xl/workbook.xml');
    const rels = await get('xl/_rels/workbook.xml.rels');
    if (wb && rels) {
      const s = /<sheet\b([^>]*)\/?>/.exec(wb);
      if (s) {
        sheetName = attr(s[1], 'name') || sheetName;
        const rid = attr(s[1], 'r:id');
        const relRe = /<Relationship\b([^>]*)\/?>/g;
        let r;
        while ((r = relRe.exec(rels))) {
          if (attr(r[1], 'Id') === rid) {
            let target = attr(r[1], 'Target');
            target = target.startsWith('/') ? target.slice(1) : 'xl/' + target.replace(/^\.\//, '');
            sheetPath = target;
          }
        }
      }
    }
    const sheetXml = await get(sheetPath);
    if (!sheetXml) throw new Error('Could not find the first worksheet in this .xlsx file.');

    const shared = [];
    const ssXml = await get('xl/sharedStrings.xml');
    if (ssXml) {
      const siRe = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
      let m;
      // Drop phonetic runs (<rPh>) so their reading text isn't appended to the value.
      while ((m = siRe.exec(ssXml))) shared.push(textOf(m[1].replace(/<rPh\b[\s\S]*?<\/rPh>/g, '')));
    }
    const dateStyle = dateStyles(await get('xl/styles.xml'));

    const rows = [];
    const rowRe = /<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g;
    const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let rm, autoRow = 0;
    while ((rm = rowRe.exec(sheetXml))) {
      const rNum = parseInt(attr(rm[1], 'r') || '0', 10) || (autoRow + 1);
      autoRow = rNum;
      const cells = [];
      const inner = rm[2] || '';
      let cm, autoCol = 0;
      cellRe.lastIndex = 0;
      while ((cm = cellRe.exec(inner))) {
        const a = cm[1], body = cm[2] || '';
        let ci = colIndex(attr(a, 'r'));
        if (ci < 0) ci = autoCol;
        autoCol = ci + 1;
        const t = attr(a, 't');
        const s = parseInt(attr(a, 's') || '0', 10);
        const vMatch = /<v>([\s\S]*?)<\/v>/.exec(body);
        const v = vMatch ? decodeXml(vMatch[1]) : '';
        let value;
        if (t === 's') value = shared[parseInt(v, 10)] ?? '';
        else if (t === 'inlineStr') value = textOf(body);
        else if (t === 'str' || t === 'e') value = v;
        else if (t === 'b') value = v === '1' ? 'TRUE' : 'FALSE';
        else if (t === 'd') value = v;
        else if (v === '') value = '';
        else {
          const num = Number(v);
          value = dateStyle[s] && isFinite(num) ? serialToIso(num) : num;
        }
        while (cells.length < ci) cells.push('');
        cells[ci] = value;
      }
      while (rows.length < rNum - 1) rows.push([]);
      rows[rNum - 1] = cells;
    }
    const CSV = root.ReconCSV || (typeof require === 'function' ? require('./csv.js') : null);
    const table = CSV.toTable(rows, null);
    table.sheetName = sheetName;
    return table;
  }

  const api = { read, isDateFormat, serialToIso };
  root.ReconXLSX = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : this);
