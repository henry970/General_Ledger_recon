"""Generate ReconCheck sample data with known, planted reconciliation defects.

Usage:  python3 tools/generate_samples.py
Writes: samples/transactions.csv, samples/gl.csv, samples/expected_findings.json

All names and references are fictional.
"""
import csv
import json
import os
import random
from datetime import datetime, timedelta
from decimal import Decimal, ROUND_HALF_UP

rng = random.Random(2026)
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "samples")
os.makedirs(OUT, exist_ok=True)

D = Decimal
K = D("0.01")

ACCTS = {
    "WALLET": ("2001", "Customer Wallets"),
    "NIP": ("1201", "NIP Settlement"),
    "FEE": ("4001", "Fee Income"),
    "BILLER": ("2105", "Biller Payable"),
    "CARD": ("1301", "Card Settlement Receivable"),
}
FIRST = ["Adaeze", "Tunde", "Chioma", "Ibrahim", "Ngozi", "Emeka", "Funmi", "Yusuf", "Kemi", "Obinna",
         "Halima", "Segun", "Amaka", "Bayo", "Zainab", "Chidi", "Bisi", "Musa", "Ifeoma", "Dayo"]
LAST = ["Okafor", "Bakare", "Eze", "Bello", "Adeyemi", "Nwosu", "Lawal", "Okonkwo", "Abubakar", "Ogunleye"]


def money(x):
    return D(x).quantize(K, rounding=ROUND_HALF_UP)


def nip_fee(amount):
    if amount <= 5000:
        return D("10.75")
    if amount <= 50000:
        return D("26.88")
    return D("53.75")


def fmt_gl(v):
    """GL export style: thousands separators, blank for zero."""
    if v is None or v == 0:
        return ""
    q = v if v.as_tuple().exponent < -2 else v.quantize(K)
    s = f"{abs(q):,}"
    return ("-" if q < 0 else "") + s


# ---------------------------------------------------------------- transactions
txns = []
start = datetime(2026, 10, 1, 7, 0)
for i in range(1, 241):
    when = start + timedelta(minutes=rng.randint(0, 19 * 24 * 60))
    r = rng.random()
    if r < 0.45:
        typ = "Transfer"
        amount = money(rng.choice([rng.uniform(500, 5000), rng.uniform(5000, 50000), rng.uniform(50000, 450000)]))
        fee = nip_fee(amount)
    elif r < 0.70:
        typ = "Wallet Funding"
        amount = money(rng.choice([1000, 2000, 5000, 10000, 20000, 50000, 100000]) + rng.randint(0, 999))
        fee = D("0.00")
    elif r < 0.85:
        typ = "Bill Payment"
        amount = money(rng.choice([1500, 3000, 5000, 9900, 15000, 24500]))
        fee = D("100.00")
    else:
        typ = "Card Payment"
        amount = money(rng.uniform(800, 120000))
        fee = min(money(amount * D("0.015")), D("2000.00"))
    status = rng.choices(["SUCCESSFUL", "FAILED", "PENDING"], weights=[86, 9, 5])[0]
    txns.append({
        "transaction_id": f"TXN-202610-{i:05d}",
        "created_at": when,
        "type": typ,
        "customer_name": f"{rng.choice(FIRST)} {rng.choice(LAST)}",
        "amount": amount,
        "fee": fee,
        "currency": "NGN",
        "status": status,
    })

by_status = {s: [t for t in txns if t["status"] == s] for s in ("SUCCESSFUL", "FAILED", "PENDING")}
success = by_status["SUCCESSFUL"]
used = set()


def pick(pool, typ=None, n=1):
    out = []
    for t in pool:
        if t["transaction_id"] in used:
            continue
        if typ and t["type"] != typ:
            continue
        out.append(t)
        used.add(t["transaction_id"])
        if len(out) == n:
            return out
    raise RuntimeError(f"not enough {typ} transactions")


planted = {}
def plant(check, ids, note):
    planted.setdefault(check, []).append({"refs": ids, "note": note})


missing_in_gl = pick(success, n=4)
unbal_missing_fee, = pick(success, "Transfer")
unbal_short_credit, = pick(success, "Transfer")
unbal_transposed, = pick(success, "Wallet Funding")
mismatch_fee_tier = next(t for t in success if t["type"] == "Transfer" and t["amount"] <= 5000 and t["transaction_id"] not in used)
used.add(mismatch_fee_tier["transaction_id"])
mismatch_scale, = pick(success, "Wallet Funding")
mismatch_bill, = pick(success, "Bill Payment")
dup_postings = pick(success, n=2)
drift = pick(success, "Transfer", n=3)
subkobo_card = next(t for t in success if t["type"] == "Card Payment" and t["fee"] < 2000 and t["transaction_id"] not in used)
used.add(subkobo_card["transaction_id"])
date_gap = pick(success, n=2)
dup_record, = pick(success, "Transfer")

