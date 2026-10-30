// The "מסמכים" tab: upload documents, keep every version, and merge only what changed.
//
// Storage (Firestore only, like the ZIV project): metadata in files/{id}, the content as base64
// pieces in fileChunks/{id}_{i}. Nothing personal is in this file or anywhere in the repo.
//
// Every upload is checked in three steps:
//   1. Same bytes (SHA-256) as a document already here -> reported as a duplicate, not stored.
//   2. Same document key (type + period, e.g. "bank:2026-04-18", "isracard:<card>:2026-10-02",
//      "slip:2026-09") as an existing document -> stored as its newer version; the older one stays
//      in the list as a previous version.
//   3. Bank (.xls), Max (.xlsx) and bit (.csv) exports are read here, the same way
//      scripts/build.py reads them, and compared with the transactions already in finance/data:
//      only new and changed rows are merged, after a confirmation that lists them.
//      PDFs (Isracard statements, payslips) are stored and read at the next build.py run.
//   4. A portfolio report ("ניתוח תיק"), even a scan, is read by reader.js: only balances that
//      changed are updated in the investments tab, after a confirmation.
import { collection, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, serverTimestamp }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { readPdf, allLines, parsePortfolio, sameNumber } from "./reader.js?v=31";

const CHUNK = 700000;               // base64 characters per Firestore document (limit ~1MB)
const MAX_FILE = 15 * 1024 * 1024;
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const ils = n => "₪" + Math.round(Math.abs(n)).toLocaleString("he-IL");
const dmy = iso => (iso ? iso.slice(8, 10) + "." + iso.slice(5, 7) + "." + iso.slice(2, 4) : "");
const clean = s => String(s ?? "").replace(/[‪-‮‎‏]/g, "").replace(/\s+/g, " ").trim();
const round2 = n => Math.round(n * 100) / 100;

let db, ctx, files = [];

export function initDocs(firestore, context) {
  db = firestore;
  ctx = context;   // { email, isOwner, getData, saveData }
  $("#docUpload").onchange = ev => {
    const list = [...ev.target.files];
    ev.target.value = "";
    if (list.length) upload(list).catch(e => { alert("ההעלאה נכשלה: " + (e.code || e.message)); progress(""); });
  };
  $("#docTbl").onclick = ev => {
    const del = ev.target.closest("[data-del]");
    if (del) return removeFile(files.find(f => f.id === del.dataset.del));
    const row = ev.target.closest("tr[data-file]");
    if (row) openFile(files.find(f => f.id === row.dataset.file));
  };
  $("#docClose").onclick = () => $("#docDlg").close();
  loadList();
}

const progress = t => { $("#docProg").textContent = t; };

