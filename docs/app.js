// Sign-in, data loading and saving for the finance app.
// The data itself lives only in Firestore (finance/data) and is readable just
// by the accounts allowed in firestore.rules; this file holds no personal data.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signInWithRedirect, getRedirectResult,
  signInWithEmailAndPassword, sendPasswordResetEmail, signOut }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, doc, getDoc, setDoc, updateDoc, deleteDoc, collection, getDocs, serverTimestamp, Timestamp, Bytes }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
// Bump ?v= on every change: GitHub Pages caches files for ~10 minutes, and an old
// cached firebase-config.js from the previous site broke the module import.
import { firebaseConfig, ownerEmail } from "./firebase-config.js?v=25";

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
  $("#signInBox").hidden = !signIn;
  $("#uploadFirst").hidden = !upload;
};

// ---- sign-in: Google, or email + password for users the owner created in the
// Firebase console (self sign-up is turned off there).
const AUTH_ERRORS = {
  "auth/popup-closed-by-user": "חלון הכניסה נסגר לפני שהכניסה הסתיימה. נסו שוב.",
  "auth/cancelled-popup-request": "חלון הכניסה נסגר לפני שהכניסה הסתיימה. נסו שוב.",
  "auth/network-request-failed": "אין חיבור לאינטרנט. בדקו את החיבור ונסו שוב.",
  "auth/unauthorized-domain": "האתר לא מורשה לכניסה עם Google. פנו למנהל האתר.",
  "auth/web-storage-unsupported": "הדפדפן חוסם את הכניסה. פתחו את הקישור בכרום או בספארי.",
  "auth/operation-not-supported-in-this-environment": "הדפדפן הזה לא תומך בכניסה עם Google. פתחו את הקישור בכרום או בספארי.",
  "auth/invalid-credential": "המייל או הסיסמה לא נכונים.",
  "auth/wrong-password": "המייל או הסיסמה לא נכונים.",
  "auth/user-not-found": "אין משתמש עם המייל הזה. בקשו ממנהל האתר ליצור לכם משתמש.",
  "auth/invalid-email": "כתובת המייל לא תקינה.",
  "auth/too-many-requests": "יותר מדי ניסיונות. נסו שוב בעוד כמה דקות.",
  "auth/operation-not-allowed": "הכניסה עם מייל וסיסמה עוד לא הופעלה. פנו למנהל האתר.",
};
const authError = e => AUTH_ERRORS[e.code] || `הכניסה נכשלה (${e.code || e.message}). נסו לפתוח את הקישור בכרום או בספארי.`;
const loginErr = msg => { $("#loginErr").textContent = msg; };

