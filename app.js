/* ReconCheck — extension page controller. All processing is local; nothing leaves the browser. */
(function () {
  'use strict';
  const R = window.Recon;
  const $ = id => document.getElementById(id);
  const PAGE = 200;
  const SETTINGS_KEY = 'reconcheck.settings.v1';

  const state = {
    tx: null, gl: null,
    txMap: {}, glMap: {}, glMode: 'split',
    opts: loadSettings(),
    result: null,
    filter: { check: null, severity: 'all', q: '' },
    shown: PAGE
  };

  // ---------- helpers ----------
  function el(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat(Infinity)) if (kid !== null && kid !== undefined && kid !== false) n.append(kid.nodeType ? kid : String(kid));
    return n;
  }
  const money = (u, o) => R.formatMoney(u, Object.assign({ symbol: '₦' }, o));
  const plural = (n, w, p) => n + ' ' + (n === 1 ? w : (p || w + 's'));
  const pct = x => (Math.floor(x * 1000) / 10).toFixed(1) + '%';

  function loadSettings() {
    try {
      const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
      return Object.assign({}, R.DEFAULTS, s || {});
    } catch (e) { return Object.assign({}, R.DEFAULTS); }
  }
  function saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.opts)); } catch (e) { /* storage unavailable */ }
  }

  // ---------- file loading ----------
  async function readFile(file) {
    const name = file.name || 'file';
    if (/\.xlsx$/i.test(name)) return window.ReconXLSX.read(await file.arrayBuffer());
    if (/\.xls$/i.test(name)) throw new Error('Older .xls files are not supported. Save it as .xlsx or CSV and try again.');
    const buf = await file.arrayBuffer();
    let text = new TextDecoder('utf-8').decode(buf);
    if (text.includes('�')) text = new TextDecoder('windows-1252').decode(buf);
    return window.ReconCSV.parse(text);
  }

  async function loadSide(side, file) {
    const info = $('info-' + side);
    info.hidden = false;
    info.textContent = 'Reading ' + file.name + '…';
    try {
      const table = await readFile(file);
      if (!table.headers.length || !table.rows.length) throw new Error('No data rows found. Check that the first row holds column names.');
      state[side] = { name: file.name, table };
      const fields = side === 'tx' ? R.TX_FIELDS : R.GL_FIELDS;
      state[side + 'Map'] = R.autoMap(table.headers, fields);
      if (side === 'gl') state.glMode = R.autoGlMode(state.glMap);
      state.result = null;
      $('results').hidden = true;
      renderSide(side);
      renderMapping();
      renderSpine();
    } catch (err) {
      state[side] = null;
      info.replaceChildren(el('span', { class: 'err', text: (err && err.message) || 'This file could not be read.' }));
      $('drop-' + side).classList.remove('loaded');
      renderMapping();
      renderSpine();
    }
  }

  function renderSide(side) {
    const s = state[side];
    const drop = $('drop-' + side);
    const info = $('info-' + side);
    drop.classList.add('loaded');
    drop.querySelector('.drop-title').textContent = 'Replace file';
    const t = s.table;
    const preview = el('div', { class: 'preview' },
      el('table', null,
        el('thead', null, el('tr', null, t.headers.map(h => el('th', { text: h })))),
        el('tbody', null, t.rows.slice(0, 4).map(r => el('tr', null, t.headers.map((_, i) => el('td', { text: r.cells[i] === undefined ? '' : String(r.cells[i]) })))))));
    info.replaceChildren(
      el('div', null, el('strong', { text: s.name })),
      el('div', { text: plural(t.rows.length, 'row') + ', ' + plural(t.headers.length, 'column') + (t.sheetName ? ', sheet "' + t.sheetName + '"' : '') }),
      el('details', { class: 'peek' }, el('summary', { text: 'Preview first rows' }), preview)
    );
  }

  // ---------- column mapping ----------
  function mappingRow(side, field, headers) {
    const map = state[side + 'Map'];
    const id = 'map-' + side + '-' + field.key;
    const sel = el('select', { id },
      el('option', { value: '', text: field.required ? 'Choose a column' : 'Not in this file' }),
      headers.map((h, i) => el('option', { value: String(i), text: h })));
    sel.value = map[field.key] === undefined ? '' : String(map[field.key]);
    sel.addEventListener('change', () => {
      if (sel.value === '') delete map[field.key]; else map[field.key] = Number(sel.value);
      state.result = null;
      updateMappingStatus();
    });
    return el('div', { class: 'mrow' },
      el('label', { for: id }, field.label, field.required ? el('span', { class: 'req', text: ' *', 'aria-label': 'required' }) : null),
      sel);
  }

  function glFieldsForMode() {
    const hide = state.glMode === 'split' ? ['amount', 'side'] : ['debit', 'credit'];
    return R.GL_FIELDS.filter(f => !hide.includes(f.key)).map(f =>
      Object.assign({}, f, { required: f.required || (state.glMode === 'single' && f.key === 'amount') }));
  }

  function renderMapping() {
    const section = $('mapping');
    if (!state.tx && !state.gl) { section.hidden = true; return; }
    section.hidden = false;
    const txBox = $('map-tx');
    txBox.querySelectorAll('.mrow, .placeholder').forEach(n => n.remove());
    if (state.tx) R.TX_FIELDS.forEach(f => txBox.append(mappingRow('tx', f, state.tx.table.headers)));
    else txBox.append(el('p', { class: 'placeholder run-msg', text: 'Load a transactions file to map its columns.' }));
    const glBox = $('map-gl-fields');
    glBox.replaceChildren();
    document.querySelectorAll('input[name="glmode"]').forEach(r => { r.checked = r.value === state.glMode; r.disabled = !state.gl; });
    if (state.gl) glFieldsForMode().forEach(f => glBox.append(mappingRow('gl', f, state.gl.table.headers)));
    else glBox.append(el('p', { class: 'run-msg', text: 'Load a GL file to map its columns.' }));
    updateMappingStatus();
  }

  function updateMappingStatus() {
    const summary = $('mapping-summary');
    const run = $('btn-run');
    const msg = $('run-msg');
    msg.classList.remove('err');
    if (!state.tx || !state.gl) {
      summary.replaceChildren('Columns');
      run.disabled = true;
      msg.textContent = !state.tx ? 'Add a transactions file to continue.' : 'Add a GL file to continue.';
      return;
    }
    const errors = R.validateMapping(state.txMap, state.glMap, state.glMode);
    const mapped = Object.keys(state.txMap).length + Object.keys(state.glMap).length;
    if (errors.length) {
      summary.replaceChildren(el('span', { class: 'bad', text: plural(errors.length, 'required column') + ' still to map' }));
      $('mapping-details').open = true;
      run.disabled = true;
      msg.textContent = errors[0];
      msg.classList.add('err');
    } else {
      summary.replaceChildren(el('span', { class: 'good', text: 'Columns matched' }), ' (' + mapped + ' mapped automatically or by you). Open to review.');
      run.disabled = false;
      msg.textContent = '';
    }
  }

  // ---------- run ----------
  function run() {
    const errors = R.validateMapping(state.txMap, state.glMap, state.glMode);
    if (errors.length) return;
    const btn = $('btn-run');
    btn.disabled = true;
    btn.textContent = 'Reconciling…';
    // Let the button repaint before the (synchronous) work starts.
    setTimeout(() => {
      try {
        const t0 = performance.now();
        state.result = R.reconcile(state.tx.table, state.gl.table, state.txMap, state.glMap, Object.assign({}, state.opts, { glMode: state.glMode }));
        state.result.ms = Math.round(performance.now() - t0);
        state.result.files = { transactions: state.tx.name, ledger: state.gl.name };
        state.filter = { check: null, severity: 'all', q: '' };
        $('search').value = '';
        $('sev-filter').value = 'all';
        state.shown = PAGE;
        renderSpine();
        renderResults();
        $('results').hidden = false;
        $('mapping-details').open = false;
        $('results').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
      } catch (err) {
        $('run-msg').textContent = 'Reconciliation stopped: ' + ((err && err.message) || err);
        $('run-msg').classList.add('err');
        console.error(err);
      } finally {
        btn.disabled = false;
        btn.textContent = 'Run reconciliation';
      }
    }, 30);
  }

  // ---------- spine (tie-out) ----------
  function renderSpine() {
    const spine = $('spine'), fig = $('spine-figure'), note = $('spine-note');
    const r = state.result;
    if (!r) {
      if (state.tx && state.gl) {
        spine.dataset.state = 'ready';
        fig.textContent = 'Ready';
        note.textContent = 'Check the columns below, then run the reconciliation.';
      } else {
        spine.dataset.state = '';
        fig.textContent = 'Waiting for both files';
        note.textContent = state.tx || state.gl ? 'One file loaded. Add the other side.' : 'Upload a transactions export and a GL export.';
      }
      return;
    }
    const s = r.summary;
    const serious = s.bySeverity.critical + s.bySeverity.high;
    if (s.glImbalance === 0 && serious === 0) {
      spine.dataset.state = 'ties';
      fig.textContent = 'Ties out';
      note.textContent = 'Debits equal credits and every transaction matches the ledger.';
    } else {
      spine.dataset.state = 'off';
      fig.textContent = s.glImbalance !== 0 ? 'Off by ' + money(Math.abs(s.glImbalance)) : 'Does not tie';
      note.textContent = s.glImbalance !== 0
        ? 'Total debits ' + (s.glImbalance > 0 ? 'exceed' : 'fall short of') + ' credits. ' + plural(serious, 'critical or high finding') + '.'
        : 'Debits equal credits, but ' + plural(serious, 'critical or high finding') + ' remain.';
    }
  }

  // ---------- results ----------
  function renderResults() {
    const r = state.result, s = r.summary;
    const flagged = s.uniqueTx - s.cleanTx;
    const v = $('verdict');
    if (!r.findings.length) {
      v.replaceChildren('No findings. All ', el('b', { text: plural(s.uniqueTx, 'transaction') }), ' reconcile to ', el('b', { text: plural(s.glLines, 'GL line') }), '.');
    } else {
      v.replaceChildren(
        el('b', { text: plural(s.totalFindings, 'finding') }), ' across ', el('b', { text: plural(flagged, 'transaction') }),
        ', with ', el('b', { text: money(s.valueAtRisk) }), ' at risk. ',
        s.bySeverity.critical ? el('span', null, el('b', { text: String(s.bySeverity.critical) }), ' ' + (s.bySeverity.critical === 1 ? 'needs' : 'need') + ' attention first.') : 'Nothing critical.'
      );
    }
    const fig = (label, value, sub) => el('div', null, el('dt', { text: label }), el('dd', null, value, sub ? el('small', { text: sub }) : null));
    $('figures').replaceChildren(
      fig('Transactions', s.uniqueTx.toLocaleString(), s.statusCounts.success + ' successful, ' + s.statusCounts.failed + ' failed, ' + s.statusCounts.pending + ' pending'),
      fig('Clean', pct(s.cleanRate), s.cleanTx.toLocaleString() + ' with no findings'),
      fig('Matched to GL', s.matchedTx.toLocaleString(), 'of ' + s.uniqueTx.toLocaleString() + ' transactions'),
      fig('GL lines', s.glLines.toLocaleString(), plural(s.journals, 'journal')),
      fig('Debits minus credits', el('span', { class: s.glImbalance ? 'neg' : null, text: money(s.glImbalance) }), 'Debits ' + money(s.glDebit)),
      fig('Value at risk', money(s.valueAtRisk), 'Net rounding drift ' + money(s.netDrift, { signed: true }))
    );
    renderRail();
    renderTable();
  }

  function renderRail() {
    const s = state.result.summary;
    const items = [el('li', null, railButton(null, 'All findings', s.totalFindings, null)), el('li', { class: 'sep', 'aria-hidden': 'true' })];
    for (const key of R.CHECK_ORDER) {
      const c = R.CHECKS[key];
      items.push(el('li', null, railButton(key, c.label, s.byCheck[key], c.severity)));
    }
    $('rail').replaceChildren(...items);
  }
  function railButton(key, label, count, sev) {
    return el('button', {
      type: 'button',
      class: (sev ? 'sev-' + sev : '') + (count ? '' : ' zero'),
      'aria-pressed': String(state.filter.check === key),
      title: key ? R.CHECKS[key].what : 'Show every finding',
      onclick: () => { state.filter.check = key; state.shown = PAGE; renderRail(); renderTable(); }
    }, el('span', { class: 'bar' }), el('span', { text: label }), el('span', { class: 'count', text: String(count) }));
  }

  function filtered() {
    const f = state.filter;
    const q = f.q.trim().toLowerCase();
    return state.result.findings.filter(x =>
      (!f.check || x.check === f.check) &&
      (f.severity === 'all' || x.severity === f.severity) &&
      (!q || [x.ref, x.title, x.detail, R.CHECKS[x.check].label, ...x.glLines.map(l => l.account + ' ' + l.accountName + ' ' + l.journal)].join(' ').toLowerCase().includes(q)));
  }

  function renderTable() {
    const list = filtered();
    const rows = list.slice(0, state.shown).map(f => {
      const tr = el('tr', { class: 'sev-' + f.severity, tabindex: '0', 'data-id': String(f.id) },
        el('td', null, el('span', { class: 'tag', text: cap(f.severity) })),
        el('td', { class: 'ref', text: f.ref }),
        el('td', null,
          el('div', { class: 'check', text: R.CHECKS[f.check].label }),
          el('div', { class: 'title', text: f.title }),
          el('div', { class: 'detail', text: f.detail })),
        el('td', { class: 'num' + (f.diff < 0 ? ' neg' : ''), text: f.diff === null || f.diff === undefined ? (f.valueAtRisk ? money(f.valueAtRisk) : '—') : money(f.diff, { signed: true }) }));
      tr.addEventListener('click', () => openDrawer(f, tr));
      tr.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDrawer(f, tr); } });
      return tr;
    });
    $('ftbody').replaceChildren(...rows);
    const empty = $('empty');
    empty.hidden = list.length > 0;
    if (!list.length) empty.textContent = state.result.findings.length ? 'No findings match these filters. Clear the search or pick "All findings".' : 'Nothing to report. The two files reconcile.';
    const more = $('btn-more');
    more.hidden = list.length <= state.shown;
    more.textContent = 'Show ' + Math.min(PAGE, list.length - state.shown) + ' more of ' + (list.length - state.shown) + ' remaining';
  }
  const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

  // ---------- drawer ----------
  let lastFocus = null;
  function openDrawer(f, from) {
    lastFocus = from || null;
    const c = R.CHECKS[f.check];
    const body = $('drawer-body');
    const parts = [
      el('div', { class: 'd-head sev-' + f.severity },
        el('span', { class: 'tag', text: cap(f.severity) + ', ' + c.label }),
        el('h2', { id: 'drawer-title', text: f.title }),
        el('p', { text: f.detail }))
    ];
    if (f.expected !== null || f.actual !== null || f.diff !== null) {
      const cell = (label, v, o) => el('div', null, el('dt', { text: label }), el('dd', { class: v < 0 && o ? 'neg' : null, text: v === null || v === undefined ? '—' : money(v, o) }));
      parts.push(el('dl', { class: 'd-amounts' }, cell('Expected', f.expected), cell('Actual', f.actual), cell('Difference', f.diff, { signed: true })));
    }
    parts.push(el('div', { class: 'd-section' },
      el('div', { class: 'd-guide' },
        el('div', null, el('b', { text: 'What this check looks for' }), c.what),
        el('div', null, el('b', { text: 'Why it matters' }), c.why),
        el('div', null, el('b', { text: 'What to check next' }), c.action))));

    if (f.txRecords.length) {
      const headers = state.tx.table.headers;
      const sec = el('div', { class: 'd-section' }, el('h3', { text: f.check === 'ORPHAN_GL' ? 'Possible matching transaction' : (f.txRecords.length > 1 ? 'Transaction records' : 'Transaction record') }));
      if (f.check === 'ORPHAN_GL' && f.relatedRef) sec.append(el('p', { class: 'related', text: 'This GL reference is not in the transactions file, but ' + f.relatedRef + ' looks like the same payment and has no GL lines of its own.' }));
      for (const t of f.txRecords) {
        sec.append(el('dl', { class: 'kv' },
          el('dt', { text: 'File row' }), el('dd', { text: String(t.line) }),
          headers.map((h, i) => [el('dt', { text: h }), el('dd', { text: t.cells[i] === undefined || t.cells[i] === '' ? '—' : String(t.cells[i]) })])));
        if (f.txRecords.length > 1) sec.append(el('hr', { style: 'border:0;border-top:1px solid var(--rule);margin:10px 0' }));
      }
      parts.push(sec);
    }

    if (f.glLines.length) {
      const showJournal = f.glLines.some(l => l.journal);
      const showDate = f.glLines.some(l => l.date !== null && l.date !== undefined);
      const dr = f.glLines.reduce((s, l) => s + l.debit, 0), cr = f.glLines.reduce((s, l) => s + l.credit, 0);
      const rows = f.glLines.map(l => el('tr', null,
        el('td', { text: String(l.line) }),
        showJournal ? el('td', { text: l.journal || '—' }) : null,
        showDate ? el('td', { text: R.formatDay(l.date) || '—' }) : null,
        el('td', { class: 'acct' }, l.account || '—', l.accountName ? el('small', { text: l.accountName }) : null),
        el('td', { class: 'num', text: l.debit ? money(l.debit) : '' }),
        el('td', { class: 'num', text: l.credit ? money(l.credit) : '' })));
      const span = 2 + (showJournal ? 1 : 0) + (showDate ? 1 : 0);
      const foot = [el('tr', null, el('td', { colspan: String(span), text: 'Total' }), el('td', { class: 'num', text: money(dr) }), el('td', { class: 'num', text: money(cr) }))];
      if (f.check === 'MISSING_REVERSAL' || f.check === 'UNBALANCED') {
        const net = new Map();
        for (const l of f.glLines) net.set(l.account, (net.get(l.account) || 0) + l.debit - l.credit);
        for (const [acct, v] of net) {
          if (!v) continue;
          foot.push(el('tr', { class: 'netrow' }, el('td', { colspan: String(span), text: 'Net on ' + acct }),
            el('td', { class: 'num', text: v > 0 ? money(v) : '' }), el('td', { class: 'num', text: v < 0 ? money(-v) : '' })));
        }
      }
      parts.push(el('div', { class: 'd-section' },
        el('h3', { text: 'GL lines (' + f.glLines.length + ')' }),
        el('div', { class: 'gl-wrap' }, el('table', { class: 'gl-table' },
          el('thead', null, el('tr', null, el('th', { text: 'Row' }), showJournal ? el('th', { text: 'Journal' }) : null, showDate ? el('th', { text: 'Posted' }) : null, el('th', { text: 'Account' }), el('th', { class: 'num', text: 'Debit' }), el('th', { class: 'num', text: 'Credit' }))),
          el('tbody', null, rows),
          el('tfoot', null, foot)))));
    }
    if (f.rows && f.rows.length) {
      parts.push(el('div', { class: 'd-section' }, el('h3', { text: 'Rows affected' }), el('p', { text: f.rows.join(', ') })));
    }
    body.replaceChildren(...parts);
    const drawer = $('drawer');
    drawer.classList.add('open');
    drawer.setAttribute('aria-hidden', 'false');
    $('drawer').querySelector('.drawer-panel').scrollTop = 0;
    $('drawer-close').focus();
  }
  function closeDrawer() {
    const drawer = $('drawer');
    if (!drawer.classList.contains('open')) return;
    drawer.classList.remove('open');
    drawer.setAttribute('aria-hidden', 'true');
    if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
  }

  // ---------- exports ----------
  function download(name, mime, content) {
    const url = URL.createObjectURL(new Blob([content], { type: mime }));
    const a = el('a', { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
  const stamp = () => new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '').replace(/^(\d{8})/, '$1-');
  const csvCell = v => {
    const s = v === null || v === undefined ? '' : String(v);
    const risky = /^(?:[=+@\t\r]|-(?![\d.]))/.test(s); // spreadsheet formula injection
    return risky || /[",\n\r]/.test(s) ? '"' + (risky ? "'" : '') + s.replace(/"/g, '""') + '"' : s;
  };
  const plainMoney = u => (u === null || u === undefined) ? '' : R.formatMoney(u).replace(/,/g, '');

  function exportCsv() {
    const list = filtered();
    const head = ['#', 'severity', 'check', 'reference', 'title', 'detail', 'expected', 'actual', 'difference', 'value_at_risk', 'transaction_rows', 'gl_rows'];
    const lines = [head.join(',')];
    for (const f of list) {
      lines.push([f.id, f.severity, R.CHECKS[f.check].label, f.ref, f.title, f.detail, plainMoney(f.expected), plainMoney(f.actual), plainMoney(f.diff), plainMoney(f.valueAtRisk),
        f.txRecords.map(t => t.line).join(' '), f.glLines.map(l => l.line).join(' ')].map(csvCell).join(','));
    }
    download('reconcheck-findings-' + stamp() + '.csv', 'text/csv;charset=utf-8', '﻿' + lines.join('\r\n'));
  }

  function exportJson() {
    const r = state.result;
    const units = u => (u === null || u === undefined) ? null : u / R.SCALE;
    const s = r.summary;
    const out = {
      tool: 'ReconCheck 1.0.0', generatedAt: r.generatedAt, files: r.files,
      settings: Object.fromEntries(Object.entries(r.options).filter(([k]) => k !== 'glMode').concat([['glMode', r.options.glMode]])),
      summary: Object.assign({}, s, { successValue: units(s.successValue), glDebit: units(s.glDebit), glCredit: units(s.glCredit), glImbalance: units(s.glImbalance), valueAtRisk: units(s.valueAtRisk), netDrift: units(s.netDrift) }),
      findings: r.findings.map(f => ({
        id: f.id, severity: f.severity, check: f.check, label: R.CHECKS[f.check].label, reference: f.ref, relatedReference: f.relatedRef || null,
        title: f.title, detail: f.detail,
        expected: units(f.expected), actual: units(f.actual), difference: units(f.diff), valueAtRisk: units(f.valueAtRisk),
        transactionRows: f.txRecords.map(t => t.line), glRows: f.glLines.map(l => l.line)
      }))
    };
    download('reconcheck-result-' + stamp() + '.json', 'application/json', JSON.stringify(out, null, 2));
  }

  // ---------- settings ----------
  function openSettings() {
    const form = $('settings-form');
    for (const k of ['tolerance', 'roundingThreshold', 'dateWindowDays', 'dateOrder', 'successValues', 'failedValues', 'pendingValues']) form.elements[k].value = state.opts[k];
    // Escape closes the dialog without touching returnValue, so clear a stale 'save'.
    $('settings').returnValue = '';
    $('settings').showModal();
  }
  function applySettingsForm(values) {
    const form = $('settings-form');
    for (const k of ['tolerance', 'roundingThreshold', 'dateWindowDays']) {
      const n = parseFloat(values ? values[k] : form.elements[k].value);
      state.opts[k] = isFinite(n) && n >= 0 ? n : R.DEFAULTS[k];
    }
    for (const k of ['dateOrder', 'successValues', 'failedValues', 'pendingValues']) state.opts[k] = values ? values[k] : form.elements[k].value;
    saveSettings();
    if (state.result) run();
  }

  // ---------- wiring ----------
  function wireDrop(side) {
    const drop = $('drop-' + side);
    const input = drop.querySelector('input');
    input.addEventListener('change', () => { if (input.files[0]) loadSide(side, input.files[0]); input.value = ''; });
    drop.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
    ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
    ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
    drop.addEventListener('drop', e => { const f = e.dataTransfer.files[0]; if (f) loadSide(side, f); });
  }
  // Dropping a file outside a drop zone should not navigate away from the page.
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop', e => e.preventDefault());

  wireDrop('tx');
  wireDrop('gl');
  $('btn-run').addEventListener('click', run);
  $('btn-csv').addEventListener('click', exportCsv);
  $('btn-json').addEventListener('click', exportJson);
  $('btn-print').addEventListener('click', () => window.print());
  $('btn-more').addEventListener('click', () => { state.shown += PAGE; renderTable(); });
  $('search').addEventListener('input', e => { state.filter.q = e.target.value; state.shown = PAGE; renderTable(); });
  $('sev-filter').addEventListener('change', e => { state.filter.severity = e.target.value; state.shown = PAGE; renderTable(); });
  document.querySelectorAll('input[name="glmode"]').forEach(r => r.addEventListener('change', () => {
    state.glMode = r.value;
    state.result = null;
    renderMapping();
  }));
  $('drawer-close').addEventListener('click', closeDrawer);
  $('drawer').addEventListener('click', e => { if (e.target === $('drawer')) closeDrawer(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDrawer(); });
  $('btn-settings').addEventListener('click', openSettings);
  $('settings').addEventListener('close', () => { if ($('settings').returnValue === 'save') applySettingsForm(); });
  $('settings-reset').addEventListener('click', () => {
    const form = $('settings-form');
    for (const k of ['tolerance', 'roundingThreshold', 'dateWindowDays', 'dateOrder', 'successValues', 'failedValues', 'pendingValues']) form.elements[k].value = R.DEFAULTS[k];
  });

  renderSpine();
})();
