# CORMATE Manual Submission

## Shareable user link
After deployment, share:

`https://YOUR-DOMAIN/manual-upload`

Users do not need a password for this fallback page. They enter their registered email, select one of their mapped shops, upload `.xlsx`, `.xlsm` or `.csv`, choose the EAN header and Quantity header, and submit.

## Validation
- Email must exist in `data/users.json` and be Active/Enabled.
- Shop must be mapped to that email in `data/mapping.json`.
- File must be Excel/CSV.
- EAN and Quantity headers must be selected.
- Rows with blank/zero quantity or EANs that cannot be matched to the master/store SKU data are skipped.
- Duplicate EAN rows in one upload are summed.
- Submission is written with `submission_mode=manual_upload` and `submitted_by=<user email>`.

## Admin-generated links
The older admin-generated temporary links remain supported with `?t=...` for backward compatibility.


## PDF backup upload
The same `/manual-upload` link also accepts a previously downloaded Stock Verification PDF. Users enter email, select shop, and click **Upload Stock Verification PDF**; no EAN/Quantity mapping is required. The PDF is stored in the Google Apps Script owner's Drive in `CORMATE Stock Verification PDFs` and indexed in the `PDF Uploads` sheet. Deploy the updated `Google_Apps_Script_Submissions_v4_Admin.gs` and keep the same `SUBMISSION_API_URL`/secret configured in Render.
