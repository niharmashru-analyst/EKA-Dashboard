"""
Extra workspaces, registered into the main app:

  1. Master SKU JSON feed     GET /api/master-skus.json
  2. Stock Reports  (right: "reports")   /reports  + /api/reports/*   -> Excel / CSV downloads of punched stock
  3. Sales Dashboard (right: "sales")    /sales    + /api/sales/*     -> target vs achievement, SKU sales, outlet stock

Kept in its own file so app.py does not grow further. app.py calls  extras.register(<app module>)  once at the end.
"""
import io, os, re, json, time, hmac, gzip, hashlib, threading, logging
from datetime import datetime, timezone

import pandas as pd
from flask import jsonify, render_template, request, Response, session

log = logging.getLogger("eka.extras")

MASTER_JSON_TOKEN = os.getenv("MASTER_JSON_TOKEN", "").strip()           # optional: lets another system read the feed without a login
REPORT_TZ = os.getenv("REPORT_TZ", "Asia/Kolkata")
REPORT_MAX_ROWS = int(os.getenv("REPORT_MAX_ROWS", "400000"))
SALES_EXCEL_URL = os.getenv("SALES_EXCEL_URL", "").strip()
SALES_FILE = os.getenv("SALES_FILE", "").strip()      # where an admin-uploaded workbook is kept (point at a persistent disk)
SALES_CACHE_SECONDS = int(os.getenv("SALES_CACHE_SECONDS", "300"))


def _canon(s):
    return re.sub(r"[^a-z0-9]+", "", str(s or "").lower())


def _okey(s):
    """Outlet match key: 'RENEE - AHMEDABAD EBO', 'Ahmedabad EBO' and 'Delhi T2' / 'Delhi T-2' compare equal;
    a leading RENEE brand and a trailing KIOSK are ignored (ZED is a different brand and is kept)."""
    k = _canon(s)
    if k.startswith("renee"): k = k[5:]
    if k.endswith("kiosk") and len(k) > 5: k = k[:-5]
    return k


def _ean_key(s):
    """EAN-13 and UPC-A differ only by a leading zero; compare on the digits without leading zeros."""
    return re.sub(r"\D", "", str(s or "")).lstrip("0")


def _bearer():
    h = request.headers.get("Authorization", "")
    return h[7:].strip() if h.lower().startswith("bearer ") else ""


