# car-listing-qr

Two QR codes tracking interest in two car listings you're selling — one for
the BYD, one for the Honda. **Completely separate from any other project** —
its own GitHub repo (`gavishori/car-listing-qr`), its own dedicated Firebase
project (`car-qr-counter`), no shared code or data with anything else.

## What it does

1. **`docs/go/index.html`** (BYD) and **`docs/go/honda/index.html`** (Honda)
   — the two pages the two QR codes point to. Each fires a fire-and-forget
   `sendBeacon` write to Firestore (no SDK to load, nothing awaited) tagged
   with which listing it is, and redirects on the very next line, so the
   intermediate URL is on screen for only a few milliseconds — not the ~1s a
   full SDK load would take. Then:
   - BYD lands the visitor on the Yad2 listing:
     `https://www.yad2.co.il/vehicles/item/57q4474l?key=97eO8nxkFJmbtCZA`
   - Honda lands the visitor on a WhatsApp chat with `972503043348`, with the
     message box pre-filled with a description of the car (edit
     `PREFILL_MESSAGE` in `docs/go/honda/redirect.js` to change the wording)

   (A screen recording paused frame-by-frame, or view-source, could still
   reveal the intermediate URL — a fully invisible redirect needs a
   server-side Cloud Function, which requires enabling Firebase's paid Blaze
   plan.)
2. **`docs/index.html`** — the site's home page: a dashboard showing the
   running scan count split by listing (BYD vs. Honda), a breakdown by rough
   device type, and a list of recent scans. This is what opens when you
   click **"Visit site"** on GitHub Pages, or the bare hosting URL on
   Firebase.
3. **`docs/generate-qr.html`** — pick BYD or Honda from the dropdown, and it
   renders the QR image for that listing's `/go/...` redirect URL, with a
   PNG download button.

The dashboard also has an **"איפוס המונה" (reset)** button at the bottom
that permanently deletes all recorded scans after a confirmation prompt —
use it to zero the counter out (e.g. after testing, right before actually
sharing the QR for real).

## What data is collected (and what isn't)

Every scan writes exactly one Firestore document with four fields:

| field     | example    | notes                                   |
|-----------|------------|------------------------------------------|
| `ts`      | client time | set by the visitor's browser clock, roughly accurate |
| `device`  | `נייד` / `טאבלט` / `מחשב` | coarse guess from the browser's user-agent |
| `browser` | `Chrome` / `Safari` / ... | coarse guess from the user-agent |
| `listing` | `byd` / `honda` | which of the two QR codes was scanned |

**Never collected, and not possible to collect this way:** the scanning
visitor's name, phone number, email, exact location, or IP address. There is
no form, no login, and no way to tie a record back to a specific person. The
person scanning is never shown any of this — they just land on the listing
or WhatsApp chat.

Records written before the BYD/Honda split (i.e. from before this feature
existed) have no `listing` field; the dashboard treats those as BYD.

## Hosting: two mirrors of the same site

Both serve the exact same files (`docs/`) and read/write the same Firestore
project, so it doesn't matter which one you use day to day.

- **Firebase Hosting** (already deployed): <https://car-qr-counter.web.app>
- **GitHub Pages**: <https://gavishori.github.io/car-listing-qr/> — needs one
  manual setting: repo **Settings → Pages → Build and deployment → Source
  → Branch: `main`, Folder: `/docs`** (GitHub Pages can only serve from repo
  root or a folder literally named `docs`, which is why the site lives in a
  folder called `docs/`).

Either way, the URLs you actually use are:

- **BYD QR target**: `.../go/`
- **Honda QR target**: `.../go/honda/`
- **Dashboard** (open this yourself to see the counts): the bare root URL

## Generating the QR image

Open `.../generate-qr.html` on whichever host you're using, pick **BYD** or
**הונדה** from the dropdown, confirm the URL field updates accordingly, and
click **הורדה כ-PNG**.

## Redeploying after a change

- Firebase: `npx firebase-tools deploy` from this folder (requires
  `npx firebase-tools login` once).
- GitHub Pages: just `git push` — it redeploys automatically from `/docs`.

## Notes on privacy of the dashboard

The dashboard (and its reset button) sit at the site's root, and the repo is
public (required for free GitHub Pages), so anyone who finds the URL can open
it and reset the counter. Since it only ever shows anonymous counts (no
names, no PII), that's a reasonable trade-off for a personal tool — but don't
be surprised if the number moves on its own, and don't treat the count as
tamper-proof.

## Note on the WhatsApp number

`docs/go/honda/redirect.js` contains the WhatsApp number as plain text,
because the repo (and its full commit history) is public — required for free
GitHub Pages. That's presumably fine here since the number is meant to be
found by prospective buyers anyway, but it's worth being aware the number is
visible to anyone who looks at the source, not just people who scan the QR.

## Household finance dashboard (private)

`finance/` holds a separate, private household finance dashboard. Only its code
is committed; all data lives in `finance/private/`, which is git-ignored and is
never published (it sits outside `docs/`). See [`finance/README.md`](finance/README.md).
