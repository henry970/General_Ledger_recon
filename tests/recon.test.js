// Run with:  node --test tests/*.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const CSV = require('../lib/csv.js');
const R = require('../lib/recon.js');

const sample = f => fs.readFileSync(path.join(__dirname, '..', 'samples', f), 'utf8');

function runSample(opts) {
  const tx = CSV.parse(sample('transactions.csv'));
  const gl = CSV.parse(sample('gl.csv'));
  const txMap = R.autoMap(tx.headers, R.TX_FIELDS);
  const glMap = R.autoMap(gl.headers, R.GL_FIELDS);
  return { tx, gl, txMap, glMap, result: R.reconcile(tx, gl, txMap, glMap, Object.assign({ glMode: R.autoGlMode(glMap) }, opts)) };
}

test('CSV parser handles quotes, embedded commas and CRLF', () => {
  const t = CSV.parse('a,b,c\r\n"1,000.00","say ""hi""",x\r\n\r\n2,3,4');
  assert.deepEqual(t.headers, ['a', 'b', 'c']);
  assert.equal(t.rows.length, 2);
  assert.deepEqual(t.rows[0].cells, ['1,000.00', 'say "hi"', 'x']);
  assert.equal(t.rows[1].line, 4);
});

test('CSV parser detects semicolon and tab delimiters', () => {
  assert.equal(CSV.parse('a;b\n1;2').headers.length, 2);
  assert.equal(CSV.parse('a\tb\tc\n1\t2\t3').headers.length, 3);
});

test('parseAmount handles currency, separators, negatives and junk', () => {
  assert.equal(R.parseAmount('₦1,234.50'), 1234.5);
  assert.equal(R.parseAmount('NGN 10,000'), 10000);
  assert.equal(R.parseAmount('(250.00)'), -250);
  assert.equal(R.parseAmount('-12.5'), -12.5);
  assert.equal(R.parseAmount('500.00 CR'), 500);
  assert.equal(R.parseAmount(''), null);
  assert.ok(Number.isNaN(R.parseAmount('N/A')));
});

test('parseDate understands ISO, DMY, MDY, month names and serials', () => {
  const d = R.parseDate('2026-10-05 13:00:00');
  assert.equal(R.formatDay(d), '2026-10-05');
  assert.equal(R.formatDay(R.parseDate('05/10/2026', 'DMY')), '2026-10-05');
  assert.equal(R.formatDay(R.parseDate('10/05/2026', 'MDY')), '2026-10-05');
  assert.equal(R.formatDay(R.parseDate('25/10/2026', 'MDY')), '2026-10-25'); // unambiguous wins
  assert.equal(R.formatDay(R.parseDate('5-Oct-2026')), '2026-10-05');
  assert.equal(R.formatDay(R.parseDate('Oct 5, 2026')), '2026-10-05');
  assert.equal(R.formatDay(R.parseDate(46300)), '2026-10-05');
  assert.ok(Number.isNaN(R.parseDate('31/02/2026')));
});

test('formatMoney shows kobo, and 4 dp only for sub-kobo values', () => {
  assert.equal(R.formatMoney(R.toUnits(1234567.5)), '1,234,567.50');
  assert.equal(R.formatMoney(R.toUnits(-0.25), {}), '-0.25');
  assert.equal(R.formatMoney(R.toUnits(185.185)), '185.1850');
  assert.equal(R.formatMoney(R.toUnits(0.3), { signed: true }), '+0.30');
});

test('autoMap finds the sample columns', () => {
  const { txMap, glMap, tx, gl } = runSample();
  assert.equal(tx.headers[txMap.id], 'transaction_id');
  assert.equal(tx.headers[txMap.amount], 'amount');
  assert.equal(tx.headers[txMap.status], 'status');
  assert.equal(gl.headers[glMap.ref], 'transaction_ref');
  assert.equal(gl.headers[glMap.journal], 'journal_id');
  assert.equal(gl.headers[glMap.entry], 'entry_id');
  assert.equal(gl.headers[glMap.debit], 'debit');
  assert.equal(R.autoGlMode(glMap), 'split');
});

