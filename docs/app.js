// Sign-in, data loading and saving for the finance app.
// The data itself lives only in Firestore (finance/data) and is readable just
// by the accounts allowed in firestore.rules; this file holds no personal data.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signOut }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, doc, getDoc, setDoc, serverTimestamp }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

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
document.addEventListener("click", e => { if (e.target.closest("[data-upload]")) $("#fileIn").click(); });
$("#fileIn").onchange = async () => {
  const file = $("#fileIn").files[0];
  $("#fileIn").value = "";
  if (!file) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    if (!data.ledger || !data.config || !data.balance) throw new Error("זה לא קובץ data.json של scripts/build.py");
    if (new Blob([text]).size > 1_000_000) throw new Error("הקובץ גדול מדי למסמך אחד ב-Firestore");
    await setDoc(dataRef, { json: text, generated: data.generated, uploadedAt: serverTimestamp() });
    location.reload();
  } catch (e) {
    alert("העדכון נכשל: " + (e.code || e.message));
  }
};

onAuthStateChanged(auth, async user => {
  if (!user) return gate("כדי לראות את הנתונים צריך להתחבר.", { signIn: true });
  $("#gateWho").textContent = "מחובר כ-" + user.email;
  gate("טוען נתונים…");
  try {
    const [d, st] = await Promise.all([getDoc(dataRef), getDoc(stateRef)]);
    if (!d.exists()) return gate("מחובר.", { upload: true });
    $("#gate").hidden = true;
    $("#app").hidden = false;
    window.renderApp(JSON.parse(d.data().json), st.exists() ? st.data() : {}, saveState);
  } catch (e) {
    if (e.code === "permission-denied") {
      gate(`לחשבון ${user.email} אין הרשאה לנתונים האלה.`, { signIn: true });
      signOut(auth);
    } else {
      gate("שגיאה בטעינה: " + (e.code || e.message));
    }
  }
});
