import io, os, time, json, sqlite3
from urllib.parse import urlparse, parse_qs, urlencode, urlunparse
from datetime import datetime, timezone
import requests
import pandas as pd
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
    df["Movement Check Qty"] = (df["Calculated Closing Qty"].round(4) == df["Closing Stock Qty"].round(4))
    df["Movement Check"] = df["Movement Check Qty"]
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
    """Fast quantity-only variance merge. Uses vectorized pandas joins instead of row-by-row loops."""
    out = var.copy()
    out["__key"] = out["Store Name"].astype(str).str.strip() + "|" + out["EAN Code"].astype(str).str.strip()

    # Current system stock by Store + EAN.
    st = stock[["Store Name","EAN Code","Product Name","Stock"]].copy()
    st["__key"] = st["Store Name"].astype(str).str.strip() + "|" + st["EAN Code"].astype(str).str.strip()
    st = st.drop_duplicates("__key", keep="last")[["__key","Product Name","Stock"]].rename(columns={"Product Name":"__Stock Product Name","Stock":"System Stock Qty"})
    out = out.merge(st, on="__key", how="left")

    # Latest field submission per Store + EAN.
    subs = load_submissions_live()
    if not subs.empty:
        for c in ["store_name","ean_code","product_name"]:
            if c not in subs.columns: subs[c] = ""
        if "total" not in subs.columns: subs["total"] = 0
        if "submitted_at" not in subs.columns: subs["submitted_at"] = ""
        subs["__key"] = subs["store_name"].fillna("").astype(str).str.strip() + "|" + subs["ean_code"].fillna("").astype(str).str.strip()
        subs["total"] = pd.to_numeric(subs["total"], errors="coerce").fillna(0)
        subs = subs.sort_values("submitted_at").drop_duplicates("__key", keep="last")
        sub = subs[["__key","product_name","total"]].rename(columns={"product_name":"__Submitted Product Name","total":"Actual Closing Qty"})
        out = out.merge(sub, on="__key", how="left")
    else:
        out["Actual Closing Qty"] = pd.NA

    out["System Stock Qty"] = pd.to_numeric(out["System Stock Qty"], errors="coerce").fillna(out["Closing Stock Qty"]).fillna(0)
    out["Actual Closing Qty"] = pd.to_numeric(out["Actual Closing Qty"], errors="coerce")
    out["Difference Qty"] = out["Actual Closing Qty"].sub(out["System Stock Qty"]).where(out["Actual Closing Qty"].notna(), 0)
    out["Live Submission"] = out["Actual Closing Qty"].notna()

    # Keep submitted SKUs even if they are absent from the movement workbook.
    if not subs.empty:
        existing = set(out["__key"])
        extra = subs[~subs["__key"].isin(existing)].copy()
        if not extra.empty:
            extra["Store Name"] = extra["__key"].str.rsplit("|", n=1).str[0]
            extra["EAN Code"] = extra["__key"].str.rsplit("|", n=1).str[1]
            extra["Product Name"] = extra["__Submitted Product Name"]
            extra["Opening Stock Qty"] = 0; extra["Inward Qty"] = 0; extra["Tertiary Qty"] = 0; extra["Closing Stock Qty"] = 0
            extra["Calculated Closing Qty"] = 0; extra["Movement Check Qty"] = False; extra["Movement Check"] = False
            extra["System Stock Qty"] = 0
            # If current Stock_Data has this SKU, use it.
            extra = extra.merge(st[["__key","System Stock Qty"]], on="__key", how="left", suffixes=("","_stock"))
            extra["System Stock Qty"] = pd.to_numeric(extra["System Stock Qty_stock"], errors="coerce").fillna(extra["System Stock Qty"]).fillna(0)
            extra["Actual Closing Qty"] = pd.to_numeric(extra["Actual Closing Qty"], errors="coerce").fillna(0)
            extra["Difference Qty"] = extra["Actual Closing Qty"] - extra["System Stock Qty"]
            extra["Live Submission"] = True
            extra = extra[out.columns]
            out = pd.concat([out, extra], ignore_index=True, sort=False)

    return out.drop(columns=[c for c in ["__key","__Stock Product Name","__Submitted Product Name"] if c in out.columns])


def load_variance(force=False):
    now=time.time(); url=VARIANCE_EXCEL_URL or EXCEL_URL
    if force or _cache["var_df"] is None or now-_cache["var_ts"]>=CACHE_SECONDS:
        df,src=read_sheet_from_workbook(url, VARIANCE_SHEET, "data.xlsx", force)
        _cache.update(var_ts=now,var_df=clean_variance(df),var_source=src)
    return _cache["var_df"].copy()


def json_records(df):
    out=df.copy()
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
            df=df[(~df["Movement Check"]) | (df["Live Submission"] & (df["Difference Qty"].abs()>0))]
        return Response(df.to_csv(index=False),mimetype="text/csv",headers={"Content-Disposition":"attachment; filename=variance_analysis.csv"})
    except Exception as e: return jsonify({"ok":False,"error":str(e)}),500