def register(A):
    app = A.app
    require_access = A.require_access

    # ======================================================================
    # 0. Installable app (PWA): manifest + a tiny service worker that only caches /static files
    # ======================================================================
    @app.get("/manifest.webmanifest")
    def pwa_manifest():
        m = {"name": "RENEE E.K.A.", "short_name": "E.K.A.", "start_url": "/choose", "scope": "/", "display": "standalone", "orientation": "portrait",
             "background_color": "#080808", "theme_color": "#080808", "description": "Stock entry, sales and reports for RENEE outlets.",
             "icons": [{"src": "/static/assets/icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any"}, {"src": "/static/assets/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any maskable"}]}
        r = Response(json.dumps(m), mimetype="application/manifest+json"); r.headers["Cache-Control"] = "public, max-age=3600"; return r

    SW_JS = """const C='eka-static-v1';
self.addEventListener('install',e=>self.skipWaiting());
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==C).map(x=>caches.delete(x)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',e=>{const u=new URL(e.request.url);
  if(e.request.method!=='GET'||u.origin!==location.origin||!u.pathname.startsWith('/static/')||u.pathname.startsWith('/static/downloads/'))return;   // pages and APIs always go to the network
  e.respondWith(caches.open(C).then(c=>c.match(e.request).then(hit=>{const net=fetch(e.request).then(r=>{if(r.ok)c.put(e.request,r.clone());return r}).catch(()=>hit);return hit||net})))});
"""

    @app.get("/sw.js")
    def pwa_sw():
        r = Response(SW_JS, mimetype="application/javascript"); r.headers["Cache-Control"] = "no-cache"; r.headers["Service-Worker-Allowed"] = "/"; return r

    # ======================================================================
    # 1. MASTER SKU JSON
    # ======================================================================
    def _master_blob():
        master = A.load_master(False)

        def build():
            df = master.fillna("")
            return {"ok": True, "generated_at": datetime.now(timezone.utc).isoformat(), "count": int(len(df)),
                    "columns": [str(c) for c in df.columns], "skus": df.astype(str).to_dict(orient="records")}
        return A._json_blob("master_json", master.attrs.get("_gen", 0), build)

    @app.route("/api/master-skus.json", methods=["GET", "HEAD"])
    def master_skus_json():
        """The SKU master as JSON. Signed-in users read it with their session; another system can use MASTER_JSON_TOKEN
        (?token=… or Authorization: Bearer …). Supports ETag / If-None-Match so repeat reads cost almost nothing."""
        if not session.get("user_email"):
            supplied = request.args.get("token", "") or _bearer()
            if not (MASTER_JSON_TOKEN and supplied and hmac.compare_digest(supplied, MASTER_JSON_TOKEN)):
                return jsonify({"ok": False, "error": "Authentication required."}), 401
        try:
            blob = _master_blob()
            etag = '"' + hashlib.sha1(blob["raw"]).hexdigest()[:20] + '"'
            if request.headers.get("If-None-Match") == etag:
                r = Response(status=304)
            elif "gzip" in request.headers.get("Accept-Encoding", ""):
                r = Response(blob["gz"], mimetype="application/json"); r.headers["Content-Encoding"] = "gzip"
            else:
                r = Response(blob["raw"], mimetype="application/json")
            r.headers["ETag"] = etag
            r.headers["Cache-Control"] = "private, max-age=0, must-revalidate"
            r.headers["Vary"] = "Accept-Encoding, Authorization"
            if request.args.get("download") == "1":
                r.headers["Content-Disposition"] = 'attachment; filename="master_skus.json"'
            return r
        except Exception as e:
            return A._fail(e)

    @app.get("/api/admin/master-json-info")
    def master_json_info():
        if not A._admin_required(): return jsonify({"ok": False, "error": "Admin access required."}), 403
        try:
            blob = _master_blob(); doc = json.loads(blob["raw"])
            return jsonify({"ok": True, "count": doc["count"], "columns": doc["columns"], "generated_at": doc["generated_at"],
                            "bytes": len(blob["raw"]), "token_enabled": bool(MASTER_JSON_TOKEN), "path": "/api/master-skus.json"})
        except Exception as e:
            return A._fail(e)

    # ======================================================================
    # 2. STOCK REPORTS  (access right: "reports")
    # ======================================================================
    DETAIL_COLS = ["Entry No", "Submitted At", "Outlet", "Submitted By", "EAN Code", "Product Name", "Stock", "Tester", "Total"]

    def _subs():
        df = A.get_submissions()
        df = df[df["total"] > 0].copy()
        df["_k"] = A._entry_key(df)
        return df

    def _local(ts):
        return ts.dt.tz_convert(REPORT_TZ)

    def _parse_day(v):
        try: return pd.Timestamp(str(v)[:10]) if v else None
        except Exception: return None

    def _select(args):
        """-> (DataFrame of the chosen rows, label, error). mode: latest | range | entry"""
        df = _subs()
        mode = (args.get("mode") or "range").strip().lower()
        if mode == "entry":
            nos = [x.strip() for x in args.getlist("entry_no") if x.strip()]
            if not nos: return None, "", "Choose an entry."
            return df[df["_k"].isin(nos)].copy(), (nos[0] if len(nos) == 1 else f"{len(nos)}-entries"), ""
        stores = [x for x in args.getlist("store") if x]
        if args.get("all") == "1": label = "all-outlets"
        elif stores:
            df = df[df["store_name"].isin(stores)]
            label = re.sub(r"[^A-Za-z0-9]+", "-", stores[0]).strip("-").lower() if len(stores) == 1 else f"{len(stores)}-outlets"
        else: return None, "", "Select at least one outlet (or choose all outlets)."
        d_from, d_to = _parse_day(args.get("from")), _parse_day(args.get("to"))
        if d_from is not None or d_to is not None:
            day = _local(df["_ts"]).dt.tz_localize(None).dt.normalize()
            ok = day.notna()
            if d_from is not None: ok &= day >= d_from
            if d_to is not None: ok &= day <= d_to
            df = df[ok]
        if mode == "latest" and len(df):
            ts = df.groupby("store_name")["_ts"].transform("max")
            newest = df[df["_ts"].eq(ts) | ts.isna()]
            keep = newest.groupby("store_name")["_k"].last()
            df = df[df["_k"].isin(set(keep.values)) & df["store_name"].isin(set(keep.index))]
            label += "-latest"
        return df.copy(), label, ""

    def _detail(df):
        if df.empty: return pd.DataFrame(columns=DETAIL_COLS)
        d = df.sort_values(["store_name", "_ts", "_k", "product_name"], na_position="first")
        when = _local(d["_ts"]).dt.strftime("%d-%b-%Y %H:%M").fillna(d["submitted_at"])
        by = d["submitted_by"].where(d["submitted_by"].astype(str).str.strip() != "", d["email"])
        return pd.DataFrame({"Entry No": d["_k"].where(~d["_k"].str.startswith("LEGACY-"), ""), "Submitted At": when.values, "Outlet": d["store_name"].values,
                             "Submitted By": by.values, "EAN Code": d["ean_code"].values, "Product Name": d["product_name"].values,
                             "Stock": d["stock"].values, "Tester": d["tester"].values, "Total": d["total"].values})

    def _summary(df):
        if df.empty: return pd.DataFrame(columns=["Outlet", "Entries", "SKUs", "Stock", "Tester", "Total Qty", "Last Submitted", "Last Entry No"])
        rows = []
        for store, z in df.groupby("store_name"):
            last = z.sort_values("_ts", na_position="first").iloc[-1]
            rows.append({"Outlet": store, "Entries": int(z["_k"].nunique()), "SKUs": int(z["ean_code"].nunique()), "Stock": float(z["stock"].sum()),
                         "Tester": float(z["tester"].sum()), "Total Qty": float(z["total"].sum()),
                         "Last Submitted": last["_ts"].tz_convert(REPORT_TZ).strftime("%d-%b-%Y %H:%M") if pd.notna(last["_ts"]) else str(last["submitted_at"]),
                         "Last Entry No": "" if str(last["_k"]).startswith("LEGACY-") else str(last["_k"])})
        return pd.DataFrame(rows).sort_values("Outlet").reset_index(drop=True)

    def _safe_csv(v):
        s = str(v)
        return "'" + s if s[:1] in ("=", "+", "-", "@") else s

    def _to_csv(detail):
        d = detail.copy()
        for c in ("Entry No", "Outlet", "Submitted By", "Product Name", "EAN Code"): d[c] = d[c].map(_safe_csv)
        return ("﻿" + d.to_csv(index=False)).encode("utf-8")

    def _to_xlsx(detail, summary, split, meta):
        from openpyxl import Workbook
        from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
        from openpyxl.utils import get_column_letter
        wb = Workbook(); ws = wb.active; ws.title = "Summary"
        head_fill = PatternFill("solid", fgColor="FF2B8A"); head_font = Font(bold=True, color="FFFFFF"); thin = Side(style="thin", color="DDDDDD")
        ws["A1"] = "Stock report — punched stock"; ws["A1"].font = Font(bold=True, size=14)
        for i, line in enumerate(meta, start=2): ws.cell(row=i, column=1, value=line).font = Font(color="666666")

        def put(sheet, df, top, num_cols=()):
            for j, c in enumerate(df.columns, start=1):
                cell = sheet.cell(row=top, column=j, value=c); cell.fill = head_fill; cell.font = head_font; cell.alignment = Alignment(horizontal="center", vertical="center")
            for i, row in enumerate(df.itertuples(index=False), start=top + 1):
                for j, v in enumerate(row, start=1):
                    if isinstance(v, str):
                        cell = sheet.cell(row=i, column=j); cell.value = v
                        if v.startswith("="): cell.data_type = "s"            # never let text turn into a formula
                    else:
                        cell = sheet.cell(row=i, column=j, value=(None if pd.isna(v) else (int(v) if float(v).is_integer() else float(v))))
                    if df.columns[j - 1] in num_cols: cell.number_format = "#,##0"
                    cell.border = Border(bottom=thin)
            for j, c in enumerate(df.columns, start=1):
                longest = max([len(str(c))] + [len(str(x)) for x in df.iloc[:400, j - 1].tolist()]) if len(df) else len(str(c))
                sheet.column_dimensions[get_column_letter(j)].width = min(46, max(10, longest + 2))
            sheet.freeze_panes = sheet.cell(row=top + 1, column=1)
            if len(df): sheet.auto_filter.ref = f"A{top}:{get_column_letter(len(df.columns))}{top + len(df)}"

        top = len(meta) + 3
        put(ws, summary, top, ("Entries", "SKUs", "Stock", "Tester", "Total Qty"))
        if split and len(detail):
            used = {"Summary"}
            for outlet, part in detail.groupby("Outlet", sort=True):
                name = re.sub(r"[\[\]:*?/\\]", " ", str(outlet)).strip()[:31] or "Outlet"; base, n = name, 2
                while name in used: name = f"{base[:28]}~{n}"; n += 1
                used.add(name); put(wb.create_sheet(name), part.reset_index(drop=True), 1, ("Stock", "Tester", "Total"))
        else:
            put(wb.create_sheet("Stock Detail"), detail, 1, ("Stock", "Tester", "Total"))
        buf = io.BytesIO(); wb.save(buf); return buf.getvalue()

    @app.get("/reports")
    @require_access("reports")
    def reports_page():
        return render_template("reports.html", name=session.get("user_name", "User"), email=session.get("user_email", ""), access=A._access_destinations())

    @app.get("/api/reports/outlets")
    @require_access("reports")
    def reports_outlets():
        try:
            df = _subs()
            known = set()
            try: known |= set(A.load_mapping(False)["Store Name"].astype(str).str.strip())
            except Exception: pass
            out = {s: {"outlet": s, "entries": 0, "last_submitted": "", "last_entry_no": "", "last_qty": 0.0} for s in sorted(k for k in known if k)}
            for s, z in df.groupby("store_name"):
                if not s: continue
                zz = z.sort_values("_ts", na_position="first"); last = zz.iloc[-1]; lk = zz[zz["_k"] == last["_k"]]
                out[s] = {"outlet": s, "entries": int(z["_k"].nunique()),
                          "last_submitted": last["_ts"].isoformat() if pd.notna(last["_ts"]) else str(last["submitted_at"]),
                          "last_entry_no": "" if str(last["_k"]).startswith("LEGACY-") else str(last["_k"]), "last_qty": float(lk["total"].sum())}
            return jsonify({"ok": True, "outlets": sorted(out.values(), key=lambda r: r["outlet"].lower()), "tz": REPORT_TZ, "warning": A._subs.get("error", "")})
        except Exception as e:
            return A._fail(e)

    @app.get("/api/reports/entries")
    @require_access("reports")
    def reports_entries():
        try:
            df = _subs()
            stores = [x for x in request.args.getlist("store") if x]
            if stores: df = df[df["store_name"].isin(stores)]
            d_from, d_to = _parse_day(request.args.get("from")), _parse_day(request.args.get("to"))
            if d_from is not None or d_to is not None:
                day = _local(df["_ts"]).dt.tz_localize(None).dt.normalize(); ok = day.notna()
                if d_from is not None: ok &= day >= d_from
                if d_to is not None: ok &= day <= d_to
                df = df[ok]
            q = (request.args.get("q") or "").strip().lower()
            g = (df.groupby("_k").agg(store=("store_name", "first"), email=("email", "first"), by=("submitted_by", "first"), ts=("_ts", "max"),
                                       raw=("submitted_at", "first"), skus=("ean_code", "nunique"), qty=("total", "sum")).reset_index())
            if q: g = g[(g["_k"] + " " + g["store"] + " " + g["email"] + " " + g["by"]).str.lower().str.contains(q, regex=False)]
            g = g.sort_values("ts", ascending=False, na_position="last")
            total = int(len(g)); g = g.head(int(request.args.get("limit", 200) or 200))
            recs = [{"entry_no": "" if k.startswith("LEGACY-") else k, "key": k, "outlet": r.store, "submitted_by": (r.by or r.email),
                     "submitted_at": r.ts.isoformat() if pd.notna(r.ts) else str(r.raw), "skus": int(r.skus), "qty": float(r.qty)} for k, r in ((r._1, r) for r in g.itertuples())]
            return jsonify({"ok": True, "entries": recs, "total": total})
        except Exception as e:
            return A._fail(e)

    @app.get("/api/reports/preview")
    @require_access("reports")
    def reports_preview():
        try:
            df, label, err = _select(request.args)
            if err: return jsonify({"ok": False, "error": err}), 400
            return jsonify({"ok": True, "rows": int(len(df)), "entries": int(df["_k"].nunique()) if len(df) else 0, "outlets": int(df["store_name"].nunique()) if len(df) else 0,
                            "qty": float(df["total"].sum()) if len(df) else 0.0})
        except Exception as e:
            return A._fail(e)

    @app.get("/api/reports/download")
    @require_access("reports")
    def reports_download():
        try:
            fmt = (request.args.get("format") or "xlsx").lower()
            if fmt not in ("xlsx", "csv"): return jsonify({"ok": False, "error": "Format must be xlsx or csv."}), 400
            df, label, err = _select(request.args)
            if err: return jsonify({"ok": False, "error": err}), 400
            if df.empty: return jsonify({"ok": False, "error": "No punched stock was found for this selection."}), 404
            if len(df) > REPORT_MAX_ROWS: return jsonify({"ok": False, "error": f"That is {len(df):,} rows — please narrow the date range or outlets (limit {REPORT_MAX_ROWS:,})."}), 413
            detail, summary = _detail(df), _summary(df)
            stamp = datetime.now().strftime("%Y%m%d-%H%M")
            name = f"stock_report_{label}_{stamp}.{fmt}"[:120]
            who = session.get("user_email", "")
            log.info("Stock report downloaded by %s: %s (%d rows, %s)", who, label, len(df), fmt)
            if fmt == "csv":
                body, mime = _to_csv(detail), "text/csv; charset=utf-8"
            else:
                meta = [f"Generated {datetime.now().strftime('%d-%b-%Y %H:%M')} by {who}", f"Selection: {label} • {len(df):,} rows • {df['_k'].nunique()} entries • {df['store_name'].nunique()} outlets", f"Times shown in {REPORT_TZ}"]
                body, mime = _to_xlsx(detail, summary, request.args.get("split") == "1", meta), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            r = Response(body, mimetype=mime)
            r.headers["Content-Disposition"] = f'attachment; filename="{name}"'; r.headers["Cache-Control"] = "no-store"
            return r
        except Exception as e:
            return A._fail(e)

    # ======================================================================
    # 3. SALES DASHBOARD  (access right: "sales")
    #    Outlet logins see only their mapped outlet(s); admin / "dashboard" logins see every outlet.
    # ======================================================================
    ALIASES = {
        "outlet": ["outlet", "name", "outletname", "store", "storename", "shop", "shopname", "branch", "branchname", "location", "outletcode", "storecode", "shopcode"],
        "ean": ["productcode", "eancode", "ean", "sku", "skucode", "barcode", "itemcode", "articlecode", "article", "material", "materialcode"],
        "product": ["productname", "product", "skuname", "itemname", "itemdescription", "description", "articlename", "materialdescription"],
        "qty": ["qtysold", "qty", "quantity", "salesqty", "soldqty", "saleqty", "unitssold", "units", "netqty", "netsalesqty", "salesunits"],
        "value": ["mrpsales", "netsales", "salesvalue", "salevalue", "value", "amount", "salesamount", "netvalue", "netsalesvalue", "revenue", "salesinr", "netamount", "netsalesamount"],
        "target": ["target", "salestarget", "monthlytarget", "targetvalue", "targetamount", "targetinr", "mtdtarget", "monthtarget"],
        "ach": ["achievement", "achieved", "actual", "actualsales", "achievementvalue", "achvalue", "ach", "mtdachievement", "mtdsales", "mtdactual"],
        "period": ["month", "period", "monthyear", "salesmonth", "date", "salesdate", "billdate", "invoicedate", "monthname"],
        "region": ["region", "city", "zone", "area"],
        "type": ["type", "channel", "format", "storetype", "outlettype"],
    }
    _sales = {"sig": None, "ts": 0.0, "data": None, "lock": threading.Lock(), "source": ""}

    def _link_file():
        return os.path.join(os.path.dirname(_sales_path()) if SALES_FILE else os.path.join(app.root_path, "data"), "sales_link.json")

    def _alias_file():
        return os.path.join(os.path.dirname(_link_file()), "outlet_aliases.json")

    def _known_shops():
        out = set()
        try: out |= set(A.load_mapping(False)["Store Name"].astype(str).str.strip())
        except Exception: pass
        try: out |= set(A.load_stock(False, copy=False)["Store Name"].astype(str).str.strip())
        except Exception: pass
        return sorted(x for x in out if x)

    def _sales_url():
        """Env SALES_EXCEL_URL wins; otherwise the SharePoint / OneDrive / Drive link an admin saved in the Admin page."""
        if SALES_EXCEL_URL: return SALES_EXCEL_URL
        try:
            with open(_link_file(), encoding="utf-8") as f: return str(json.load(f).get("url", "")).strip()
        except Exception: return ""

    def _sales_path():
        return SALES_FILE or os.path.join(app.root_path, "data", "sales.xlsx")

    def _map_columns(df):
        found = {}; norm = {c: _canon(c) for c in df.columns}
        for kind, names in ALIASES.items():
            for c, n in norm.items():
                if c not in found.values() and n in names: found[kind] = c; break
        for c, n in norm.items():                      # looser fallbacks
            if "target" not in found and "target" in n and c not in found.values(): found["target"] = c
            if "ach" not in found and ("achiev" in n) and c not in found.values(): found["ach"] = c
            if "value" not in found and ("sales" in n or "revenue" in n) and ("value" in n or "amt" in n or "amount" in n) and c not in found.values(): found["value"] = c
            if "qty" not in found and ("qty" in n or "quantity" in n) and c not in found.values(): found["qty"] = c
        return found

    def _period_label(series):
        """Return (labels, sort_keys). Dates become 'Nov 2026'; text such as 'Nov-26' is kept as typed."""
        import warnings
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            dt = pd.to_datetime(series, errors="coerce", dayfirst=True)
        use = dt.notna() & series.map(lambda v: not isinstance(v, str) or bool(re.search(r"\d{1,4}[-/. ]\d{1,2}|[A-Za-z]{3}", str(v))))
        labels = series.astype(str).str.strip().where(~use, dt.dt.strftime("%b %Y"))
        keys = dt.where(use, pd.NaT)
        return labels.fillna(""), keys

    def _outlet_resolver():
        """Map any spelling of an outlet (name / code from the sales file) to the shop name used by the rest of the app."""
        alias = {}
        try:                                                    # optional hand-made data/outlet_aliases.json: {"name in sales file": "shop name in app"}
            with open(_alias_file(), encoding="utf-8-sig") as f:
                for k, v in json.load(f).items(): alias[_okey(k)] = str(v).strip()
        except Exception: pass
        try:
            mp = A.load_mapping(False)
            for _, r in mp.iterrows():
                nm = str(r.get("Store Name", "")).strip()
                for key in (nm, str(r.get("Store Code", "")).strip()):
                    if key: alias.setdefault(_okey(key), nm)
        except Exception: pass
        try:
            for nm in A.load_stock(False, copy=False)["Store Name"].astype(str).str.strip().unique(): alias.setdefault(_okey(nm), nm)
        except Exception: pass
        try:
            with open(os.path.join(app.root_path, "data", "shops.json"), encoding="utf-8-sig") as f:
                for s in json.load(f).get("shops", []):
                    nm = str(s.get("name", "")).strip()
                    for key in (nm, str(s.get("code", "")).strip()):
                        if key: alias.setdefault(_okey(key), nm)
        except Exception: pass
        return lambda x: alias.get(_okey(x), str(x).strip())

    def _parse_sales(xls_bytes):
        resolve = _outlet_resolver(); report = {"sheets": [], "unmatched_outlets": [], "warnings": []}
        targets, skus = [], []
        with pd.ExcelFile(io.BytesIO(xls_bytes)) as xls:
            for sh in xls.sheet_names:
                try: df = pd.read_excel(xls, sheet_name=sh)
                except Exception: continue
                df.columns = [str(c).strip() for c in df.columns]; df = df.dropna(how="all")
                m = _map_columns(df)
                if "outlet" not in m: report["sheets"].append({"sheet": sh, "used_as": "ignored (no outlet column)", "rows": int(len(df))}); continue
                base = pd.DataFrame({"outlet": df[m["outlet"]].fillna("").astype(str).str.strip()})
                if "period" in m: base["period"], base["_pk"] = _period_label(df[m["period"]])
                else: base["period"], base["_pk"] = "", pd.NaT
                base["region"] = df[m["region"]].fillna("").astype(str).str.strip() if "region" in m else ""
                base["type"] = df[m["type"]].fillna("").astype(str).str.strip() if "type" in m else ""
                num = lambda k: pd.to_numeric(df[m[k]].astype(str).str.replace(r"[,₹\s]", "", regex=True), errors="coerce").fillna(0.0) if k in m else None
                is_sku = ("ean" in m or "product" in m) and ("qty" in m or "value" in m)
                if "target" in m and not is_sku:
                    t = base.copy(); t["target"] = num("target"); t["ach"] = num("ach") if "ach" in m else float("nan")
                    targets.append(t[t["outlet"] != ""]); report["sheets"].append({"sheet": sh, "used_as": "Outlet target", "rows": int(len(t)), "columns": {k: m[k] for k in m}})
                elif is_sku:
                    s = base.copy()
                    s["ean"] = df[m["ean"]].fillna("").astype(str).str.strip() if "ean" in m else ""
                    s["product"] = df[m["product"]].fillna("").astype(str).str.strip() if "product" in m else ""
                    s["qty"] = num("qty") if "qty" in m else 0.0; s["value"] = num("value") if "value" in m else 0.0
                    if "target" in m:                                       # target repeated on every SKU line -> one target per outlet
                        tt = base.copy(); tt["target"] = num("target"); tt["ach"] = float("nan")
                        targets.append(tt[tt["outlet"] != ""].groupby(["outlet", "period"], as_index=False).agg(target=("target", "max"), ach=("ach", "first"), region=("region", "first"), type=("type", "first"), _pk=("_pk", "first")))
                    skus.append(s[s["outlet"] != ""]); report["sheets"].append({"sheet": sh, "used_as": "SKU sales", "rows": int(len(s)), "columns": {k: m[k] for k in m}})
                else:
                    report["sheets"].append({"sheet": sh, "used_as": "ignored (no target / SKU columns)", "rows": int(len(df))})
        T = pd.concat(targets, ignore_index=True) if targets else pd.DataFrame(columns=["outlet", "period", "target", "ach", "region", "type", "_pk"])
        S = pd.concat(skus, ignore_index=True) if skus else pd.DataFrame(columns=["outlet", "period", "ean", "product", "qty", "value", "region", "type", "_pk"])
        raw_names = sorted(set(T["outlet"]) | set(S["outlet"]))
        for fr in (T, S):
            fr["outlet_raw"] = fr["outlet"]; fr["outlet"] = fr["outlet"].map(resolve)
        known = set()
        try: known = set(A.load_mapping(False)["Store Name"].astype(str).str.strip()) | set(A.load_stock(False, copy=False)["Store Name"].astype(str).str.strip())
        except Exception: pass
        report["unmatched_outlets"] = sorted({r for r in raw_names if resolve(r) not in known}) if known else []
        if not len(T) and not len(S): report["warnings"].append("No target or SKU-sales columns were recognised. Download the template to see the expected layout.")
        keys = pd.concat([T[["period", "_pk"]], S[["period", "_pk"]]]).drop_duplicates("period")
        periods = [p for p in keys.sort_values("_pk", na_position="first")["period"].tolist() if p]
        if not S.empty: S["ean_key"] = S["ean"].map(_ean_key)
        unit = "₹" if (("value" in S.columns and S["value"].abs().sum() > 0) or len(T)) else "Qty"
        return {"T": T, "S": S, "periods": periods, "unit": unit, "report": report}

    def _load_sales(force=False):
        """Parsed sales workbook (cached). Source: SALES_EXCEL_URL if set, else the file an admin uploaded (data/sales.xlsx)."""
        with _sales["lock"]:
            path = _sales_path(); have_file = os.path.exists(path)
            url = _sales_url(); sig = ("url", url) if url else (("file", os.path.getmtime(path)) if have_file else None)
            if sig is None: raise RuntimeError("No sales workbook yet. Ask the admin to upload it (Admin → Sales data) or set SALES_EXCEL_URL.")
            fresh = _sales["data"] is not None and _sales["sig"] == sig and time.time() - _sales["ts"] < SALES_CACHE_SECONDS
            if fresh and not force: return _sales["data"]
            raw = A.load_from_url(url) if url else open(path, "rb").read()
            data = _parse_sales(raw); data["source"] = "Linked Excel (SharePoint)" if url else "Uploaded workbook"
            _sales.update(sig=sig, ts=time.time(), data=data)
            return data

    def _scope():
        """None = every outlet; otherwise the set of outlets this login may see."""
        if session.get("is_admin") or "dashboard" in (session.get("access") or []): return None
        return A._mapped_stores_for(str(session.get("user_email", "")).strip().lower())

    def _pick_period(data, requested):
        ps = data["periods"]
        if not ps: return ""
        return requested if requested in ps else ps[-1]

    def _days_info(period):
        try:
            d = pd.to_datetime(period, format="%b %Y"); today = pd.Timestamp.now(tz=REPORT_TZ).tz_localize(None).normalize()
            if d.year == today.year and d.month == today.month:
                dim = d.days_in_month; return {"days_in_month": dim, "days_elapsed": int(today.day), "days_left": int(dim - today.day + 1)}
        except Exception: pass
        return None

    @app.get("/sales")
    @require_access("sales")
    def sales_page():
        return render_template("sales.html", name=session.get("user_name", "User"), email=session.get("user_email", ""), access=A._access_destinations())

    @app.get("/api/sales/summary")
    @require_access("sales")
    def sales_summary():
        try:
            data = _load_sales(request.args.get("refresh") == "1"); scope = _scope()
            period = _pick_period(data, request.args.get("period", "")); T, S = data["T"], data["S"]
            if period:
                T = T[T["period"] == period]; S = S[S["period"] == period]
            if scope is not None: T = T[T["outlet"].isin(scope)]; S = S[S["outlet"].isin(scope)]
            types = sorted({t for t in set(T["type"]) | set(S["type"]) if t})
            want = (request.args.get("type") or "").strip()
            if want:
                T = T[T["type"].map(_canon) == _canon(want)]; S = S[S["type"].map(_canon) == _canon(want)]
            tgt = T.groupby("outlet").agg(target=("target", "sum"), ach=("ach", "sum"), has_ach=("ach", lambda x: x.notna().any()), region=("region", "first"), type=("type", "first"))
            sk = S.groupby("outlet").agg(sales_value=("value", "sum"), sales_qty=("qty", "sum"), skus=("ean_key", "nunique"), type=("type", "first")) if len(S) else pd.DataFrame(columns=["sales_value", "sales_qty", "skus"])
            names = sorted(set(tgt.index) | set(sk.index) | (set(scope) if scope is not None and not len(tgt) and not len(sk) and not want else set()))
            outlets = []
            for n in names:
                t = float(tgt.at[n, "target"]) if n in tgt.index else 0.0
                has_ach = bool(tgt.at[n, "has_ach"]) if n in tgt.index else False
                sv = float(sk.at[n, "sales_value"]) if n in sk.index else 0.0
                ach = float(tgt.at[n, "ach"]) if has_ach else sv
                if data["unit"] == "Qty" and not has_ach: ach = float(sk.at[n, "sales_qty"]) if n in sk.index else 0.0
                outlets.append({"outlet": n, "type": (tgt.at[n, "type"] if n in tgt.index and tgt.at[n, "type"] else (sk.at[n, "type"] if n in sk.index else "")), "region": (tgt.at[n, "region"] if n in tgt.index else ""), "target": t, "achievement": ach, "pending": max(t - ach, 0.0),
                                "excess": max(ach - t, 0.0), "pct": (ach / t * 100.0) if t > 0 else None, "sales_qty": float(sk.at[n, "sales_qty"]) if n in sk.index else 0.0,
                                "skus_sold": int(sk.at[n, "skus"]) if n in sk.index else 0})
            ranked = sorted([o for o in outlets if o["pct"] is not None], key=lambda o: -o["pct"])
            for i, o in enumerate(ranked, 1): o["rank"] = i
            tt, aa = sum(o["target"] for o in outlets), sum(o["achievement"] for o in outlets)
            totals = {"target": tt, "achievement": aa, "pending": max(tt - aa, 0.0), "pct": (aa / tt * 100.0) if tt > 0 else None, "outlets": len(outlets)}
            days = _days_info(period)
            if days and totals["pending"] > 0: totals["required_per_day"] = totals["pending"] / max(days["days_left"], 1)
            if days and days["days_elapsed"] and aa > 0: totals["projected"] = aa / days["days_elapsed"] * days["days_in_month"]
            return jsonify({"ok": True, "periods": data["periods"], "period": period, "unit": data["unit"], "source": data["source"], "scope_all": scope is None, "types": types, "outlets": outlets,
                            "totals": totals, "days": days, "has_targets": bool(len(data["T"]) and data["T"]["target"].sum() > 0), "as_of": datetime.fromtimestamp(_sales["ts"], timezone.utc).isoformat()})
        except Exception as e:
            return A._fail(e)

    @app.get("/api/sales/outlet")
    @require_access("sales")
    def sales_outlet():
        """SKU-wise sales for one outlet (or all permitted outlets) joined with SKU-wise stock at that outlet."""
        try:
            data = _load_sales(); scope = _scope(); outlet = (request.args.get("outlet") or "").strip()
            period = _pick_period(data, request.args.get("period", ""))
            if outlet and outlet != "__all__" and scope is not None and outlet not in scope:
                return jsonify({"ok": False, "error": "This outlet is not mapped to your login."}), 403
            S = data["S"]
            if period: S = S[S["period"] == period]
            want = (request.args.get("type") or "").strip()
            if want: S = S[S["type"].map(_canon) == _canon(want)]
            if outlet and outlet != "__all__": S = S[S["outlet"] == outlet]
            elif scope is not None: S = S[S["outlet"].isin(scope)]
            stock = A.load_stock(False, copy=False)
            if want and "Type" in stock.columns: stock = stock[stock["Type"].map(_canon) == _canon(want)]
            stock = stock[["Store Name", "EAN Code", "Product Name", "Stock", "L3M Avg Qty"]].copy(); stock["Store Name"] = stock["Store Name"].astype(str).str.strip()
            if outlet and outlet != "__all__": stock = stock[stock["Store Name"] == outlet]
            elif scope is not None: stock = stock[stock["Store Name"].isin(scope)]
            stock["ean_key"] = stock["EAN Code"].map(_ean_key)
            st = stock.groupby("ean_key").agg(stock=("Stock", "sum"), l3m=("L3M Avg Qty", "sum"), name=("Product Name", "first"), ean=("EAN Code", "first"))
            sl = (S.groupby("ean_key").agg(qty=("qty", "sum"), value=("value", "sum"), name=("product", "first"), ean=("ean", "first")) if len(S) else pd.DataFrame(columns=["qty", "value", "name", "ean"]))
            keys = sorted(set(st.index) | set(sl.index)); total_val = float(sl["value"].sum()) if len(sl) else 0.0; total_qty = float(sl["qty"].sum()) if len(sl) else 0.0
            rows = []
            for k in keys:
                if not k: continue
                in_st, in_sl = k in st.index, k in sl.index
                stock_q = float(st.at[k, "stock"]) if in_st else None; l3m = float(st.at[k, "l3m"]) if in_st else 0.0
                qty = float(sl.at[k, "qty"]) if in_sl else 0.0; val = float(sl.at[k, "value"]) if in_sl else 0.0
                cover = (stock_q * 31.0 / l3m) if (stock_q is not None and l3m > 0) else None
                if stock_q is None: status = "no_stock_data"
                elif stock_q <= 0: status = "out" if (qty > 0 or l3m > 0) else "nil"
                elif cover is not None and cover < 15: status = "low"
                elif cover is not None and cover > 90: status = "over"
                else: status = "ok"
                rows.append({"ean": (sl.at[k, "ean"] if in_sl and sl.at[k, "ean"] else (st.at[k, "ean"] if in_st else k)), "product": (sl.at[k, "name"] if in_sl and sl.at[k, "name"] else (st.at[k, "name"] if in_st else "")),
                             "sales_qty": qty, "sales_value": val, "share": (val / total_val * 100.0) if total_val > 0 else ((qty / total_qty * 100.0) if total_qty > 0 else 0.0),
                             "stock": stock_q, "cover_days": cover, "status": status})
            rows.sort(key=lambda r: (-r["sales_value"], -r["sales_qty"], -(r["stock"] or 0)))
            return jsonify({"ok": True, "outlet": outlet or "__all__", "period": period, "unit": data["unit"], "rows": rows,
                            "totals": {"sales_value": total_val, "sales_qty": total_qty, "stock": float(sum((r["stock"] or 0) for r in rows)),
                                       "out": sum(1 for r in rows if r["status"] == "out"), "low": sum(1 for r in rows if r["status"] == "low")}})
        except Exception as e:
            return A._fail(e)

    @app.get("/api/sales/export")
    @require_access("sales")
    def sales_export():
        """Excel of what is on screen: outlet performance + SKU sales/stock for the chosen month / type / outlet."""
        try:
            a = sales_summary()
            if a.status_code != 200: return a
            b = sales_outlet()
            if b.status_code != 200: return b
            a, b = a.get_json(), b.get_json(); cur = "Sales (INR)" if a["unit"] == "₹" else "Sales"
            o = pd.DataFrame([{"Rank": r.get("rank", ""), "Outlet": r["outlet"], "Type": r["type"], "Target": r["target"], "Achieved": r["achievement"], "Pending": r["pending"], "Ach %": (round(r["pct"], 1) if r["pct"] is not None else ""), "Qty sold": r["sales_qty"], "SKUs sold": r["skus_sold"]} for r in a["outlets"]])
            k = pd.DataFrame([{"EAN": r["ean"], "Product": r["product"], "Qty sold": r["sales_qty"], cur: r["sales_value"], "Share %": round(r["share"], 1), "Stock": ("" if r["stock"] is None else r["stock"]), "Cover days": ("" if r["cover_days"] is None else round(r["cover_days"])), "Status": r["status"]} for r in b["rows"]])
            from openpyxl import Workbook
            from openpyxl.styles import Font, PatternFill, Alignment
            from openpyxl.utils import get_column_letter
            wb = Workbook(); first = True
            for title, df in (("Outlet performance", o), ("SKU sales & stock", k)):
                ws = wb.active if first else wb.create_sheet(); first = False; ws.title = title
                ws.append(list(df.columns))
                for c in ws[1]: c.fill = PatternFill("solid", fgColor="FF2B8A"); c.font = Font(bold=True, color="FFFFFF"); c.alignment = Alignment(horizontal="center")
                for row in df.itertuples(index=False):
                    ws.append([(v.item() if hasattr(v, "item") else v) if not (isinstance(v, str) and v.startswith("=")) else "'" + v for v in row])
                for j, c in enumerate(df.columns, 1): ws.column_dimensions[get_column_letter(j)].width = min(44, max(10, len(str(c)) + 3, *(len(str(x)) + 2 for x in df.iloc[:200, j - 1].tolist()))) if len(df) else 14
                ws.freeze_panes = "A2"
                if len(df): ws.auto_filter.ref = ws.dimensions
            buf = io.BytesIO(); wb.save(buf)
            label = re.sub(r"[^A-Za-z0-9]+", "-", (request.args.get("outlet") if request.args.get("outlet") not in (None, "", "__all__") else "all-outlets")).strip("-").lower()
            return Response(buf.getvalue(), mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                            headers={"Content-Disposition": f'attachment; filename="sales_{label}_{datetime.now().strftime("%Y%m%d")}.xlsx"', "Cache-Control": "no-store"})
        except Exception as e:
            return A._fail(e)

    # ---- admin: upload the sales workbook / template ----
    @app.post("/api/admin/sales-upload")
    def sales_upload():
        if not A._admin_required(): return jsonify({"ok": False, "error": "Admin access required."}), 403
        try:
            f = request.files.get("file")
            if not f or not f.filename.lower().endswith((".xlsx", ".xlsm")): return jsonify({"ok": False, "error": "Please choose an Excel (.xlsx) file."}), 400
            raw = f.read()
            if len(raw) > 40 * 1024 * 1024: return jsonify({"ok": False, "error": "File is larger than 40 MB."}), 413
            parsed = _parse_sales(raw)                                              # validate before replacing the live file
            if not len(parsed["T"]) and not len(parsed["S"]): return jsonify({"ok": False, "error": "No target or SKU-sales columns were recognised in this file.", "report": parsed["report"]}), 400
            os.makedirs(os.path.dirname(_sales_path()), exist_ok=True)
            tmp = _sales_path() + ".tmp"
            with open(tmp, "wb") as out: out.write(raw)
            os.replace(tmp, _sales_path()); _sales.update(sig=None, ts=0.0, data=None)
            return jsonify({"ok": True, "message": "Sales workbook uploaded.", "periods": parsed["periods"], "outlets": int(len(set(parsed["T"]["outlet"]) | set(parsed["S"]["outlet"]))),
                            "target_rows": int(len(parsed["T"])), "sku_rows": int(len(parsed["S"])), "report": parsed["report"],
                            "note": "Set SALES_EXCEL_URL instead if your server disk is wiped on every deploy." if True else ""})
        except Exception as e:
            return A._fail(e)

    @app.route("/api/admin/sales-link", methods=["GET", "POST"])
    def sales_link():
        if not A._admin_required(): return jsonify({"ok": False, "error": "Admin access required."}), 403
        if request.method == "GET":
            return jsonify({"ok": True, "url": _sales_url(), "from_env": bool(SALES_EXCEL_URL)})
        if SALES_EXCEL_URL: return jsonify({"ok": False, "error": "SALES_EXCEL_URL is set on the server and overrides this."}), 400
        url = str((request.get_json(silent=True) or {}).get("url", "")).strip()
        try:
            if url:
                if not re.match(r"^https://", url): return jsonify({"ok": False, "error": "Paste the full https:// link."}), 400
                parsed = _parse_sales(A.load_from_url(url))                                  # prove it downloads and reads before saving
                if not len(parsed["T"]) and not len(parsed["S"]): return jsonify({"ok": False, "error": "The link opened, but no sales columns were recognised.", "report": parsed["report"]}), 400
            os.makedirs(os.path.dirname(_link_file()), exist_ok=True)
            with open(_link_file(), "w", encoding="utf-8") as f: json.dump({"url": url}, f)
            _sales.update(sig=None, ts=0.0, data=None)
            return jsonify({"ok": True, "message": "Link saved." if url else "Link removed.", "report": parsed["report"] if url else None,
                            "target_rows": int(len(parsed["T"])) if url else 0, "sku_rows": int(len(parsed["S"])) if url else 0})
        except Exception as e:
            return jsonify({"ok": False, "error": "Could not open that link: " + str(e) + " (make sure it is shared as 'Anyone with the link can view')."}), 400

    @app.route("/api/admin/sales-aliases", methods=["GET", "POST"])
    def sales_aliases():
        """Fix outlet names that appear in the sales file but not in the shop list: {"name in sales file": "shop name in app"}."""
        if not A._admin_required(): return jsonify({"ok": False, "error": "Admin access required."}), 403
        try:
            cur = {}
            try:
                with open(_alias_file(), encoding="utf-8-sig") as f: cur = json.load(f)
            except Exception: pass
            if request.method == "POST":
                shops = set(_known_shops()); new = (request.get_json(silent=True) or {}).get("aliases", {})
                cur = {str(k).strip(): str(v).strip() for k, v in new.items() if str(k).strip() and str(v).strip() and (not shops or str(v).strip() in shops)}
                os.makedirs(os.path.dirname(_alias_file()), exist_ok=True)
                with open(_alias_file(), "w", encoding="utf-8") as f: json.dump(cur, f, ensure_ascii=False, indent=1)
                _sales.update(sig=None, ts=0.0, data=None)
            try: unmatched = _load_sales(True)["report"]["unmatched_outlets"]
            except Exception: unmatched = []
            return jsonify({"ok": True, "aliases": cur, "unmatched": unmatched, "shops": _known_shops()})
        except Exception as e:
            return A._fail(e)

    @app.get("/api/admin/sales-status")
    def sales_status():
        if not A._admin_required(): return jsonify({"ok": False, "error": "Admin access required."}), 403
        try:
            d = _load_sales(True)
            return jsonify({"ok": True, "source": d["source"], "periods": d["periods"], "unit": d["unit"], "report": d["report"], "target_rows": int(len(d["T"])), "sku_rows": int(len(d["S"]))})
        except Exception as e:
            return jsonify({"ok": False, "error": str(e)})

    @app.get("/api/admin/sales-template")
    def sales_template():
        if not A._admin_required(): return jsonify({"ok": False, "error": "Admin access required."}), 403
        from openpyxl import Workbook
        from openpyxl.styles import Font, PatternFill
        wb = Workbook(); t = wb.active; t.title = "Target"
        t.append(["Outlet", "Month", "Target", "Achievement"]); t.append(["Ahmedabad EBO", "Nov 2026", 500000, 320000]); t.append(["Mumbai EBO", "Nov 2026", 650000, 410000])
        s = wb.create_sheet("SKU Sales")
        s.append(["Outlet", "Month", "EAN Code", "Product Name", "Qty", "Net Sales"]); s.append(["Ahmedabad EBO", "Nov 2026", "8901234567890", "Matte Lipstick Rose", 42, 12600]); s.append(["Mumbai EBO", "Nov 2026", "8901234567890", "Matte Lipstick Rose", 55, 16500])
        n = wb.create_sheet("Notes")
        for line in ["Sheet names do not matter — columns are recognised by their headings.", "Target sheet: Outlet, Target (and optionally Month, Achievement). If Achievement is missing it is the sum of Net Sales.",
                     "SKU sales sheet: Outlet, EAN Code, Product Name, Qty, Net Sales (and optionally Month).", "Outlet names must match the shop names (or shop codes) used in the app.",
                     "Stock level per SKU at each outlet comes from the existing Stock_Data sheet — it does not need to be in this file."]: n.append([line])
        for ws in (t, s):
            for c in ws[1]: c.font = Font(bold=True, color="FFFFFF"); c.fill = PatternFill("solid", fgColor="FF2B8A")
            for col in "ABCDEF": ws.column_dimensions[col].width = 22
        buf = io.BytesIO(); wb.save(buf)
        return Response(buf.getvalue(), mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", headers={"Content-Disposition": 'attachment; filename="sales_template.xlsx"'})
