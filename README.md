# ReconCheck: Ledger Reconciliation Checker

A Chrome extension that reconciles a **transactions export** against a **general ledger (GL) export** and shows exactly where they disagree. Everything runs locally in the browser. No data leaves your machine, there are no network calls, and there are no third-party libraries.

## Install (2 minutes)

1. Unzip `recon-checker.zip`.
2. In Chrome, open `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and select the `recon-checker` folder.
5. Pin ReconCheck from the puzzle-piece menu. Clicking the icon opens it in a full tab.

## How to use it

1. Drop your transactions file on the left and your GL file on the right. CSV, TSV and Excel `.xlsx` files are supported.
2. Columns are matched automatically from common header names. Open **Columns** to check or change the matching.
   * GL files can have separate **Debit/Credit** columns, or a single **Amount** column with a Dr/Cr indicator (or a +/- sign).
3. Click **Run reconciliation**.
   * The middle "tie-out" panel shows whether total debits equal total credits.
   * Click a check in the left list to filter by it.
   * Click any finding to open the full transaction record, its GL lines with totals, and guidance on what to check next.
4. Export the findings as CSV (only the currently filtered rows), the full result as JSON, or print the report (you can save it as a PDF).

## What it checks

| Check | Severity | What it catches |
|---|---|---|
| Unbalanced posting | Critical | A journal where debits ≠ credits (a missing leg, a wrong amount, transposed digits) |
| Missing in GL | Critical | A successful transaction with no GL lines |
| Missing reversal | Critical | A failed or reversed transaction whose postings don't net to zero per account, including partial reversals (e.g. the fee was not reversed) |
| Duplicate posting | Critical | Identical lines posted in two journals (retried callbacks), or a reused entry ID |
| Amount mismatch | High | GL amount ≠ transaction amount. Amount + fee and amount − fee are also tried before flagging |
| Orphan GL entry | High | GL lines whose reference isn't in the transactions file, or blank references. Likely matches are suggested (similar reference or same amount) |
| Duplicate transaction record | High | The same transaction ID appears twice in the transactions file |
| Rounding drift | Medium | Small differences within the threshold, or amounts posted with fractions of a kobo |
| Posted while pending | Medium | A pending transaction that is already in the ledger |
| Posting date gap | Medium | The GL posting date is outside the allowed window from the transaction date (cut-off and timezone bugs) |
| Data quality | Low | Unreadable amounts or dates, and unknown status values |

Money is stored internally as integers (1/10,000 of a naira), so the checker itself never introduces floating-point rounding errors.

## Settings

* **Amount tolerance.** Differences at or below this amount are ignored. The default is 0, which means exact to the kobo.
* **Rounding drift threshold.** Differences up to this amount are reported as rounding drift, and anything larger as an amount mismatch. The default is ₦1.00.
* **Posting date window.** The default is 1 day.
* **Date order** for ambiguous dates like `05/10/2026`. The default is day/month/year. Unambiguous dates are always read correctly.
* **Status lists** that define success, failed and pending. The defaults cover the common values (SUCCESSFUL, FAILED, REVERSED, PENDING and similar). Add your system's own values here.

Settings are saved in the browser.

## Test data

`samples/` contains 241 transactions and 620 GL lines with **30 planted defects** across every check. `samples/expected_findings.json` lists each planted defect and the reason for it. To regenerate the samples:

```
python3 tools/generate_samples.py
```

## Tests

The reconciliation engine is plain JavaScript with no DOM dependencies, so it can be tested in Node:

```
node --test tests/*.test.js
```

There are 13 tests. They cover the CSV parser, amount and date parsing, and auto-mapping. One test checks that every planted sample defect is found with no false positives. Others cover tolerance and status settings, and single-column Dr/Cr GL files.

## Project layout

```
manifest.json        Chrome MV3 manifest (no permissions requested)
background.js        Opens the app in a tab when the icon is clicked
app.html / .css / .js  The interface
lib/recon.js         Reconciliation engine (all checks)
lib/csv.js           CSV parser with delimiter detection
lib/xlsx.js          Minimal .xlsx reader using the browser's built-in unzip
samples/             Test data with known defects (used by the tests)
tests/               Node unit tests
tools/               Sample data generator
```

## Limits

* Older `.xls` (Excel 97–2003) files are not supported. Save them as `.xlsx` or CSV first.
* Only the first worksheet of an `.xlsx` file is read.
* Comparisons use a single currency. Multi-currency files should be split by currency first.
