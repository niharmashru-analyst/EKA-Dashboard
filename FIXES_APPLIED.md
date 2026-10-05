# Fixes applied (stability, speed, visibility)

## Root causes found
| Symptom | Cause | Fix |
|---|---|---|
| Whole app slow / "not responding" | Data cache had no locking: when it expired, every open page re-downloaded and re-parsed the Excel at the same time, and only 4 server threads existed, so a few slow requests blocked everyone. | Thread-safe cache with **stale-while-revalidate** (old data is served instantly while one background job refreshes), one rebuild shared by all requests, start-up warm-up, 8 threads, response bodies built + gzipped once per data version, static files gzipped and cached. |
| Random errors on the home page | A shared Excel reader object was swapped while another request was using it (`NoneType` errors); `localStorage` call at the top of `app.js` crashes in some WebViews; a 502/504 while the server woke up showed an error immediately. | No shared reader; safe storage helper; GET requests retry 3x with timeout; 401 redirects to sign-in. |
| Admin panel very slow | `/api/admin/config` waited for the **entire Google Sheet** of submissions before returning anything. | Config returns instantly; submissions load afterwards from `/api/admin/submissions` (cached, shows "Loading…", has Retry). Writes disable their button while running. Shop save no longer publishes to GitHub twice. |
| Admin edits made the site restart / lose data | Every admin save committed to GitHub, which triggers a Render redeploy (restart, cold cache, local SQLite file wiped). | Commits now carry `[skip render]`. |
| Punched stock not visible | (1) Any failure fetching submissions was silently turned into "no entries"; (2) EAN codes stored as numbers in Excel (`8901234567890.0`) never matched submitted EANs, so variance showed no actuals; (3) history only showed entries under the exact same email; (4) dates in mixed formats sorted wrongly and one invalid date broke the whole list; (5) retries after a timeout created duplicates or nothing. | One submissions normaliser + cache; stale data served if the sheet is down; entries just saved are shown immediately (kept in memory 30 min); EANs normalised everywhere; history shows entries for the user's mapped shops (`HISTORY_SCOPE=own` to restore old behaviour); ISO dates; idempotent entry numbers so retry/double-tap never duplicates; real error + Retry button instead of a blank list. |
| Admin not responsive on phones | Tables forced 880px width, modals not mobile-sized. | Tables become cards <700px, bottom-sheet modals, 16px inputs, sticky tabs, progress bar. |

## New / changed settings (all optional)
`SUBMISSIONS_CACHE_SECONDS` (20) · `HISTORY_SCOPE` (`shop`|`own`) · `HISTORY_MAX_ENTRIES` (60) · `MIN_FORCE_INTERVAL` (20) · `WARMUP` (1) · `MAPPING_JSON_PATH` · `TRUST_PROXY` (1) · `MAX_SUBMIT_ROWS` (5000)

## Still needs action on your side
1. **Submissions storage.** If `SUBMISSION_API_URL` (Google Apps Script) is NOT set, entries live in a local SQLite file that Render deletes on every redeploy/restart. Set `SUBMISSION_API_URL`, or attach a persistent disk and point `DATABASE_PATH` at it. The Admin > Settings tab now warns about this.
2. **Render free plan sleeps** after ~15 min idle (30-60 s first load). Ping `https://<your-app>/healthz` every 10 min (UptimeRobot) or use a paid instance.
3. **Passwords:** `data/users.json` still holds plaintext passwords (`Admin@123`, etc.). Move to hashes via the Admin panel (saving a user with a new password stores a hash).
4. `tests/_outdated_test_app.py.txt` tests features this code base does not have (login throttling, CSRF); new tests are in `tests/test_stability.py`.


## Master Manual Upload Link
- `/manual-upload` is now the single shared manual upload URL.
- Users enter registered email + assigned shop.
- Email/shop is validated against `data/mapping.json`.
- Legacy signed links remain supported.

## V7 — Upload Audit & Proof
- Added permanent `Upload Audit` Google Sheet.
- Added Audit ID and receipt hash to successful submissions.
- Records uploader, target email, shop, submission mode, file metadata, Drive reference, timestamp, IP/user-agent when available, and failures/duplicates.
- Added Admin Control Center audit ledger and Drive proof links.
- Added user-facing submission receipt after manual upload.
- Added one-time historical `backfillAuditOnce()` helper.