async function loadList() {
  try {
    const snap = await getDocs(collection(db, "files"));
    files = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (e) {
    files = [];
    $("#docTbl").innerHTML = `<tbody><tr><td class="small">לא הצלחתי לטעון את המסמכים: ${esc(e.code || e.message)}</td></tr></tbody>`;
    return;
  }
  render();
}

const STATUS = { merged: "עודכן בנתונים", same: "בלי שינויים", pending: "ייקלט בבנייה הבאה", stored: "נשמר" };

// The monthly checklist: what to upload at the start of each month, ticked by what is already here.
// A bill counts once it covers this month: the bank export must reach into it, the Isracard
// statement must be charged in it, the payslip must be last month's or this month's.
function checklist(now = new Date()) {
  const ym = d => d.toISOString().slice(0, 7);
  const month = ym(new Date(Date.UTC(now.getFullYear(), now.getMonth(), 15)));
  const prev = ym(new Date(Date.UTC(now.getFullYear(), now.getMonth() - 1, 15)));
  const uploaded = f => f.uploadedAt?.toDate ? ym(f.uploadedAt.toDate()) === month : false;
  const ofKind = k => files.filter(f => f.kind === k);
  return [
    { name: "בנק: תנועות עו״ש (xls)", hint: "מההעלאה הקודמת עד היום", done: ofKind("bank").some(f => f.period?.[1] >= month + "-01") },
    { name: "מקס: עסקאות של כל הכרטיסים (xlsx)", hint: "כולל חיובים עתידיים", done: ofKind("max").some(uploaded) },
    { name: "ישראכרט: דף פירוט חודשי (PDF)", hint: "החיוב של החודש", done: ofKind("isracard").some(f => f.period?.[0]?.startsWith(month)) },
    { name: "bit: היסטוריית פעולות (csv)", hint: "", done: ofKind("bit").some(uploaded) },
    { name: "תלוש פנסיה (PDF)", hint: "של החודש שעבר", done: ofKind("slip").some(f => f.key === "slip:" + prev || f.key === "slip:" + month) },
  ];
}
function drawChecklist() {
  const items = checklist(), left = items.filter(x => !x.done).length;
  const label = new Date().toLocaleDateString("he-IL", { month: "long", year: "numeric" });
  const pending = files.filter(f => f.status === "pending" && f.current !== false).length;
  const others = (ctx.getData()?.config?.missing_sources || []);
  $("#docCheck").innerHTML = `<h3 style="margin:0 0 4px">צ׳ק ליסט לתחילת ${esc(label)}</h3>
    <p class="small" style="margin:0 0 10px">${left ? `נשארו ${left} מתוך ${items.length}. הזמן הכי טוב: בין ה-3 ל-5 בחודש.` : "הכול הועלה החודש ✓"}</p>
    <ul class="chk-list">${items.map(x => `<li class="${x.done ? "done" : ""}"><span class="chk-box">${x.done ? "✓" : ""}</span><span>${esc(x.name)}${x.hint ? ` <span class="small">· ${esc(x.hint)}</span>` : ""}</span></li>`).join("")}</ul>
    ${pending ? `<p class="small" style="margin:10px 0 0">⏳ ${pending} מסמכים מחכים לבנייה במחשב: node scripts/pull_docs.js ואז python scripts/build.py, ואחר כך ״רענון״.</p>` : ""}
    ${others.length ? `<details style="margin-top:10px"><summary class="small" style="cursor:pointer">להעלות רק כשיש שינוי או כשזה מגיע (${others.length})</summary>
      <ul class="chk-others">${others.map(m => `<li>${esc(m.name)}${m.why ? ` <span class="small">· ${esc(m.why)}</span>` : ""}</li>`).join("")}</ul></details>` : ""}`;
}

function render() {
  drawChecklist();
  const when = f => f.uploadedAt?.toDate ? f.uploadedAt.toDate() : new Date(0);
  const byKey = {};
  files.forEach(f => (byKey[f.key] = byKey[f.key] || []).push(f));
  const groups = Object.values(byKey).map(g => g.sort((a, b) => when(b) - when(a)))
    .sort((a, b) => when(b[0]) - when(a[0]));
  if (!groups.length) {
    $("#docTbl").innerHTML = '<tbody><tr><td class="small">עוד אין מסמכים. אפשר להעלות ייצוא מהבנק (xls), ממקס (xlsx), מ-bit (csv), דפי ישראכרט, תלושים וכל מסמך אחר.</td></tr></tbody>';
    return;
  }
  const row = (f, older) => `<tr data-file="${f.id}" class="click" style="cursor:pointer${older ? ";opacity:.6" : ""}">
    <td>${older ? "↳ " : ""}${icon(f.name)} ${esc(f.name)}${older ? ' <span class="small">(גרסה קודמת)</span>' : ""}</td>
    <td class="small">${esc(f.label || "")}</td>
    <td class="small hide-sm">${f.period ? `${dmy(f.period[0])}–${dmy(f.period[1])}` : ""}</td>
    <td class="small hide-sm">${esc(STATUS[f.status] || "")}${f.summary ? `<div>${esc(f.summary)}</div>` : ""}</td>
    <td class="small">${when(f).toLocaleDateString("he-IL")}</td>
    <td>${ctx.isOwner ? `<button type="button" class="sm" data-del="${f.id}" title="מחיקה" aria-label="מחיקת ${esc(f.name)}">✕</button>` : ""}</td></tr>`;
  $("#docTbl").innerHTML = '<thead><tr><th>מסמך</th><th>סוג</th><th class="hide-sm">תקופה</th><th class="hide-sm">מה נעשה</th><th>הועלה</th><th></th></tr></thead><tbody>' +
    groups.map(g => row(g[0], false) + g.slice(1).map(f => row(f, true)).join("")).join("") + "</tbody>";
}
const icon = name => /\.pdf$/i.test(name) ? "📕" : /\.(xlsx?|csv)$/i.test(name) ? "📗" : /\.(jpe?g|png|webp|heic)$/i.test(name) ? "🖼️" : "📄";

// ---------- libraries, loaded only when needed
const loadScript = src => new Promise((res, rej) => {
  if (document.querySelector(`script[src="${src}"]`)) return res();
  const s = document.createElement("script");
  s.src = src; s.onload = res; s.onerror = () => rej(new Error("טעינת ספרייה נכשלה: " + src));
  document.head.appendChild(s);
});
const XLSX_SRC = "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";

// ---------- reading the exports (mirrors scripts/build.py)
const excelDate = v => {
  if (typeof v === "number") return new Date(Math.round((v - 25569) * 864e5)).toISOString().slice(0, 10);
  if (v instanceof Date) return new Date(v.getTime() - v.getTimezoneOffset() * 6e4).toISOString().slice(0, 10);
  const m = clean(v).match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})/);
  return m ? `${m[3].length === 2 ? "20" + m[3] : m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}` : "";
};
const sheetRows = (wb, i) => window.XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[i]], { header: 1, raw: true, defval: null });

