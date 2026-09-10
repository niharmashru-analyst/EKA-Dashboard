import io, os, time, json, sqlite3
from urllib.parse import urlparse, parse_qs, urlencode, urlunparse
from datetime import datetime, timezone
import requests
import pandas as pd
import re
from flask import Flask, jsonify, render_template, request, Response

app = Flask(__name__)

@app.after_request
def compress_response(response):
    # Keep large JSON responses fast over the network without adding a dependency.
    if response.direct_passthrough or response.status_code < 200 or response.status_code >= 300:
        return response
    if 'Content-Encoding' in response.headers or 'Content-Length' not in response.headers:
        return response
    if int(response.headers.get('Content-Length','0') or 0) < 20000:
        return response
    accept = request.headers.get('Accept-Encoding','')
    if 'gzip' not in accept:
        return response
    import gzip
    data = response.get_data()
    response.set_data(gzip.compress(data, compresslevel=5))
    response.headers['Content-Encoding'] = 'gzip'
    response.headers['Content-Length'] = str(len(response.get_data()))
    response.headers['Vary'] = 'Accept-Encoding'
    return response
EXCEL_URL = os.getenv("EXCEL_URL", "").strip()
EXCEL_SHEET = os.getenv("EXCEL_SHEET", "Stock_Data").strip()
VARIANCE_EXCEL_URL = os.getenv("VARIANCE_EXCEL_URL", "").strip()
VARIANCE_SHEET = os.getenv("VARIANCE_SHEET", "Variance_Data").strip()
CACHE_SECONDS = int(os.getenv("CACHE_SECONDS", "900"))
SUBMISSION_API_URL = os.getenv("SUBMISSION_API_URL", "").strip()
SUBMISSION_API_SECRET = os.getenv("SUBMISSION_API_SECRET", "").strip()
DATABASE_PATH = os.getenv("DATABASE_PATH", os.path.join(app.root_path, "data", "submissions.db"))
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "").strip()
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-2.5-flash").strip()

STOCK_REQUIRED = ["Type","Store Name","EAN Code","Product Name","Pareto","Stock","Total MRP Value","L3M Avg Qty","L3M Avg Value","NOD"]
STOCK_OPTIONAL_METRICS = ["LY Qty","LY Value","Current Month Qty","Current Month Value"]
VAR_REQUIRED = ["Store Name","EAN Code","Product Name","Opening Stock Qty","Inward Qty","Tertiary Qty","Closing Stock Qty"]
MAP_REQUIRED = ["Email ID","Store Name"]
MASTER_REQUIRED = ["EAN Code","Product Name"]

_cache = {
    "workbook_ts": 0, "workbook_raw": None, "workbook_url": "", "workbook_sheets": [], "workbook_xls": None,
    "stock_ts": 0, "stock_df": None, "stock_source": "",
    "var_ts": 0, "var_df": None, "var_source": "",
    "map_ts": 0, "map_df": None, "master_ts": 0, "master_df": None,
}


def public_download_url(url):
    if not url: return ""
    parts = urlparse(url); q = parse_qs(parts.query); q["download"] = ["1"]
    return urlunparse((parts.scheme, parts.netloc, parts.path, parts.params, urlencode(q, doseq=True), parts.fragment))


def load_from_url(url):
    candidates = [url]
    dl = public_download_url(url)
    if dl != url: candidates.append(dl)
    last = None
    for u in candidates:
        try:
            r = requests.get(u, timeout=60, allow_redirects=True, headers={"User-Agent":"Mozilla/5.0"})
            r.raise_for_status(); data = r.content; ctype = (r.headers.get("content-type") or "").lower()
            if len(data) > 1000 and (data[:2] == b"PK" or "spreadsheet" in ctype or "excel" in ctype): return data
            if len(data) > 10000 and data[:2] == b"PK": return data
            last = f"Received non-Excel content ({ctype or 'unknown content-type'})"
        except Exception as e: last = str(e)
    raise RuntimeError(last or "Could not download Excel file")


def workbook_raw(url, force=False):
    now = time.time()
    if force or _cache["workbook_raw"] is None or _cache["workbook_url"] != url or now - _cache["workbook_ts"] >= CACHE_SECONDS:
        raw = load_from_url(url) if url else None
        _cache.update(workbook_ts=now, workbook_raw=raw, workbook_url=url, workbook_sheets=[], workbook_xls=None)
    return _cache["workbook_raw"]


def read_sheet_from_workbook(url, sheet_name, local_name, force=False):
    if url:
        raw = workbook_raw(url, force)
        if force or _cache.get("workbook_xls") is None:
            _cache["workbook_xls"] = pd.ExcelFile(io.BytesIO(raw))
        xls = _cache["workbook_xls"]
        sheet = sheet_name if sheet_name and sheet_name in xls.sheet_names else xls.sheet_names[0]
        return pd.read_excel(xls, sheet_name=sheet), f"Linked Excel • {sheet}"
    local = os.path.join(app.root_path, "data", local_name)
    if not os.path.exists(local): raise RuntimeError(f"No linked Excel configured and {local_name} is missing.")
    return pd.read_excel(local, sheet_name=sheet_name if sheet_name else 0), f"Bundled Excel • {sheet_name}"


