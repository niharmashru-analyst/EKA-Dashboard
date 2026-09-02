# SKU 360 — Render-ready Excel dashboard

This is a standalone Flask dashboard built using the attached Modern Trade dashboard as the UI/interaction reference. It does **not** depend on the old dashboard files or its multiple Excel workbooks.

## Required Excel columns

Type | Store Name | EAN Code | Product Name | Pareto | Stock | Total MRP Value | L3M Avg Qty | L3M Avg Value | NOD

The app validates these headers when it loads the workbook.

## What is included

- Dark, high-contrast RENÉE-style analytical UI inspired by the reference ZIP
- Overview KPIs
- Pareto MRP mix chart
- Stock vs L3M Avg Qty analysis
- Top SKU stock-value view
- Store stock distribution
- SKU Explorer
- Store Analysis
- Complete table with all 10 source columns
- Filters: Type, Store Name, Pareto, Product/EAN search
- CSV export
- Refresh Excel button
- 5-minute server-side cache
- Responsive layout
- Local ECharts copy; no dependency on a chart CDN
- Render Procfile + Gunicorn

## Render deployment

1. Upload this folder to a GitHub repository.
2. In Render, create **New → Web Service** and select the repository.
3. Runtime: Python.
4. Build Command:
   `pip install -r requirements.txt`
5. Start Command:
   `gunicorn app:app --bind 0.0.0.0:$PORT`
6. Add Environment Variable:
   `EXCEL_URL = <your public Excel/OneDrive/SharePoint file link>`
7. Optional:
   `EXCEL_SHEET = Sheet1`
8. Optional:
   `CACHE_SECONDS = 300`
9. Deploy.

### Important about the Excel link

The Render server must be able to download the workbook without an interactive Microsoft login. Use a publicly accessible OneDrive/SharePoint/Excel file link. The app automatically tries a `download=1` variant as a best-effort Microsoft link conversion.

If the link requires your personal Microsoft login, Render cannot access it. In that case, use a public/shared download link or connect the data source through an authenticated API.

## Updating the dashboard

Replace/update the same Excel workbook at the linked location. Open the dashboard and press **Refresh Excel**. The server re-downloads the workbook and rebuilds the dashboard.

## Local test

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
$env:EXCEL_URL="YOUR_PUBLIC_EXCEL_LINK"
python app.py
```

Open http://127.0.0.1:5000
