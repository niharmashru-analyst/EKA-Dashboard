# SKU 360 Dashboard — Stock vs Sales + Variance + Field Entry

## Workbook structure
Use one linked Excel workbook with these sheets:

- `Stock_Data`
- `Variance_Data`
- `User_Shop_Map`
- `SKU_Master`

`Stock_Data` drives Stock vs Sales, Pareto and Forecast.
`Variance_Data` drives movement reconciliation.
`User_Shop_Map` maps field-staff email IDs to shops.
`SKU_Master` is the only source allowed for adding extra SKUs in the field form.

## Forecast
- Top 10 = L3M Avg Qty × 2
- Top 25 = L3M Avg Qty × 1.5
- Others = L3M Avg Qty × 1

The dashboard calculates `Forecast Qty` automatically. `Ideal Stock` is retained from Excel; if it is blank/missing, Forecast Qty is used as the fallback.

## Render environment variables
Required:
- `EXCEL_URL` = public/downloadable link to the workbook

Optional:
- `EXCEL_SHEET=Stock_Data`
- `VARIANCE_EXCEL_URL` = separate workbook link if variance is maintained separately
- `VARIANCE_SHEET=Variance_Data`
- `CACHE_SECONDS=300`

Field-entry storage options:
1. Recommended: Google Apps Script + Google Sheet. Set `SUBMISSION_API_URL` and `SUBMISSION_API_SECRET`.
2. Fallback: SQLite. Set `DATABASE_PATH=/var/data/submissions.db` only if your Render service has a persistent disk mounted at `/var/data`.

Field staff URL is the same Render service plus `/entry`.

## Local run
```bash
pip install -r requirements.txt
flask --app app run
```

## Git update
```bat
git status
git add .
git commit -m "Update SKU dashboard with forecast variance and field entry"
git pull --rebase origin main
git push origin main
```
If `git pull --rebase` reports local uncommitted changes, commit them first.
