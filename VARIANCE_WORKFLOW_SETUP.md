# CORMATE Stock Variance Workflow Setup

## Data source
The workflow uses the existing linked Excel configuration (`EXCEL_URL` / `VARIANCE_EXCEL_URL`) and the current `Variance_Data` source. No separate variance input workbook is introduced. The current source mapping is `Inward Qty` as Primary, plus `Opening Stock Qty`, minus `Tertiary Qty`; this produces Derived Stock. Stage 1 compares Derived Stock with `Closing Stock Qty` (System Stock). Stage 2 compares latest physical submission (`Stock + Tester`, stored as Total) with System Stock. Verify that `Inward Qty` represents Primary in your source workbook before production rollout.

## HOD access
Add `HOD_EMAIL` to Render Environment Variables with the HOD's exact login email. The HOD must have an active user account in `data/users.json`; HOD_EMAIL grants access to the variance workflow and is the only identity authorised by Flask to approve/reject cases. Admin can view all cases but cannot approve/reject. Do not share the HOD account.

## Persistent case storage (required)
Variance cases are stored in the Google Apps Script spreadsheet, in a new `Variance Cases` sheet. Render local JSON/SQLite is intentionally not used for this workflow because Render local storage may be ephemeral.

1. Open the Apps Script currently deployed at `SUBMISSION_API_URL`.
2. Replace its code with the updated `Google_Apps_Script_Submissions_v6.gs` from this ZIP.
3. Keep the existing secret configuration unchanged.
4. Run `authorizeOnce()` if Apps Script asks for authorisation.
5. Deploy > Manage deployments > Edit > **New version** > Deploy. Keep the same web app URL.
6. In Render, verify `SUBMISSION_API_URL` and `SUBMISSION_API_SECRET` are still correct and add `HOD_EMAIL`.
7. Redeploy the Flask app.

## Workflow
- Field users see variance items for their mapped shops and can raise a case with updated stock and required remarks.
- Each case receives an ID and starts as `Pending HOD`; its timeline is retained in Google Sheets.
- Only the configured HOD can approve/reject. Rejection requires remarks in the UI.
- Admin can view the complete case list/timeline but cannot action a decision.

## Dashboard Action Centre
The Overview now surfaces exception counts based on currently filtered live Excel rows: dead stock, possible stock-outs, >60 days cover, and material current-month quantity decline versus LY. These are diagnostic flags for review, not automatic business decisions.
