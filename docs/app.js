// Sign-in, data loading and saving for the finance app.
// The data itself lives only in Firestore (finance/data) and is readable just
// by the accounts allowed in firestore.rules; this file holds no personal data.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signOut }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, doc, getDoc, setDoc, deleteDoc, collection, getDocs, serverTimestamp, Timestamp }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
// Bump ?v= on every change: GitHub Pages caches files for ~10 minutes, and an old
// cached firebase-config.js from the previous site broke the module import.
import { firebaseConfig, ownerEmail } from "./firebase-config.js?v=11";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const dataRef = doc(db, "finance", "data");
const stateRef = doc(db, "finance", "state");

const $ = s => document.querySelector(s);
const gate = (msg, { signIn = false, upload = false } = {}) => {
  $("#app").hidden = true;
  $("#gate").hidden = false;
  $("#gateMsg").textContent = msg;
  $("#signIn").hidden = !signIn;
  $("#uploadFirst").hidden = !upload;
};

$("#signIn").onclick = () => signInWithPopup(auth, new GoogleAuthProvider())
  .catch(e => gate("ההתחברות נכשלה: " + (e.code || e.message), { signIn: true }));
$("#signOut").onclick = () => signOut(auth);

// ---- budgets & answers sync (debounced, merged into finance/state)
let pending = {}, timer;
function saveState(patch) {
  Object.assign(pending, patch);
  clearTimeout(timer);
  timer = setTimeout(() => {
    const body = { ...pending, updatedAt: serverTimestamp() };
    pending = {};
    setDoc(stateRef, body, { merge: true }).catch(e => console.error("state save failed", e));
  }, 800);
}

// ---- upload data.json produced by scripts/build.py
// Chrome/Edge can remember the picked file (File System Access API), so "רענון"
// re-reads it from disk and uploads it when it changed. Other browsers fall back
// to a plain file input and "רענון" only reloads from Firestore.
let loadedGenerated = null, loadedData = null, loadedState = {};
const canRemember = "showOpenFilePicker" in window;
const idb = (mode, fn) => new Promise((res, rej) => {
  const open = indexedDB.open("mh-files", 1);
  open.onupgradeneeded = () => open.result.createObjectStore("h");
  open.onerror = () => rej(open.error);
  open.onsuccess = () => { const tx = open.result.transaction("h", mode), req = fn(tx.objectStore("h")); tx.oncomplete = () => res(req && req.result); tx.onerror = () => rej(tx.error); };
});
const saveHandle = h => idb("readwrite", st => st.put(h, "data")).catch(() => {});
const loadHandle = () => idb("readonly", st => st.get("data")).catch(() => null);

async function uploadText(text) {
  const data = JSON.parse(text);
  if (!data.ledger || !data.config || !data.balance) throw new Error("זה לא קובץ data.json של scripts/build.py");
  if (new Blob([text]).size > 1_000_000) throw new Error("הקובץ גדול מדי למסמך אחד ב-Firestore");
  await setDoc(dataRef, { json: text, generated: data.generated, uploadedAt: serverTimestamp() });
  return data.generated;
}
document.addEventListener("click", async e => {
  if (!e.target.closest("[data-upload]")) return;
  if (!canRemember) return $("#fileIn").click();
  try {
    const [h] = await window.showOpenFilePicker({ types: [{ description: "data.json", accept: { "application/json": [".json"] } }] });
    await saveHandle(h);
    await uploadText(await (await h.getFile()).text());
    location.reload();
  } catch (err) { if (err.name !== "AbortError") alert("העדכון נכשל: " + (err.code || err.message)); }
});
$("#fileIn").onchange = async () => {
  const file = $("#fileIn").files[0];
  $("#fileIn").value = "";
  if (!file) return;
  try { await uploadText(await file.text()); location.reload(); }
  catch (e) { alert("העדכון נכשל: " + (e.code || e.message)); }
};

// ---- refresh: pull the remembered data.json if it changed, then reload
$("#refreshBtn").onclick = async () => {
  const btn = $("#refreshBtn");
  btn.disabled = true; btn.textContent = "בודק…";
  try {
    const h = canRemember ? await loadHandle() : null;
    if (h) {
      let perm = await h.queryPermission({ mode: "read" });
      if (perm !== "granted") perm = await h.requestPermission({ mode: "read" });
      if (perm === "granted") {
        const text = await (await h.getFile()).text();
        const gen = JSON.parse(text).generated;
        if (gen && gen !== loadedGenerated) { btn.textContent = "מעלה נתונים חדשים…"; await uploadText(text); }
      }
    }
  } catch (err) {
    // file moved/deleted or permission refused: fall back to a plain reload from Firestore
    console.warn("refresh from file failed", err);
  }
  location.reload();
};

