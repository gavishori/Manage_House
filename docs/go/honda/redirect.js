// See ../redirect.js (BYD) for the full explanation of why this avoids the
// Firebase SDK and uses sendBeacon.
const PROJECT_ID = "car-qr-counter";
const API_KEY = "AIzaSyC0KFLFvnmWnSO-5E-i9LEaxzMxppAbBjc";
const WHATSAPP_NUMBER = "972503043348";
const PREFILL_MESSAGE = `הי,

ראיתי את הרכב

הונדה ג'אז 2005 מפרטי.

287,000 ק"מ.

מטופלת מכאנית.

הוחלף מנוע בינואר 2025.

טסט עד 02.2027.

ארבעה צמיגים חדשים.

נדרשים שני טסטים בשנה.

מומלץ.

תחזור אלי בבקשה`;
const TARGET_URL = `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(PREFILL_MESSAGE)}`;
const LISTING = "honda";

function detectDevice(ua) {
  if (/iPad|Tablet|PlayBook/i.test(ua)) return "טאבלט";
  if (/Mobi|Android|iPhone|iPod/i.test(ua)) return "נייד";
  return "מחשב";
}

function detectBrowser(ua) {
  if (/Edg\//.test(ua)) return "Edge";
  if (/OPR\/|Opera/.test(ua)) return "Opera";
  if (/CriOS|Chrome\//.test(ua)) return "Chrome";
  if (/FxiOS|Firefox\//.test(ua)) return "Firefox";
  if (/Safari\//.test(ua)) return "Safari";
  return "אחר";
}

function logScanFireAndForget() {
  const ua = navigator.userAgent || "";
  const payload = {
    fields: {
      device: { stringValue: detectDevice(ua) },
      browser: { stringValue: detectBrowser(ua) },
      ts: { timestampValue: new Date().toISOString() },
      listing: { stringValue: LISTING }
    }
  };
  const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/carQrScans?key=${API_KEY}`;
  const body = JSON.stringify(payload);

  try {
    if (navigator.sendBeacon) {
      navigator.sendBeacon(url, new Blob([body], { type: "application/json" }));
      return;
    }
  } catch (e) {
    // fall through to fetch
  }

  try {
    fetch(url, { method: "POST", body, headers: { "Content-Type": "application/json" }, keepalive: true });
  } catch (e) {
    // never let logging failures block the redirect
  }
}

logScanFireAndForget();
window.location.replace(TARGET_URL);
