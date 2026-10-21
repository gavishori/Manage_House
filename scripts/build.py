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


# ---------------------------------------------------------------- PDF text (read each file once)
_PDF_CACHE = {}


def pdf_lines(f):
    if f not in _PDF_CACHE:
        with pdfplumber.open(f) as pdf:
            _PDF_CACHE[f] = [l for p in pdf.pages for l in (p.extract_text() or "").split("\n")]
    return _PDF_CACHE[f]


# ---------------------------------------------------------------- Isracard statements (PDF)
ISR_TX = re.compile(r"(-?[\d,]+\.\d\d) (-?[\d,]+\.\d\d) (.+?) (\d\d/\d\d/\d\d)$")
ISR_TOT = re.compile(r"(-?[\d,]+\.\d\d) (\d\d/\d\d/\d\d) ךיראתל בויח כ\"הס")
ISR_HDR = re.compile(r"(\d\d/\d\d/\d\d) :ךיראתל ךיתולועפ טורפ")
ISR_CARD = re.compile(r"(\d{4}) :תורפסב םייתסמש סיטרכ")
METHODS = ("תש.נייד", "טלפוני", "אינטרנט", "הו\"ק", "ה.קבע")


def logical(text):
    # pdfplumber gives these RTL statements mirrored: flip the line, then flip Latin/digit runs back
    return re.sub(r"[A-Za-z0-9][A-Za-z0-9 &'.\-]*[A-Za-z0-9]|[A-Za-z0-9]", lambda m: m.group(0)[::-1], text[::-1])


def yymmdd(d):
    return f"20{d[6:8]}-{d[3:5]}-{d[0:2]}"


def load_isracard(files):
    """Monthly Isracard statements: one row per purchase, dated by the statement's charge date."""
    rows, totals = {}, []
    for f in files:
        lines = pdf_lines(f)
        if not any(ISR_HDR.search(l) for l in lines):
            continue
        card = next((ISR_CARD.search(l).group(1) for l in lines if ISR_CARD.search(l)), "")
        pending = []
        for l in lines:
            m = ISR_TX.search(l)
            if m:
                pending.append(m)
                continue
            t = ISR_TOT.search(l)
            if not t:
                continue
            charge = yymmdd(t.group(2))
            # a club discount is printed on the same summary line; the bank charges the total after it
            dm = re.search(r"הנח\s?ה\s?(\d+\.\d\d)", logical(l))
            disc = float(dm.group(1)) if dm else 0.0
            totals.append((charge, round(float(t.group(1).replace(",", "")) - disc, 2)))
            if disc:
                rows[(charge, charge, "הנחת מועדון", -disc, -1)] = dict(td=charge, d=charge, m="הנחת מועדון (ישראכרט)", mcat="הנחה",
                                                                       card=card, kind="זיכוי", a=-disc, cur="₪", note="", issuer="isracard")
            for i, m in enumerate(pending):  # a section's purchases are charged on its total line's date
                charged, deal = (float(x.replace(",", "")) for x in (m.group(1), m.group(2)))
                text = logical(m.group(3))
                foreign = any(c in text for c in "€$£")
                toks = [w for w in re.sub(r"[€$£]", " ", text).split() if w != "א"]
                method = toks.pop(0) if toks and (toks[0] in METHODS or toks[0].startswith("תש.")) else ""
                sector = "" if foreign else (toks.pop() if len(toks) > 1 else "")
                note = "הוראת קבע" if method in ("הו\"ק", "ה.קבע") else ""
                if abs(charged - deal) > 0.005 and not foreign:
                    note = (note + " · " if note else "") + f"תשלום מתוך עסקה של {deal:,.2f}"
                it = dict(td=yymmdd(m.group(4)), d=charge, m=" ".join(toks), mcat=sector or ("חו״ל" if foreign else ""),
                          card=card, kind="רגילה", a=charged, cur="€" if foreign else "₪", note=note, issuer="isracard")
                rows[(it["td"], it["d"], it["m"], it["a"], i)] = it
            pending = []
    return sorted(rows.values(), key=lambda x: (x["d"], x["td"])), sorted(set(totals))


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
        lines = [fix_line(l) for l in pdf_lines(f)]
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