def clean_stock(df):
    df = df.copy(); df.columns = [str(c).strip() for c in df.columns]
    source_columns = list(df.columns)
    missing = [c for c in STOCK_REQUIRED if c not in df.columns]
    if missing: raise RuntimeError("Stock_Data missing required columns: " + ", ".join(missing))
    for c in ["Stock","Total MRP Value","L3M Avg Qty","L3M Avg Value","NOD"]: df[c] = pd.to_numeric(df[c], errors="coerce").fillna(0)
    # New Overview metrics. Keep legacy LY as a fallback for LY Qty so older files remain readable.
    if "LY Qty" not in df.columns:
        df["LY Qty"] = df["LY"] if "LY" in df.columns else 0
    if "LY Value" not in df.columns: df["LY Value"] = 0
    if "Current Month Qty" not in df.columns: df["Current Month Qty"] = 0
    if "Current Month Value" not in df.columns: df["Current Month Value"] = 0
    for c in STOCK_OPTIONAL_METRICS: df[c] = pd.to_numeric(df[c], errors="coerce").fillna(0)
    for c in ["Type","Store Name","EAN Code","Product Name","Pareto"]: df[c] = df[c].fillna("").astype(str).str.strip()
    df["Forecast Months"] = df["Pareto"].map({"Top 10":2.0,"Top 25":1.5,"Others":1.0}).fillna(1.0)
    df["Forecast Qty"] = df["L3M Avg Qty"] * df["Forecast Months"]
    # NOD is always calculated from current stock and L3M average sales; never use average NOD.
    # Vectorized calculation keeps refreshes fast even as the workbook grows.
    df["NOD"] = (df["Stock"] * 31.0).div(df["L3M Avg Qty"].replace(0, pd.NA)).fillna(0)
    if "Ideal Stock" not in df.columns: df["Ideal Stock"] = df["Forecast Qty"]
    else: df["Ideal Stock"] = pd.to_numeric(df["Ideal Stock"], errors="coerce").fillna(df["Forecast Qty"])
    if "Status" not in df.columns: df["Status"] = ""
    if "LY" not in df.columns: df["LY"] = 0
    df.attrs["source_columns"] = source_columns
    return df


def clean_variance(df):
    # Quantity-only variance model. Value columns are intentionally not loaded or calculated.
    df = df.copy(); df.columns = [str(c).strip() for c in df.columns]
    missing = [c for c in VAR_REQUIRED if c not in df.columns]
    if missing: raise RuntimeError("Variance_Data missing required columns: " + ", ".join(missing))
    for c in VAR_REQUIRED[3:]: df[c] = pd.to_numeric(df[c], errors="coerce").fillna(0)
    for c in ["Store Name","EAN Code","Product Name"]: df[c] = df[c].fillna("").astype(str).str.strip()
    df["Calculated Closing Qty"] = df["Opening Stock Qty"] + df["Inward Qty"] - df["Tertiary Qty"]
    # Stock Variance compares the movement-derived closing stock with the
    # Closing Stock Qty supplied in Variance_Data. Positive = Closing Stock
    # Qty is higher than the calculated closing; negative = lower.
    df["Stock Variance Qty"] = df["Calculated Closing Qty"] - df["Closing Stock Qty"]
    return df


def clean_map(df):
    df = df.copy(); df.columns = [str(c).strip() for c in df.columns]
    missing = [c for c in MAP_REQUIRED if c not in df.columns]
    if missing: raise RuntimeError("User_Shop_Map missing required columns: " + ", ".join(missing))
    for c in MAP_REQUIRED: df[c] = df[c].fillna("").astype(str).str.strip()
    df["Email ID"] = df["Email ID"].str.lower()
    return df[df["Email ID"]!=""]


def clean_master(df):
    df = df.copy(); df.columns = [str(c).strip() for c in df.columns]
    missing = [c for c in MASTER_REQUIRED if c not in df.columns]
    if missing: raise RuntimeError("SKU_Master missing required columns: " + ", ".join(missing))
    for c in MASTER_REQUIRED: df[c] = df[c].fillna("").astype(str).str.strip()
    return df[df["EAN Code"]!=""].drop_duplicates(subset=["EAN Code"], keep="first")


def load_stock(force=False):
    now=time.time()
    if force or _cache["stock_df"] is None or now-_cache["stock_ts"]>=CACHE_SECONDS:
        df,src=read_sheet_from_workbook(EXCEL_URL, EXCEL_SHEET, "data.xlsx", force)
        _cache.update(stock_ts=now,stock_df=clean_stock(df),stock_source=src)
    return _cache["stock_df"].copy()


def load_entry_sources(force=False):
    now=time.time()
    if force or _cache["map_df"] is None or _cache["master_df"] is None or now-_cache["map_ts"]>=CACHE_SECONDS or now-_cache["master_ts"]>=CACHE_SECONDS:
        if EXCEL_URL:
            raw=workbook_raw(EXCEL_URL, force)
            if force or _cache.get("workbook_xls") is None:
                _cache["workbook_xls"] = pd.ExcelFile(io.BytesIO(raw))
            xls=_cache["workbook_xls"]
            mp=clean_map(pd.read_excel(xls,sheet_name="User_Shop_Map")) if "User_Shop_Map" in xls.sheet_names else pd.DataFrame(columns=MAP_REQUIRED)
            master=clean_master(pd.read_excel(xls,sheet_name="SKU_Master")) if "SKU_Master" in xls.sheet_names else pd.DataFrame(columns=MASTER_REQUIRED)
        else:
            path=os.path.join(app.root_path,"data","data.xlsx")
            mp=clean_map(pd.read_excel(path,sheet_name="User_Shop_Map")) if os.path.exists(path) and "User_Shop_Map" in pd.ExcelFile(path).sheet_names else pd.DataFrame(columns=MAP_REQUIRED)
            master=clean_master(pd.read_excel(path,sheet_name="SKU_Master")) if os.path.exists(path) and "SKU_Master" in pd.ExcelFile(path).sheet_names else pd.DataFrame(columns=MASTER_REQUIRED)
        _cache["map_df"]=mp; _cache["master_df"]=master; _cache["map_ts"]=now; _cache["master_ts"]=now
    return _cache["map_df"].copy(), _cache["master_df"].copy()


def load_submissions_live():
    try:
        if SUBMISSION_API_URL:
            result = remote_request("GET") or {}
            if not result.get("ok"): return pd.DataFrame()
            return pd.DataFrame(result.get("records", []))
        return load_local_submissions()
    except Exception:
        return pd.DataFrame()

