import io, os, time
from urllib.parse import urlparse, parse_qs, urlencode, urlunparse
import requests
import pandas as pd
from flask import Flask, jsonify, render_template, request, Response

app = Flask(__name__)
EXCEL_URL = os.getenv("EXCEL_URL", "").strip()
EXCEL_SHEET = os.getenv("EXCEL_SHEET", "").strip()
CACHE_SECONDS = int(os.getenv("CACHE_SECONDS", "300"))

EXPECTED = ["Type","Store Name","EAN Code","Product Name","Pareto","Stock",
            "Total MRP Value","L3M Avg Qty","L3M Avg Value","NOD"]

_cache = {"ts": 0, "df": None, "source": ""}

def public_download_url(url):
    """Best-effort conversion for public OneDrive/SharePoint/Excel links."""
    if not url:
        return ""
    # Many Microsoft share links honor download=1.
    parts = urlparse(url)
    q = parse_qs(parts.query)
    q["download"] = ["1"]
    return urlunparse((parts.scheme, parts.netloc, parts.path, parts.params,
                       urlencode(q, doseq=True), parts.fragment))

def load_from_url(url):
    candidates = [url]
    dl = public_download_url(url)
    if dl != url:
        candidates.append(dl)
    last = None
    for u in candidates:
        try:
            r = requests.get(u, timeout=35, allow_redirects=True,
                             headers={"User-Agent":"Mozilla/5.0"})
            r.raise_for_status()
            ctype = (r.headers.get("content-type") or "").lower()
            data = r.content
            if len(data) > 1000 and (data[:2] == b"PK" or "spreadsheet" in ctype or "excel" in ctype):
                return data
            # Some servers return xlsx bytes without a useful content type.
            if len(data) > 10000 and data[:2] == b"PK":
                return data
            last = f"Received non-Excel content ({ctype or 'unknown content-type'})"
        except Exception as e:
            last = str(e)
    raise RuntimeError(last or "Could not download Excel file")

def load_df(force=False):
    now = time.time()
    if not force and _cache["df"] is not None and now - _cache["ts"] < CACHE_SECONDS:
        return _cache["df"].copy(), _cache["source"]
    if EXCEL_URL:
        raw = load_from_url(EXCEL_URL)
        xls = pd.ExcelFile(io.BytesIO(raw))
        sheet = EXCEL_SHEET if EXCEL_SHEET and EXCEL_SHEET in xls.sheet_names else xls.sheet_names[0]
        df = pd.read_excel(io.BytesIO(raw), sheet_name=sheet)
        source = f"Linked Excel • {sheet}"
    else:
        local = os.path.join(app.root_path, "data", "data.xlsx")
        if not os.path.exists(local):
            raise RuntimeError("EXCEL_URL is not configured and data/data.xlsx is missing.")
        df = pd.read_excel(local)
        source = "Bundled Excel"
    df.columns = [str(c).strip() for c in df.columns]
    missing = [c for c in EXPECTED if c not in df.columns]
    if missing:
        raise RuntimeError("Missing required columns: " + ", ".join(missing))
    for c in ["Stock","Total MRP Value","L3M Avg Qty","L3M Avg Value","NOD"]:
        df[c] = pd.to_numeric(df[c], errors="coerce").fillna(0)
    for c in ["Type","Store Name","EAN Code","Product Name","Pareto"]:
        df[c] = df[c].fillna("").astype(str).str.strip()
    _cache.update({"ts": now, "df": df, "source": source})
    return df.copy(), source

def clean_num(x):
    if pd.isna(x): return 0
    return float(x)

def serialize_records(df):
    out = df.copy()
    for c in out.columns:
        if pd.api.types.is_numeric_dtype(out[c]):
            out[c] = out[c].apply(clean_num)
        else:
            out[c] = out[c].fillna("").astype(str)
    return out.to_dict(orient="records")

@app.get("/")
def index():
    return render_template("index.html")

@app.get("/api/data")
def api_data():
    try:
        df, source = load_df(force=request.args.get("refresh") == "1")
        return jsonify({
            "ok": True, "source": source, "rows": len(df),
            "columns": list(df.columns),
            "records": serialize_records(df)
        })
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500

@app.get("/api/health")
def health():
    try:
        df, source = load_df()
        return jsonify({"ok": True, "rows": len(df), "source": source})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500

@app.get("/api/export")
def export():
    try:
        df, _ = load_df()
        # Apply simple query-string filters to keep export useful.
        for col in ["Type","Store Name","Pareto","Product Name","EAN Code"]:
            vals = request.args.getlist(col)
            if vals:
                df = df[df[col].isin(vals)]
        return Response(df.to_csv(index=False), mimetype="text/csv",
                        headers={"Content-Disposition":"attachment; filename=sku_stock_dashboard.csv"})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.getenv("PORT","5000")), debug=False)