failed = by_status["FAILED"]
reversal_missing = pick(failed, n=2)
reversal_partial = next(t for t in failed if t["type"] in ("Transfer", "Bill Payment") and t["transaction_id"] not in used)
used.add(reversal_partial["transaction_id"])
pending_posted = pick(by_status["PENDING"], n=2)

bad_amount, = pick(success, "Wallet Funding")
unknown_status, = pick(success)
typo_src, = pick(success)

# ---------------------------------------------------------------- GL postings
gl = []
seq = {"entry": 0, "journal": 0}


def journal(ref, when, legs, narration, journal_id=None):
    if journal_id is None:
        seq["journal"] += 1
        journal_id = f"JV-202610-{seq['journal']:05d}"
    for acct, dr, cr in legs:
        seq["entry"] += 1
        code, name = ACCTS[acct] if acct in ACCTS else acct
        gl.append({
            "entry_id": f"GL-{seq['entry']:06d}",
            "journal_id": journal_id,
            "transaction_ref": ref,
            "posting_date": when.strftime("%d/%m/%Y"),
            "account_code": code,
            "account_name": name,
            "debit": dr,
            "credit": cr,
            "narration": narration,
        })
    return journal_id


def legs_for(t, amount=None, fee=None):
    a = t["amount"] if amount is None else amount
    f = t["fee"] if fee is None else fee
    typ = t["type"]
    if typ == "Transfer":
        return [("WALLET", a + f, None), ("NIP", None, a), ("FEE", None, f)]
    if typ == "Wallet Funding":
        return [("NIP", a, None), ("WALLET", None, a)]
    if typ == "Bill Payment":
        return [("WALLET", a + f, None), ("BILLER", None, a), ("FEE", None, f)]
    # Card Payment: merchant receives amount minus fee
    return [("CARD", a, None), ("WALLET", None, a - f), ("FEE", None, f)]


def reverse(legs):
    return [(acct, cr, dr) for acct, dr, cr in legs]


def post_date(t, days=0):
    d = t["created_at"]
    # Late-evening transactions settle next morning (still inside a 1-day window).
    if d.hour >= 23:
        d += timedelta(days=1)
    return d + timedelta(days=days)


special = {t["transaction_id"] for t in missing_in_gl} | {typo_src["transaction_id"]}
for t in txns:
    ref = t["transaction_id"]
    if ref in special or t["status"] == "PENDING" and t not in pending_posted:
        continue
    nar = f"{t['type']} {ref}"

    if t is unbal_missing_fee:
        legs = legs_for(t)[:-1]  # fee income leg never written
        journal(ref, post_date(t), [(a, d, c) for a, d, c in legs], nar)
        plant("UNBALANCED", [ref], "fee income leg missing")
        continue
    if t is unbal_short_credit:
        legs = legs_for(t)
        legs[1] = ("NIP", None, t["amount"] - D("100.00"))
        journal(ref, post_date(t), legs, nar)
        plant("UNBALANCED", [ref], "settlement credit short by 100.00")
        continue
    if t is unbal_transposed:
        a = t["amount"]
        s = f"{a:.2f}"
        whole, frac = s.split(".")
        swapped = whole[:-3] + whole[-2] + whole[-3] + whole[-1] if len(whole) >= 3 and whole[-2] != whole[-3] else str(int(whole) + 90)
        journal(ref, post_date(t), [("NIP", a, None), ("WALLET", None, D(swapped + "." + frac))], nar)
        plant("UNBALANCED", [ref], f"credit keyed as {swapped}.{frac} (transposed digits)")
        continue
    if t is mismatch_fee_tier:
        journal(ref, post_date(t), legs_for(t, fee=D("26.88")), nar)
        plant("AMOUNT_MISMATCH", [ref], "fee charged at 26.88 tier instead of 10.75")
        continue
    if t is mismatch_scale:
        journal(ref, post_date(t), legs_for(t, amount=t["amount"] * 10), nar)
        plant("AMOUNT_MISMATCH", [ref], "posted 10x the transaction amount")
        continue
    if t is mismatch_bill:
        journal(ref, post_date(t), legs_for(t, amount=t["amount"] - D("2000.00")), nar)
        plant("AMOUNT_MISMATCH", [ref], "biller principal posted 2,000.00 short")
        continue
    if t in dup_postings:
        journal(ref, post_date(t), legs_for(t), nar)
        journal(ref, post_date(t), legs_for(t), nar + " (retry)")
        plant("DUPLICATE_POSTING", [ref], "posted twice by a retried callback")
        continue
    if t in drift:
        delta = [D("0.01"), D("0.25"), D("-0.50")][drift.index(t)]
        journal(ref, post_date(t), legs_for(t, amount=t["amount"] + delta), nar)
        plant("ROUNDING_DRIFT", [ref], f"principal posted {delta:+} off")
        continue
    if t is subkobo_card:
        raw_fee = (t["amount"] * D("0.015")).quantize(D("0.0001"))
        if raw_fee == raw_fee.quantize(K):
            raw_fee += D("0.0025")
        journal(ref, post_date(t), legs_for(t, fee=raw_fee), nar)
        plant("ROUNDING_DRIFT", [ref], f"fee posted unrounded ({raw_fee})")
        continue
    if t in date_gap:
        days = [3, 5][date_gap.index(t)]
        journal(ref, post_date(t, days), legs_for(t), nar)
        plant("DATE_GAP", [ref], f"posted {days} days after the transaction")
        continue
    if t in reversal_missing:
        journal(ref, post_date(t), legs_for(t), nar)
        plant("MISSING_REVERSAL", [ref], "failed but original posting never reversed")
        continue
    if t is reversal_partial:
        legs = legs_for(t)
        journal(ref, post_date(t), legs, nar)
        principal_only = [l for l in legs if l[0] != "FEE"]
        principal_only = [(l[0], (l[1] - t["fee"]) if l[1] else None, l[2]) for l in principal_only]
        journal(ref, post_date(t), reverse(principal_only), "Reversal " + nar)
        plant("MISSING_REVERSAL", [ref], "reversal returned principal but not the fee")
        continue
    if t in pending_posted:
        journal(ref, post_date(t), legs_for(t), nar)
        plant("POSTED_WHILE_PENDING", [ref], "posted on initiation, still pending")
        continue

    if t["status"] == "FAILED":
        if rng.random() < 0.6:  # posted, then correctly reversed
            legs = legs_for(t)
            journal(ref, post_date(t), legs, nar)
            journal(ref, post_date(t), reverse(legs), "Reversal " + nar)
        continue  # otherwise never posted, which is fine
    journal(ref, post_date(t), legs_for(t), nar)

