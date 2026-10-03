# Submission History v3

This update adds:
- Entry Number for every stock submission.
- Submission History on the Entry page.
- Click an Entry Number to see SKU-wise Stock / Tester / Total.
- Only rows with Total > 0 are stored and displayed.
- Current System Stock from `Stock_Data` is shown while entering new quantities.
- Existing submissions remain visible through the mapped shops.

## Apps Script

If `SUBMISSION_API_URL` is configured in Render, replace the existing Apps Script code with `Google_Apps_Script_Submissions_v6.gs` and deploy a new Web App version.

Keep the same `SECRET` value as Render's `SUBMISSION_API_SECRET`.

The script migrates an older `Submissions` tab by adding the `entry_no` column.

## Important

Old rows that were saved before Entry Number support may not have an `entry_no`. The website groups those historical rows by their submission timestamp and still displays them in history.


## Important
If Render still points to an older Apps Script deployment, redeploy the updated script and make sure SUBMISSION_API_URL points to the new /exec deployment URL.

Regular field users see only their own submissions for their mapped shops. Admin sees all submissions. History filters out Total = 0 rows.

## Admin Control Center / v4

The current build includes full admin operations at `/admin`, including user CRUD, shop master, shop assignment, admin stock upload, secure manual upload links and submission audit.

If remote submissions are enabled, use `Google_Apps_Script_Submissions_v6.gs` and deploy a new Web App version. It is backward-compatible with the older submission columns and migrates the `Submissions` sheet to the v4 audit schema.