def merge_variance_actuals(var, stock):
    """Build the quantity-only variance dataset without pandas column collisions.

    Uses keyed Series/maps rather than merging submission columns into the movement
    dataframe. This guarantees that Actual Closing Qty always exists exactly once,
    even when the source Variance_Data sheet already contains old submission fields.
    """
    out = var.copy()

    # Remove any legacy/calculated submission fields first. They are rebuilt below.
    drop_cols = [c for c in [
        "Actual Closing Qty", "Difference Qty", "Live Submission",
        "System Stock Qty", "__key", "__Stock Product Name", "__Submitted Product Name"
    ] if c in out.columns]
    if drop_cols:
        out = out.drop(columns=drop_cols)

    # Make sure the core movement columns always exist.
    for c in ["Store Name","EAN Code","Product Name","Opening Stock Qty",
              "Inward Qty","Tertiary Qty","Closing Stock Qty",
              "Calculated Closing Qty","Stock Variance Qty"]:
        if c not in out.columns:
            out[c] = "" if c in ["Store Name","EAN Code","Product Name"] else 0

    out["__key"] = (out["Store Name"].fillna("").astype(str).str.strip() + "|" +
                    out["EAN Code"].fillna("").astype(str).str.strip())

    # System closing stock for Variance Analysis is the Closing Stock Qty from
    # Variance_Data. It is the ERP/system closing quantity for the same movement
    # period, so System Stock Qty and Closing Stock Qty intentionally match.
    # Stock_Data is still used by the main dashboard, but is not substituted here
    # because it may represent a later/current snapshot.
    out["System Stock Qty"] = pd.to_numeric(out["Closing Stock Qty"], errors="coerce").fillna(0)

    # Keep a keyed stock map only for submitted SKUs that do not exist in the
    # movement workbook.
    st = stock.copy()
    for c in ["Store Name","EAN Code","Product Name","Stock"]:
        if c not in st.columns:
            st[c] = "" if c != "Stock" else 0
    st["__key"] = (st["Store Name"].fillna("").astype(str).str.strip() + "|" +
                   st["EAN Code"].fillna("").astype(str).str.strip())
    st["Stock"] = pd.to_numeric(st["Stock"], errors="coerce").fillna(0)
    st_map = st.drop_duplicates("__key", keep="last").set_index("__key")["Stock"]

    # Latest field submission: Store + EAN -> submitted Total Qty.
    subs = load_submissions_live()
    if subs is None or subs.empty:
        subs = pd.DataFrame(columns=["store_name","ean_code","product_name","total","submitted_at"])
    for c, default in [("store_name",""),("ean_code",""),("product_name",""),("total",0),("submitted_at","")]:
        if c not in subs.columns:
            subs[c] = default
    subs = subs.copy()
    subs["__key"] = (subs["store_name"].fillna("").astype(str).str.strip() + "|" +
                      subs["ean_code"].fillna("").astype(str).str.strip())
    subs["total"] = pd.to_numeric(subs["total"], errors="coerce").fillna(0)
    subs = subs.sort_values("submitted_at", kind="stable").drop_duplicates("__key", keep="last")
    sub_map = subs.set_index("__key")["total"] if not subs.empty else pd.Series(dtype=float)

    # map() cannot create duplicate columns, so Actual Closing Qty is guaranteed.
    out["Actual Closing Qty"] = out["__key"].map(sub_map)
    out["Actual Closing Qty"] = pd.to_numeric(out["Actual Closing Qty"], errors="coerce")
    out["Live Submission"] = out["Actual Closing Qty"].notna()
    out["Difference Qty"] = (
        out["Actual Closing Qty"].sub(out["System Stock Qty"])
        .where(out["Actual Closing Qty"].notna(), 0)
    )

    # Add submitted SKUs that are not present in the movement workbook.
    if not subs.empty:
        existing = set(out["__key"])
        extra = subs[~subs["__key"].isin(existing)].copy()
        if not extra.empty:
            extra["Store Name"] = extra["store_name"].fillna("").astype(str).str.strip()
            extra["EAN Code"] = extra["ean_code"].fillna("").astype(str).str.strip()
            extra["Product Name"] = extra["product_name"].fillna("").astype(str)
            for c in ["Opening Stock Qty","Inward Qty","Tertiary Qty","Closing Stock Qty",
                      "Calculated Closing Qty","Stock Variance Qty"]:
                extra[c] = 0
            extra["System Stock Qty"] = extra["__key"].map(st_map).fillna(0)
            extra["Actual Closing Qty"] = pd.to_numeric(extra["total"], errors="coerce").fillna(0)
            extra["Difference Qty"] = extra["Actual Closing Qty"] - extra["System Stock Qty"]
            extra["Live Submission"] = True
            # Match the output schema exactly before concatenation.
            for c in out.columns:
                if c not in extra.columns:
                    extra[c] = 0 if c not in ["Store Name","EAN Code","Product Name","__key"] else ""
            extra = extra[out.columns]
            out = pd.concat([out, extra], ignore_index=True, sort=False)

    # Final defensive guarantee: no duplicate columns and the expected field exists.
    out = out.loc[:, ~out.columns.duplicated()].copy()
    if "Actual Closing Qty" not in out.columns:
        out["Actual Closing Qty"] = pd.NA
    if "Difference Qty" not in out.columns:
        out["Difference Qty"] = 0
    if "Live Submission" not in out.columns:
        out["Live Submission"] = False

    # Do not expose legacy movement-check fields in the API/table/export.
    out = out.drop(columns=[c for c in ["__key", "Movement Check Qty", "Movement Check"] if c in out.columns], errors="ignore")
    return out

def load_variance(force=False):
    now=time.time(); url=VARIANCE_EXCEL_URL or EXCEL_URL
    if force or _cache["var_df"] is None or now-_cache["var_ts"]>=CACHE_SECONDS:
        df,src=read_sheet_from_workbook(url, VARIANCE_SHEET, "data.xlsx", force)
        _cache.update(var_ts=now,var_df=clean_variance(df),var_source=src)
    return _cache["var_df"].copy()


def json_records(df):
    out=df.copy()
    # Defensive cleanup: duplicate Excel headers break pandas records JSON conversion.
    out=out.loc[:, ~out.columns.duplicated()].copy()
    for c in out.columns:
        if pd.api.types.is_bool_dtype(out[c]): out[c]=out[c].astype(bool)
        elif pd.api.types.is_numeric_dtype(out[c]): out[c]=pd.to_numeric(out[c],errors="coerce").fillna(0)
        else: out[c]=out[c].fillna("").astype(str)
    return out.to_dict(orient="records")


