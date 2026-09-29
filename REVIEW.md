# Code review - CORMATE / RENEE EKA Dashboard

Scope: `app.py` (read in full), the three JS files and templates (syntax + targeted scan), CSS (structure only).
Verified by running the app with Flask's test client, synthetic DataFrames and a 24-test suite (`tests/`, passes on
pandas 3.0 and on the pandas 2.3 that `requirements.txt` pins). NOT verified: real Excel/SharePoint data, the Google
Apps Script endpoint, Gemini, Render, or the Android WebView.

## Found and fixed

| # | Severity | Problem (confirmed by test) | Fix |
|---|---|---|---|
| 1 | High | No login throttling: 30 wrong passwords all answered 401 | 5 failures / 15 min per IP+email (and 30 per IP) -> 429 |
| 2 | High | State-changing POSTs accepted with a foreign `Origin` (login returned 200) | `before_request` CSRF guard on Origin / Sec-Fetch-Site |
| 3 | High | Plaintext passwords in `users.json`, default `ChangeMe@2026` | Hashed; `tools/hash_password.py`; startup warning if plaintext remains |
| 4 | High | A SHA-256 `password_hash` (documented as supported) could never verify - werkzeug rejects the format | Legacy hex digest now verified explicitly |
| 5 | Med | Removing/disabling a user did nothing until their cookie expired; no session lifetime | Access re-checked from `users.json` every request; 12 h lifetime (`SESSION_HOURS`) |
| 6 | Med | `next` deep-link was captured but never used; would have been an open redirect if wired naively | Deep-link preserved, same-site paths only |
| 7 | Med | Raw exception text returned to clients (file paths, library internals) | `_fail()` logs the traceback, returns a generic message (deliberate `RuntimeError` config messages kept) |
| 8 | Med | Garbage quantity (`"abc"`, `nan`, `inf`) -> HTTP 500; unbounded row count | Validated -> HTTP 400; row and size caps |
| 9 | Med | Global caches shared by 4 threads with no lock: simultaneous requests re-download the workbook and share one non-thread-safe `ExcelFile` | Locks (mapping path kept independent so it stays fast) |
| 10 | Med | `NOD` column came out as dtype `object` (`pd.NA` leak) | Float-safe calculation |
| 11 | Med | EANs stored as numbers in Excel (`8901234567890.0`) fail to join to text EANs -> variance silently misses rows | EAN normalised on load and in join keys |
| 12 | Med | Remote submission outage swallowed by `except: return DataFrame()` -> variance quietly shows "no submissions" | Logged with traceback |
| 13 | Med | Admin could not use Field Entry (admin email is never in the mapping, so 404/403) | Admin sees all mapped stores |
| 14 | Low | Comment on Stock Variance sign was inverted (positive = calculated closing is *higher*) | Corrected |
| 15 | Low | Two dead duplicate function definitions (`_ai_prepare_stock`, `_ai_filter_stock`) | Removed |
| 16 | Low | CSV export vulnerable to spreadsheet formula injection (`=HYPERLINK(...)` in a product name) | Neutralised |
| 17 | Low | CSS cache-bust numbers hand-bumped and already inconsistent (`v47/48/49` across pages; notes said v46) | Automatic, from file mtime |
| 18 | Low | Expired session showed cryptic "unexpected response" errors | 401 -> redirect to sign-in |
| 19 | Low | Missing HSTS / Permissions-Policy; authenticated HTML cacheable | Added; `no-store` on HTML; `/healthz` for Render |

## Deliberately NOT changed (needs your decision or a bigger job)

- **`NOD = 0` when a SKU has stock but zero sales.** Reads as "sells out today"; really infinite cover. Changing it
  alters bucket/chart behaviour, so it needs a product decision (e.g. a separate "No sales" bucket).
- **Submissions in SQLite on Render's ephemeral disk are lost on every redeploy** unless you attach a persistent disk
  or use `SUBMISSION_API_URL`.
- **`/api/ai/chat` has no per-user rate limit** - each call spends Gemini quota, and aggregated stock data is sent to Google.
- **No Content-Security-Policy**: every template uses inline scripts/styles; needs a nonce refactor.
- **`GET /logout`** can be triggered cross-site (nuisance only; kept because the UI links to it).
- **Maintainability:** `app.py` is one 1,700-line file (split into blueprints: auth, entry, inward, analytics);
  `dashboard.css` has 371 `!important` and stacked "FINAL / GLOBAL FINAL" override blocks (consolidate); `app.js` uses
  very long one-line functions; the whole stock dataset is shipped to the browser on every load (fine now, will not scale).
- The 44 `innerHTML` uses all sit next to an `esc()` helper, but I did not audit each one for missing escaping.
- Login limiter and caches are per-process (correct for the current single-worker Procfile; use Redis if you scale out).

## Before you deploy
1. Rotate `ChangeMe@2026` (it is in this zip / your git history - treat as compromised) with `tools/hash_password.py`.
2. Set `SECRET_KEY`, `ADMIN_PASSWORD` (see `.env.example`).
3. Keep the repo private; `users.json` still holds password hashes and real email addresses.
4. Smoke-test Field Entry submit, the variance page and one PDF export against your real workbook.
5. `pip install -r requirements-dev.txt && pytest`
