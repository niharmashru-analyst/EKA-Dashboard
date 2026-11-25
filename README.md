# RENEE E.K.A. — field stock, sales & reports

Flask app (`app.py` + `extras.py`), Jinja templates, vanilla JS. Run: `pip install -r requirements.txt && gunicorn app:app` (see `Procfile`). Tests: `pip install -r requirements-dev.txt && pytest tests/`.

## Workspaces (access rights, set per user in Admin → Users)
| Right | Page | What it does |
|---|---|---|
| `stock_entry` | `/entry` | Field stock count: auto-save every 3 min (green chip), drafts, review-before-submit, barcode scan, offline queue |
| `dashboard` | `/` | Analytics dashboard (all outlets) |
| `sales` | `/sales` | Target vs achievement, pending, SKU sales + stock. Outlet logins see only their outlet(s); HO/admin/dashboard see all, with channel + outlet filters and Excel export |
| `reports` | `/reports` | Download punched stock (Excel/CSV): chosen outlets, all, latest per outlet, or one entry no. Flags outlets that have not punched |
| `admin` | `/admin` | Users, shops, uploads, sales link, outlet-name matching |

## Key settings (environment)
`SECRET_KEY`, `ADMIN_PASSWORD`, `EXCEL_URL` (stock/master workbook), `DATABASE_PATH` and `SALES_FILE` (put both on a persistent disk), `SALES_EXCEL_URL` or paste a SharePoint link in Admin, `MASTER_JSON_TOKEN`, `REPORT_TZ`. See `.env.example`.

## Also
* Theme: Dark / Light / Auto button on every page. One typeface (Inter).
* Installable: open the site on a phone → Add to Home Screen (manifest + static-file cache; pages and APIs are never cached).
* `GET /api/master-skus.json` — SKU master feed (login, or `MASTER_JSON_TOKEN`). `GET /healthz` — uptime check.
* More notes in `docs/`.