def db_init():
    os.makedirs(os.path.dirname(DATABASE_PATH) or ".", exist_ok=True)
    with sqlite3.connect(DATABASE_PATH) as con:
        con.execute("""CREATE TABLE IF NOT EXISTS submissions(id INTEGER PRIMARY KEY AUTOINCREMENT, submitted_at TEXT, email TEXT, store_name TEXT, ean_code TEXT, product_name TEXT, stock REAL, tester REAL, total REAL)""")


def save_local_submission(payload):
    db_init(); ts=datetime.now(timezone.utc).isoformat(); rows=[]
    for r in payload["rows"]:
        rows.append((ts,payload["email"],payload["store_name"],str(r.get("EAN Code","")),str(r.get("Product Name","")),float(r.get("Stock",0) or 0),float(r.get("Tester",0) or 0),float(r.get("Total",0) or 0)))
    with sqlite3.connect(DATABASE_PATH) as con:
        con.executemany("INSERT INTO submissions(submitted_at,email,store_name,ean_code,product_name,stock,tester,total) VALUES(?,?,?,?,?,?,?,?)",rows)
    return len(rows)


def load_local_submissions():
    db_init()
    with sqlite3.connect(DATABASE_PATH) as con: return pd.read_sql_query("SELECT * FROM submissions",con)


def remote_request(method, payload=None):
    if not SUBMISSION_API_URL: return None
    payload=payload or {}
    if SUBMISSION_API_SECRET:
        if method.upper()=="GET": r=requests.get(SUBMISSION_API_URL,params={"secret":SUBMISSION_API_SECRET},timeout=30)
        else: payload={**payload,"secret":SUBMISSION_API_SECRET}; r=requests.request(method,SUBMISSION_API_URL,json=payload,timeout=30)
    else: r=requests.request(method,SUBMISSION_API_URL,json=payload,timeout=30)
    r.raise_for_status(); return r.json()



def _ai_num(v):
    try:
        x=float(v)
        return 0 if pd.isna(x) else x
    except Exception:
        return 0

def _ai_prepare_stock(df, view_mode="qty"):
    if df is None or df.empty:
        return pd.DataFrame()
    x=df.copy()
    # Excel/source files can occasionally contain duplicate header names.
    # Pandas returns a DataFrame (instead of a Series) for duplicate columns,
    # which breaks to_json(orient="records") and several aggregations below.
    # Keep the first occurrence consistently for the AI context.
    x=x.loc[:, ~x.columns.duplicated()].copy()
    for c in ["Stock","L3M Avg Qty","LY Qty","Current Month Qty","Total MRP Value","L3M Avg Value","LY Value","Current Month Value"]:
        if c in x.columns: x[c]=pd.to_numeric(x[c],errors="coerce").fillna(0)
    if "Growth %" not in x.columns:
        x["Growth %"]=x.apply(lambda r: ((r.get("Current Month Qty",0)-r.get("LY Qty",0))/r.get("LY Qty",1)*100) if r.get("LY Qty",0)>0 else None,axis=1)
    x["NOD"]=x.apply(lambda r: (r.get("Stock",0)*31/r.get("L3M Avg Qty",1)) if r.get("L3M Avg Qty",0)>0 else 0,axis=1)
    return x

def _ai_filter_stock(df, payload):
    x=df.copy()
    filters=payload.get("filters") or {}
    for c in ["Type","Store Name","Pareto","NOD Bucket","Stock Health"]:
        vals=filters.get(c) or []
        if vals and c in x.columns: x=x[x[c].astype(str).isin([str(v) for v in vals])]
    skus=filters.get("__sku") or []
    if skus and "EAN Code" in x.columns: x=x[x["EAN Code"].astype(str).str.strip().isin([str(v).strip() for v in skus])]
    q=str(filters.get("__q") or "").strip().lower()
    if q:
        mask=x["EAN Code"].astype(str).str.lower().str.contains(q,na=False) if "EAN Code" in x.columns else False
        if "Product Name" in x.columns: mask=mask|x["Product Name"].astype(str).str.lower().str.contains(q,na=False)
        x=x[mask]
    return x

def _ai_clean_columns(df):
    if df is None or df.empty:
        return pd.DataFrame()
    x=df.copy()
    x.columns=[str(c).strip() for c in x.columns]
    return x.loc[:, ~x.columns.duplicated()].copy()

def _ai_prepare_stock(df, view_mode="qty"):
    x=_ai_clean_columns(df)
    if x.empty: return x
    for c in ["Stock","L3M Avg Qty","LY Qty","Current Month Qty","Total MRP Value","L3M Avg Value","LY Value","Current Month Value"]:
        if c in x.columns: x[c]=pd.to_numeric(x[c],errors="coerce").fillna(0)
    if "Growth %" not in x.columns:
        x["Growth %"]=x.apply(lambda r: ((r.get("Current Month Qty",0)-r.get("LY Qty",0))/r.get("LY Qty",1)*100) if r.get("LY Qty",0)>0 else None,axis=1)
    x["NOD"]=x.apply(lambda r: (r.get("Stock",0)*31/r.get("L3M Avg Qty",1)) if r.get("L3M Avg Qty",0)>0 else 0,axis=1)
    if "Stock Health" not in x.columns: x["Stock Health"]=x.apply(lambda r: ("Dead Stock" if float(r.get("Stock",0) or 0)>0 and float(r.get("L3M Avg Qty",0) or 0)<=0 else "Slow Moving" if float(r.get("NOD",0) or 0)>60 else "Healthy"),axis=1)
    return x