// Yahav current account (.xls): newest first; each row carries the balance after it.
function readBank(wb) {
  const rows = sheetRows(wb, 0);
  const head = rows.slice(0, 20).findIndex(r => r && r.map(clean).includes("תיאור פעולה"));
  if (head < 0) return null;
  const tx = [];
  for (const v of rows.slice(head + 1)) {
    if (!v || typeof v[0] !== "number") continue;
    tx.push({ d: excelDate(v[0]), ref: clean(v[2]), desc: clean(v[3]), out: +v[4] || 0, inn: +v[5] || 0, bal: +v[6] || 0 });
  }
  return tx.length ? tx : null;
}
// Max (.xlsx): one sheet per card group, header row with "שם בית העסק".
function readMax(wb) {
  const out = [];
  wb.SheetNames.forEach((_, i) => {
    const rows = sheetRows(wb, i);
    const head = rows.slice(0, 15).findIndex(r => r && r.map(clean).includes("שם בית העסק"));
    if (head < 0) return;
    const H = rows[head].map(clean), col = n => H.indexOf(n);
    const cur = col("מטבע עסקה מקורי") >= 0 ? col("מטבע עסקה מקורי") : col("מטבע חיוב");
    for (const r of rows.slice(head + 1)) {
      if (!r || r[col("סכום חיוב")] == null || !r[col("תאריך עסקה")]) continue;
      out.push({ td: excelDate(r[col("תאריך עסקה")]), d: excelDate(r[col("תאריך חיוב")]), m: clean(r[col("שם בית העסק")]),
        mcat: clean(r[col("קטגוריה")]), card: clean(r[col("4 ספרות אחרונות של כרטיס האשראי")]), kind: clean(r[col("סוג עסקה")]),
        a: +r[col("סכום חיוב")], cur: clean(r[cur]), note: clean(r[col("הערות")]) });
    }
  });
  return out.length ? out : null;
}
// bit history (.csv)
function readBit(text) {
  const out = [];
  for (const r of parseCsv(text.replace(/^﻿/, ""))) {
    if (r.length >= 9 && clean(r[1]) === "בוצע") {
      const d = clean(r[8]);
      out.push({ d: `20${d.slice(6, 8)}-${d.slice(3, 5)}-${d.slice(0, 2)}`, desc: clean(r[2]), a: +r[4],
        pay: clean(r[5]), dir: clean(r[6]) === "זיכוי" ? "in" : "out", who: clean(r[7]) });
    }
  }
  // a row exported twice counts once (as in build.py)
  const uniq = [...new Map(out.map(x => [JSON.stringify(x), x])).values()];
  return uniq.length ? uniq : null;
}
function parseCsv(text) {
  const rows = []; let row = [], f = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(f); f = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(f); rows.push(row); row = []; f = ""; }
    else f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows;
}

