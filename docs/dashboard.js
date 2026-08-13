import { db } from "./firebase-config.js";
import {
  collection,
  query,
  where,
  orderBy,
  limit,
  getDocs,
  getCountFromServer,
  writeBatch
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const col = collection(db, "carQrScans");
const DEVICE_CATEGORIES = ["נייד", "טאבלט", "מחשב"];
const LISTING_LABELS = { byd: "BYD", honda: "הונדה" };
const REFRESH_MS = 30000;

const totalEl = document.getElementById("totalCount");
const listingRowEl = document.getElementById("listingRow");
const deviceRowEl = document.getElementById("deviceRow");
const recentListEl = document.getElementById("recentList");
const updatedAtEl = document.getElementById("updatedAt");
const refreshBtn = document.getElementById("refreshBtn");
const resetBtn = document.getElementById("resetBtn");

function formatTime(date) {
  return date.toLocaleString("he-IL", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function renderListings(counts) {
  listingRowEl.innerHTML = "";
  for (const key of Object.keys(LISTING_LABELS)) {
    const chip = document.createElement("div");
    chip.className = "device-chip listing-chip";
    chip.innerHTML = `<span class="device-chip-count">${counts[key] ?? 0}</span><span class="device-chip-label">${LISTING_LABELS[key]}</span>`;
    listingRowEl.appendChild(chip);
  }
}

function renderDevices(counts) {
  deviceRowEl.innerHTML = "";
  for (const cat of DEVICE_CATEGORIES) {
    const chip = document.createElement("div");
    chip.className = "device-chip";
    chip.innerHTML = `<span class="device-chip-count">${counts[cat] ?? 0}</span><span class="device-chip-label">${cat}</span>`;
    deviceRowEl.appendChild(chip);
  }
}

function renderRecent(docs) {
  recentListEl.innerHTML = "";
  if (docs.length === 0) {
    recentListEl.innerHTML = '<li class="empty">עדיין אין סריקות</li>';
    return;
  }
  for (const d of docs) {
    const data = d.data();
    const when = data.ts ? formatTime(data.ts.toDate()) : "—";
    const listingKey = data.listing || "byd"; // records from before the split default to byd
    const li = document.createElement("li");
    li.className = "recent-row";
    li.innerHTML = `
      <span class="recent-time">${when}</span>
      <span class="tag tag-listing">${LISTING_LABELS[listingKey] || listingKey}</span>
      <span class="tag tag-device">${data.device || "לא ידוע"}</span>
      <span class="tag tag-browser">${data.browser || "לא ידוע"}</span>
    `;
    recentListEl.appendChild(li);
  }
}

async function loadStats() {
  refreshBtn.disabled = true;
  refreshBtn.textContent = "טוען...";
  try {
    const totalSnap = await getCountFromServer(col);
    const total = totalSnap.data().count;
    totalEl.textContent = total;

    // Records written before the BYD/Honda split have no `listing` field at
    // all, so "byd" is derived as the remainder rather than queried
    // directly — a direct query would miss those older records.
    const hondaSnap = await getCountFromServer(query(col, where("listing", "==", "honda")));
    const hondaCount = hondaSnap.data().count;
    renderListings({ honda: hondaCount, byd: total - hondaCount });

    const counts = {};
    for (const cat of DEVICE_CATEGORIES) {
      const snap = await getCountFromServer(query(col, where("device", "==", cat)));
      counts[cat] = snap.data().count;
    }
    renderDevices(counts);

    const recentSnap = await getDocs(query(col, orderBy("ts", "desc"), limit(20)));
    renderRecent(recentSnap.docs);

    updatedAtEl.textContent = `עודכן לאחרונה: ${formatTime(new Date())}`;
  } catch (e) {
    console.error("failed to load stats", e);
    updatedAtEl.textContent = "שגיאה בטעינת הנתונים";
  } finally {
    refreshBtn.disabled = false;
    refreshBtn.textContent = "רענון";
  }
}

async function resetCounter() {
  const sure = window.confirm(
    "פעולה זו תמחק לצמיתות את כל היסטוריית הסריקות ותאפס את המונה ל-0.\nאי אפשר לשחזר אחרי זה. להמשיך?"
  );
  if (!sure) return;

  resetBtn.disabled = true;
  resetBtn.textContent = "מאפס...";
  try {
    // Firestore has no "delete collection" call from the client — page
    // through it in batches until nothing is left.
    while (true) {
      const snap = await getDocs(query(col, limit(400)));
      if (snap.empty) break;
      const batch = writeBatch(db);
      snap.docs.forEach((d) => batch.delete(d.ref));
      await batch.commit();
      if (snap.size < 400) break;
    }
    await loadStats();
  } catch (e) {
    console.error("reset failed", e);
    alert("האיפוס נכשל: " + e.message);
  } finally {
    resetBtn.disabled = false;
    resetBtn.textContent = "איפוס המונה";
  }
}

resetBtn.addEventListener("click", resetCounter);
refreshBtn.addEventListener("click", loadStats);
loadStats();
setInterval(loadStats, REFRESH_MS);
