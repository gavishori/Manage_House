// Reads a document in the browser and gives back clean lines of text. Nothing is sent anywhere
// except the two libraries' public files, and it needs nothing from this app, so the file can be
// copied as is to another project (no Firebase, no app state).
//
//   const doc = await readPdf(bytes, { pages: 6, onProgress: t => ... });
//   doc.pages -> [{ n, source: "text" | "ocr", lines: ["...", ...] }]
//
// A PDF with a text layer is read directly: its pieces are put back into lines by their position
// on the page, right to left. A scanned page has no text layer, so it is drawn at high resolution
// and read by OCR (Tesseract, Hebrew + English).
const PDFJS = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/";
const TESSERACT = "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js";
const MIN_TEXT = 20;      // fewer characters than this on a page means it is a scan
const OCR_SCALE = 3;      // small table text needs about 300dpi to read digits reliably

const loadScript = src => new Promise((res, rej) => {
  if (document.querySelector(`script[src="${src}"]`)) return res();
  const s = document.createElement("script");
  s.src = src; s.onload = res; s.onerror = () => rej(new Error("טעינת ספרייה נכשלה: " + src));
  document.head.appendChild(s);
});

async function pdfjs() {
  await loadScript(PDFJS + "pdf.min.js");
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS + "pdf.worker.min.js";
  return window.pdfjsLib;
}

// Pieces at about the same height form one line; within a line, right to left.
function toLines(items) {
  const rows = [];
  for (const it of items) {
    if (!it.str.trim()) continue;
    const y = it.transform[5], x = it.transform[4];
    const row = rows.find(r => Math.abs(r.y - y) <= Math.max(2, (it.height || 8) * 0.4));
    if (row) row.items.push({ x, s: it.str }); else rows.push({ y, items: [{ x, s: it.str }] });
  }
  return rows.sort((a, b) => b.y - a.y)
    .map(r => r.items.sort((a, b) => b.x - a.x).map(i => i.s.trim()).join(" ").replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

let worker = null;
async function ocrWorker(onProgress) {
  if (worker) return worker;
  await loadScript(TESSERACT);
  onProgress?.("טוען זיהוי תווים (בפעם הראשונה זה לוקח כחצי דקה)…");
  worker = await window.Tesseract.createWorker("heb+eng", 1);
  await worker.setParameters({ preserve_interword_spaces: "1", tessedit_pageseg_mode: "6" });  // a block of table-like text
  return worker;
}

// Draws the page and sharpens it: light backgrounds and colored header bars become plain white
// or black, which is what OCR reads best.
async function pageCanvas(page) {
  const vp = page.getViewport({ scale: OCR_SCALE });
  const c = document.createElement("canvas");
  c.width = vp.width; c.height = vp.height;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  // "print" draws without requestAnimationFrame, so reading goes on if the tab is in the background
  await page.render({ canvasContext: ctx, viewport: vp, intent: "print" }).promise;
  const img = ctx.getImageData(0, 0, c.width, c.height), d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const v = 0.3 * d[i] + 0.59 * d[i + 1] + 0.11 * d[i + 2] > 165 ? 255 : 0;
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

export async function readPdf(bytes, { pages = Infinity, from = 1, ocr = true, onProgress } = {}) {
  const lib = await pdfjs();
  const pdf = await lib.getDocument({ data: bytes.slice() }).promise;
  const out = [], last = Math.min(pdf.numPages, from + pages - 1);
  for (let n = from; n <= last; n++) {
    const page = await pdf.getPage(n);
    const lines = toLines((await page.getTextContent()).items);
    if (lines.join("").length >= MIN_TEXT) { out.push({ n, source: "text", lines }); continue; }
    if (!ocr) { out.push({ n, source: "none", lines: [] }); continue; }
    onProgress?.(`קורא עמוד ${n} מתוך ${last} (סריקה)…`);
    const w = await ocrWorker(onProgress);
    const canvas = await pageCanvas(page);
    const { data } = await w.recognize(canvas);
    out.push({ n, source: "ocr", lines: data.text.split("\n").map(l => l.replace(/\s+/g, " ").trim()).filter(Boolean) });
  }
  return { numPages: pdf.numPages, pages: out, scanned: out.some(p => p.source === "ocr") };
}

export const allLines = doc => doc.pages.flatMap(p => p.lines);

// ---------- "ניתוח תיק" (pension agent's portfolio report)
// The status table gives one row per plan. OCR reads its numbers well but drops spaces between
// Hebrew words and garbles dates, so a row is found by its plan number and amount, and sections
// are matched without spaces. The reading is then checked against the report's own total, so a
// misread digit is caught rather than silently saved.
const money = s => Number(String(s).replace(/[^\d]/g, ""));
const squeeze = s => s.replace(/\s+/g, "");
const SECTIONS = [["קופותגמל", "gemel"], ["קרנותהשתלמות", "hishtalmut"], ["קרנותפנסיה", "pension"],
  ["חיסכוןטהור", "savings"], ["משולבותחיסכון", "policy"], ["סיכוןטהור", "risk"]];
export function parsePortfolio(doc) {
  const lines = allLines(doc), flat = squeeze(lines.join(" "));
  if (!/סטטוספוליסות|כמהחסכתי|ניתוחתיק/.test(flat)) return null;
  const start = lines.findIndex(l => squeeze(l).includes("סטטוספוליסות"));
  const plans = []; let section = null;
  for (const l of start >= 0 ? lines.slice(start + 1) : []) {
    const sec = SECTIONS.find(([k]) => squeeze(l).includes(k));
    const clean = l.replace(/\d{2}\/\d{2}\/\d{4}/g, " ");
    const no = (clean.match(/\d{7,16}/) || [])[0];
    if (sec && !no) { section = sec[1]; continue; }
    if (/מתוך\s*\d/.test(l)) break;
    if (!no) continue;
    const amt = [...clean.matchAll(/\d{1,3}(?:,\d{3})+/g)].map(m => money(m[0]));
    plans.push({ no: no.replace(/^0+/, ""), section, balance: amt.length ? amt[amt.length - 1] : null });
  }
  const i = lines.findIndex(l => squeeze(l).includes("כמהחסכתי"));
  const near = i >= 0 ? lines.slice(i, i + 3).join(" ") : "";
  const big = [...near.matchAll(/\d{1,3}(?:,\d{3})+|\d{6,8}/g)].map(m => money(m[0]));
  const total = big.length ? Math.max(...big) : null;
  const sum = plans.reduce((a, p) => a + (p.balance || 0), 0);
  const person = (flat.match(/עבור:?([֐-׿]+?)ת\.?ז/) || [])[1] || "";
  return { person, total, sum, plans, exact: total != null && sum === total };
}

// Two plan numbers that differ by one digit are the same plan misread by OCR.
export function sameNumber(a, b) {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d === 1;
}