// What a document is, and the key that ties its versions together.
async function classify(file, bytes) {
  const name = file.name, ext = (name.split(".").pop() || "").toLowerCase();
  const span = ds => { const s = ds.filter(Boolean).sort(); return s.length ? [s[0], s[s.length - 1]] : null; };
  if (ext === "xls" || ext === "xlsx") {
    await loadScript(XLSX_SRC);
    const wb = window.XLSX.read(bytes, { type: "array" });
    const bank = readBank(wb);
    if (bank) { const p = span(bank.map(t => t.d)); return { kind: "bank", label: "בנק: תנועות עו״ש", key: "bank:" + p[0], period: p, bank }; }
    const max = readMax(wb);
    if (max) { const p = span(max.map(t => t.d)); return { kind: "max", label: "מקס: עסקאות אשראי", key: "max:" + p[0].slice(0, 7), period: p, max }; }
  }
  if (ext === "csv") {
    const bit = readBit(new TextDecoder().decode(bytes));
    if (bit) { const p = span(bit.map(t => t.d)); return { kind: "bit", label: "bit", key: "bit:" + p[0].slice(0, 4), period: p, bit }; }
  }
  if (ext === "pdf") {
    let t = "", first = null;
    try { first = await readPdf(bytes, { pages: 2, ocr: false }); t = allLines(first).join("\n"); }
    catch { /* unreadable PDF: stored by name */ }
    // No text layer: a scan. A portfolio report has its figures on pages 3-4.
    if (first && !t.trim()) {
      const scan = await readPdf(bytes, { from: Math.min(3, Math.max(1, first.numPages - 1)), pages: 2, onProgress: progress });
      const pf = parsePortfolio(scan);
      if (pf?.plans.length) {
        const who = personOf(pf.person + " " + name);
        return { kind: "portfolio", label: `ניתוח תיק${who ? ": " + who.name : ""}`, key: "portfolio:" + (who?.key || pf.person || name), period: null, portfolio: pf, who };
      }
    }
    // pdf.js gives the words in logical order ("פרוט פעולותיך לתאריך: 02/03/26"); the payslip's
    // words come in reverse order ("2026 ינואר לחודש שכר תלוש").
    if (/ישראכרט|isracard/i.test(t) && /פי?רוט פעולותיך/.test(t)) {
      const card = (t.match(/שמסתיים בספרות:?\s*(\d{4})/) || [])[1] || "";
      const raw = (t.match(/פי?רוט פעולותיך לתאריך:?\s*(\d\d\/\d\d\/\d\d)/) || [])[1];
      const date = raw ? `20${raw.slice(6, 8)}-${raw.slice(3, 5)}-${raw.slice(0, 2)}` : "";
      return { kind: "isracard", label: `ישראכרט${card ? " " + card : ""}: דף פירוט`, key: `isracard:${card}:${date || name}`, period: date ? [date, date] : null };
    }
    const MONTHS = ["ינואר", "פברואר", "מרץ", "אפריל", "מאי", "יוני", "יולי", "אוגוסט", "ספטמבר", "אוקטובר", "נובמבר", "דצמבר"];
    const a = t.match(/(\d{4})\s+(\S+)\s+לחודש/), b = t.match(/לחודש\s+(\S+)\s+(\d{4})/);
    const [year, mon] = a ? [a[1], a[2]] : b ? [b[2], b[1]] : [];
    if (/תלוש/.test(t) && year) {
      if (MONTHS.includes(mon)) {
        const month = `${year}-${String(MONTHS.indexOf(mon) + 1).padStart(2, "0")}`;
        return { kind: "slip", label: "תלוש פנסיה", key: "slip:" + month, period: [month + "-01", month + "-28"] };
      }
    }
  }
  return { kind: "other", label: "מסמך", key: "file:" + name.toLowerCase(), period: null };
}

// Which person a portfolio report belongs to, by the names in the investments config.
function personOf(text) {
  const P = ctx.getData()?.config?.investments?.people || {};
  const key = Object.keys(P).find(k => text.includes(P[k].match));
  return key ? { key, name: P[key].name } : null;
}

