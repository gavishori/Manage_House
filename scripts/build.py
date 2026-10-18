"""Build the data file for the household finance app.

Reads every export dropped into finance/private/raw/ (bank account .xls,
credit-card .xlsx, bit .csv, pension payslip .pdf), categorizes them with the
rules in finance/private/config.json and writes finance/private/data.json.
That file is uploaded from the app (button "עדכון נתונים") into Firestore,
which only the allowed Google accounts can read. finance/private/ is
git-ignored, so no personal data is ever committed.

Usage:  python scripts/build.py
Needs:  pip install xlrd openpyxl pdfplumber
"""
import csv
import datetime as dt
import json
import re
import sys
from collections import Counter
from pathlib import Path

import openpyxl
import pdfplumber
import xlrd

ROOT = Path(__file__).resolve().parent.parent
PRIV = ROOT / "finance" / "private"
RAW = PRIV / "raw"
OUT = PRIV / "data.json"

BIDI = dict.fromkeys(map(ord, "‪‫‬‭‮"), None)


def clean(s):
    return re.sub(r"\s+", " ", str(s or "").translate(BIDI)).strip()


# ---------------------------------------------------------------- bank
def load_bank(files):
    rows, anchors = {}, []
    for f in files:
        sh = xlrd.open_workbook(f).sheet_by_index(0)
        head = next((r for r in range(min(sh.nrows, 20))
                     if "תיאור פעולה" in [clean(v) for v in sh.row_values(r)]), None)
        if head is None:
            continue
        first = None
        for r in range(head + 1, sh.nrows):
            v = sh.row_values(r)
            if not isinstance(v[0], float):
                continue
            d = (dt.datetime(1899, 12, 30) + dt.timedelta(days=v[0])).date().isoformat()
            item = dict(d=d, ref=clean(v[2]), desc=clean(v[3]),
                        out=float(v[4] or 0), inn=float(v[5] or 0), bal=float(v[6] or 0))
            rows[(d, item["ref"], item["out"], item["inn"], item["desc"])] = item
            if first is None:
                first = item  # exports are newest-first: the first row carries the latest balance
        if first:
            anchors.append(first)
    tx = sorted(rows.values(), key=lambda x: x["d"])
    # end-of-day balances, walking back from the newest anchored balance
    balance = []
    if tx and anchors:
        # the newest file's top row is the last movement of its day, so its balance closes that day
        latest = max(anchors, key=lambda a: a["d"])
        start = latest["bal"] + sum(t["inn"] - t["out"] for t in tx if t["d"] > latest["d"])
        b, eod = start, {}
        for t in reversed(tx):
            eod.setdefault(t["d"], b)
            b -= t["inn"] - t["out"]
        day = dt.date.fromisoformat(tx[0]["d"])
        end = dt.date.fromisoformat(tx[-1]["d"])
        cur = b
        while day <= end:
            k = day.isoformat()
            if k in eod:
                cur = eod[k]
            balance.append([k, round(cur, 2)])
            day += dt.timedelta(days=1)
    return tx, balance


# ---------------------------------------------------------------- Max cards
def ddmmyyyy(s):
    s = clean(s)
    return f"{s[6:10]}-{s[3:5]}-{s[0:2]}" if len(s) >= 10 else ""


def load_cards(files):
    best = Counter()
    keep = {}
    for f in files:
        wb = openpyxl.load_workbook(f, data_only=True)
        here = Counter()
        for ws in wb:
            rows = list(ws.iter_rows(values_only=True))
            head = next((i for i, r in enumerate(rows[:15]) if r and "שם בית העסק" in [clean(v) for v in r]), None)
            if head is None:
                continue
            H = [clean(v) for v in rows[head]]
            col = {name: H.index(name) for name in H if name}
            for r in rows[head + 1:]:
                if not r or r[col["סכום חיוב"]] is None or not r[col["תאריך עסקה"]]:
                    continue
                it = dict(td=ddmmyyyy(r[col["תאריך עסקה"]]), d=ddmmyyyy(r[col["תאריך חיוב"]]),
                          m=clean(r[col["שם בית העסק"]]), mcat=clean(r[col["קטגוריה"]]),
                          card=clean(r[col["4 ספרות אחרונות של כרטיס האשראי"]]),
                          kind=clean(r[col["סוג עסקה"]]), a=float(r[col["סכום חיוב"]]),
                          cur=clean(r[col.get("מטבע עסקה מקורי", col["מטבע חיוב"])]),
                          note=clean(r[col["הערות"]]))
                k = (it["td"], it["d"], it["m"], it["card"], it["a"], it["note"])
                here[k] += 1
                keep[k] = it
        for k, n in here.items():
            best[k] = max(best[k], n)  # the same purchase exported twice counts once
    out = []
    for k, n in best.items():
        out += [keep[k]] * n
    return sorted(out, key=lambda x: (x["d"], x["td"]))


# ---------------------------------------------------------------- bit
def load_bit(files):
    out = []
    for f in files:
        for r in csv.reader(open(f, encoding="utf-8-sig")):
            if len(r) >= 9 and clean(r[1]) == "בוצע":
                d = clean(r[8])
                out.append(dict(d=f"20{d[6:8]}-{d[3:5]}-{d[0:2]}", desc=clean(r[2]), a=float(r[4]),
                                pay=clean(r[5]), dir="in" if clean(r[6]) == "זיכוי" else "out", who=clean(r[7])))
    return sorted({json.dumps(x, ensure_ascii=False): x for x in out}.values(), key=lambda x: x["d"])


