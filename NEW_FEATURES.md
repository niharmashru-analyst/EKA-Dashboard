# New in this version
1. **Sales Dashboard** (`/sales`, right: *sales*) - Outlet logins see only their mapped outlet(s); HO/admin/dashboard users see all outlets, ranking and an outlet filter. Target vs Achievement, Pending, % achieved, needed-per-day, projection, SKU-wise sales joined with SKU-wise stock at the outlet (out / low cover / overstock).
   Data: Admin > Upload > "Sales data" (or `SALES_EXCEL_URL`). Download the template there. Columns are recognised by heading (Outlet, Month, Target, Achievement, EAN Code, Product Name, Qty, Net Sales).
2. **Dark / Light / Auto theme** - button on every page, remembered per device.
3. **Master SKU JSON** - `/api/master-skus.json` (ETag, gzip). Entry screen now reads it and caches it on the device. External systems: set `MASTER_JSON_TOKEN`.
4. **Stock Reports** (`/reports`, right: *reports*) - pick outlets / all outlets / latest per outlet / one submission (entry no.), optional dates, download Excel (one sheet per outlet) or CSV.
Grant the new rights in Admin > Users (Sales, Reports checkboxes).