// Compares a report with the plans already known: only different balances count (a shekel either
// way is rounding). Plans with the same number can exist, so each is matched once, closest first.
function planPortfolio(pf, who) {
  const I = ctx.getData().config.investments, cur = ctx.getInvest()[who.key] || {}, bal = cur.balances || {};
  const pool = I.people[who.key].plans.map(p => { const k = p.no + "|" + p.company; return { p, k, balance: k in bal ? bal[k] : p.balance, used: false }; });
  const out = { changed: [], added: [], same: 0 };
  for (const r of pf.plans.filter(x => x.balance != null)) {
    const cands = pool.filter(x => !x.used && sameNumber(x.p.no, r.no)).sort((a, b) => Math.abs(a.balance - r.balance) - Math.abs(b.balance - r.balance));
    const m = cands[0];
    if (!m) { out.added.push(r); continue; }
    m.used = true;
    if (Math.abs(m.balance - r.balance) <= 1) out.same++;
    else out.changed.push({ k: m.k, name: `${m.p.company} ${m.p.name}`, before: m.balance, after: r.balance });
  }
  return out;
}
function portfolioText(name, pf, p) {
  const out = [`מהדוח ${name}:`];
  if (p.changed.length) out.push("", `${p.changed.length} יתרות השתנו:`, ...p.changed.map(c => `• ${c.name}: ${ils(c.before)} ← ${ils(c.after)}`));
  if (p.added.length) out.push("", `${p.added.length} תוכניות חדשות:`, ...p.added.map(a => `• ${a.no}: ${ils(a.balance)}`));
  out.push("", pf.exact ? `הקריאה נבדקה: סכום השורות שווה לסה״כ בדוח (${ils(pf.total)}).`
    : pf.total ? `שימו לב: סכום השורות (${ils(pf.sum)}) שונה מהסה״כ בדוח (${ils(pf.total)}). כדאי לבדוק מול הדוח.`
    : `לא מצאתי בדוח סה״כ לבדיקה. סכום השורות: ${ils(pf.sum)}.`);
  out.push("", `${p.same} תוכניות זהות לא ישתנו. לעדכן?`);
  return out.join("\n");
}

// ---------- turning rows into ledger entries (same rules as build.py)
function firstMatch(rules, f) {
  for (const r of rules || []) {
    if ("dir" in r && r.dir !== f.dir) continue;
    if ("card" in r && r.card !== f.card) continue;
    if ("mcat" in r && !new RegExp(r.mcat).test(f.mcat || "")) continue;
    if ("match" in r && !new RegExp(r.match).test(f.text || "")) continue;
    return r.cat;
  }
  return null;
}
// Without rules in the data (older data.json), reuse the category the same description already has.
function learnedCat(ledger, src, desc) {
  const n = {};
  ledger.forEach(x => { if (x.src === src && x.desc === desc) n[x.cat] = (n[x.cat] || 0) + 1; });
  return Object.keys(n).sort((a, b) => n[b] - n[a])[0] || "שונות";
}
const FALLBACK = { max: "כרטיס מקס (ללא פירוט)", isracard: "ישראכרט (קניות הילדים)" };

function bankEntries(data, bank) {
  const C = data.config, L = data.ledger;
  const cover = issuer => { const ds = L.filter(x => x.src === "card" && (x.issuer || "max") === issuer).map(x => x.d).sort(); return ds.length ? [ds[0], ds[ds.length - 1]] : ["9999", "0000"]; };
  const out = [];
  // the same row exported twice in one file counts once (like build.py's key)
  const seen = new Set();
  for (const t of bank) {
    const k = [t.d, t.ref, t.out, t.inn, t.desc].join("|");
    if (seen.has(k)) continue;
    seen.add(k);
    const dir = t.inn > 0 ? "in" : "out";
    let cat = firstMatch(C.bank_rules, { text: t.desc, dir }) ?? learnedCat(L, "bank", t.desc);
    if (cat === "@card") {
      const issuer = /ישראכרט/.test(t.desc) ? "isracard" : "max";
      const [lo, hi] = cover(issuer);
      if (lo <= t.d && t.d <= hi) continue;   // itemized in the card export instead
      cat = FALLBACK[issuer];
    }
    out.push({ d: t.d, src: "bank", desc: t.desc, cat, amt: round2(t.inn - t.out) });
  }
  return out;
}
function maxEntries(data, max) {
  const C = data.config, L = data.ledger, from = data.coverage?.bank?.[0] || "0000";
  return max.filter(c => c.d >= from).map(c => ({
    d: c.d, td: c.td, src: "card", desc: c.m,
    cat: firstMatch(C.card_rules, { text: c.m + (c.cur && c.cur !== "₪" ? " USA" : ""), mcat: c.mcat, card: c.card }) ?? learnedCat(L, "card", c.m),
    amt: -c.a, card: c.card, note: c.note, kind: c.kind, issuer: "max" }));
}

// Categories of kind "ignore" (e.g. a card that belongs to someone else) never reach the data.
const notIgnored = (data, entries) => {
  const ignored = new Set(Object.entries(data.config.categories || {}).filter(([, v]) => v.kind === "ignore").map(([k]) => k));
  return entries.filter(e => !ignored.has(e.cat));
};

