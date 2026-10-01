# Submission History v2

This update adds:
- Entry Number for every stock submission.
- Submission History on the Entry page.
- Click an Entry Number to see SKU-wise Stock / Tester / Total.
- Only rows with Total > 0 are stored and displayed.
- Current System Stock from `Stock_Data` is shown while entering new quantities.
- Existing submissions remain visible through the mapped shops.

## Apps Script

If `SUBMISSION_API_URL` is configured in Render, replace the existing Apps Script code with `Google_Apps_Script_Submissions_v2.gs` and deploy a new Web App version.

Keep the same `SECRET` value as Render's `SUBMISSION_API_SECRET`.

The script migrates an older `Submissions` tab by adding the `entry_no` column.

## Important

Old rows that were saved before Entry Number support may not have an `entry_no`. The website groups those historical rows by their submission timestamp and still displays them in history.
