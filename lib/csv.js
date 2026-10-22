/* ReconCheck — CSV parser (RFC 4180, delimiter auto-detect). No dependencies. */
(function (root) {
  'use strict';

  function detectDelimiter(text) {
    const sample = text.slice(0, 20000);
    const firstLines = [];
    let line = '', inQ = false;
    for (let i = 0; i < sample.length && firstLines.length < 5; i++) {
      const c = sample[i];
      if (c === '"') inQ = !inQ;
      if (!inQ && (c === '\n' || c === '\r')) {
        if (line.trim()) firstLines.push(line);
        line = '';
        continue;
      }
      line += c;
    }
    if (line.trim() && firstLines.length < 5) firstLines.push(line);
    const candidates = [',', ';', '\t', '|'];
    let best = ',', bestScore = -1;
    for (const d of candidates) {
      const counts = firstLines.map(l => countOutsideQuotes(l, d));
      if (!counts.length || counts[0] === 0) continue;
      const consistent = counts.every(n => n === counts[0]);
      const score = counts[0] * (consistent ? 2 : 1);
      if (score > bestScore) { bestScore = score; best = d; }
    }
    return best;
  }

  function countOutsideQuotes(line, d) {
    let n = 0, inQ = false;
    for (const c of line) {
      if (c === '"') inQ = !inQ;
      else if (!inQ && c === d) n++;
    }
    return n;
  }

  function parse(text, opts) {
    opts = opts || {};
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const delim = opts.delimiter || detectDelimiter(text);
    const rows = [];
    let row = [], field = '', inQ = false, i = 0;
    const n = text.length;
    while (i < n) {
      const c = text[i];
      if (inQ) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
          inQ = false; i++; continue;
        }
        field += c; i++; continue;
      }
      if (c === '"' && field === '') { inQ = true; i++; continue; }
      if (c === delim) { row.push(field); field = ''; i++; continue; }
      if (c === '\r' || c === '\n') {
        row.push(field); rows.push(row); row = []; field = '';
        if (c === '\r' && text[i + 1] === '\n') i++;
        i++; continue;
      }
      field += c; i++;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return toTable(rows, delim);
  }

  /** Turn an array of arrays into {headers, rows}; first non-empty row is the header. */
  function toTable(rows, delim) {
    const isEmpty = r => !r || r.every(v => v === '' || v === null || v === undefined);
    let start = 0;
    while (start < rows.length && isEmpty(rows[start])) start++;
    const headerRow = (rows[start] || []).map(h => String(h == null ? '' : h).trim());
    const headers = headerRow.map((h, i) => h || ('Column ' + (i + 1)));
    const body = [];
    for (let r = start + 1; r < rows.length; r++) {
      if (isEmpty(rows[r])) continue;
      body.push({ line: r + 1, cells: rows[r] });
    }
    return { headers, rows: body, delimiter: delim || null, headerLine: start + 1 };
  }

  const api = { parse, detectDelimiter, toTable };
  root.ReconCSV = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : this);