// Each new row is matched to one existing row (each existing row matches once):
//   same date, amount and text -> identical; same date and amount, other text -> changed;
//   no match -> new. Rows that exist only on the site are kept.
function plan(existing, incoming, ident, loose, fields) {
  const pool = existing.map((x, i) => ({ x, i, used: false }));
  const take = pred => { const m = pool.find(p => !p.used && pred(p.x)); if (m) m.used = true; return m; };
  const out = { add: [], update: [], same: 0 };
  for (const n of incoming) {
    if (take(x => ident(x) === ident(n))) { out.same++; continue; }
    const m = take(x => loose(x) === loose(n));
    if (!m) { out.add.push(n); continue; }
    const ch = {};
    fields.forEach(f => { if ((m.x[f] ?? "") !== (n[f] ?? "")) ch[f] = n[f]; });
    if (Object.keys(ch).length) out.update.push({ i: m.i, before: m.x, ch }); else out.same++;
  }
  return out;
}

function mergeLedger(data, entries, kind) {
  const L = data.ledger;
  const lo = entries.reduce((a, e) => e.d < a ? e.d : a, "9999"), hi = entries.reduce((a, e) => e.d > a ? e.d : a, "0000");
  const src = kind === "bank" ? "bank" : "card";
  const inRange = x => x.src === src && x.d >= lo && x.d <= hi && (src === "bank" || (x.issuer || "max") === "max");
  const idx = L.map((x, i) => i).filter(i => inRange(L[i]));
  const ident = x => [x.d, x.td || "", x.desc, x.amt, x.card || "", x.note || ""].join("|");
  const loose = x => [x.d, x.td || "", x.amt, x.card || ""].join("|");
  const p = plan(idx.map(i => L[i]), entries, ident, loose, ["desc", "note", "kind"]);
  p.update.forEach(u => { u.i = idx[u.i]; });
  return p;
}

function mergeBit(data, items) {
  const ident = x => [x.d, x.desc, x.a, x.dir, x.who].join("|");
  const loose = x => [x.d, x.a, x.dir].join("|");
  return plan(data.bit || [], items, ident, loose, ["desc", "who", "pay"]);
}

const line = e => `• ${dmy(e.d)} · ${ils(e.amt ?? e.a)} · ${String(e.desc).slice(0, 45)}`;
function summaryText(name, p) {
  const out = [`מהקובץ ${name}:`];
  if (p.add.length) out.push("", `${p.add.length} תנועות חדשות:`, ...p.add.slice(0, 8).map(line), p.add.length > 8 ? `…ועוד ${p.add.length - 8}` : "");
  if (p.update.length) out.push("", `${p.update.length} תנועות שהשתנו:`, ...p.update.slice(0, 8).map(u => line({ ...u.before, ...u.ch })), p.update.length > 8 ? `…ועוד ${p.update.length - 8}` : "");
  out.push("", `${p.same} תנועות זהות לא ישתנו, ותנועות שכבר באתר יישארו. לעדכן?`);
  return out.filter((l, i, a) => l !== "" || a[i - 1] !== "").join("\n");
}