// ---- sharing (owner only): one /access/{email} document per shared account
async function drawShares() {
  const snap = await getDocs(collection(db, "access"));
  const rows = snap.docs.map(d => d.id).sort();
  $("#shareList").innerHTML = rows.length
    ? "<tbody>" + rows.map(e => `<tr><td>${e}</td><td style="text-align:left"><button class="sm" type="button" data-remove="${e}">הסרה</button></td></tr>`).join("") + "</tbody>"
    : '<tbody><tr><td class="small">עוד לא שיתפת עם אף אחד.</td></tr></tbody>';
}
$("#shareBtn").onclick = async () => {
  $("#shareMsg").textContent = "";
  $("#shareDlg").showModal();
  try { await drawShares(); } catch (e) { $("#shareMsg").textContent = "שגיאה: " + (e.code || e.message); }
};
$("#shareClose").onclick = () => $("#shareDlg").close();
$("#shareForm").onsubmit = async e => {
  e.preventDefault();
  const email = $("#shareEmail").value.trim().toLowerCase();
  if (!email || email === ownerEmail) return;
  try {
    await setDoc(doc(db, "access", email), { addedAt: serverTimestamp(), addedBy: auth.currentUser.email });
    $("#shareEmail").value = "";
    $("#shareMsg").textContent = `${email} נוסף. אפשר לשלוח לו/לה את הקישור לאתר.`;
    await drawShares();
  } catch (err) { $("#shareMsg").textContent = "ההוספה נכשלה: " + (err.code || err.message); }
};
$("#shareList").onclick = async e => {
  const email = e.target.closest("[data-remove]")?.dataset.remove;
  if (!email || !confirm(`להסיר את הגישה של ${email}?`)) return;
  try { await deleteDoc(doc(db, "access", email)); $("#shareMsg").textContent = `הגישה של ${email} הוסרה.`; await drawShares(); }
  catch (err) { $("#shareMsg").textContent = "ההסרה נכשלה: " + (err.code || err.message); }
};

const shareId = new URLSearchParams(location.search).get("s");
if (!shareId) onAuthStateChanged(auth, async user => {
  if (!user) return gate("כדי לראות את הנתונים צריך להתחבר.", { signIn: true });
  $("#gateWho").textContent = "מחובר כ-" + user.email;
  $("#shareBtn").hidden = user.email !== ownerEmail;
  gate("טוען נתונים…");
  try {
    const [d, st] = await Promise.all([getDoc(dataRef), getDoc(stateRef)]);
    if (!d.exists()) return gate("מחובר.", { upload: true });
    $("#gate").hidden = true;
    $("#app").hidden = false;
    const data = JSON.parse(d.data().json);
    loadedGenerated = data.generated; loadedData = data; loadedState = st.exists() ? st.data() : {};
    window.renderApp(data, loadedState, saveState);
    if (canRemember && !(await loadHandle())) $("#refreshBtn").title = "כדי שרענון ימשוך את data.json אוטומטית, בחרו אותו פעם אחת דרך ״עדכון נתונים״";
  } catch (e) {
    if (e.code === "permission-denied") {
      gate(`לחשבון ${user.email} אין הרשאה לנתונים האלה.`, { signIn: true });
      signOut(auth);
    } else {
      gate("שגיאה בטעינה: " + (e.code || e.message));
    }
  }
});

