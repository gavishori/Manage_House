// Downloads the documents uploaded in the app's "מסמכים" tab into finance/private/raw/,
// so the next `python scripts/build.py` includes them (Isracard statements and payslips are
// only read there). Only current versions are downloaded, and a file whose exact bytes are
// already in raw/ is skipped.
//
// Uses the Firebase CLI's own login (run `npx firebase-tools login` once).
// Usage:  node scripts/pull_docs.js
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const PROJECT = "car-qr-counter";
const RAW = path.join(__dirname, "..", "finance", "private", "raw");

// firebase-tools is usually run through npx, so look in npx's cache as well as the normal places.
function findFirebaseTools() {
  try { return path.dirname(require.resolve("firebase-tools/package.json")); } catch {}
  const cache = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), ".npm"), "npm-cache", "_npx");
  const alt = path.join(os.homedir(), ".npm", "_npx");
  for (const base of [cache, alt]) {
    if (!fs.existsSync(base)) continue;
    for (const d of fs.readdirSync(base)) {
      const p = path.join(base, d, "node_modules", "firebase-tools");
      if (fs.existsSync(path.join(p, "lib", "auth.js"))) return p;
    }
  }
  throw new Error("firebase-tools not found: run `npx firebase-tools login` once");
}

(async () => {
  const ft = findFirebaseTools();
  const auth = require(path.join(ft, "lib", "auth.js"));
  const tokens = require(path.join(ft, "lib", "configstore.js")).configstore.get("tokens");
  if (!tokens?.refresh_token) throw new Error("not logged in: run `npx firebase-tools login`");
  const token = (await auth.getAccessToken(tokens.refresh_token, [])).access_token;
  const base = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
  const get = async url => {
    const r = await fetch(url, { headers: { Authorization: "Bearer " + token } });
    if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
    return r.json();
  };
  const val = f => f && (f.stringValue ?? f.integerValue ?? f.booleanValue);

  const have = new Set(fs.readdirSync(RAW).map(n => crypto.createHash("sha256").update(fs.readFileSync(path.join(RAW, n))).digest("hex")));
  let page = "", got = 0, skipped = 0;
  do {
    const list = await get(`${base}/files?pageSize=200${page ? "&pageToken=" + page : ""}`);
    for (const d of list.documents || []) {
      const f = d.fields, id = d.name.split("/").pop();
      if (val(f.current) === false || have.has(val(f.sha))) { skipped++; continue; }
      let b64 = "";
      for (let i = 0; i < Number(val(f.chunks)); i++) b64 += val((await get(`${base}/fileChunks/${id}_${i}`)).fields.data);
      const bytes = Buffer.from(b64, "base64");
      let name = path.basename(val(f.name));
      if (fs.existsSync(path.join(RAW, name))) name = name.replace(/(\.[^.]+)?$/, `_${id.slice(0, 6)}$1`);
      fs.writeFileSync(path.join(RAW, name), bytes);
      console.log("downloaded", name);
      got++;
    }
    page = list.nextPageToken || "";
  } while (page);
  console.log(`${got} new, ${skipped} already here or older versions`);
})().catch(e => { console.error("ERROR", e.message); process.exit(1); });