def _ai_filter_stock(df, payload):
    x=_ai_clean_columns(df)
    filters=payload.get("filters") or {}
    for c in ["Type","Store Name","Pareto","NOD Bucket","Stock Health"]:
        vals=filters.get(c) or []
        if vals and c in x.columns: x=x[x[c].astype(str).isin([str(v) for v in vals])]
    skus=filters.get("__sku") or []
    if skus and "EAN Code" in x.columns: x=x[x["EAN Code"].astype(str).str.strip().isin([str(v).strip() for v in skus])]
    q=str(filters.get("__q") or "").strip().lower()
    if q:
        mask=x["EAN Code"].astype(str).str.lower().str.contains(q,na=False) if "EAN Code" in x.columns else pd.Series(False,index=x.index)
        if "Product Name" in x.columns: mask=mask|x["Product Name"].astype(str).str.lower().str.contains(q,na=False)
        x=x[mask]
    return x

def _ai_records(df, cols, n=25):
    if df is None or df.empty: return []
    d=_ai_clean_columns(df)
    cols=list(dict.fromkeys(c for c in cols if c in d.columns))
    if not cols: return []
    return json.loads(d.loc[:,cols].head(n).to_json(orient="records"))

def _ai_aggregate_skus(x):
    if x.empty or "EAN Code" not in x.columns: return pd.DataFrame()
    key=["EAN Code"]
    if "Product Name" in x.columns: key.append("Product Name")
    numeric=[c for c in ["Stock","Total MRP Value","L3M Avg Qty","L3M Avg Value","LY Qty","LY Value","Current Month Qty","Current Month Value"] if c in x.columns]
    agg=x.groupby(key,dropna=False)[numeric].sum().reset_index()
    if "Growth %" in agg.columns: agg=agg.drop(columns=["Growth %"])
    agg["Growth %"]=agg.apply(lambda r: ((r.get("Current Month Qty",0)-r.get("LY Qty",0))/r.get("LY Qty",1)*100) if r.get("LY Qty",0)>0 else None,axis=1)
    agg["NOD"]=agg.apply(lambda r: r.get("Stock",0)*31/r.get("L3M Avg Qty",1) if r.get("L3M Avg Qty",0)>0 else 0,axis=1)
    # Preserve a representative Pareto category for display; the dashboard's source classification is SKU-level.
    if "Pareto" in x.columns:
        pm=x.groupby(key)["Pareto"].agg(lambda s: next((str(v) for v in s if str(v).strip()),"")).reset_index()
        agg=agg.merge(pm,on=key,how="left")
    return agg

def _ai_aggregate_stores(x):
    if x.empty or "Store Name" not in x.columns: return pd.DataFrame()
    numeric=[c for c in ["Stock","Total MRP Value","L3M Avg Qty","L3M Avg Value","LY Qty","LY Value","Current Month Qty","Current Month Value"] if c in x.columns]
    agg=x.groupby("Store Name",dropna=False)[numeric].sum().reset_index()
    agg["Growth %"]=agg.apply(lambda r: ((r.get("Current Month Qty",0)-r.get("LY Qty",0))/r.get("LY Qty",1)*100) if r.get("LY Qty",0)>0 else None,axis=1)
    agg["NOD"]=agg.apply(lambda r: r.get("Stock",0)*31/r.get("L3M Avg Qty",1) if r.get("L3M Avg Qty",0)>0 else 0,axis=1)
    agg["SKU Count"]=x.groupby("Store Name")["EAN Code"].nunique().reindex(agg["Store Name"]).fillna(0).astype(int).values if "EAN Code" in x.columns else 0
    return agg