def describe_sources(files):
    """One row per file in raw/: what it is, how many rows it gave, and the period it covers."""
    out = []
    for f in files:
        ext, row = f.suffix.lower(), dict(file=f.name, size_kb=round(f.stat().st_size / 1024),
                                          modified=dt.datetime.fromtimestamp(f.stat().st_mtime).strftime("%Y-%m-%d"))
        try:
            if ext == ".xls":
                t, _ = load_bank([f])
                d = [x["d"] for x in t]
                row.update(kind="bank", label="בנק: תנועות עו״ש", rows=len(t), period=[min(d), max(d)] if d else None)
            elif ext == ".xlsx":
                t = load_cards([f])
                d = [x["d"] for x in t]
                row.update(kind="card", label="כרטיסי אשראי (מקס)", rows=len(t), period=[min(d), max(d)] if d else None,
                           detail="כרטיסים: " + ", ".join(sorted({x["card"] for x in t})))
            elif ext == ".csv":
                t = load_bit([f])
                d = [x["d"] for x in t]
                row.update(kind="bit", label="bit", rows=len(t), period=[min(d), max(d)] if d else None)
            elif ext == ".pdf" and any(ISR_HDR.search(l) for l in pdf_lines(f)):
                t, tot = load_isracard([f])
                charges = sorted({x["d"] for x in t})
                row.update(kind="card", label="ישראכרט: דף פירוט חודשי", rows=len(t), period=[min(x["td"] for x in t), max(charges)],
                           detail=f"כרטיס {t[0]['card']} · חיוב {', '.join(dmy for dmy in charges)} · סה״כ {sum(v for _, v in tot):,.2f}")
            elif ext == ".pdf":
                sl = load_payslips([f])
                if sl:
                    row.update(kind="slip", label="תלוש פנסיה", rows=1, period=[sl[0]["month"] + "-01", sl[0]["month"] + "-28"],
                               detail=f"חודש {sl[0]['month']}, נטו {sl[0]['net']:,.2f}")
                else:
                    row.update(kind="unknown", label="PDF שלא זוהה כתלוש", rows=0, period=None)
            else:
                row.update(kind="unknown", label="קובץ שלא נקרא", rows=0, period=None)
        except Exception as e:  # a broken file should show up in the list, not stop the build
            row.update(kind="error", label="שגיאה בקריאה", rows=0, period=None, detail=str(e)[:120])
        out.append(row)
    return out


def main():
    cfg = json.loads((PRIV / "config.json").read_text(encoding="utf-8"))
    files = sorted(RAW.glob("*"))
    bank, balance = load_bank([f for f in files if f.suffix.lower() == ".xls"])
    cards = load_cards([f for f in files if f.suffix.lower() == ".xlsx"])
    for c in cards:
        c["issuer"] = "max"
    isr, isr_totals = load_isracard([f for f in files if f.suffix.lower() == ".pdf"])
    bit = load_bit([f for f in files if f.suffix.lower() == ".csv"])
    slips = load_payslips([f for f in files if f.suffix.lower() == ".pdf"])
    if not bank:
        sys.exit("No bank export (.xls) found in finance/private/raw/")

    b_from, b_to = bank[0]["d"], bank[-1]["d"]
    # each issuer's bank charge is replaced by its itemized purchases, where the export covers that date
    coverage = {k: (min((c["d"] for c in v), default="9999"), max((c["d"] for c in v), default="0000"))
                for k, v in (("max", cards), ("isracard", isr))}
    fallback = {"max": "כרטיס מקס (ללא פירוט)", "isracard": "ישראכרט (קניות הילדים)"}
    c_from, c_to = coverage["max"]

    ledger, unknown = [], set(cfg["categories"])
    for t in bank:
        direction = "in" if t["inn"] > 0 else "out"
        cat = first_match(cfg["bank_rules"], text=t["desc"], dir=direction)
        if cat == "@card":
            issuer = "isracard" if "ישראכרט" in t["desc"] else "max"
            lo, hi = coverage[issuer]
            if lo <= t["d"] <= hi:
                continue  # detailed in the card export instead
            cat = fallback[issuer]
        ledger.append(dict(d=t["d"], src="bank", desc=t["desc"], cat=cat, amt=round(t["inn"] - t["out"], 2)))
    # sanity check: each Isracard statement total should equal the bank charge of that date
    bank_isr = {t["d"]: t["out"] for t in bank if "ישראכרט" in t["desc"]}
    for d, v in isr_totals:
        if d in bank_isr and abs(bank_isr[d] - v) > 0.01:
            print(f"NOTE: Isracard statement {d} totals {v:,.2f} but the bank charged {bank_isr[d]:,.2f}")
    for c in cards + isr:
        if not (b_from <= c["d"]):
            continue
        cat = first_match(cfg["card_rules"], text=c["m"] + (" USA" if c["cur"] not in ("", "₪") else ""),
                          mcat=c["mcat"], card=c["card"])
        ledger.append(dict(d=c["d"], td=c["td"], src="card", desc=c["m"], cat=cat, amt=-c["a"],
                           card=c["card"], note=c["note"], kind=c["kind"], issuer=c["issuer"]))
    # categories of kind "ignore" (e.g. a card used only for someone else's apartment) never reach the app
    ignored = {c for c, v in cfg["categories"].items() if v.get("kind") == "ignore"}
    dropped = sum(1 for x in ledger if x["cat"] in ignored)
    ledger = [x for x in ledger if x["cat"] not in ignored]
    if dropped:
        print(f"ignored {dropped} transactions ({', '.join(sorted(ignored))})")
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
        counts=dict(bank=len(bank), card=len(cards) + len(isr), bit=len(bit), slips=len(slips)),
        sources=describe_sources(files),
        ledger=ledger, balance=balance, bit=bit, slips=slips,
        config={k: cfg[k] for k in ("title", "household", "categories", "forecast", "fixed_commitments",
                                    "insights", "learned", "questions", "pension", "cards", "manual_sources", "missing_sources", "summary") if k in cfg},
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