# Orphans: manual journal + reference typo + blank reference
orphan_day = datetime(2026, 10, 14, 10, 0)
journal("MJ-202610-0007", orphan_day, [("NIP", D("250000.00"), None), ("WALLET", None, D("250000.00"))], "Manual adjustment - ops request")
plant("ORPHAN_GL", ["MJ-202610-0007"], "manual journal with no source transaction")
typo_ref = typo_src["transaction_id"].replace("TXN-", "TXM-")
journal(typo_ref, post_date(typo_src), legs_for(typo_src), "Posting with mistyped reference")
plant("ORPHAN_GL", [typo_ref], "reference prefix typo (TXM vs TXN)")
journal("", orphan_day, [("CARD", D("1200.00"), None), ("FEE", None, D("1200.00"))], "Chargeback fee - no ref")
plant("ORPHAN_GL", ["(blank)"], "lines posted without a transaction reference")
# The real typo_src transaction now has no GL posting under its own ID.
plant("MISSING_IN_GL", [typo_src["transaction_id"]], "only posted under the mistyped reference")

for t in missing_in_gl:
    plant("MISSING_IN_GL", [t["transaction_id"]], "never posted")

# ---------------------------------------------------------------- write files
rows = list(txns)
rows.insert(rows.index(dup_record) + 3, dict(dup_record))
plant("DUPLICATE_TXN", [dup_record["transaction_id"]], "exported twice")
plant("DATA_QUALITY", [bad_amount["transaction_id"]], "amount is 'N/A'")
plant("DATA_QUALITY", [unknown_status["transaction_id"]], "status 'UNDER REVIEW' is not in any list")

with open(os.path.join(OUT, "transactions.csv"), "w", newline="", encoding="utf-8") as f:
    w = csv.writer(f)
    w.writerow(["transaction_id", "created_at", "type", "customer_name", "amount", "fee", "currency", "status", "narration"])
    for t in rows:
        amount = "N/A" if t is bad_amount else f"{t['amount']:.2f}"
        status = "UNDER REVIEW" if t is unknown_status else t["status"]
        w.writerow([t["transaction_id"], t["created_at"].strftime("%Y-%m-%d %H:%M:%S"), t["type"], t["customer_name"],
                    amount, f"{t['fee']:.2f}", t["currency"], status, f"{t['type']} by {t['customer_name']}"])

with open(os.path.join(OUT, "gl.csv"), "w", newline="", encoding="utf-8") as f:
    w = csv.writer(f)
    w.writerow(["entry_id", "journal_id", "transaction_ref", "posting_date", "account_code", "account_name", "debit", "credit", "narration"])
    for g in gl:
        w.writerow([g["entry_id"], g["journal_id"], g["transaction_ref"], g["posting_date"], g["account_code"],
                    g["account_name"], fmt_gl(g["debit"]), fmt_gl(g["credit"]), g["narration"]])

summary = {k: len(v) for k, v in planted.items()}
with open(os.path.join(OUT, "expected_findings.json"), "w", encoding="utf-8") as f:
    json.dump({"counts": summary, "total": sum(summary.values()), "planted": planted}, f, indent=2)

print(f"transactions: {len(rows)} rows, GL: {len(gl)} lines")
print(json.dumps(summary, indent=2))