# ---------------------------------------------------------------- payslips
MONTHS = ["ינואר", "פברואר", "מרץ", "אפריל", "מאי", "יוני", "יולי", "אוגוסט", "ספטמבר", "אוקטובר", "נובמבר", "דצמבר"]
EXTRAS = ["דמי הבראה", "ביגוד", "מענק יובל", "מענק"]


def num(s):
    return float(s.replace(",", ""))


def fix_line(line):
    # pdfplumber returns these RTL payslips mirrored; flip the line, then flip each number back
    return re.sub(r"[\d][\d.,]*", lambda m: m.group(0)[::-1], line[::-1])


def load_payslips(files):
    out = []
    for f in files:
        with pdfplumber.open(f) as pdf:
            lines = [fix_line(l) for p in pdf.pages for l in (p.extract_text() or "").split("\n")]
        text = "\n".join(lines)
        m = re.search(r"פירוט תשלומים וניכויים - חודש (\S+) (\d{4})", text)
        if not m or m.group(1) not in MONTHS:
            continue
        slip = dict(month=f"{m.group(2)}-{MONTHS.index(m.group(1)) + 1:02d}", file=f.name, extras=[])
        for l in lines:
            nums = re.findall(r"-?\d[\d,]*\.\d\d", l)
            if not nums:
                continue
            if "סה\"כ לתשלום" in l:
                slip["net"] = num(nums[-1])
            elif "סה\"כ משכורת" in l:
                slip["gross"] = num(nums[-1])
            elif "ניכוי היוון" in l and "hivun" not in slip:
                slip["hivun"] = abs(num(nums[-1]))  # the minus sign lands after the number when un-mirrored
            elif "/450 מס הכנסה" in l or "/054 מס הכנסה" in l:
                slip.setdefault("tax", num(nums[0]))
            elif not re.search(r"קצובת|בסך|החודש|אשתקד", l):
                for e in EXTRAS:
                    if e in l and not any(x[0] == e for x in slip["extras"]):
                        slip["extras"].append([e, num(nums[-1])])
                        break
        if "net" in slip:
            out.append(slip)
    return sorted({s["month"]: s for s in out}.values(), key=lambda s: s["month"])


# ---------------------------------------------------------------- categorize
def first_match(rules, **fields):
    for r in rules:
        if "dir" in r and r["dir"] != fields.get("dir"):
            continue
        if "card" in r and r["card"] != fields.get("card"):
            continue
        if "mcat" in r and not re.search(r["mcat"], fields.get("mcat", "")):
            continue
        if "match" in r and not re.search(r["match"], fields.get("text", "")):
            continue
        return r["cat"]
    return "שונות"


def main():
    cfg = json.loads((PRIV / "config.json").read_text(encoding="utf-8"))
    files = sorted(RAW.glob("*"))
    bank, balance = load_bank([f for f in files if f.suffix.lower() == ".xls"])
    cards = load_cards([f for f in files if f.suffix.lower() == ".xlsx"])
    bit = load_bit([f for f in files if f.suffix.lower() == ".csv"])
    slips = load_payslips([f for f in files if f.suffix.lower() == ".pdf"])
    if not bank:
        sys.exit("No bank export (.xls) found in finance/private/raw/")

    b_from, b_to = bank[0]["d"], bank[-1]["d"]
    c_from = min((c["d"] for c in cards), default="9999")
    c_to = max((c["d"] for c in cards), default="0000")

    ledger, unknown = [], set(cfg["categories"])
    for t in bank:
        direction = "in" if t["inn"] > 0 else "out"
        cat = first_match(cfg["bank_rules"], text=t["desc"], dir=direction)
        if cat == "@card":
            if c_from <= t["d"] <= c_to:
                continue  # detailed in the card export instead
            cat = "כרטיס מקס (ללא פירוט)"
        ledger.append(dict(d=t["d"], src="bank", desc=t["desc"], cat=cat, amt=round(t["inn"] - t["out"], 2)))
    for c in cards:
        if not (b_from <= c["d"]):
            continue
        cat = first_match(cfg["card_rules"], text=c["m"] + (" USA" if c["cur"] not in ("", "₪") else ""),
                          mcat=c["mcat"], card=c["card"])
        ledger.append(dict(d=c["d"], td=c["td"], src="card", desc=c["m"], cat=cat, amt=-c["a"],
                           card=c["card"], note=c["note"], kind=c["kind"]))
    ledger.sort(key=lambda x: x["d"])
    missing = sorted({x["cat"] for x in ledger} - unknown)
    if missing:
        print("WARNING: categories used by rules but missing from config:", missing)

    data = dict(
        generated=dt.datetime.now().strftime("%d.%m.%Y %H:%M"),
        today=dt.date.today().isoformat(),
        coverage=dict(bank=[b_from, b_to], card=[c_from, c_to],
                      bit=[bit[0]["d"], bit[-1]["d"]] if bit else None,
                      slips=[slips[0]["month"], slips[-1]["month"]] if slips else None),
        counts=dict(bank=len(bank), card=len(cards), bit=len(bit), slips=len(slips)),
        ledger=ledger, balance=balance, bit=bit, slips=slips,
        config={k: cfg[k] for k in ("title", "household", "categories", "forecast", "fixed_commitments",
                                    "insights", "learned", "questions")},
    )
    OUT.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    print(f"bank {len(bank)} ({b_from}..{b_to}) · card {len(cards)} ({c_from}..{c_to}) · "
          f"bit {len(bit)} · payslips {len(slips)} · ledger {len(ledger)}")
    size = OUT.stat().st_size
    print(f"wrote {OUT} ({size // 1024} KB)")
    if size > 900_000:
        print("WARNING: close to Firestore's 1 MB document limit")


if __name__ == "__main__":
    main()