def _ai_analyze_query(x, variance, view_mode, question):
    """Deterministic analytics layer. Gemini receives these exact results and only explains them."""
    mode_stock="Total MRP Value" if view_mode=="value" else "Stock"
    mode_cm="Current Month Value" if view_mode=="value" else "Current Month Qty"
    mode_ly="LY Value" if view_mode=="value" else "LY Qty"
    mode_l3="L3M Avg Value" if view_mode=="value" else "L3M Avg Qty"
    sku=_ai_aggregate_skus(x); store=_ai_aggregate_stores(x)
    q=question.lower()
    result={"view_mode":view_mode,"question":question,"analysis_type":"general","scope":{"rows":int(len(x)),"skus":int(sku["EAN Code"].nunique()) if not sku.empty and "EAN Code" in sku else 0,"stores":int(x["Store Name"].nunique()) if "Store Name" in x else 0}}
    def cols(d): return [c for c in ["EAN Code","Product Name","Pareto",mode_stock,"Stock","L3M Avg Qty","L3M Avg Value",mode_cm,mode_ly,"Growth %","NOD"] if c in d.columns]
    # Specific numeric threshold queries, e.g. stock value > 1L, growth < -10%, NOD > 60.
    thresholds={}
    m=re.search(r'(?:stock|inventory)[^\d]{0,20}(?:>|above|over|more than|greater than)\s*[₹rs\.]*\s*([\d,]+(?:\.\d+)?)\s*(lakh|lac|k|m)?',q)
    if m:
        n=float(m.group(1).replace(',','')); unit=(m.group(2) or '').lower(); thresholds['stock_min']=n*(100000 if unit in ('lakh','lac') else 1000 if unit=='k' else 1000000 if unit=='m' else 1)
    m=re.search(r'growth[^\d-]{0,15}(?:<|below|under|less than)\s*(-?\d+(?:\.\d+)?)',q)
    if m: thresholds['growth_max']=float(m.group(1))
    m=re.search(r'nod[^\d]{0,15}(?:>|above|over|more than|greater than)\s*(\d+(?:\.\d+)?)',q)
    if m: thresholds['nod_min']=float(m.group(1))
    if thresholds and not sku.empty:
        z=sku.copy()
        if 'stock_min' in thresholds: z=z[z[mode_stock]>=thresholds['stock_min']]
        if 'growth_max' in thresholds: z=z[z['Growth %'].notna() & (z['Growth %']<thresholds['growth_max'])]
        if 'nod_min' in thresholds: z=z[z['NOD']>thresholds['nod_min']]
        result["analysis_type"]="threshold_filter"; result["criteria"]=thresholds; result["results"]=_ai_records(z.sort_values(mode_stock,ascending=False),cols(z),50); return result
    if any(k in q for k in ["top 10 sku","top 10 skus","top 10 products","top sku","highest stock sku","highest stock skus","highest inventory sku"]):
        result["analysis_type"]="top_skus_by_stock"; result["results"]=_ai_records(sku.sort_values(mode_stock,ascending=False),cols(sku),10); return result
    if any(k in q for k in ["bottom 10 sku","bottom 10 skus","worst sku","worst skus","lowest growth sku"]):
        z=sku[sku["Growth %"].notna()].sort_values("Growth %")
        result["analysis_type"]="bottom_skus_by_growth"; result["results"]=_ai_records(z,cols(z),10); return result
    if "high stock" in q and ("negative growth" in q or "declining" in q or "growth negative" in q):
        z=sku[(sku["Growth %"].notna())&(sku["Growth %"]<0)].sort_values(mode_stock,ascending=False)
        result["analysis_type"]="high_stock_negative_growth"; result["results"]=_ai_records(z,cols(z),25); return result
    if any(k in q for k in ["highest nod","high nod","nod above 60","nod > 60","slow moving"]):
        if "store" in q or "stores" in q:
            z=store.sort_values("NOD",ascending=False); result["analysis_type"]="highest_nod_stores"; result["results"]=_ai_records(z,["Store Name",mode_stock,"Stock",mode_cm,mode_ly,"Growth %","NOD","SKU Count"],10)
        else:
            z=sku.sort_values("NOD",ascending=False); result["analysis_type"]="highest_nod_skus"; result["results"]=_ai_records(z,cols(z),10)
        return result
    if any(k in q for k in ["highest stock store","highest stock stores","top stores","best store by stock","inventory by store"]):
        z=store.sort_values(mode_stock,ascending=False); result["analysis_type"]="top_stores_by_stock"; result["results"]=_ai_records(z,["Store Name",mode_stock,"Stock",mode_cm,mode_ly,"Growth %","NOD","SKU Count"],10); return result
    if any(k in q for k in ["worst store","worst stores","bottom stores","lowest growth store"]):
        z=store[store["Growth %"].notna()].sort_values("Growth %"); result["analysis_type"]="worst_stores_by_growth"; result["results"]=_ai_records(z,["Store Name",mode_stock,"Stock",mode_cm,mode_ly,"Growth %","NOD","SKU Count"],10); return result
    if any(k in q for k in ["where should i focus","focus first","priority","immediate action","what should i do","strategy"]):
        z=sku.copy()
        if not z.empty:
            z["priority_score"]=0.0
            z.loc[z["Growth %"].notna() & (z["Growth %"]<0),"priority_score"]+=2
            z.loc[z["NOD"]>60,"priority_score"]+=2
            if len(z): z.loc[z[mode_stock]>=z[mode_stock].quantile(.75),"priority_score"]+=2
            if "Stock Health" in x.columns:
                dead=set(x.loc[x["Stock Health"]=="Dead Stock","EAN Code"].astype(str)); z.loc[z["EAN Code"].astype(str).isin(dead),"priority_score"]+=3
            z=z.sort_values(["priority_score",mode_stock],ascending=[False,False])
        result["analysis_type"]="focus_priorities"; result["results"]=_ai_records(z,cols(z)+["priority_score"],15); return result
    if any(k in q for k in ["compare","versus"," vs "]):
        tokens=[t.strip() for t in re.split(r'\s+vs\s+|\s+versus\s+|\s+and\s+',q) if t.strip()]
        names=[]
        for t in tokens:
            t=re.sub(r'[^a-z0-9 ._-]','',t).strip()
            if len(t)>2 and t not in {"compare","the","store","stores","sku"}: names.append(t)
        matches=[]
        for n in names[:4]:
            sm=store[store["Store Name"].astype(str).str.lower().str.contains(re.escape(n),na=False)]
            if not sm.empty: matches.append(sm.iloc[0])
        if matches:
            result["analysis_type"]="store_comparison"; result["results"]=[{k:(float(r[k]) if isinstance(r[k],(int,float)) else r[k]) for k in r.index if k in ["Store Name",mode_stock,"Stock",mode_cm,mode_ly,"Growth %","NOD","SKU Count"]} for r in matches]; return result
    # General context: authoritative totals plus compact rankings.
    total={"sku_count":result["scope"]["skus"],"store_count":result["scope"]["stores"],"stock":float(x[mode_stock].sum()) if mode_stock in x else 0,"current_month":float(x[mode_cm].sum()) if mode_cm in x else 0,"ly":float(x[mode_ly].sum()) if mode_ly in x else 0,"l3m_avg":float(x[mode_l3m].sum()) if mode_l3m in x else 0}
    total["growth_pct"]=(total["current_month"]-total["ly"])/total["ly"]*100 if total["ly"] else None
    result["analysis_type"]="general"; result["overview"]=total
    result["top_skus"]=_ai_records(sku.sort_values(mode_stock,ascending=False),cols(sku),10)
    result["worst_growth_skus"]=_ai_records(sku[sku["Growth %"].notna()].sort_values("Growth %"),cols(sku),10)
    result["top_nod_skus"]=_ai_records(sku.sort_values("NOD",ascending=False),cols(sku),10)
    result["top_stores"]=_ai_records(store.sort_values(mode_stock,ascending=False),["Store Name",mode_stock,"Growth %","NOD","SKU Count"],10)
    result["worst_stores"]=_ai_records(store[store["Growth %"].notna()].sort_values("Growth %"),["Store Name",mode_stock,"Growth %","NOD","SKU Count"],10)
    if variance is not None and not variance.empty:
        v=_ai_clean_columns(variance)
        for c in ["Stock Variance Qty","Difference Qty"]:
            if c in v.columns:v[c]=pd.to_numeric(v[c],errors="coerce").fillna(0)
        result["variance"]={"stock_variance_signed":float(v.get("Stock Variance Qty",pd.Series(dtype=float)).sum()),"physical_variance_signed":float(v.get("Difference Qty",pd.Series(dtype=float)).sum()),"sku_count":int(v["EAN Code"].nunique()) if "EAN Code" in v else 0,"store_count":int(v["Store Name"].nunique()) if "Store Name" in v else 0}
    return result