$("#signIn").onclick = async () => {
  loginErr("");
  try { await signInWithPopup(auth, new GoogleAuthProvider()); }
  catch (e) {
    // Phones often block the popup: go to Google's page and come back instead.
    if (e.code === "auth/popup-blocked") return signInWithRedirect(auth, new GoogleAuthProvider());
    loginErr(authError(e));
  }
};
getRedirectResult(auth).catch(e => loginErr(authError(e)));
$("#emailForm").onsubmit = async ev => {
  ev.preventDefault();
  loginErr("");
  try {
    await signInWithEmailAndPassword(auth, $("#emailIn").value.trim(), $("#emailPw").value);
    $("#emailPw").value = "";
  } catch (e) { loginErr(authError(e)); }
};
$("#pwReset").onclick = async () => {
  const email = $("#emailIn").value.trim();
  if (!email) return loginErr("כתבו את המייל ואז לחצו שוב על ״שכחתי סיסמה״.");
  try { await sendPasswordResetEmail(auth, email); loginErr("נשלח מייל לאיפוס הסיסמה."); }
  catch (e) { loginErr(authError(e)); }
};
// Google refuses to sign in inside apps' built-in browsers (WhatsApp, Facebook, Instagram...).
if (/FBAN|FBAV|Instagram|Line\/|WhatsApp|; wv\)|WebView/i.test(navigator.userAgent)) {
  $("#inAppNote").hidden = false;
  $("#inAppChrome").hidden = !/Android/i.test(navigator.userAgent);
  $("#inAppChrome").href = `intent://${location.host}${location.pathname}#Intent;scheme=https;package=com.android.chrome;end`;
  $("#inAppCopy").onclick = async () => {
    const url = location.origin + location.pathname;
    try { await navigator.clipboard.writeText(url); loginErr("הקישור הועתק. הדביקו אותו בכרום או בספארי."); }
    catch { prompt("העתיקו את הקישור:", url); }
  };
}
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
  open.onsuccess = () => {  // any failure must reject, never leave the caller waiting
    try { const tx = open.result.transaction("h", mode), req = fn(tx.objectStore("h")); tx.oncomplete = () => res(req && req.result); tx.onerror = tx.onabort = () => rej(tx.error); }
    catch (err) { rej(err); }
  };
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
// Upload a picked file with explicit feedback, so a silent failure can't look like success.
async function uploadPicked(text) {
  let gen;
  try { gen = JSON.parse(text).generated; } catch { gen = null; }
  if (gen && gen === loadedGenerated &&
      !confirm(`הקובץ שבחרת נבנה ב-${gen}, בדיוק כמו הנתונים שכבר באתר.
כנראה נבחר קובץ ישן. להעלות בכל זאת?`)) return false;
  await uploadText(text);
  alert(`הנתונים עודכנו: נבנו ב-${gen || "?"}. הדף ייטען מחדש.`);
  return true;
}
document.addEventListener("click", async e => {
  if (!e.target.closest("[data-upload]")) return;
  if (!canRemember) return $("#fileIn").click();
  let h;
  try { [h] = await window.showOpenFilePicker({ types: [{ description: "data.json", accept: { "application/json": [".json"] } }] }); }
  catch (err) { if (err.name !== "AbortError") alert("פתיחת בחירת הקובץ נכשלה: " + err.message); return; }
  try {
    const ok = await uploadPicked(await (await h.getFile()).text());
    // remember the file for "רענון"; best effort, never blocks the upload
    await Promise.race([saveHandle(h), new Promise(r => setTimeout(r, 1500))]);
    if (ok) location.reload();
  } catch (err) { alert("העדכון נכשל: " + (err.code || err.message)); }
});
$("#fileIn").onchange = async () => {
  const file = $("#fileIn").files[0];
  $("#fileIn").value = "";
  if (!file) return;
  try { if (await uploadPicked(await file.text())) location.reload(); }
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

// ---- temporary password shares
// /shareSalts/{id}: salt only (readable while the link is valid, up to 7 days)
// /shares/{id}: ciphertext + vh, readable for one hour after the first correct password
const ENC = new TextEncoder(), DEC = new TextDecoder();
const toB64 = buf => { const b = new Uint8Array(buf); let s = ""; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s); };
const fromB64 = str => Uint8Array.from(atob(str), c => c.charCodeAt(0));
// One PBKDF2 run gives 64 bytes: the first half is the AES key, the second half the
// "proof" whose SHA-256 the server checks before starting the one-hour clock.
async function pwSecrets(pw, salt) {
  const base = await crypto.subtle.importKey("raw", ENC.encode(pw), "PBKDF2", false, ["deriveBits"]);
  const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: 310000, hash: "SHA-256" }, base, 512));
  const key = await crypto.subtle.importKey("raw", bits.slice(0, 32), "AES-GCM", false, ["encrypt", "decrypt"]);
  return { key, proof: bits.slice(32) };
}
const VIEW_MS = 60 * 60 * 1000, LINK_MS = 7 * 24 * 60 * 60 * 1000;
const fmtTime = d => d.toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" });
const fmtDate = d => d.toLocaleDateString("he-IL", { day: "2-digit", month: "2-digit" }) + " " + fmtTime(d);

