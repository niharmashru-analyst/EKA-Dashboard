# EKA Dashboard — Final

## Pages
- Overview — Qty and Value KPIs; LY vs L3M Average vs Current Month; EBO/Kiosk/Airport charts.
- SKU Explorer — Unique SKU, Stock Qty, Stock Value, NOD count; Top 10/Top 25 stock vs L3M/CM/LY; sales momentum; clickable shop detail with search/filter.
- Store Analysis — store KPIs, stock/run-rate, sales momentum, NOD distribution, type-wise performance; clickable SKU detail with search/filter.
- Data Table — full Stock_Data table with Forecast Qty and persistent column-sequence control.
- Variance Analysis — Qty/Value switch, Opening + Inward - Tertiary reconciliation, live field submissions, actual-vs-system closing difference, issue filter and CSV export.
- Field Entry — separate `/entry` URL for field staff, with a sidebar of two pages: **Physical Stock Entry** and **Inward Validation**; email-to-shop mapping, 25 SKUs/page, master SKU search/add, live counts, Stock + Tester + Total, verified submission popup.

## Inward Validation (`/entry`, sidebar → Inward Validation)
Field staff enter their company email + a PO number and press **Fetch**. The dashboard reads that PO's SKUs and order qty from the linked inward sheet, staff type the qty actually received per SKU, and on **Submit** a variance CSV (Order vs Received, Short / Excess / Match) downloads.

Environment:
- `INWARD_EXCEL_URL` — link to the inward sheet. Works with Google Sheets, Google Drive, OneDrive/SharePoint, or any direct `.xlsx` / `.csv` link. Google Sheets must be shared as *Anyone with the link → Viewer*. Change the link any time (then restart) to point at a different sheet.
- `INWARD_SHEET` (optional) — tab name. If omitted or not found, the first tab that has the required columns is used.
- `INWARD_CACHE_SECONDS` (optional, default `60`) — how long the sheet is cached. A PO that isn't found triggers one automatic refresh.
- `INWARD_SUBMISSION_API_URL` (optional) — Apps Script `/exec` URL; each submission is appended to an `Inward_Validation` tab. Use the same URL as `SUBMISSION_API_URL` after redeploying the updated `apps_script.gs` (Deploy → Manage deployments → New version), or deploy the script on any other Google Sheet. If not set, submissions are saved to the local SQLite database instead (lost when Render redeploys — the CSV is unaffected).

Inward sheet columns (header names are matched flexibly; title rows above the header are fine): PO Number (`PO No`, `Purchase Order`…), EAN Code (`SKU`, `Barcode`…), Product Name (`SKU Name`, `Description`…), Order Qty (`PO Qty`, `Quantity`…). Optional: Vendor / Supplier, PO Date, Location / Warehouse — shown above the table. A PO with the same SKU on several lines is merged into one line.

The email must be mapped in `User_Shop_Map`, same as Physical Stock Entry. Order qty is always re-read from the sheet on submit, never taken from the browser.

## NOD rule
NOD is never averaged. It is calculated from current stock and L3M average sales:
`NOD = Current Stock Qty × 31 ÷ L3M Avg Sales Qty`

## Forecast rule
- Top 10 = L3M Avg Qty × 2 months
- Top 25 = L3M Avg Qty × 1.5 months
- Others = L3M Avg Qty × 1 month

## Workbook sheets
`Stock_Data`, `Variance_Data`, `User_Shop_Map`, `SKU_Master`.

Stock_Data recommended columns:
`Type, Store Name, EAN Code, Product Name, Pareto, Stock, Total MRP Value, L3M Avg Qty, L3M Avg Value, LY Qty, LY Value, Current Month Qty, Current Month Value, Status, Ideal Stock`

Variance_Data required columns:
`Store Name, EAN Code, Product Name, Opening Stock Qty, Inward Qty, Tertiary Qty, Closing Stock Qty, Opening Stock Value, Inward Value, Tertiary Value, Closing Stock Value`

User_Shop_Map: `Email ID, Store Name`
SKU_Master: `EAN Code, Product Name`

## Render environment
Required:
- `EXCEL_URL`
- `SUBMISSION_API_URL`
- `SUBMISSION_API_SECRET`
- `SMTP_USER` — Gmail/Google Workspace account used to send submission emails
- `PASS_KEY` — Gmail App Password for `SMTP_USER` (or use `SMTP_PASS`)
- `NOTIFY_EMAIL` — office recipient email; if omitted, email is sent to `SMTP_USER`

**Important:** `PASS_KEY` alone is not enough. Render must also know which mailbox to authenticate (`SMTP_USER`) and where to send the notification (`NOTIFY_EMAIL`).

Optional:
- `EXCEL_SHEET=Stock_Data`
- `VARIANCE_EXCEL_URL`
- `VARIANCE_SHEET=Variance_Data`
- `CACHE_SECONDS=300`

Field URL: `https://YOUR-RENDER-URL/entry`

## Google Apps Script
Deploy `apps_script.gs` as a Web App:
Execute as: Me
Who has access: Anyone
Use the `/exec` URL as `SUBMISSION_API_URL` and keep `SUBMISSION_API_SECRET` identical to `SECRET`.

## Git update
```bat
git add .
git commit -m "Final dashboard analytics and field entry update"
git push origin main
```