@app.post("/api/ai/chat")
def ai_chat():
    try:
        if not GEMINI_API_KEY:
            return jsonify({"ok":False,"error":"Gemini AI is not configured. Add GEMINI_API_KEY in Render Environment Variables."}),503
        payload=request.get_json(silent=True) or {}
        question=str(payload.get("question") or "").strip()
        if not question:return jsonify({"ok":False,"error":"Please enter a question."}),400
        if len(question)>1000:return jsonify({"ok":False,"error":"Question is too long (maximum 1000 characters)."}),400
        stock=load_stock(False)
        filtered=_ai_filter_stock(stock,payload)
        try: variance=load_variance(False)
        except Exception: variance=pd.DataFrame()
        context=_ai_analyze_query(filtered,variance,str(payload.get("view_mode") or "qty"),question)
        system=("You are Analyst inside a business analytics dashboard. "
          "Answer ONLY from the authoritative Python analytics result supplied by the server. Never invent, estimate, recalculate, or substitute numbers. "
          "The server has already performed aggregation, ranking, filtering, growth and NOD calculations. Treat those results as exact. "
          "Growth is Current Month vs LY. NOD is days. Qty/Value mode must be respected; NOD always stays in days. "
          "For strategy questions, first state the data facts, then give practical recommendations clearly labelled Recommendation. "
          "For rankings, preserve the requested order and do not reorder unless the user asks. "
          "For a specific SKU/store, discuss only evidence present in the result. "
          "If the result is empty or insufficient, say exactly what data is missing. Do not answer unrelated questions. "
          "Keep answers concise, structured, and business-friendly.")
        user=("Question: "+question+"\n\nDashboard context (authoritative):\n"+json.dumps(context,ensure_ascii=False,separators=(",",":")))
        url=f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent?key={GEMINI_API_KEY}"
        body={"system_instruction":{"parts":[{"text":system}]},"contents":[{"role":"user","parts":[{"text":user}]}],"generationConfig":{"temperature":0.2,"maxOutputTokens":900}}
        r=requests.post(url,json=body,timeout=45)
        if r.status_code>=400:
            try: detail=r.json().get("error",{}).get("message",r.text)
            except Exception: detail=r.text
            return jsonify({"ok":False,"error":"Gemini API error: "+str(detail)}),502
        data=r.json(); text=""
        for cand in data.get("candidates",[]):
            for part in cand.get("content",{}).get("parts",[]):
                if part.get("text"): text+=part["text"]
        if not text:text="I couldn't generate an answer from the available dashboard data."
        return jsonify({"ok":True,"answer":text,"view_mode":payload.get("view_mode") or "qty"})
    except Exception as e:
        return jsonify({"ok":False,"error":str(e)}),500

@app.get("/")
def index(): return render_template("index.html")

@app.get("/entry")
def entry(): return render_template("entry.html")

@app.get("/api/data")
def api_data():
    try:
        stock=load_stock(request.args.get("refresh")=="1")
        source_columns = list(stock.attrs.get("source_columns") or [c for c in stock.columns if c not in {"Forecast Months","Forecast Qty","NOD Bucket"}])
        resp=jsonify({"ok":True,"source":_cache["stock_source"],"rows":len(stock),"columns":list(stock.columns),"source_columns":source_columns,"records":json_records(stock)})
        resp.headers["Cache-Control"]="no-store, no-cache, must-revalidate, max-age=0"
        resp.headers["Pragma"]="no-cache"
        return resp
    except Exception as e: return jsonify({"ok":False,"error":str(e)}),500

@app.get("/api/variance")
def api_variance():
    try:
        var=load_variance(request.args.get("refresh")=="1")
        stock=load_stock(request.args.get("refresh")=="1")
        merged=merge_variance_actuals(var,stock)
        resp=jsonify({"ok":True,"source":_cache["var_source"],"rows":len(merged),"columns":list(merged.columns),"records":json_records(merged)})
        resp.headers["Cache-Control"]="no-store, no-cache, must-revalidate, max-age=0"
        resp.headers["Pragma"]="no-cache"
        return resp
    except Exception as e: return jsonify({"ok":False,"error":str(e)}),500

@app.get("/api/entry-meta")
def entry_meta():
    try:
        stock=load_stock(False); mp,master=load_entry_sources(False)
        email=request.args.get("email","").strip().lower(); stores=sorted(mp.loc[mp["Email ID"]==email,"Store Name"].unique().tolist()) if email else []
        if email and not stores: return jsonify({"ok":False,"error":"Email ID is not mapped to any shop."}),404
        store=request.args.get("store","").strip()
        available=stock[stock["Store Name"].astype(str)==store][["EAN Code","Product Name"]].drop_duplicates().to_dict(orient="records") if store else []
        return jsonify({"ok":True,"stores":stores,"selected_store":store,"available_skus":available,"master_skus":master[["EAN Code","Product Name"]].to_dict(orient="records")})
    except Exception as e: return jsonify({"ok":False,"error":str(e)}),500

