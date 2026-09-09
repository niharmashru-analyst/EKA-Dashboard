# EKA Dashboard — Final

## Pages
- Overview — Qty and Value KPIs; LY vs L3M Average vs Current Month; EBO/Kiosk/Airport charts.
- SKU Explorer — Unique SKU, Stock Qty, Stock Value, NOD count; Top 10/Top 25 stock vs L3M/CM/LY; sales momentum; clickable shop detail with search/filter.
- Store Analysis — store KPIs, stock/run-rate, sales momentum, NOD distribution, type-wise performance; clickable SKU detail with search/filter.
- Data Table — full Stock_Data table with Forecast Qty and persistent column-sequence control.
- Variance Analysis — Qty/Value switch, Opening + Inward - Tertiary reconciliation, live field submissions, actual-vs-system closing difference, issue filter and CSV export.
- Field Entry — separate `/entry` URL for field staff; email-to-shop mapping, 25 SKUs/page, master SKU search/add, live counts, Stock + Tester + Total, verified submission popup.

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