// Applies a confirmed plan to a copy of the data and saves it to finance/data.
async function applyPlan(info, p) {
  const data = structuredClone(ctx.getData());
  if (info.kind === "bit") {
    data.bit = (data.bit || []).slice();
    p.update.forEach(u => Object.assign(data.bit[u.i], u.ch));
    data.bit.push(...p.add);
    data.bit.sort((a, b) => a.d.localeCompare(b.d));
    if (data.bit.length) data.coverage.bit = [data.bit[0].d, data.bit[data.bit.length - 1].d];
    data.counts.bit = data.bit.length;
  } else {
    p.update.forEach(u => Object.assign(data.ledger[u.i], u.ch));
    data.ledger.push(...p.add);
    if (info.kind === "max" && p.add.length) {
      // the bank's lump Max charge is now itemized: drop its placeholder rows in the new range
      const ds = data.ledger.filter(x => x.src === "card" && (x.issuer || "max") === "max").map(x => x.d).sort();
      data.ledger = data.ledger.filter(x => !(x.src === "bank" && x.cat === FALLBACK.max && x.d >= ds[0] && x.d <= ds[ds.length - 1]));
      data.coverage.card = [ds[0], ds[ds.length - 1]];
    }
    if (info.kind === "bank") updateBalance(data, info.bank);
    const ignored = new Set(Object.entries(data.config.categories || {}).filter(([, v]) => v.kind === "ignore").map(([k]) => k));
    data.ledger = data.ledger.filter(x => !ignored.has(x.cat)).sort((a, b) => a.d.localeCompare(b.d));
    const b = data.ledger.filter(x => x.src === "bank").map(x => x.d);
    if (b.length) data.coverage.bank = [b[0], b[b.length - 1]];
    data.counts.bank = data.ledger.filter(x => x.src === "bank").length;
    data.counts.card = data.ledger.filter(x => x.src === "card").length;
  }
  data.docsMerged = new Date().toISOString();
  await ctx.saveData(data);
}
// End-of-day balances: the first row of each day in the export (newest first) closes that day.
function updateBalance(data, bank) {
  const eod = Object.fromEntries((data.balance || []).map(([d, v]) => [d, v]));
  const seen = new Set();
  for (const t of bank) if (!seen.has(t.d)) { seen.add(t.d); eod[t.d] = round2(t.bal); }
  const days = Object.keys(eod).sort();
  const out = [];
  let cur = eod[days[0]];
  for (let d = new Date(days[0] + "T12:00:00Z"), end = new Date(days[days.length - 1] + "T12:00:00Z"); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const k = d.toISOString().slice(0, 10);
    if (k in eod) cur = eod[k];
    out.push([k, cur]);
  }
  data.balance = out;
}

// ---------- upload
async function sha256(bytes) {
  const h = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, "0")).join("");
}
const toB64 = bytes => { let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };

async function upload(list) {
  const report = [];
  for (const [n, file] of list.entries()) {
    progress(`בודק ${n + 1}/${list.length}: ${file.name}…`);
    if (file.size > MAX_FILE) { report.push(`${file.name}: גדול מ-15MB, לא הועלה.`); continue; }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const sha = await sha256(bytes);
    const dup = files.find(f => f.sha === sha);
    if (dup) { report.push(`${file.name}: כבר קיים (${dup.name}). לא הועלה שוב.`); continue; }
    const info = await classify(file, bytes);
    const prev = files.filter(f => f.key === info.key && f.current);
    let status = "stored", summary = "";
    if (info.bank || info.max || info.bit) {
      const data = ctx.getData();
      if (!data) { report.push(`${file.name}: אין נתונים באתר להשוואה.`); continue; }
      // Without the rules the bank's card charges can't be told apart and would be counted twice.
      if (!info.bit && !data.config.bank_rules) {
        report.push(`${file.name}: הנתונים באתר נבנו לפני שהמסמכים נתמכו. לחצו ״רענון״ (או העלו את data.json החדש) ונסו שוב.`);
        continue;
      }
      const p = info.bit ? mergeBit(data, info.bit)
        : mergeLedger(data, notIgnored(data, info.bank ? bankEntries(data, info.bank) : maxEntries(data, info.max)), info.kind);
      if (!p.add.length && !p.update.length) {
        status = "same"; summary = `${p.same} תנועות, כולן כבר באתר`;
      } else if (confirm(summaryText(file.name, p))) {
        progress(`מעדכן את הנתונים מ-${file.name}…`);
        await applyPlan(info, p);
        status = "merged"; summary = `${p.add.length} חדשות, ${p.update.length} עודכנו, ${p.same} זהות`;
      } else {
        report.push(`${file.name}: העדכון בוטל, הקובץ לא נשמר.`);
        continue;
      }
    } else if (info.portfolio && info.who) {
      const p = planPortfolio(info.portfolio, info.who);
      if (!p.changed.length && !p.added.length) {
        status = "same"; summary = `${p.same} תוכניות, בלי שינוי`;
      } else if (confirm(portfolioText(file.name, info.portfolio, p))) {
        const all = ctx.getInvest(), cur = all[info.who.key] || {};
        await ctx.saveInvest({ ...all, [info.who.key]: { asOf: new Date().toISOString().slice(0, 10),
          balances: { ...(cur.balances || {}), ...Object.fromEntries(p.changed.map(c => [c.k, c.after])) },
          added: [...(cur.added || []), ...p.added.map(a => ({ no: a.no, type: a.section, balance: a.balance }))] } });
        status = "merged"; summary = `${p.changed.length} יתרות עודכנו, ${p.added.length} חדשות, ${p.same} זהות`;
      } else {
        report.push(`${file.name}: העדכון בוטל, הקובץ לא נשמר.`);
        continue;
      }
    } else if (info.kind === "isracard" || info.kind === "slip") {
      status = "pending";
    }
    progress(`שומר את ${file.name}…`);
    const id = await store(file, bytes, sha, info, status, summary);
    // a newer version of the same document: the older one stays, marked as previous
    for (const f of prev) await updateDoc(doc(db, "files", f.id), { current: false }).catch(() => {});
    files = files.map(f => prev.some(p => p.id === f.id) ? { ...f, current: false } : f);
    files.push({ id, name: file.name, size: file.size, sha, key: info.key, kind: info.kind, label: info.label, period: info.period,
      status, summary, current: true, uploadedAt: { toDate: () => new Date() } });
    report.push(`${file.name}: ${prev.length ? "גרסה חדשה של מסמך קיים" : "נשמר"}${summary ? " · " + summary : ""}${status === "pending" ? " · ייקלט בבנייה הבאה" : ""}.`);
    render();
  }
  progress("");
  render();
  if (report.length) alert(report.join("\n"));
}

