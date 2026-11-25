# CORMATE Upload Audit Trail — V7

This build adds a permanent audit trail without changing the existing master upload flow.

## What is recorded

Every remote stock/PDF upload or field submission gets an `Audit ID` and a receipt hash. The `Upload Audit` sheet records:

- Audit ID
- Event date/time
- Status: SUCCESS / FAILED / DUPLICATE
- Action
- Entry / Submission number
- Target email
- Store
- Submitted by / Issued by
- Submission mode
- Original file name and type
- File size
- Saved SKU row count
- Client IP (best-effort, proxy-aware)
- User agent / device browser string
- Google Drive file ID + URL
- Error message, if failed
- Receipt hash

## Google Sheets tabs

- `Submissions` — existing SKU-level records
- `PDF Uploads` — existing PDF upload records
- `Upload Audit` — new audit/proof ledger

## One-time deployment

1. Replace the Apps Script code with `Google_Apps_Script_Submissions_v6.gs`.
2. Run `authorizeOnce()` once and approve Drive/Sheets permissions.
3. Optional: run `backfillAuditOnce()` once to create `LEGACY-*` audit records for submissions/uploads that existed before this audit feature. Historical IP/device values are intentionally left blank.
4. Deploy a **new Web App version** with Execute as **Me** and access **Anyone**.
5. Keep the existing Render `SUBMISSION_API_URL` and `SUBMISSION_API_SECRET` values unchanged.
6. Deploy the new Render ZIP.

## Proof

After a successful upload, the user sees:

- Submission ID / Entry No.
- Audit ID
- Uploaded By
- Store
- Timestamp
- Original Google Drive file link

Admin → **Upload Audit & Proof** shows the permanent audit ledger.

## Important

This does not fabricate identity information. IP/device values are only recorded when the browser/proxy provides them. The strongest proof is the combination of Audit ID + timestamp + email + store + original Drive file + receipt hash.