async function drawTmpShares() {
  const now = Date.now(), snap = await getDocs(collection(db, "shares"));
  const rows = [];
  for (const d of snap.docs) {
    const x = d.data(), linkExp = x.linkExpiresAt ? x.linkExpiresAt.toMillis() : 0, opened = x.openedAt ? x.openedAt.toMillis() : null;
    const dead = opened ? opened + VIEW_MS <= now : linkExp <= now;
    if (dead) { deleteDoc(d.ref).catch(() => {}); deleteDoc(doc(db, "shareSalts", d.id)).catch(() => {}); continue; }
    rows.push({ id: d.id, text: opened ? `נפתח ב-${fmtTime(new Date(opened))}, פעיל עד ${fmtTime(new Date(opened + VIEW_MS))}` : `ממתין לפתיחה (עד ${fmtDate(new Date(linkExp))})` });
  }
  $("#tmpList").innerHTML = rows.length
    ? "<tbody>" + rows.map(x => `<tr><td>${x.text}</td><td style="text-align:left"><button class="sm" type="button" data-kill="${x.id}">ביטול עכשיו</button></td></tr>`).join("") + "</tbody>"
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
    const { key, proof } = await pwSecrets(pw, salt);
    const vh = new Uint8Array(await crypto.subtle.digest("SHA-256", proof));
    const plain = ENC.encode(JSON.stringify({ data: loadedData, state: { budgets: loadedState.budgets || {} } }));
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plain);
    const id = toB64(crypto.getRandomValues(new Uint8Array(18))).replace(/[+/=]/g, c => ({ "+": "-", "/": "_", "=": "" }[c]));
    const linkExpiresAt = Timestamp.fromMillis(Date.now() + LINK_MS);
    await setDoc(doc(db, "shares", id), { ct: toB64(ct), iv: toB64(iv), vh: Bytes.fromUint8Array(vh), linkExpiresAt, createdAt: serverTimestamp() });
    await setDoc(doc(db, "shareSalts", id), { salt: toB64(salt), linkExpiresAt });
    $("#tmpLink").value = location.origin + location.pathname + "?s=" + id;
    $("#tmpOut").hidden = false; $("#tmpPw").value = "";
    $("#shareMsg").textContent = `הקישור נוצר. אפשר לפתוח אותו עד ${fmtDate(linkExpiresAt.toDate())}. השעה מתחילה ברגע שמכניסים את הסיסמה. שלחו את הסיסמה בנפרד מהקישור.`;
    await drawTmpShares();
  } catch (err) { $("#shareMsg").textContent = "יצירת הקישור נכשלה: " + (err.code || err.message); }
  btn.disabled = false; btn.textContent = "יצירת קישור";
};
$("#tmpCopy").onclick = async () => { try { await navigator.clipboard.writeText($("#tmpLink").value); } catch { $("#tmpLink").select(); document.execCommand("copy"); } $("#tmpCopy").textContent = "הועתק ✓"; setTimeout(() => $("#tmpCopy").textContent = "העתקה", 2000); };
$("#tmpList").onclick = async e => {
  const id = e.target.closest("[data-kill]")?.dataset.kill;
  if (!id) return;
  try { await deleteDoc(doc(db, "shares", id)); await deleteDoc(doc(db, "shareSalts", id)); $("#shareMsg").textContent = "הקישור בוטל."; await drawTmpShares(); }
  catch (err) { $("#shareMsg").textContent = "הביטול נכשל: " + (err.code || err.message); }
};

// ---- viewer side: ?s=<id> asks for the password; the first correct entry starts the hour
if (shareId) {
  gate("נתוני ניהול ההוצאות שותפו איתך. הכניסו את הסיסמה שקיבלתם. מרגע הכניסה הנתונים פתוחים לשעה אחת.");
  $("#pwGate").hidden = false;
  const closed = msg => { $("#pwGate").hidden = true; gate(msg); };
  $("#pwGate").onsubmit = async e => {
    e.preventDefault();
    $("#gateMsg").textContent = "בודק סיסמה…";
    const shareRef = doc(db, "shares", shareId);
    let saltDoc;
    try { saltDoc = await getDoc(doc(db, "shareSalts", shareId)); } catch { return closed("הקישור פג או בוטל. בקשו קישור חדש."); }
    if (!saltDoc.exists()) return closed("הקישור פג או בוטל. בקשו קישור חדש.");
    const { key, proof } = await pwSecrets($("#pwIn").value, fromB64(saltDoc.data().salt));
    const wrong = () => { gate("הסיסמה שגויה, או שזמן הצפייה כבר הסתיים."); $("#pwGate").hidden = false; $("#pwIn").value = ""; };
    let snap = null;
    try { snap = await getDoc(shareRef); } catch { /* not opened yet, or the hour is over */ }
    if (!snap || !snap.exists()) {
      // first opening: the server accepts this only if the proof matches the password
      try { await updateDoc(shareRef, { openedAt: serverTimestamp(), proof: Bytes.fromUint8Array(proof) }); }
      catch { return wrong(); }
      try { snap = await getDoc(shareRef); } catch { return wrong(); }
    }
    const d = snap.data();
    let payload;
    try { payload = JSON.parse(DEC.decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(d.iv) }, key, fromB64(d.ct)))); }
    catch { return wrong(); }
    const exp = d.openedAt.toMillis() + VIEW_MS;
    document.body.classList.add("readonly");
    $("#gate").hidden = true; $("#app").hidden = false;
    window.renderApp(payload.data, payload.state || {}, () => {});
    const banner = $("#shareBanner"); banner.hidden = false;
    const tick = () => {
      const left = exp - Date.now();
      if (left <= 0) {  // close the view; the server already refuses new reads
        $("#app").innerHTML = ""; $("#app").hidden = true;
        return closed("זמן הצפייה (שעה) הסתיים. הנתונים נסגרו.");
      }
      const m = Math.floor(left / 60000), sec = Math.floor(left / 1000) % 60;
      banner.textContent = `תצוגה משותפת לצפייה בלבד · נסגרת בעוד ${m}:${String(sec).padStart(2, "0")} (ב-${fmtTime(new Date(exp))})`;
      setTimeout(tick, 1000);
    };
    tick();
  };
}