async function store(file, bytes, sha, info, status, summary) {
  const id = doc(collection(db, "files")).id;
  const b64 = toB64(bytes);
  const chunks = Math.max(1, Math.ceil(b64.length / CHUNK));
  for (let i = 0; i < chunks; i++) {
    await setDoc(doc(db, "fileChunks", `${id}_${i}`), { fileId: id, i, data: b64.slice(i * CHUNK, (i + 1) * CHUNK) });
  }
  // metadata last, so a document only shows once all its pieces are saved
  await setDoc(doc(db, "files", id), { name: file.name, type: file.type || "", size: file.size, chunks, sha,
    key: info.key, kind: info.kind, label: info.label, period: info.period, status, summary, current: true,
    uploadedAt: serverTimestamp(), uploadedBy: ctx.email });
  return id;
}

// ---------- open / download / delete
const guessType = name => ({ pdf: "application/pdf", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", csv: "text/csv" })[(name.split(".").pop() || "").toLowerCase()] || "application/octet-stream";
let viewUrl = null;
async function openFile(f) {
  if (!f) return;
  const dlg = $("#docDlg");
  $("#docTitle").textContent = f.name;
  $("#docBody").innerHTML = '<p class="small">טוען…</p>';
  dlg.showModal();
  try {
    let b64 = "";
    for (let i = 0; i < f.chunks; i++) b64 += (await getDoc(doc(db, "fileChunks", `${f.id}_${i}`))).data()?.data || "";
    const bin = atob(b64), bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const blob = new Blob([bytes], { type: f.type || guessType(f.name) });
    if (viewUrl) URL.revokeObjectURL(viewUrl);
    viewUrl = URL.createObjectURL(blob);
    $("#docDownload").href = viewUrl;
    $("#docDownload").download = f.name;
    $("#docBody").innerHTML = /pdf/.test(blob.type) ? `<iframe src="${viewUrl}" title="${esc(f.name)}" style="width:100%;height:70vh;border:0;border-radius:10px;background:#fff"></iframe>`
      : /^image\//.test(blob.type) ? `<img src="${viewUrl}" alt="${esc(f.name)}" style="max-width:100%">`
      : '<p class="small">אי אפשר להציג את הקובץ הזה בדפדפן. לחצו ״הורדה״ כדי לפתוח אותו.</p>';
  } catch (e) {
    $("#docBody").innerHTML = `<p class="small">לא הצלחתי לפתוח את המסמך: ${esc(e.code || e.message)}</p>`;
  }
}
async function removeFile(f) {
  if (!f || !confirm(`למחוק את "${f.name}"? הנתונים שכבר נקלטו ממנו נשארים.`)) return;
  await deleteDoc(doc(db, "files", f.id));
  for (let i = 0; i < f.chunks; i++) await deleteDoc(doc(db, "fileChunks", `${f.id}_${i}`)).catch(() => {});
  files = files.filter(x => x.id !== f.id);
  render();
}

// For local tests of reading and merging (no Firestore involved).
export const _internal = { classify, bankEntries, maxEntries, mergeLedger, mergeBit, applyPlan, notIgnored, sha256, checklist, drawChecklist, planPortfolio, portfolioText, setContext: c => { ctx = c; }, setFiles: f => { files = f; } };