// ---- temporary password shares (/shares/{id}, readable for one hour)
const ENC = new TextEncoder(), DEC = new TextDecoder();
const toB64 = buf => { const b = new Uint8Array(buf); let s = ""; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s); };
const fromB64 = str => Uint8Array.from(atob(str), c => c.charCodeAt(0));
async function pwKey(pw, salt) {
  const base = await crypto.subtle.importKey("raw", ENC.encode(pw), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: 310000, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
const SHARE_MS = 60 * 60 * 1000;
const fmtTime = d => d.toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" });

async function drawTmpShares() {
  const now = Date.now(), snap = await getDocs(collection(db, "shares"));
  const live = [];
  for (const d of snap.docs) {
    const exp = d.data().expiresAt.toMillis();
    if (exp <= now) deleteDoc(d.ref).catch(() => {});  // tidy up expired copies
    else live.push({ id: d.id, exp });
  }
  $("#tmpList").innerHTML = live.length
    ? "<tbody>" + live.sort((a, b) => a.exp - b.exp).map(x => `<tr><td>קישור פעיל עד ${fmtTime(new Date(x.exp))}</td><td style="text-align:left"><button class="sm" type="button" data-kill="${x.id}">ביטול עכשיו</button></td></tr>`).join("") + "</tbody>"
    : "";
}
$("#shareBtn").addEventListener("click", () => { $("#tmpOut").hidden = true; drawTmpShares().catch(() => {}); });
$("#tmpForm").onsubmit = async e => {
  e.preventDefault();
  const pw = $("#tmpPw").value;
  if (pw.length < 8) return;
  const btn = $("#tmpBtn"); btn.disabled = true; btn.textContent = "מצפין…";
  try {
    const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
    const plain = ENC.encode(JSON.stringify({ data: loadedData, state: { budgets: loadedState.budgets || {} } }));
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await pwKey(pw, salt), plain);
    const id = toB64(crypto.getRandomValues(new Uint8Array(18))).replace(/[+/=]/g, c => ({ "+": "-", "/": "_", "=": "" }[c]));
    const expiresAt = Timestamp.fromMillis(Date.now() + SHARE_MS);
    await setDoc(doc(db, "shares", id), { ct: toB64(ct), iv: toB64(iv), salt: toB64(salt), expiresAt, createdAt: serverTimestamp() });
    $("#tmpLink").value = location.origin + location.pathname + "?s=" + id;
    $("#tmpOut").hidden = false; $("#tmpPw").value = "";
    $("#shareMsg").textContent = `הקישור נוצר ויעבוד עד ${fmtTime(expiresAt.toDate())}. שלחו את הסיסמה בנפרד מהקישור.`;
    await drawTmpShares();
  } catch (err) { $("#shareMsg").textContent = "יצירת הקישור נכשלה: " + (err.code || err.message); }
  btn.disabled = false; btn.textContent = "יצירת קישור לשעה";
};
$("#tmpCopy").onclick = async () => { try { await navigator.clipboard.writeText($("#tmpLink").value); } catch { $("#tmpLink").select(); document.execCommand("copy"); } $("#tmpCopy").textContent = "הועתק ✓"; setTimeout(() => $("#tmpCopy").textContent = "העתקה", 2000); };
$("#tmpList").onclick = async e => {
  const id = e.target.closest("[data-kill]")?.dataset.kill;
  if (!id) return;
  try { await deleteDoc(doc(db, "shares", id)); $("#shareMsg").textContent = "הקישור בוטל."; await drawTmpShares(); }
  catch (err) { $("#shareMsg").textContent = "הביטול נכשל: " + (err.code || err.message); }
};

// ---- viewer side: ?s=<id> asks for the password, decrypts, shows a read-only copy until expiry
if (shareId) {
  gate("נתוני ניהול ההוצאות שותפו איתך לשעה. הכניסו את הסיסמה שקיבלתם.");
  $("#pwGate").hidden = false;
  $("#pwGate").onsubmit = async e => {
    e.preventDefault();
    $("#gateMsg").textContent = "פותח…";
    let snap;
    const expired = () => { $("#pwGate").hidden = true; gate("הקישור פג (עברה שעה) או בוטל. בקשו קישור חדש."); };
    try { snap = await getDoc(doc(db, "shares", shareId)); }
    catch { return expired(); }
    if (!snap.exists()) return expired();
    const d = snap.data(), exp = d.expiresAt.toMillis();
    let payload;
    try {
      const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(d.iv) }, await pwKey($("#pwIn").value, fromB64(d.salt)), fromB64(d.ct));
      payload = JSON.parse(DEC.decode(plain));
    } catch {
      gate("הסיסמה שגויה. נסו שוב."); $("#pwGate").hidden = false; $("#pwIn").value = ""; return;
    }
    document.body.classList.add("readonly");
    $("#gate").hidden = true; $("#app").hidden = false;
    window.renderApp(payload.data, payload.state || {}, () => {});
    const banner = $("#shareBanner"); banner.hidden = false;
    const tick = () => {
      const left = exp - Date.now();
      if (left <= 0) {  // close the view on expiry; the server already refuses new reads
        $("#app").innerHTML = ""; $("#app").hidden = true; $("#pwGate").hidden = true;
        return gate("זמן הצפייה הסתיים. הנתונים נסגרו.");
      }
      const m = Math.floor(left / 60000), sec = Math.floor(left / 1000) % 60;
      banner.textContent = `תצוגה משותפת לצפייה בלבד · נסגרת בעוד ${m}:${String(sec).padStart(2, "0")} (ב-${fmtTime(new Date(exp))})`;
      setTimeout(tick, 1000);
    };
    tick();
  };
}
