# Stock Entry update

Files changed: `static/entry.js`, `static/dashboard.css` (appended), `templates/entry.html`, `app.py` (new endpoints + submit check), `.env.example`, tests.

## What the user sees
- **Numeric-only qty** (digits only, no letters/`.`/`-`/`e`; empty = 0; Enter/"Next" jumps to the next box).
- **15-minute timer** from opening the SKU list. At 3:00 left an amber prompt asks them to Save Draft. At 0:00 the draft is saved and a dialog offers "Keep counting (+15 min)" / "Finish later". The clock is kept by the **server**, so reloading the page or changing phone does not reset it, and it cannot be cheated by the phone clock.
- **Draft + auto-save** on the device (0.6 s after each keystroke) **and on the server** (a few seconds later). Opening the same shop restores the newest copy, even after cleared app data or on another phone. The draft is deleted only after a successful submit (or Discard). Header shows "Draft auto-saved • time • synced".
- **Search keyboard fix**: the search box is never rebuilt while typing, so the keyboard stays open. `123 / ABC` button switches pad/keyboard without closing it.
- **Review before submit**: totals, every entered SKU, warnings for quantities >= 500 (`BIG_QTY`) or Tester higher than Stock, count of SKUs left blank (with "Show them"). Tap a row to go back and fix it. Every Submit button goes through this screen.
- **Offline-safe submit**: if the connection drops, the entry is kept on the phone (banner "Waiting to send"), and sent automatically when online (also "Send now"). A retry can never double-count (the server ignores a repeated entry number).
- **Camera barcode scan** (📷 Scan): jumps to the SKU and focuses its Stock box; a leading-zero difference (UPC-A vs EAN-13) still matches; a code that is only in SKU Master is added; unknown codes are reported. Manual EAN box as fallback.
- **Stable order**: rows stay in catalogue order while counting (no jumping). "Order: Catalogue / Highest total" toggle is opt-in. **Next uncounted ↓** continues after the SKU last worked on. All / Entered / Not entered chips.
- Sign-out pushes the latest draft, then removes device copies the server already holds (shared phones).
- Larger, more readable small print on phones; sticky session bar; set-up panels hidden while counting.
- System stock is intentionally NOT shown anywhere on this screen.

## Server (app.py)
- `GET/PUT/DELETE /api/draft` — per signed-in email + shop; checks the shop is mapped to that email; numbers sanitised/clamped; an older device cannot overwrite a newer draft.
- `POST /api/entry-session` (`start` keeps a running session, `extend` restarts it) — server-side 15-min clock.
- `POST /api/submit` returns `409 {code:"session_expired"}` when the session ran out (+60 s grace) unless extended; admins are exempt; a submit with no session record still works. A successful submit deletes that shop's draft and session.
- Settings (env): `ENTRY_SESSION_SECONDS=900`, `ENTRY_SESSION_GRACE_SECONDS=60`, `ENTRY_SESSION_ENFORCE=1` (set 0 to make the timer advisory only).
- **Important:** drafts live in the same SQLite file as `DATABASE_PATH`. If the host disk is ephemeral (e.g. Render free tier) point `DATABASE_PATH` to a persistent disk, otherwise server drafts reset on redeploy (the phone keeps its own copy as a fallback).

## Not changed / not possible from the data
- Brand/category filters: the SKU data has no brand or category column, so there is nothing to filter on.
- Camera scanning needs the camera permission. In the Android APK the native app must allow camera access for the web view; if it does not, the scanner shows a message and the typed-EAN box still works. Not testable in the headless test browser (no camera).

## Tests
`pytest tests/` — backend (drafts, timer, enforcement) and `tests/test_entry_e2e.py` (browser: keyboard focus, numeric qty, review, offline queue, server-draft restore, stable order, scan, next-uncounted, timer enforcement, sign-out). The e2e file is skipped automatically if Playwright is not installed.