@app.post("/api/submit")
def submit():
    try:
        payload=request.get_json(force=True); email=str(payload.get("email","")).strip().lower(); store=str(payload.get("store_name","")).strip(); rows=payload.get("rows",[])
        if not email or not store or not rows: return jsonify({"ok":False,"error":"Email, shop and at least one SKU are required."}),400
        mp,master=load_entry_sources(False)
        allowed=set(mp.loc[mp["Email ID"]==email,"Store Name"])
        if store not in allowed: return jsonify({"ok":False,"error":"This email is not mapped to the selected shop."}),403
        stock=load_stock(False)
        master_map={str(x["EAN Code"]).strip():str(x["Product Name"]) for _,x in master.iterrows()}
        # Current-store SKUs are valid even if the master file is temporarily missing one.
        store_rows=stock[stock["Store Name"].astype(str).str.strip()==store][["EAN Code","Product Name"]].drop_duplicates()
        store_map={str(x["EAN Code"]).strip():str(x["Product Name"]) for _,x in store_rows.iterrows()}
        cleaned=[]
        for r in rows:
            ean=str(r.get("EAN Code","" )).strip()
            if not ean: continue
            product_name=master_map.get(ean) or store_map.get(ean) or str(r.get("Product Name","" )).strip()
            if not product_name: continue
            stock_qty=max(0.0,float(r.get("Stock",0) or 0))
            tester_qty=max(0.0,float(r.get("Tester",0) or 0))
            cleaned.append({"EAN Code":ean,"Product Name":product_name,"Stock":stock_qty,"Tester":tester_qty,"Total":stock_qty+tester_qty})
        if not cleaned: return jsonify({"ok":False,"error":"No valid SKU rows submitted."}),400
        payload={"email":email,"store_name":store,"rows":cleaned}
        if SUBMISSION_API_URL:
            result=remote_request("POST",payload) or {}
            if not result.get("ok"):
                return jsonify({"ok":False,"error":result.get("error","Google Apps Script rejected the submission."),"remote":result}),502
            saved=int(result.get("saved_rows",len(cleaned)) or 0)
            if saved != len(cleaned):
                return jsonify({"ok":False,"error":f"Submission mismatch: sent {len(cleaned)} rows but Apps Script saved {saved}.","remote":result}),502
            return jsonify({"ok":True,"message":"Stock submitted successfully.","saved_rows":saved,"remote":result})
        saved=save_local_submission(payload)
        return jsonify({"ok":True,"message":"Stock submitted successfully.","saved_rows":saved})
    except Exception as e: return jsonify({"ok":False,"error":str(e)}),500

@app.post("/api/entry-report-data")
def entry_report_data():
    """Return the quantity-only data needed to build the two post-submission PDFs."""
    try:
        payload=request.get_json(force=True) or {}
        email=str(payload.get("email","")).strip().lower()
        store=str(payload.get("store_name","")).strip()
        rows=payload.get("rows",[]) or []
        if not email or not store:
            return jsonify({"ok":False,"error":"Email and shop are required."}),400

        mp,_=load_entry_sources(False)
        allowed=set(mp.loc[mp["Email ID"]==email,"Store Name"])
        if store not in allowed:
            return jsonify({"ok":False,"error":"This email is not mapped to the selected shop."}),403

        stock=load_stock(False)
        var=load_variance(False)

        # Submitted physical quantities keyed by Store + EAN.
        submitted={}
        for r in rows:
            ean=str(r.get("EAN Code","")).strip()
            if not ean: continue
            physical=max(0.0,float(r.get("Total",0) or 0))
            name=str(r.get("Product Name","")).strip()
            submitted[ean]={"Product Name":name,"Physical Stock":physical,"Stock Qty":max(0.0,float(r.get("Stock",0) or 0)),"Tester Qty":max(0.0,float(r.get("Tester",0) or 0))}

        st=stock[stock["Store Name"].astype(str).str.strip()==store].copy()
        st["EAN Code"]=st["EAN Code"].astype(str).str.strip()
        st=st.drop_duplicates("EAN Code",keep="last")
        st_map=st.set_index("EAN Code").to_dict("index")

        vv=var[var["Store Name"].astype(str).str.strip()==store].copy()
        vv["EAN Code"]=vv["EAN Code"].astype(str).str.strip()
        vv=vv.drop_duplicates("EAN Code",keep="last")
        var_map=vv.set_index("EAN Code").to_dict("index")

        # Use the submitted rows as the authoritative SKU list so every SKU the
        # store entered appears in both PDFs.
        report=[]
        for ean,x in submitted.items():
            sr=st_map.get(ean,{})
            vr=var_map.get(ean,{})
            physical=x["Physical Stock"]
            system=float(sr.get("Stock",0) or 0)
            opening=float(vr.get("Opening Stock Qty",0) or 0)
            inward=float(vr.get("Inward Qty",0) or 0)
            tertiary=float(vr.get("Tertiary Qty",0) or 0)
            movement_closing=float(vr.get("Closing Stock Qty",0) or 0)
            report.append({
                "EAN Code":ean,
                "Product Name":str(sr.get("Product Name") or vr.get("Product Name") or x["Product Name"] or ""),
                "Opening Stock":opening,
                "Inward":inward,
                "Tertiary":tertiary,
                "Movement Closing":movement_closing,
                "System Stock":system,
                "Physical Stock":physical,
                "Variance":physical-system,
                "Stock Qty":x["Stock Qty"],
                "Tester Qty":x["Tester Qty"],
                "Total Qty":physical,
            })

        return jsonify({"ok":True,"store":store,"email":email,"rows":report})
    except Exception as e:
        return jsonify({"ok":False,"error":str(e)}),500

@app.get("/api/submissions")
def submissions():
    try:
        if SUBMISSION_API_URL: return jsonify(remote_request("GET") or {})
        return jsonify({"ok":True,"records":json_records(load_local_submissions())})
    except Exception as e: return jsonify({"ok":False,"error":str(e)}),500

@app.get("/api/export")
def export():
    try:
        stock=load_stock(False)
        for col in ["Type","Store Name","Pareto","Product Name","EAN Code"]:
            vals=request.args.getlist(col)
            if vals: stock=stock[stock[col].isin(vals)]
        return Response(stock.to_csv(index=False),mimetype="text/csv",headers={"Content-Disposition":"attachment; filename=stock_dashboard.csv"})
    except Exception as e: return jsonify({"ok":False,"error":str(e)}),500

@app.get("/api/variance-export")
def variance_export():
    try:
        df=merge_variance_actuals(load_variance(False), load_stock(False))
        if request.args.get("store"): df=df[df["Store Name"]==request.args.get("store")]
        if request.args.get("sku"):
            q=request.args.get("sku").lower(); df=df[df["EAN Code"].str.lower().str.contains(q,na=False) | df["Product Name"].str.lower().str.contains(q,na=False)]
        if request.args.get("issues")=="1":
            df=df[(df["Stock Variance Qty"].abs()>0) | (df["Live Submission"] & (df["Difference Qty"].abs()>0))]
        return Response(df.to_csv(index=False),mimetype="text/csv",headers={"Content-Disposition":"attachment; filename=variance_analysis.csv"})
    except Exception as e: return jsonify({"ok":False,"error":str(e)}),500
