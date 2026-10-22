/* ReconCheck — reconciliation engine.
 * Pure functions, no DOM. Runs in the extension page and in Node (for tests).
 * Money is held as integers in 1/10,000 of a currency unit so kobo-level and
 * sub-kobo differences are exact (no floating-point drift in the checker itself). */
(function (root) {
  'use strict';

  const SCALE = 10000;          // 1.0000 NGN = 10000 units; 1 kobo = 100 units
  const KOBO = SCALE / 100;

  const SEVERITIES = ['critical', 'high', 'medium', 'low'];

  const CHECKS = {
    UNBALANCED: {
      label: 'Unbalanced posting', severity: 'critical',
      what: 'A journal where total debits do not equal total credits.',
      why: 'Double-entry is broken, so the trial balance will not tie and every report built on it is wrong.',
      action: 'Find the missing or wrong leg in the posting rules for this transaction type, then re-post the journal.'
    },
    MISSING_IN_GL: {
      label: 'Missing in GL', severity: 'critical',
      what: 'A successful transaction that has no GL lines at all.',
      why: 'Money moved for the customer but the books never recorded it, so balances and settlement will not match.',
      action: 'Check the posting job/queue for this reference (dropped event, failed consumer, retry exhausted).'
    },
    MISSING_REVERSAL: {
      label: 'Missing reversal', severity: 'critical',
      what: 'A failed or reversed transaction whose GL lines do not net to zero per account.',
      why: 'The customer was refunded (or never charged) but the ledger still shows the original posting.',
      action: 'Confirm the reversal event fired and that the reversal journal swaps every leg of the original.'
    },
    DUPLICATE_POSTING: {
      label: 'Duplicate posting', severity: 'critical',
      what: 'The same GL line appears more than once for a reference (or an entry ID is reused).',
      why: 'Classic idempotency bug: a retried webhook or job posted twice and inflated balances.',
      action: 'Check idempotency keys on the posting service and how retries/duplicate callbacks are handled.'
    },
    AMOUNT_MISMATCH: {
      label: 'Amount mismatch', severity: 'high',
      what: 'GL posted amount differs from the transaction amount (also tried amount ± fee).',
      why: 'Customer, settlement and ledger figures disagree; usually a wrong fee rule or currency/scale bug.',
      action: 'Compare the fee configuration and any currency conversion used when this transaction was posted.'
    },
    ORPHAN_GL: {
      label: 'Orphan GL entry', severity: 'high',
      what: 'GL lines whose reference does not exist in the transactions file.',
      why: 'Postings with no source transaction cannot be audited and may be manual or test entries in production.',
      action: 'Confirm whether it is a manual journal, a reference format mismatch, or a transaction missing from the export.'
    },
    DUPLICATE_TXN: {
      label: 'Duplicate transaction record', severity: 'high',
      what: 'The same transaction ID appears more than once in the transactions file.',
      why: 'Either the export is wrong or the system created two records for one payment.',
      action: 'Check the export query and the uniqueness constraint on transaction references.'
    },
    ROUNDING_DRIFT: {
      label: 'Rounding drift', severity: 'medium',
      what: 'Small differences (within the rounding threshold) or amounts posted with sub-kobo precision.',
      why: 'Tiny per-transaction differences add up to real money over volume and break period-end tie-outs.',
      action: 'Check where fees/percentages are rounded (before vs after posting) and the decimal scale in the GL.'
    },
    POSTED_WHILE_PENDING: {
      label: 'Posted while pending', severity: 'medium',
      what: 'A pending transaction that already has GL postings.',
      why: 'If the transaction later fails, the ledger must be reversed, which is a common source of missing reversals.',
      action: 'Confirm whether the design posts on initiation or on settlement, and that pending states are handled.'
    },
    DATE_GAP: {
      label: 'Posting date gap', severity: 'medium',
      what: 'GL posting date is further from the transaction date than the allowed window.',
      why: 'Postings land in the wrong day or period, so daily and month-end reports disagree.',
      action: 'Check end-of-day cut-off, timezone handling (WAT vs UTC) and delayed posting jobs.'
    },
    DATA_QUALITY: {
      label: 'Data quality', severity: 'low',
      what: 'Values the checker could not read (amounts, dates, IDs) or unknown status values.',
      why: 'Rows that cannot be parsed are skipped by other checks, so real issues could be hidden.',
      action: 'Fix the export format or adjust the column mapping and status lists in Settings.'
    }
  };
  const CHECK_ORDER = Object.keys(CHECKS);

  // ---------- column definitions & auto-mapping ----------
  const TX_FIELDS = [
    { key: 'id', label: 'Transaction ID / reference', required: true,
      synonyms: ['transaction_id', 'txn_id', 'trans_id', 'transaction_ref', 'transaction_reference', 'txn_ref', 'reference', 'ref', 'payment_reference', 'session_id', 'tran_id', 'id'] },
    { key: 'date', label: 'Transaction date',
      synonyms: ['transaction_date', 'txn_date', 'date', 'created_at', 'created', 'value_date', 'trans_date', 'timestamp', 'datetime'] },
    { key: 'amount', label: 'Amount', required: true,
      synonyms: ['amount', 'transaction_amount', 'txn_amount', 'principal', 'principal_amount', 'value', 'amt'] },
    { key: 'fee', label: 'Fee / charge',
      synonyms: ['fee', 'fees', 'fee_amount', 'charge', 'charges', 'commission', 'transaction_fee'] },
    { key: 'status', label: 'Status',
      synonyms: ['status', 'transaction_status', 'txn_status', 'state', 'response', 'response_code'] },
    { key: 'type', label: 'Type / channel',
      synonyms: ['type', 'transaction_type', 'txn_type', 'channel', 'category', 'product'] }
  ];
  const GL_FIELDS = [
    { key: 'ref', label: 'Transaction reference', required: true,
      synonyms: ['transaction_ref', 'transaction_reference', 'txn_ref', 'transaction_id', 'txn_id', 'reference', 'ref', 'source_ref', 'external_ref'] },
    { key: 'journal', label: 'Journal / batch ID',
      synonyms: ['journal_id', 'journal', 'journal_no', 'batch_id', 'batch', 'voucher', 'voucher_no', 'posting_id'] },
    { key: 'entry', label: 'Entry / line ID',
      synonyms: ['entry_id', 'line_id', 'gl_id', 'entry_no', 'line_no', 'id'] },
    { key: 'date', label: 'Posting date',
      synonyms: ['posting_date', 'post_date', 'gl_date', 'entry_date', 'value_date', 'date', 'created_at'] },
    { key: 'account', label: 'GL account', required: true,
      synonyms: ['account_code', 'gl_account', 'account', 'account_no', 'account_number', 'gl_code', 'ledger', 'ledger_code'] },
    { key: 'accountName', label: 'Account name',
      synonyms: ['account_name', 'gl_account_name', 'ledger_name', 'account_description'] },
    { key: 'debit', label: 'Debit',
      synonyms: ['debit', 'dr', 'debit_amount', 'dr_amount'] },
    { key: 'credit', label: 'Credit',
      synonyms: ['credit', 'cr', 'credit_amount', 'cr_amount'] },
    { key: 'amount', label: 'Amount (single column)',
      synonyms: ['amount', 'posting_amount', 'entry_amount', 'value'] },
    { key: 'side', label: 'Dr/Cr indicator',
      synonyms: ['dr_cr', 'drcr', 'side', 'entry_type', 'direction', 'debit_credit', 'dc', 'indicator'] }
  ];

  function normHeader(h) {
    return String(h || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  }

  /** Returns {fieldKey: columnIndex} using exact matches first, then "contains" matches. */
  function autoMap(headers, fields) {
    const norm = headers.map(normHeader);
    const used = new Set();
    const map = {};
    for (const f of fields) {
      for (const syn of f.synonyms) {
        const i = norm.findIndex((h, idx) => !used.has(idx) && h === syn);
        if (i >= 0) { map[f.key] = i; used.add(i); break; }
      }
    }
    for (const f of fields) {
      if (map[f.key] !== undefined) continue;
      for (const syn of f.synonyms) {
        if (syn.length < 4) continue;
        const i = norm.findIndex((h, idx) => !used.has(idx) && h.includes(syn));
        if (i >= 0) { map[f.key] = i; used.add(i); break; }
      }
    }
    return map;
  }

  function autoGlMode(map) {
    if (map.debit !== undefined || map.credit !== undefined) return 'split';
    if (map.amount !== undefined) return 'single';
    return 'split';
  }

  function validateMapping(txMap, glMap, glMode) {
    const errors = [];
    if (txMap.id === undefined) errors.push('Transactions: map the Transaction ID column.');
    if (txMap.amount === undefined) errors.push('Transactions: map the Amount column.');
    if (glMap.ref === undefined) errors.push('GL: map the Transaction reference column.');
    if (glMap.account === undefined) errors.push('GL: map the GL account column.');
    if (glMode === 'single') {
      if (glMap.amount === undefined) errors.push('GL: map the Amount column (single-column mode).');
    } else if (glMap.debit === undefined && glMap.credit === undefined) {
      errors.push('GL: map the Debit and Credit columns.');
    }
    return errors;
  }

  // ---------- parsing ----------
  function parseAmount(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === 'number') return isFinite(v) ? v : NaN;
    let s = String(v).trim();
    if (!s || s === '-') return null;
    let neg = false;
    if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1).trim(); }
    s = s.replace(/\b(?:dr|cr)\.?$/i, '').trim();
    s = s.replace(/^(?:NGN|USD|GBP|EUR|N)\s*/i, '').replace(/\s*(?:NGN|USD|GBP|EUR)$/i, '');
    s = s.replace(/[₦$€£\s,]/g, '');
    if (s.endsWith('-')) { neg = !neg; s = s.slice(0, -1); }
    if (s.startsWith('-')) { neg = !neg; s = s.slice(1); }
    else if (s.startsWith('+')) s = s.slice(1);
    if (!/^(\d+\.?\d*|\.\d+)$/.test(s)) return NaN;
    const n = parseFloat(s);
    return neg ? -n : n;
  }
  function toUnits(n) { return Math.round(n * SCALE); }

  const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
  function mkDay(y, m, d) {
    if (y < 100) y += 2000;
    if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31)) return NaN;
    const t = Date.UTC(y, m - 1, d);
    const back = new Date(t);
    if (back.getUTCDate() !== d) return NaN;
    return Math.floor(t / 864e5);
  }
  /** Returns days since 1970-01-01 (integer), null for empty, NaN if unreadable. */
  function parseDate(v, order) {
    if (v === null || v === undefined || v === '') return null;
    if (v instanceof Date) return isNaN(v) ? NaN : mkDay(v.getFullYear(), v.getMonth() + 1, v.getDate());
    if (typeof v === 'number') {
      if (v > 20000 && v < 80000) return Math.floor(v) - 25569; // Excel serial
      return NaN;
    }
    const s = String(v).trim();
    if (!s) return null;
    let m;
    if ((m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(s))) return mkDay(+m[1], +m[2], +m[3]);
    if ((m = /^(\d{4})(\d{2})(\d{2})$/.exec(s))) return mkDay(+m[1], +m[2], +m[3]);
    if ((m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})\b/.exec(s))) {
      const a = +m[1], b = +m[2], y = +m[3];
      if (a > 12) return mkDay(y, b, a);
      if (b > 12) return mkDay(y, a, b);
      return order === 'MDY' ? mkDay(y, a, b) : mkDay(y, b, a);
    }
    if ((m = /^(\d{1,2})[-\s/]([A-Za-z]{3,9})[-\s/,]+(\d{2,4})/.exec(s))) {
      const mo = MONTHS[m[2].toLowerCase().slice(0, 4)] || MONTHS[m[2].toLowerCase().slice(0, 3)];
      return mo ? mkDay(+m[3], mo, +m[1]) : NaN;
    }
    if ((m = /^([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})/.exec(s))) {
      const mo = MONTHS[m[1].toLowerCase().slice(0, 4)] || MONTHS[m[1].toLowerCase().slice(0, 3)];
      return mo ? mkDay(+m[3], mo, +m[2]) : NaN;
    }
    return NaN;
  }
  function formatDay(day) {
    if (day === null || day === undefined || isNaN(day)) return '';
    return new Date(day * 864e5).toISOString().slice(0, 10);
  }

  function formatMoney(units, opts) {
    if (units === null || units === undefined || isNaN(units)) return '—';
    opts = opts || {};
    const neg = units < 0;
    const abs = Math.abs(units);
    const subKobo = abs % KOBO !== 0;
    const dp = subKobo ? 4 : 2;
    const whole = Math.floor(abs / SCALE);
    const frac = abs % SCALE;
    let fracStr = String(frac).padStart(4, '0').slice(0, dp);
    const wholeStr = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    const sign = neg ? '-' : (opts.signed && units > 0 ? '+' : '');
    return sign + (opts.symbol || '') + wholeStr + '.' + fracStr;
  }

  function listToSet(s) {
    return new Set(String(s || '').split(/[,\n;]/).map(x => x.trim().toLowerCase()).filter(Boolean));
  }

  const DEFAULTS = {
    tolerance: 0,
    roundingThreshold: 1,
    dateWindowDays: 1,
    dateOrder: 'DMY',
    successValues: 'successful, success, completed, complete, approved, settled, paid, 00',
    failedValues: 'failed, failure, reversed, declined, cancelled, canceled, refunded, rejected, error',
    pendingValues: 'pending, processing, initiated, in progress, queued, awaiting',
    glMode: 'split'
  };

  // ---------- main ----------
  function reconcile(txTable, glTable, txMap, glMap, options) {
    const o = Object.assign({}, DEFAULTS, options || {});
    const tolU = toUnits(Math.max(0, Number(o.tolerance) || 0));
    const roundU = toUnits(Math.max(0, Number(o.roundingThreshold) || 0));
    const windowDays = Math.max(0, Number(o.dateWindowDays) || 0);
    const statusSets = { success: listToSet(o.successValues), failed: listToSet(o.failedValues), pending: listToSet(o.pendingValues) };
    const cell = (r, idx) => (idx === undefined || idx === null || idx < 0) ? '' : (r.cells[idx] === undefined || r.cells[idx] === null ? '' : r.cells[idx]);

    const findings = [];
    function add(f) {
      f.severity = CHECKS[f.check].severity;
      f.txIds = f.txIds || [];
      f.glLines = f.glLines || [];
      f.txRecords = f.txRecords || [];
      f.valueAtRisk = Math.abs(f.valueAtRisk || 0);
      findings.push(f);
    }
    const dq = { txId: [], txAmount: [], txFee: [], txDate: [], glAmount: [], glDate: [], glRef: [], glAccount: [], glSide: [] };

    // ---- normalise transactions
    const txs = txTable.rows.map(r => {
      const t = { line: r.line, cells: r.cells };
      t.id = String(cell(r, txMap.id)).trim();
      if (!t.id) dq.txId.push(r.line);
      const a = parseAmount(cell(r, txMap.amount));
      if (a === null || isNaN(a)) { dq.txAmount.push(r.line); t.amount = null; } else t.amount = toUnits(a);
      if (txMap.fee !== undefined) {
        const f = parseAmount(cell(r, txMap.fee));
        if (f !== null && isNaN(f)) { dq.txFee.push(r.line); t.fee = 0; } else t.fee = f === null ? 0 : toUnits(f);
      } else t.fee = 0;
      if (txMap.date !== undefined) {
        const d = parseDate(cell(r, txMap.date), o.dateOrder);
        if (d !== null && isNaN(d)) { dq.txDate.push(r.line); t.date = null; } else t.date = d;
      } else t.date = null;
      t.statusRaw = txMap.status !== undefined ? String(cell(r, txMap.status)).trim() : '';
      const sl = t.statusRaw.toLowerCase();
      if (txMap.status === undefined) t.status = 'success';
      else if (statusSets.success.has(sl)) t.status = 'success';
      else if (statusSets.failed.has(sl)) t.status = 'failed';
      else if (statusSets.pending.has(sl)) t.status = 'pending';
      else t.status = 'unknown';
      t.type = txMap.type !== undefined ? String(cell(r, txMap.type)).trim() : '';
      return t;
    });

    // ---- normalise GL lines
    const mode = o.glMode === 'single' ? 'single' : 'split';
    const gls = glTable.rows.map(r => {
      const g = { line: r.line, cells: r.cells, debit: 0, credit: 0 };
      g.ref = String(cell(r, glMap.ref)).trim();
      g.journal = glMap.journal !== undefined ? String(cell(r, glMap.journal)).trim() : '';
      g.entry = glMap.entry !== undefined ? String(cell(r, glMap.entry)).trim() : '';
      g.account = String(cell(r, glMap.account)).trim();
      g.accountName = glMap.accountName !== undefined ? String(cell(r, glMap.accountName)).trim() : '';
      if (!g.account) dq.glAccount.push(r.line);
      if (glMap.date !== undefined) {
        const d = parseDate(cell(r, glMap.date), o.dateOrder);
        if (d !== null && isNaN(d)) { dq.glDate.push(r.line); g.date = null; } else g.date = d;
      } else g.date = null;
      if (mode === 'split') {
        const d = parseAmount(cell(r, glMap.debit));
        const c = parseAmount(cell(r, glMap.credit));
        if ((d !== null && isNaN(d)) || (c !== null && isNaN(c))) dq.glAmount.push(r.line);
        g.debit = d === null || isNaN(d) ? 0 : toUnits(d);
        g.credit = c === null || isNaN(c) ? 0 : toUnits(c);
        // Negative values in a debit/credit column move to the other side.
        if (g.debit < 0) { g.credit += -g.debit; g.debit = 0; }
        if (g.credit < 0) { g.debit += -g.credit; g.credit = 0; }
      } else {
        const raw = cell(r, glMap.amount);
        const a = parseAmount(raw);
        if (a === null || isNaN(a)) { dq.glAmount.push(r.line); }
        else {
          const u = toUnits(a);
          let side = glMap.side !== undefined ? String(cell(r, glMap.side)).trim().toLowerCase() : '';
          if (!side) { const sm = /\b(dr|cr)\.?\s*$/i.exec(String(raw)); if (sm) side = sm[1].toLowerCase(); }
          if (/^(d|dr|debit)/.test(side)) g.debit = Math.abs(u);
          else if (/^(c|cr|credit)/.test(side)) g.credit = Math.abs(u);
          else if (glMap.side !== undefined && side) { dq.glSide.push(r.line); }
          else if (u >= 0) g.debit = u; else g.credit = -u;
        }
      }
      if (!g.ref) dq.glRef.push(r.line);
      return g;
    });

    // ---- indexes
    const txById = new Map();
    for (const t of txs) {
      if (!t.id) continue;
      if (!txById.has(t.id)) txById.set(t.id, []);
      txById.get(t.id).push(t);
    }
    const glByRef = new Map();
    for (const g of gls) {
      if (!glByRef.has(g.ref)) glByRef.set(g.ref, []);
      glByRef.get(g.ref).push(g);
    }
    const sum = (arr, k) => arr.reduce((s, x) => s + x[k], 0);

    // ---- 1. Unbalanced journals
    const journals = new Map();
    for (const g of gls) {
      const key = g.journal || g.ref || ('row ' + g.line);
      if (!journals.has(key)) journals.set(key, []);
      journals.get(key).push(g);
    }
    for (const [key, lines] of journals) {
      const dr = sum(lines, 'debit'), cr = sum(lines, 'credit');
      const diff = dr - cr;
      if (Math.abs(diff) > tolU) {
        const refs = [...new Set(lines.map(l => l.ref).filter(Boolean))];
        add({
          check: 'UNBALANCED', ref: refs.join(', ') || key,
          title: glMap.journal !== undefined && lines[0].journal ? 'Journal ' + key + ' does not balance' : 'Postings for ' + key + ' do not balance',
          detail: 'Debits ' + formatMoney(dr) + ' vs credits ' + formatMoney(cr) + ' across ' + lines.length + ' line' + (lines.length === 1 ? '' : 's') + '.',
          expected: dr, actual: cr, diff: diff, valueAtRisk: diff,
          txIds: refs, glLines: lines, txRecords: refs.flatMap(r => txById.get(r) || [])
        });
      }
    }

    // ---- 2. Duplicate postings
    const dupRefs = new Set();
    if (glMap.entry !== undefined) {
      const byEntry = new Map();
      for (const g of gls) {
        if (!g.entry) continue;
        if (!byEntry.has(g.entry)) byEntry.set(g.entry, []);
        byEntry.get(g.entry).push(g);
      }
      for (const [entry, lines] of byEntry) {
        if (lines.length < 2) continue;
        const refs = [...new Set(lines.map(l => l.ref).filter(Boolean))];
        refs.forEach(r => dupRefs.add(r));
        add({
          check: 'DUPLICATE_POSTING', ref: refs.join(', ') || entry,
          title: 'Entry ID ' + entry + ' appears ' + lines.length + ' times',
          detail: 'GL rows ' + lines.map(l => l.line).join(', ') + ' share the same entry ID.',
          expected: null, actual: null, diff: null,
          valueAtRisk: lines.slice(1).reduce((s, l) => s + Math.max(l.debit, l.credit), 0),
          txIds: refs, glLines: lines, txRecords: refs.flatMap(r => txById.get(r) || [])
        });
      }
    }
    for (const [ref, lines] of glByRef) {
      if (!ref || dupRefs.has(ref)) continue;
      const groups = new Map();
      for (const l of lines) {
        const k = l.account + '|' + l.debit + '|' + l.credit;
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(l);
      }
      const dupLines = [];
      let extra = 0;
      for (const g of groups.values()) {
        if (g.length < 2) continue;
        const distinct = new Set(g.map(l => (l.journal || '') + '#' + (l.entry || l.line)));
        const distinctJournals = new Set(g.map(l => l.journal || ('#' + l.line)));
        if (distinct.size < 2 || distinctJournals.size < 2) continue;
        dupLines.push(...g);
        extra += (g.length - 1) * Math.max(g[0].debit, g[0].credit);
      }
      if (dupLines.length) {
        dupRefs.add(ref);
        const journalsSeen = [...new Set(dupLines.map(l => l.journal).filter(Boolean))];
        add({
          check: 'DUPLICATE_POSTING', ref,
          title: 'Reference ' + ref + ' was posted more than once',
          detail: 'Identical GL lines appear in ' + (journalsSeen.length ? journalsSeen.length + ' journals (' + journalsSeen.join(', ') + ')' : 'multiple postings') + '. Extra value posted: ' + formatMoney(extra) + '.',
          expected: null, actual: null, diff: extra, valueAtRisk: extra,
          txIds: [ref], glLines: lines, txRecords: txById.get(ref) || []
        });
      }
    }

    // ---- 3. Orphan GL entries
    const noRef = glByRef.get('');
    for (const [ref, lines] of glByRef) {
      if (!ref || txById.has(ref)) continue;
      const dr = sum(lines, 'debit');
      add({
        check: 'ORPHAN_GL', ref,
        title: 'GL reference ' + ref + ' has no matching transaction',
        detail: lines.length + ' GL line' + (lines.length === 1 ? '' : 's') + ' (debits ' + formatMoney(dr) + ') with no record in the transactions file.',
        expected: null, actual: dr, diff: null, valueAtRisk: dr,
        txIds: [], glLines: lines
      });
    }
    if (noRef && noRef.length) {
      const dr = sum(noRef, 'debit');
      add({
        check: 'ORPHAN_GL', ref: '(blank)',
        title: noRef.length + ' GL line' + (noRef.length === 1 ? ' has' : 's have') + ' no transaction reference',
        detail: 'GL rows ' + listLines(noRef.map(l => l.line)) + '. Debits ' + formatMoney(dr) + '.',
        expected: null, actual: dr, diff: null, valueAtRisk: dr, glLines: noRef
      });
    }

    // ---- 4. Per-transaction checks
    const unknownStatuses = new Map();
    let netDrift = 0;
    for (const [id, recs] of txById) {
      const t = recs[0];
      const lines = glByRef.get(id) || [];
      if (recs.length > 1) {
        const amounts = [...new Set(recs.map(r => r.amount))];
        add({
          check: 'DUPLICATE_TXN', ref: id,
          title: 'Transaction ' + id + ' appears ' + recs.length + ' times',
          detail: 'Rows ' + recs.map(r => r.line).join(', ') + (amounts.length > 1 ? ' with different amounts (' + amounts.map(a => formatMoney(a)).join(' / ') + ').' : ' with the same amount.'),
          expected: null, actual: null, diff: null, valueAtRisk: 0,
          txIds: [id], txRecords: recs, glLines: lines
        });
      }
      if (t.amount === null) continue;

      if (t.status === 'unknown') {
        const k = t.statusRaw || '(blank)';
        if (!unknownStatuses.has(k)) unknownStatuses.set(k, []);
        unknownStatuses.get(k).push(t.line);
        continue;
      }

      if (t.status === 'success') {
        if (!lines.length) {
          add({
            check: 'MISSING_IN_GL', ref: id,
            title: 'Successful transaction ' + id + ' was never posted',
            detail: (t.type ? t.type + ' of ' : 'Amount ') + formatMoney(t.amount) + (t.date !== null ? ' on ' + formatDay(t.date) : '') + ' has no GL lines.',
            expected: t.amount, actual: 0, diff: -t.amount, valueAtRisk: t.amount,
            txIds: [id], txRecords: recs
          });
          continue;
        }
        if (!dupRefs.has(id)) {
          const posted = sum(lines, 'debit');
          const candidates = [{ v: t.amount, basis: 'amount' }];
          if (t.fee) {
            candidates.push({ v: t.amount + t.fee, basis: 'amount + fee' });
            candidates.push({ v: t.amount - t.fee, basis: 'amount − fee' });
          }
          let best = candidates[0];
          for (const c of candidates) if (Math.abs(posted - c.v) < Math.abs(posted - best.v)) best = c;
          const diff = posted - best.v;
          const subKobo = lines.some(l => l.debit % KOBO !== 0 || l.credit % KOBO !== 0);
          if (Math.abs(diff) > tolU && Math.abs(diff) <= roundU) {
            netDrift += diff;
            add({
              check: 'ROUNDING_DRIFT', ref: id,
              title: 'Posted ' + formatMoney(diff, { signed: true }) + ' off for ' + id,
              detail: 'GL debits ' + formatMoney(posted) + ' vs expected ' + formatMoney(best.v) + ' (' + best.basis + ')' + (subKobo ? '; lines carry sub-kobo values.' : '.'),
              expected: best.v, actual: posted, diff, valueAtRisk: diff,
              txIds: [id], txRecords: recs, glLines: lines
            });
          } else if (Math.abs(diff) > tolU) {
            add({
              check: 'AMOUNT_MISMATCH', ref: id,
              title: 'GL amount differs from transaction ' + id,
              detail: 'GL debits ' + formatMoney(posted) + ' vs transaction ' + formatMoney(t.amount) + (t.fee ? ' (fee ' + formatMoney(t.fee) + '; closest basis: ' + best.basis + ')' : '') + '.',
              expected: best.v, actual: posted, diff, valueAtRisk: diff,
              txIds: [id], txRecords: recs, glLines: lines
            });
          } else if (subKobo) {
            add({
              check: 'ROUNDING_DRIFT', ref: id,
              title: id + ' was posted with sub-kobo precision',
              detail: 'Totals match within tolerance, but GL lines hold fractions of a kobo, which accumulate across transactions.',
              expected: best.v, actual: posted, diff: diff, valueAtRisk: 0,
              txIds: [id], txRecords: recs, glLines: lines
            });
          }
        }
        if (t.date !== null) {
          const dates = lines.map(l => l.date).filter(d => d !== null && d !== undefined && !isNaN(d));
          if (dates.length) {
            const first = Math.min(...dates);
            const gap = first - t.date;
            if (Math.abs(gap) > windowDays) {
              add({
                check: 'DATE_GAP', ref: id,
                title: id + ' posted ' + Math.abs(gap) + ' day' + (Math.abs(gap) === 1 ? '' : 's') + (gap > 0 ? ' late' : ' early'),
                detail: 'Transaction date ' + formatDay(t.date) + ', first GL posting ' + formatDay(first) + ' (window: ' + windowDays + ' day' + (windowDays === 1 ? '' : 's') + ').',
                expected: null, actual: null, diff: null, valueAtRisk: 0, gapDays: gap,
                txIds: [id], txRecords: recs, glLines: lines
              });
            }
          }
        }
      } else if (t.status === 'failed') {
        if (!lines.length) continue;
        const net = new Map();
        for (const l of lines) net.set(l.account, (net.get(l.account) || 0) + l.debit - l.credit);
        const open = [...net].filter(([, v]) => Math.abs(v) > tolU);
        if (open.length) {
          const outstanding = open.reduce((s, [, v]) => s + (v > 0 ? v : 0), 0);
          const names = new Map(lines.map(l => [l.account, l.accountName]));
          add({
            check: 'MISSING_REVERSAL', ref: id,
            title: (t.statusRaw || 'Failed') + ' transaction ' + id + ' still sits in the ledger',
            detail: 'Open balances: ' + open.map(([a, v]) => a + (names.get(a) ? ' ' + names.get(a) : '') + ' ' + formatMoney(v, { signed: true })).join('; ') + '.',
            expected: 0, actual: outstanding, diff: outstanding, valueAtRisk: outstanding,
            txIds: [id], txRecords: recs, glLines: lines
          });
        }
      } else if (t.status === 'pending' && lines.length) {
        const posted = sum(lines, 'debit');
        add({
          check: 'POSTED_WHILE_PENDING', ref: id,
          title: 'Pending transaction ' + id + ' is already posted',
          detail: lines.length + ' GL lines (debits ' + formatMoney(posted) + ') exist while the transaction is still ' + (t.statusRaw || 'pending') + '.',
          expected: 0, actual: posted, diff: null, valueAtRisk: 0,
          txIds: [id], txRecords: recs, glLines: lines
        });
      }
    }

    // ---- 5. Data quality
    const dqItem = (rows, title, detail) => {
      if (!rows.length) return;
      add({ check: 'DATA_QUALITY', ref: '—', title: title.replace('{n}', rows.length), detail: detail + ' Rows: ' + listLines(rows) + '.', expected: null, actual: null, diff: null, valueAtRisk: 0, rows });
    };
    dqItem(dq.txId, '{n} transaction row(s) have no ID', 'These rows were skipped by every check.');
    dqItem(dq.txAmount, '{n} transaction amount(s) could not be read', 'These transactions were skipped.');
    dqItem(dq.txFee, '{n} fee value(s) could not be read', 'Treated as zero fee.');
    dqItem(dq.txDate, '{n} transaction date(s) could not be read', 'Date-gap check skipped for these. Check the date order setting.');
    dqItem(dq.glAmount, '{n} GL amount(s) could not be read', 'Treated as zero.');
    dqItem(dq.glDate, '{n} GL posting date(s) could not be read', 'Date-gap check skipped for these.');
    dqItem(dq.glAccount, '{n} GL line(s) have no account', 'Per-account reversal checks may be unreliable.');
    dqItem(dq.glSide, '{n} GL line(s) have an unrecognised Dr/Cr value', 'Expected values like DR/CR or Debit/Credit.');
    for (const [status, rows] of unknownStatuses) {
      add({
        check: 'DATA_QUALITY', ref: '—',
        title: 'Unknown status "' + status + '" on ' + rows.length + ' transaction' + (rows.length === 1 ? '' : 's'),
        detail: 'Add it to the success, failed or pending list in Settings. These transactions were not checked. Rows: ' + listLines(rows) + '.',
        expected: null, actual: null, diff: null, valueAtRisk: 0, rows
      });
    }

    // ---- 6. Link orphans to unposted transactions (likely the same payment)
    const missing = findings.filter(f => f.check === 'MISSING_IN_GL');
    for (const f of findings) {
      if (f.check !== 'ORPHAN_GL' || f.ref === '(blank)') continue;
      const posted = f.actual;
      let best = null;
      for (const m of missing) {
        const t = m.txRecords[0];
        const sameAmount = posted === t.amount || posted === t.amount + t.fee || posted === t.amount - t.fee;
        const dist = editDistance(f.ref, m.ref);
        const score = (sameAmount ? 2 : 0) + (dist <= 2 ? 2 : 0) - dist * 0.01;
        if (score >= 2 && (!best || score > best.score)) best = { m, score, sameAmount, dist };
      }
      if (best) {
        const why = [best.dist <= 2 ? 'similar reference' : null, best.sameAmount ? 'same amount' : null].filter(Boolean).join(', ');
        f.detail += ' Possible match: ' + best.m.ref + ' (' + why + ').';
        best.m.detail += ' Possibly posted under ' + f.ref + ' (' + why + ').';
        f.relatedRef = best.m.ref;
        best.m.relatedRef = f.ref;
        f.txRecords = best.m.txRecords;
      }
    }

    // ---- sort & number
    const sevRank = s => SEVERITIES.indexOf(s);
    findings.sort((a, b) => sevRank(a.severity) - sevRank(b.severity) || CHECK_ORDER.indexOf(a.check) - CHECK_ORDER.indexOf(b.check) || String(a.ref).localeCompare(String(b.ref), undefined, { numeric: true }));
    findings.forEach((f, i) => { f.id = i + 1; });

    // ---- summary
    const flagged = new Set();
    for (const f of findings) for (const id of f.txIds) if (txById.has(id)) flagged.add(id);
    const bySeverity = Object.fromEntries(SEVERITIES.map(s => [s, 0]));
    const byCheck = Object.fromEntries(CHECK_ORDER.map(c => [c, 0]));
    let valueAtRisk = 0;
    for (const f of findings) { bySeverity[f.severity]++; byCheck[f.check]++; if (f.check !== 'DATA_QUALITY') valueAtRisk += f.valueAtRisk; }
    const statusCounts = { success: 0, failed: 0, pending: 0, unknown: 0 };
    let successValue = 0;
    for (const [, recs] of txById) {
      statusCounts[recs[0].status]++;
      if (recs[0].status === 'success' && recs[0].amount !== null) successValue += recs[0].amount;
    }
    const glDebit = sum(gls, 'debit'), glCredit = sum(gls, 'credit');
    const uniqueTx = txById.size;
    const summary = {
      txRows: txs.length, uniqueTx, glLines: gls.length, journals: journals.size,
      glRefs: [...glByRef.keys()].filter(Boolean).length,
      matchedTx: [...txById.keys()].filter(id => glByRef.has(id)).length,
      cleanTx: uniqueTx - flagged.size,
      cleanRate: uniqueTx ? (uniqueTx - flagged.size) / uniqueTx : 1,
      successValue, glDebit, glCredit, glImbalance: glDebit - glCredit,
      valueAtRisk, netDrift, statusCounts, bySeverity, byCheck,
      totalFindings: findings.length
    };
    return { summary, findings, options: o, generatedAt: new Date().toISOString() };
  }

  function editDistance(a, b) {
    a = String(a); b = String(b);
    if (Math.abs(a.length - b.length) > 3) return 99;
    const dp = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      let prev = dp[0]; dp[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const tmp = dp[j];
        dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
        prev = tmp;
      }
    }
    return dp[b.length];
  }

  function listLines(lines) {
    const max = 15;
    return lines.length > max ? lines.slice(0, max).join(', ') + ' and ' + (lines.length - max) + ' more' : lines.join(', ');
  }

  const api = {
    SCALE, CHECKS, CHECK_ORDER, SEVERITIES, TX_FIELDS, GL_FIELDS, DEFAULTS,
    autoMap, autoGlMode, validateMapping, normHeader,
    parseAmount, parseDate, formatDay, formatMoney, toUnits, reconcile
  };
  root.Recon = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : this);