test('every planted defect is found, with no extra findings', () => {
  const expected = JSON.parse(sample('expected_findings.json'));
  const { result } = runSample();
  for (const check of R.CHECK_ORDER) {
    assert.equal(result.summary.byCheck[check], expected.counts[check] || 0, check);
  }
  assert.equal(result.findings.length, expected.total);

  // Each planted reference is flagged under the right check.
  for (const [check, items] of Object.entries(expected.planted)) {
    if (check === 'DATA_QUALITY') continue;
    for (const item of items) {
      const ref = item.refs[0];
      const hit = result.findings.find(f => f.check === check && String(f.ref).split(', ').includes(ref));
      assert.ok(hit, `${check} not raised for ${ref} (${item.note})`);
    }
  }
});

test('severity ordering puts critical first', () => {
  const { result } = runSample();
  const rank = s => R.SEVERITIES.indexOf(s);
  for (let i = 1; i < result.findings.length; i++) {
    assert.ok(rank(result.findings[i - 1].severity) <= rank(result.findings[i].severity));
  }
});

test('tolerance setting suppresses small differences', () => {
  const { result } = runSample({ tolerance: 1 });
  assert.equal(result.summary.byCheck.ROUNDING_DRIFT, 1); // only the sub-kobo posting remains
});

test('adding a status to the success list clears the unknown-status finding', () => {
  const { result } = runSample({ successValues: R.DEFAULTS.successValues + ', under review' });
  assert.equal(result.findings.filter(f => /Unknown status/.test(f.title)).length, 0);
});

test('single amount + Dr/Cr column mode', () => {
  const tx = CSV.parse('id,amount,status\nT1,100.00,success\nT2,50,failed\nT3,70,success');
  const gl = CSV.parse('ref,account,amount,dc\nT1,1201,100,DR\nT1,2001,100,CR\nT2,1201,50,DR\nT2,2001,50,CR\nT3,1201,"70.00 DR",\nT3,2001,-70,');
  const txMap = R.autoMap(tx.headers, R.TX_FIELDS);
  const glMap = R.autoMap(gl.headers, R.GL_FIELDS);
  assert.equal(R.autoGlMode(glMap), 'single');
  const res = R.reconcile(tx, gl, txMap, glMap, { glMode: 'single' });
  assert.equal(res.findings.length, 1);
  assert.equal(res.findings[0].check, 'MISSING_REVERSAL');
  assert.equal(res.findings[0].ref, 'T2');
});

test('duplicate posting counts credit-only duplicate lines in the extra value', () => {
  const tx = CSV.parse('id,amount,status\nT1,100,success');
  const gl = CSV.parse('ref,journal_id,account,debit,credit\nT1,J1,1201,100,\nT1,J1,2001,,100\nT1,J2,2001,,100\nT1,J2,1201,100,');
  const txMap = R.autoMap(tx.headers, R.TX_FIELDS);
  const glMap = R.autoMap(gl.headers, R.GL_FIELDS);
  const res = R.reconcile(tx, gl, txMap, glMap, { glMode: 'split' });
  const dup = res.findings.find(f => f.check === 'DUPLICATE_POSTING');
  assert.ok(dup);
  assert.equal(dup.valueAtRisk, R.toUnits(200)); // 100 extra debit + 100 extra credit
});

test('summary totals tie out', () => {
  const { result } = runSample();
  const s = result.summary;
  assert.equal(s.glImbalance, s.glDebit - s.glCredit);
  assert.equal(s.statusCounts.success + s.statusCounts.failed + s.statusCounts.pending + s.statusCounts.unknown, s.uniqueTx);
  assert.ok(s.cleanRate > 0.8 && s.cleanRate < 1);
});
