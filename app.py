import io, os, time, json, sqlite3, functools, secrets, base64, hashlib, threading, gzip, logging
from datetime import timedelta
from urllib.parse import urlparse, parse_qs, urlencode, urlunparse
from datetime import datetime, timezone
import requests
import pandas as pd
import re
from flask import Flask, jsonify, render_template, request, Response, session, redirect, send_file, make_response

app = Flask(__name__)
log = logging.getLogger("cormate")
# Render (and most hosts) terminate TLS at a proxy. Trust X-Forwarded-* so generated links are https.
if os.getenv("TRUST_PROXY", "1").strip().lower() not in {"0", "false", "no"}:
    from werkzeug.middleware.proxy_fix import ProxyFix
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)
# Static files change rarely; let browsers cache them (cache-busting is done with ?v=<mtime>).
app.config["SEND_FILE_MAX_AGE_DEFAULT"] = timedelta(hours=12)
SECRET_KEY = os.getenv("SECRET_KEY", "").strip()
if not SECRET_KEY:
    raise RuntimeError("SECRET_KEY must be configured in the server environment; refusing to start with a fallback key.")
app.secret_key = SECRET_KEY

@app.errorhandler(500)
def handle_internal_error(error):
    # Never return an HTML error page to the upload/admin JavaScript.
    # Log the real exception and return a compact JSON response for API calls.
    log.exception("Unhandled server error", exc_info=error)
    if request.path.startswith("/api/") or request.path.startswith("/manual-upload"):
        return jsonify({"ok": False, "error": "Server error. Please check the Render logs for the exact cause."}), 500
    return "Internal server error", 500

app.config.update(SESSION_COOKIE_HTTPONLY=True, SESSION_COOKIE_SAMESITE=os.getenv("SESSION_COOKIE_SAMESITE", "Lax"), SESSION_COOKIE_SECURE=os.getenv("SESSION_COOKIE_SECURE", "1").strip().lower() not in {"0", "false", "no"})
DASHBOARD_PASSWORD = os.getenv("DASHBOARD_PASSWORD", "")
ADMIN_EMAIL = os.getenv("ADMIN_EMAIL", "admin@cormate.com").strip().lower()
ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD", "").strip()
USERS_JSON_PATH = os.getenv("USERS_JSON_PATH", os.path.join(app.root_path, "data", "users.json")).strip()
SHOPS_JSON_PATH = os.getenv("SHOPS_JSON_PATH", os.path.join(app.root_path, "data", "shops.json")).strip()
ADMIN_UPLOAD_MAX_MB = int(os.getenv("ADMIN_UPLOAD_MAX_MB", "15"))
app.config["MAX_CONTENT_LENGTH"] = ADMIN_UPLOAD_MAX_MB * 1024 * 1024
GITHUB_CONFIG_TOKEN = os.getenv("GITHUB_CONFIG_TOKEN", "").strip()
GITHUB_CONFIG_REPO = os.getenv("GITHUB_CONFIG_REPO", "").strip()
GITHUB_CONFIG_BRANCH = os.getenv("GITHUB_CONFIG_BRANCH", "main").strip() or "main"
GITHUB_USERS_PATH = os.getenv("GITHUB_USERS_PATH", "data/users.json").strip()
GITHUB_MAPPING_PATH = os.getenv("GITHUB_MAPPING_PATH", "data/mapping.json").strip()
GITHUB_SHOPS_PATH = os.getenv("GITHUB_SHOPS_PATH", "data/shops.json").strip()
UPLOAD_LINK_HOURS = int(os.getenv("UPLOAD_LINK_HOURS", "48"))
# Optional public URL used for shareable manual-upload links.
# Example on Render: https://your-app.onrender.com
PUBLIC_BASE_URL = os.getenv("PUBLIC_BASE_URL", "").strip().rstrip("/")

@app.context_processor
def _asset_helpers():
    def asset_v(name):
        """Cache-busting token = file modification time, so browsers re-download only when a file really changed."""
        try: return int(os.path.getmtime(os.path.join(app.static_folder, name)))
        except OSError: return 0
    return {"asset_v": asset_v}


_STATIC_GZ = {}
_COMPRESSIBLE = ("text/", "application/json", "application/javascript", "text/javascript", "image/svg")

@app.after_request
def compress_response(response):
    """gzip text responses. Static files are compressed once and kept in memory."""
    try:
        if response.status_code < 200 or response.status_code >= 300 or "Content-Encoding" in response.headers:
            return response
        if "gzip" not in request.headers.get("Accept-Encoding", ""):
            return response
        ctype = (response.mimetype or "").lower()
        if not any(ctype.startswith(c) for c in _COMPRESSIBLE):
            return response
        if response.direct_passthrough:
            # send_file() / static files: compress once per (path, mtime) and reuse.
            if request.method != "GET" or not request.path.startswith("/static/"):
                return response
            rel = request.path[len("/static/"):]
            full = os.path.join(app.static_folder, rel)
            try: key = (full, os.path.getmtime(full))
            except OSError: return response
            gz = _STATIC_GZ.get(key)
            if gz is None:
                with open(full, "rb") as f: raw = f.read()
                if len(raw) < 1500: return response
                gz = gzip.compress(raw, compresslevel=6)
                _STATIC_GZ[key] = gz
            response.direct_passthrough = False
            response.set_data(gz)
        else:
            data = response.get_data()
            if len(data) < 1500: return response
            response.set_data(gzip.compress(data, compresslevel=4))
        response.headers["Content-Encoding"] = "gzip"
        response.headers["Content-Length"] = str(len(response.get_data()))
        response.headers.add("Vary", "Accept-Encoding")
        response.headers.pop("ETag", None)
    except Exception:
        log.exception("compression skipped")
    return response

@app.after_request
def security_headers(response):
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "SAMEORIGIN")
    response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
    if (response.mimetype or "") == "text/html":
        response.headers.setdefault("Cache-Control", "private, no-cache")   # always revalidate pages, never share between users
    return response
EXCEL_URL = os.getenv("EXCEL_URL", "").strip()
EXCEL_SHEET = os.getenv("EXCEL_SHEET", "Stock_Data").strip()
VARIANCE_EXCEL_URL = os.getenv("VARIANCE_EXCEL_URL", "").strip()
VARIANCE_SHEET = os.getenv("VARIANCE_SHEET", "Variance_Data").strip()
CACHE_SECONDS = int(os.getenv("CACHE_SECONDS", "900"))
MAPPING_JSON_PATH = os.getenv("MAPPING_JSON_PATH", os.path.join(app.root_path, "data", "mapping.json")).strip()
MAPPING_JSON_URL = os.getenv("MAPPING_JSON_URL", "").strip()
MAPPING_JSON_SOURCE = os.getenv("MAPPING_JSON_SOURCE", "local").strip().lower()
MAPPING_CACHE_SECONDS = int(os.getenv("MAPPING_CACHE_SECONDS", "900"))
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
    "map_ts": 0, "map_df": None, "map_source": "", "master_ts": 0, "master_df": None,
}


def public_download_url(url):
    if not url: return ""
    parts = urlparse(url); q = parse_qs(parts.query); q["download"] = ["1"]
    return urlunparse((parts.scheme, parts.netloc, parts.path, parts.params, urlencode(q, doseq=True), parts.fragment))


_data_lock = threading.RLock()      # serialises heavy Excel downloads / parses (never held for cache hits)
_bg_guard = threading.Lock()
_bg_running = set()
MIN_FORCE_INTERVAL = int(os.getenv("MIN_FORCE_INTERVAL", "20"))   # seconds; stops refresh-button stampedes
STALE_RETRY_SECONDS = 60


def load_from_url(url):
    candidates = [url]
    dl = public_download_url(url)
    if dl != url: candidates.append(dl)
    last = None
    for u in candidates:
        for attempt in range(2):
            try:
                r = requests.get(u, timeout=(8, 60), allow_redirects=True, headers={"User-Agent":"Mozilla/5.0"})
                r.raise_for_status(); data = r.content; ctype = (r.headers.get("content-type") or "").lower()
                if len(data) > 1000 and (data[:2] == b"PK" or "spreadsheet" in ctype or "excel" in ctype): return data
                if len(data) > 10000 and data[:2] == b"PK": return data
                last = f"Received non-Excel content ({ctype or 'unknown content-type'})"
                break                      # a wrong-content answer will not fix itself on retry
            except Exception as e:
                last = str(e)
                time.sleep(0.6)
    raise RuntimeError(last or "Could not download Excel file")


def workbook_raw(url, force=False):
    """Download (and cache) the workbook bytes. Callers hold _data_lock."""
    with _data_lock:
        now = time.time()
        age = now - _cache["workbook_ts"]
        have = _cache["workbook_raw"] is not None and _cache["workbook_url"] == url
        if have and (age < CACHE_SECONDS) and (not force or age < MIN_FORCE_INTERVAL):
            return _cache["workbook_raw"]
        if have and force and age < MIN_FORCE_INTERVAL:
            return _cache["workbook_raw"]
        raw = load_from_url(url) if url else None
        _cache.update(workbook_ts=time.time(), workbook_raw=raw, workbook_url=url)
        return raw


def read_sheet_from_workbook(url, sheet_name, local_name, force=False):
    # A fresh ExcelFile per read: pandas/openpyxl readers are NOT thread-safe, so they are never shared.
    with _data_lock:
        if url:
            raw = workbook_raw(url, force)
            with pd.ExcelFile(io.BytesIO(raw)) as xls:
                sheet = sheet_name if sheet_name and sheet_name in xls.sheet_names else xls.sheet_names[0]
                return pd.read_excel(xls, sheet_name=sheet), f"Linked Excel • {sheet}"
        local = os.path.join(app.root_path, "data", local_name)
        if not os.path.exists(local): raise RuntimeError(f"No linked Excel configured and {local_name} is missing.")
        return pd.read_excel(local, sheet_name=sheet_name if sheet_name else 0), f"Bundled Excel • {sheet_name}"


def _swr(prefix, ttl, build, force=False):
    """Stale-while-revalidate cache for a DataFrame.

    * fresh            -> return immediately
    * stale            -> return the old data immediately and refresh in the background
    * empty / forced   -> one thread rebuilds (others wait on the lock, then reuse the result)
    * rebuild fails    -> keep serving the last good data (the error is logged, retried in ~60s)
    """
    k_df, k_ts = prefix + "_df", prefix + "_ts"
    df = _cache.get(k_df); now = time.time()
    if df is not None and not force:
        if now - _cache.get(k_ts, 0) < ttl: return df
        _kick_refresh(prefix, ttl, build)
        return df
    with _data_lock:
        df = _cache.get(k_df)
        age = time.time() - _cache.get(k_ts, 0)
        if df is not None and (age < MIN_FORCE_INTERVAL if force else age < ttl):
            return df                        # another request already refreshed it
        new = build()
        _store_df(prefix, new)
        return new


def _store_df(prefix, new):
    gen = _cache.get("_gen_" + prefix, 0) + 1
    new.attrs["_gen"] = gen                    # the version travels with the data (no race with readers)
    _cache["_gen_" + prefix] = gen
    _cache[prefix + "_df"] = new
    _cache[prefix + "_ts"] = time.time()


def _kick_refresh(prefix, ttl, build):
    with _bg_guard:
        if prefix in _bg_running: return
        _bg_running.add(prefix)
    def run():
        try:
            with _data_lock:
                _store_df(prefix, build())
        except Exception:
            log.exception("Background refresh of %s failed; serving the previous data", prefix)
            _cache[prefix + "_ts"] = time.time() - ttl + STALE_RETRY_SECONDS
        finally:
            with _bg_guard: _bg_running.discard(prefix)
    threading.Thread(target=run, daemon=True, name=f"refresh-{prefix}").start()


def _norm_ean_value(v):
    """'8901234567890.0', 8.90123456789e12, ' 890... ' -> '8901234567890'."""
    if v is None: return ""
    if isinstance(v, float):
        if v != v: return ""
        if v.is_integer(): return str(int(v))
    s = str(v).strip()
    if not s or s.lower() in {"nan", "none", "null"}: return ""
    if re.fullmatch(r"\d+\.0+", s): return s.split(".")[0]
    if re.fullmatch(r"\d+(\.\d+)?[eE]\+?\d+", s):
        try:
            from decimal import Decimal
            d = Decimal(s)
            if d == d.to_integral_value(): return str(int(d))
        except Exception: pass
    return s


def norm_ean_series(series):
    return series.map(_norm_ean_value).astype(str)


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
    for c in ["Type","Store Name","Product Name","Pareto"]: df[c] = df[c].fillna("").astype(str).str.strip()
    df["EAN Code"] = norm_ean_series(df["EAN Code"])
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
    for c in ["Store Name","Product Name"]: df[c] = df[c].fillna("").astype(str).str.strip()
    df["EAN Code"] = norm_ean_series(df["EAN Code"])
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
    df["EAN Code"] = norm_ean_series(df["EAN Code"])
    return df[df["EAN Code"]!=""].drop_duplicates(subset=["EAN Code"], keep="first")


def _build_stock():
    df, src = read_sheet_from_workbook(EXCEL_URL, EXCEL_SHEET, "data.xlsx", False)
    out = clean_stock(df)
    _cache["stock_source"] = src
    return out


def load_stock(force=False, copy=True):
    df = _swr("stock", CACHE_SECONDS, _build_stock, force)
    return df.copy() if copy else df


def clean_json_map(payload):
    """Convert the VBA mapping.json format into the internal mapping DataFrame.

    Supported JSON:
    {
      "users": {
        "email@company.com": [
          {"store_code":"D009", "store_name":"H&B-NCR DC", "city":"Delhi", "region":"North"}
        ]
      }
    }

    A simple email -> ["Store 1", "Store 2"] format is also accepted.
    """
    if not isinstance(payload, dict):
        raise RuntimeError("mapping.json must be a JSON object.")

    # Accept both the older {"users": {...}} format and the VBA-generated
    # {"mappings": {"email": {"shops": [...]}}} format.
    if isinstance(payload.get("mappings"), dict):
        users = payload.get("mappings", {})
        normalized = {}
        for raw_email, raw_value in users.items():
            if isinstance(raw_value, dict) and "shops" in raw_value:
                normalized[raw_email] = raw_value.get("shops", [])
            else:
                normalized[raw_email] = raw_value
        users = normalized
    else:
        users = payload.get("users", payload)

    records = []
    if not isinstance(users, dict):
        raise RuntimeError("mapping.json must contain an email-to-store object.")

    for raw_email, raw_stores in users.items():
        email = str(raw_email or "").strip().lower()
        if not email:
            continue
        if isinstance(raw_stores, dict):
            raw_stores = [raw_stores]
        if not isinstance(raw_stores, list):
            continue
        for shop in raw_stores:
            if isinstance(shop, str):
                store_name, store_code, city, region = shop.strip(), "", "", ""
            elif isinstance(shop, dict):
                store_name = str(shop.get("store_name", shop.get("Store Name", shop.get("shop_name", shop.get("Shop Name", shop.get("name", ""))))) or "").strip()
                store_code = str(shop.get("store_code", shop.get("Store Code", shop.get("code", ""))) or "").strip()
                city = str(shop.get("city", shop.get("City", "")) or "").strip()
                region = str(shop.get("region", shop.get("Region", "")) or "").strip()
                status = str(shop.get("status", shop.get("Status", "Active")) or "Active").strip().lower()
                if status not in {"active", "enabled"}:
                    continue
            else:
                continue
            if store_name:
                records.append({"Email ID": email, "Store Name": store_name,
                                "Store Code": store_code, "City": city, "Region": region})

    if not records:
        raise RuntimeError("mapping.json contains no valid email-to-store mappings.")
    return pd.DataFrame(records).drop_duplicates(subset=["Email ID", "Store Name"], keep="first")


def load_mapping(force=False):
    """Load the lightweight JSON mapping. This is the fast path for Entry email/shop lookup."""
    now = time.time()
    if not force and _cache.get("map_df") is not None and now - _cache.get("map_ts", 0) < MAPPING_CACHE_SECONDS:
        return _cache["map_df"].copy()

    payload = None
    source = ""

    # The bundled file is the canonical production mapping. Render environment
    # variables cannot redirect this lookup accidentally. A remote mapping is
    # opt-in only via MAPPING_JSON_SOURCE=remote.
    use_remote = MAPPING_JSON_SOURCE == "remote" and bool(MAPPING_JSON_URL)

    if use_remote:
        try:
            r = requests.get(MAPPING_JSON_URL, timeout=20, headers={"User-Agent": "Mozilla/5.0"})
            r.raise_for_status()
            payload = r.json()
            source = "Linked JSON"
        except Exception as e:
            raise RuntimeError(f"Could not load MAPPING_JSON_URL: {e}")
    else:
        path = MAPPING_JSON_PATH
        if not os.path.exists(path):
            raise RuntimeError(f"Canonical mapping JSON not found: {path}")
        try:
            with open(path, "r", encoding="utf-8-sig") as f:
                payload = json.load(f)
            source = "Bundled JSON • data/mapping.json"
        except Exception as e:
            raise RuntimeError(f"Could not read canonical mapping JSON: {e}")

    mp = clean_json_map(payload)
    _cache["map_df"] = mp
    _cache["map_ts"] = now
    _cache["map_source"] = source
    return mp.copy()


def _build_master():
    with _data_lock:
        if EXCEL_URL:
            raw = workbook_raw(EXCEL_URL, False)
            xls = pd.ExcelFile(io.BytesIO(raw))
        else:
            path = os.path.join(app.root_path, "data", "data.xlsx")
            if not os.path.exists(path):
                raise RuntimeError("No linked Excel configured and data.xlsx is missing.")
            xls = pd.ExcelFile(path)
        with xls:
            if "SKU_Master" in xls.sheet_names:
                return clean_master(pd.read_excel(xls, sheet_name="SKU_Master"))
            return pd.DataFrame(columns=MASTER_REQUIRED)


def load_master(force=False):
    return _swr("master", CACHE_SECONDS, _build_master, force).copy()


def load_entry_sources(force=False):
    """Compatibility wrapper: mapping comes from JSON; SKU master remains in Excel."""
    return load_mapping(force), load_master(force)


# -----------------------------------------------------------------------------
# Submissions: one normaliser, one cache, used by Entry history, Admin audit and Variance.
# -----------------------------------------------------------------------------
SUBMISSIONS_TTL = int(os.getenv("SUBMISSIONS_CACHE_SECONDS", "20"))
HISTORY_SCOPE = os.getenv("HISTORY_SCOPE", "shop").strip().lower()          # "shop" (default) or "own"
HISTORY_MAX_ENTRIES = int(os.getenv("HISTORY_MAX_ENTRIES", "60"))
RECENT_TTL = 30 * 60
SUB_COLUMNS = ["entry_no", "submitted_at", "email", "store_name", "ean_code", "product_name", "stock", "tester", "total", "submitted_by"]
_SUB_ALIASES = {
    "entry_no": "entry_no", "entry_number": "entry_no", "entry": "entry_no",
    "submitted_at": "submitted_at", "date": "submitted_at", "timestamp": "submitted_at", "submitted_date": "submitted_at", "submitted_on": "submitted_at",
    "email": "email", "email_id": "email", "submitted_by_email": "email",
    "store_name": "store_name", "store": "store_name", "shop_name": "store_name", "shop": "store_name",
    "ean_code": "ean_code", "ean": "ean_code", "sku": "ean_code", "sku_code": "ean_code",
    "product_name": "product_name", "product": "product_name", "description": "product_name",
    "stock": "stock", "stock_qty": "stock", "tester": "tester", "tester_qty": "tester",
    "total": "total", "total_qty": "total", "submitted_by": "submitted_by",
}
_subs = {"df": None, "ts": 0.0, "gen": 0, "error": "", "refreshing": False}
_subs_lock = threading.Lock()
_recent = []
_recent_lock = threading.Lock()


def _empty_subs():
    return pd.DataFrame({"entry_no": pd.Series(dtype=str), "submitted_at": pd.Series(dtype=str), "email": pd.Series(dtype=str),
                         "store_name": pd.Series(dtype=str), "ean_code": pd.Series(dtype=str), "product_name": pd.Series(dtype=str),
                         "stock": pd.Series(dtype=float), "tester": pd.Series(dtype=float), "total": pd.Series(dtype=float),
                         "submitted_by": pd.Series(dtype=str), "_ts": pd.Series(dtype="datetime64[ns, UTC]")})


def _parse_ts(series):
    try: return pd.to_datetime(series, errors="coerce", utc=True, format="mixed")
    except Exception: return pd.to_datetime(series, errors="coerce", utc=True)


def _normalize_submissions(df):
    """Accept local SQLite rows or Apps Script records (any header spelling) -> one clean schema."""
    if df is None or len(df) == 0: return _empty_subs()
    df = df.copy()
    canon = {}
    for c in df.columns:                      # exact canonical names win over aliases
        n = re.sub(r"[^a-z0-9]+", "_", str(c).strip().lower()).strip("_")
        if n in SUB_COLUMNS and n not in canon.values(): canon[c] = n
    for c in df.columns:
        if c in canon: continue
        n = re.sub(r"[^a-z0-9]+", "_", str(c).strip().lower()).strip("_")
        t = _SUB_ALIASES.get(n)
        if t and t not in canon.values(): canon[c] = t
    df = df[list(canon)].rename(columns=canon)
    for c in SUB_COLUMNS:
        if c not in df.columns: df[c] = 0.0 if c in ("stock", "tester", "total") else ""
    for c in ("entry_no", "email", "store_name", "product_name", "submitted_by", "submitted_at"):
        df[c] = df[c].fillna("").astype(str).str.strip()
    df["email"] = df["email"].str.lower()
    df["ean_code"] = norm_ean_series(df["ean_code"])
    for c in ("stock", "tester", "total"):
        df[c] = pd.to_numeric(df[c], errors="coerce").fillna(0.0)
    df["_ts"] = _parse_ts(df["submitted_at"])
    return df[SUB_COLUMNS + ["_ts"]].reset_index(drop=True)


def _fetch_submissions_raw():
    if SUBMISSION_API_URL:
        result = remote_request("GET") or {}
        if not result.get("ok"):
            raise RuntimeError(result.get("error") or "The submission service rejected the request.")
        return pd.DataFrame(result.get("records", []) or [])
    return load_local_submissions()


def _refresh_submissions():
    new = _normalize_submissions(_fetch_submissions_raw())
    _subs.update(df=new, ts=time.time(), error="", gen=_subs["gen"] + 1)
    return new


def _recent_rows_df(known_entries):
    now = time.time()
    with _recent_lock:
        _recent[:] = [r for r in _recent if now - r["_t"] < RECENT_TTL]
        extra = [{k: v for k, v in r.items() if k != "_t"} for r in _recent if r["entry_no"] not in known_entries]
    return _normalize_submissions(pd.DataFrame(extra)) if extra else None


def get_submissions(force=False):
    """Cached submissions (stale-while-revalidate). Raises only if nothing at all can be shown.

    Rows this server accepted in the last 30 minutes are always merged in, so a user's own
    entry is visible immediately even if the Google Sheet is slow or briefly unreachable.
    """
    df = _subs["df"]
    if df is None or force:
        with _subs_lock:
            if _subs["df"] is None or (force and time.time() - _subs["ts"] > 2):
                try: _refresh_submissions()
                except Exception as e:
                    log.exception("Could not load submissions")
                    _subs["error"] = str(e)
                    if _subs["df"] is None:
                        extra = _recent_rows_df(set())
                        if extra is not None: return extra
                        raise
        df = _subs["df"]
    elif time.time() - _subs["ts"] >= SUBMISSIONS_TTL:
        with _subs_lock:
            start = not _subs["refreshing"]
            if start: _subs["refreshing"] = True
        if start:
            def run():
                try: _refresh_submissions()
                except Exception as e:
                    log.warning("Background submission refresh failed: %s", e)
                    _subs["error"] = str(e); _subs["ts"] = time.time() - SUBMISSIONS_TTL + 10
                finally: _subs["refreshing"] = False
            threading.Thread(target=run, daemon=True, name="refresh-submissions").start()
    extra = _recent_rows_df(set(df["entry_no"]) if len(df) else set())
    return pd.concat([df, extra], ignore_index=True) if extra is not None else df


def submissions_version():
    return (_subs["gen"], len(_recent))


def remember_submission(entry_no, email, store, rows, submitted_by=""):
    """Call after a successful save: makes the entry visible at once and schedules a refresh."""
    ts = datetime.now(timezone.utc).isoformat(); now = time.time()
    recs = [{"entry_no": entry_no, "submitted_at": ts, "email": email, "store_name": store, "ean_code": r.get("EAN Code", ""),
             "product_name": r.get("Product Name", ""), "stock": r.get("Stock", 0), "tester": r.get("Tester", 0),
             "total": r.get("Total", 0), "submitted_by": submitted_by or email, "_t": now} for r in rows]
    with _recent_lock:
        _recent.extend(recs)
        del _recent[:-5000]
    _subs["ts"] = 0.0


def entry_already_saved(entry_no):
    """Duplicate-tap guard: a retry of the same entry number must not create a second copy."""
    entry_no = str(entry_no or "").strip()
    if not entry_no: return False
    with _recent_lock:
        if any(r["entry_no"] == entry_no for r in _recent): return True
    df = _subs["df"]
    return bool(df is not None and len(df) and (df["entry_no"] == entry_no).any())


def load_submissions_live():
    """Used by Variance. Never raises: variance still works (without actuals) if submissions are down."""
    try: return get_submissions()
    except Exception: return _empty_subs()


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
        subs = _empty_subs()
    subs = subs.copy()
    subs["__key"] = subs["store_name"].astype(str).str.strip() + "|" + subs["ean_code"].astype(str).str.strip()
    subs = subs[subs["total"] > 0]
    subs = subs.sort_values(["_ts", "submitted_at"], kind="stable", na_position="first").drop_duplicates("__key", keep="last")
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

def _build_variance():
    url = VARIANCE_EXCEL_URL or EXCEL_URL
    df, src = read_sheet_from_workbook(url, VARIANCE_SHEET, "data.xlsx", False)
    out = clean_variance(df)
    _cache["var_source"] = src
    return out


def load_variance(force=False, copy=True):
    df = _swr("var", CACHE_SECONDS, _build_variance, force)
    return df.copy() if copy else df


def json_records(df):
    out=df.copy()
    # Defensive cleanup: duplicate Excel headers break pandas records JSON conversion.
    out=out.loc[:, ~out.columns.duplicated()].copy()
    for c in out.columns:
        if pd.api.types.is_bool_dtype(out[c]): out[c]=out[c].astype(bool)
        elif pd.api.types.is_numeric_dtype(out[c]): out[c]=pd.to_numeric(out[c],errors="coerce").fillna(0)
        else: out[c]=out[c].fillna("").astype(str)
    return out.to_dict(orient="records")


_db_ready = False
_db_lock = threading.Lock()


def _db():
    return sqlite3.connect(DATABASE_PATH, timeout=20)


def db_init():
    global _db_ready
    if _db_ready and os.path.exists(DATABASE_PATH): return
    with _db_lock:
        os.makedirs(os.path.dirname(DATABASE_PATH) or ".", exist_ok=True)
        with _db() as con:
            try: con.execute("PRAGMA journal_mode=WAL")
            except Exception: pass
            con.execute("""CREATE TABLE IF NOT EXISTS submissions(id INTEGER PRIMARY KEY AUTOINCREMENT, entry_no TEXT, submitted_at TEXT, email TEXT, store_name TEXT, ean_code TEXT, product_name TEXT, stock REAL, tester REAL, total REAL)""")
            cols = [r[1] for r in con.execute("PRAGMA table_info(submissions)").fetchall()]
            if "entry_no" not in cols:
                con.execute("ALTER TABLE submissions ADD COLUMN entry_no TEXT DEFAULT '' ")
            con.execute("CREATE INDEX IF NOT EXISTS idx_sub_store ON submissions(store_name)")
        _db_ready = True


def save_local_submission(payload):
    db_init(); ts=datetime.now(timezone.utc).isoformat(); rows=[]
    for r in payload["rows"]:
        rows.append((str(payload.get("entry_no", "")).strip(),ts,payload["email"],payload["store_name"],str(r.get("EAN Code","")),str(r.get("Product Name","")),float(r.get("Stock",0) or 0),float(r.get("Tester",0) or 0),float(r.get("Total",0) or 0)))
    with _db() as con:
        con.executemany("INSERT INTO submissions(entry_no,submitted_at,email,store_name,ean_code,product_name,stock,tester,total) VALUES(?,?,?,?,?,?,?,?,?)",rows)
    return len(rows)


def load_local_submissions():
    db_init()
    con = _db()
    try: return pd.read_sql_query("SELECT * FROM submissions",con)
    finally: con.close()


def inward_db_init():
    db_init()
    with _db() as con:
        con.execute("""CREATE TABLE IF NOT EXISTS inward_submissions(
            id INTEGER PRIMARY KEY AUTOINCREMENT, submitted_at TEXT, email TEXT,
            document_no TEXT, shop_name TEXT, transfer_to_code TEXT, ean TEXT,
            description TEXT, quantity REAL, received_qty REAL, variance_qty REAL,
            variance_pct REAL, status TEXT, line_data_json TEXT)""")

def save_local_inward(email, po, rows):
    inward_db_init(); ts=datetime.now(timezone.utc).isoformat()
    out=[]
    for r in rows:
        out.append((ts, email, str(r.get("Document No.", po) or po), str(r.get("Shop Name", "") or ""),
                    str(r.get("Transfer-to Code", "") or ""), str(r.get("EAN", "") or ""),
                    str(r.get("Description", "") or ""), float(r.get("Quantity", 0) or 0),
                    float(r.get("Received Qty", 0) or 0), float(r.get("Variance Qty", 0) or 0),
                    None if r.get("Variance %") is None else float(r.get("Variance %")),
                    str(r.get("Status", "") or ""), json.dumps(r, ensure_ascii=False)))
    with _db() as con:
        con.executemany("""INSERT INTO inward_submissions(
            submitted_at,email,document_no,shop_name,transfer_to_code,ean,description,quantity,
            received_qty,variance_qty,variance_pct,status,line_data_json)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)""", out)
    return len(out)

def save_remote_inward(email, po, rows):
    url = INWARD_SUBMISSION_API_URL
    if not url:
        return save_local_inward(email, po, rows)
    payload = {"kind": "inward", "email": email, "po_number": po, "rows": rows}
    secret = os.getenv("INWARD_SUBMISSION_API_SECRET", SUBMISSION_API_SECRET).strip()
    if secret:
        payload["secret"] = secret
    r = requests.post(url, json=payload, timeout=45)
    try:
        data = r.json()
    except Exception:
        data = {}
    if r.status_code >= 400 or not data.get("ok"):
        detail = data.get("error") or r.text or f"HTTP {r.status_code}"
        raise RuntimeError(f"Inward submission service rejected the request: {detail}")
    saved = int(data.get("saved_rows", len(rows)) or 0)
    if saved != len(rows):
        raise RuntimeError(f"Submission mismatch: sent {len(rows)} rows but service saved {saved}.")
    return saved


def remote_request(method, payload=None, query=None):
    if not SUBMISSION_API_URL: return None
    payload=payload or {}
    try:
        if SUBMISSION_API_SECRET:
            if method.upper()=="GET":
                params={"secret":SUBMISSION_API_SECRET}; params.update(query or {}); r=requests.get(SUBMISSION_API_URL,params=params,timeout=(6,30))
            else:
                payload={**payload,"secret":SUBMISSION_API_SECRET}; r=requests.request(method,SUBMISSION_API_URL,json=payload,timeout=(8,40))
        else:
            r=requests.request(method,SUBMISSION_API_URL,json=payload,timeout=(8,40))
        try: data=r.json()
        except ValueError: data={"ok":False,"error":(r.text or "Empty response from submission service.")[:500]}
        if r.status_code>=400:
            data.setdefault("ok",False); data.setdefault("error",f"Submission service returned HTTP {r.status_code}."); data["http_status"]=r.status_code
        return data
    except requests.RequestException as exc:
        raise RuntimeError(f"Submission service connection failed: {exc}") from exc



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
    total={"sku_count":result["scope"]["skus"],"store_count":result["scope"]["stores"],"stock":float(x[mode_stock].sum()) if mode_stock in x else 0,"current_month":float(x[mode_cm].sum()) if mode_cm in x else 0,"ly":float(x[mode_ly].sum()) if mode_ly in x else 0,"l3m_avg":float(x[mode_l3].sum()) if mode_l3 in x else 0}
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


# -----------------------------------------------------------------------------
# CORMATE access control
# -----------------------------------------------------------------------------
def _load_users_config():
    if not os.path.exists(USERS_JSON_PATH):
        return {"users": {}}
    with open(USERS_JSON_PATH, "r", encoding="utf-8-sig") as f:
        payload = json.load(f)
    if not isinstance(payload, dict):
        return {"users": {}}
    users = payload.get("users", {})
    if not isinstance(users, dict):
        raise RuntimeError("users.json must contain a users object.")
    normalized = {}
    for raw_email, rec in users.items():
        key = str(raw_email or "").strip().lower()
        if key and isinstance(rec, dict): normalized[key] = rec
    return {**payload, "users": normalized}

def _user_record(email):
    email = str(email or "").strip().lower()
    rec = _load_users_config().get("users", {}).get(email)
    return rec if isinstance(rec, dict) else None

def _check_password(rec, password):
    if not rec: return False
    stored_hash = str(rec.get("password_hash", "")).strip()
    if stored_hash:
        try:
            from werkzeug.security import check_password_hash
            return check_password_hash(stored_hash, password)
        except Exception:
            import hashlib, hmac
            return hmac.compare_digest(hashlib.sha256(password.encode("utf-8")).hexdigest(), stored_hash)
    import hmac
    return hmac.compare_digest(str(rec.get("password", "")), password)

def _is_admin(email, password=None):
    email = str(email or "").strip().lower()
    if not email or email != ADMIN_EMAIL:
        return False
    if password is None:
        return bool(session.get("is_admin"))
    import hmac
    return bool(ADMIN_PASSWORD) and hmac.compare_digest(password, ADMIN_PASSWORD)

def _has_access(page):
    if session.get("is_admin"):
        return True
    access = session.get("access", []) or []
    return page in access

def require_access(page):
    def deco(fn):
        @functools.wraps(fn)
        def wrapped(*args, **kwargs):
            if not session.get("user_email"):
                if request.path.startswith("/api/"):
                    return jsonify({"ok": False, "error": "Authentication required."}), 401
                return render_template("login.html", next_url=request.full_path.rstrip("?"))
            if not _has_access(page):
                if request.path.startswith("/api/"):
                    return jsonify({"ok": False, "error": "You do not have access to this section."}), 403
                return render_template("access_denied.html", page=page), 403
            return fn(*args, **kwargs)
        return wrapped
    return deco


def _enforce_identity(email):
    email = str(email or "").strip().lower()
    if session.get("is_admin"):
        return True
    return bool(session.get("user_email")) and email == str(session.get("user_email")).strip().lower()

def _access_destinations():
    if session.get("is_admin"):
        return ["stock_entry", "dashboard", "admin"]
    return list(session.get("access", []) or [])

@app.get("/login")
def login_page():
    if session.get("user_email"):
        return redirect(_destination_for_access())
    return render_template("login.html", next_url=request.args.get("next", ""))

def _destination_for_access():
    access = _access_destinations()
    if "dashboard" in access and len(access) == 1:
        return "/"
    if "stock_entry" in access and len(access) == 1:
        return "/entry"
    return "/choose"

@app.post("/login")
def login():
    payload = request.get_json(silent=True) or request.form
    email = str(payload.get("email", "")).strip().lower()
    password = str(payload.get("password", ""))
    if not email or not password:
        return jsonify({"ok": False, "error": "Email and password are required."}), 400

    if _is_admin(email, password):
        session.clear()
        session["user_email"] = email
        session["user_name"] = "Admin"
        session["is_admin"] = True
        session["access"] = ["stock_entry", "dashboard", "admin"]
        return jsonify({"ok": True, "redirect": "/choose"})

    rec = _user_record(email)
    if not rec or not _check_password(rec, password):
        return jsonify({"ok": False, "error": "Incorrect email or password."}), 401

    status = str(rec.get("status", "Active")).strip().lower()
    if status and status not in {"active", "enabled"}:
        return jsonify({"ok": False, "error": "Your account is inactive. Please contact the administrator."}), 403

    access = rec.get("access", [])
    if isinstance(access, str):
        access = [access]
    access = [str(x).strip().lower() for x in access if str(x).strip()]
    valid = {"stock_entry", "dashboard", "admin"}
    access = [x for x in access if x in valid]
    is_record_admin = "admin" in access
    if is_record_admin:
        access = ["stock_entry", "dashboard", "admin"]
    if not access:
        return jsonify({"ok": False, "error": "Your account has no active access assigned."}), 403

    session.clear()
    session["user_email"] = email
    session["user_name"] = str(rec.get("name", email.split("@")[0]))
    session["is_admin"] = is_record_admin
    session["access"] = access
    return jsonify({"ok": True, "redirect": _destination_for_access()})

@app.post("/api/ai/chat")
@require_access("dashboard")
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
          "Keep answers concise, structured, and business-friendly. If the user explicitly asks for Top 10 or 10 items and the server result contains 10 items, include all 10 items; do not stop early.")
        user=("Question: "+question+"\n\nDashboard context (authoritative):\n"+json.dumps(context,ensure_ascii=False,separators=(",",":")))
        url=f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent"
        body={"system_instruction":{"parts":[{"text":system}]},"contents":[{"role":"user","parts":[{"text":user}]}],"generationConfig":{"temperature":0.2,"maxOutputTokens":2200}}
        r=requests.post(url,json=body,headers={"x-goog-api-key": GEMINI_API_KEY},timeout=45)
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

@app.get("/choose")
def choose():
    if not session.get("user_email"):
        return redirect("/login")
    return render_template("choose.html", name=session.get("user_name", "User"), email=session.get("user_email", ""), access=_access_destinations())

@app.get("/logout")
def logout():
    session.clear()
    return redirect("/login")


def _admin_required():
    return bool(session.get("is_admin"))


def _atomic_write_json(path, payload):
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
        f.write("\n")
    os.replace(tmp, path)


def _github_publish(path, payload, message):
    # "[skip render]" stops Render from redeploying on every admin edit. A redeploy restarts the
    # server (cold caches, slow first page) and wipes the local SQLite file where submissions live.
    if "[skip render]" not in message: message = message + " [skip render]"
    """Optional persistence: publish admin config changes to GitHub when configured.
    This keeps admin edits across Render redeploys without making GitHub mandatory.
    """
    if not (GITHUB_CONFIG_TOKEN and GITHUB_CONFIG_REPO):
        return {"published": False, "reason": "GitHub persistence is not configured."}
    import base64 as _b64
    rel = {os.path.abspath(USERS_JSON_PATH): GITHUB_USERS_PATH,
           os.path.abspath(MAPPING_JSON_PATH): GITHUB_MAPPING_PATH,
           os.path.abspath(SHOPS_JSON_PATH): GITHUB_SHOPS_PATH}.get(os.path.abspath(path), path)
    api = f"https://api.github.com/repos/{GITHUB_CONFIG_REPO}/contents/{rel.lstrip('/')}"
    headers = {"Authorization": f"Bearer {GITHUB_CONFIG_TOKEN}", "Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"}
    content = _b64.b64encode(json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")).decode("ascii")
    try:
        r = requests.get(api, params={"ref": GITHUB_CONFIG_BRANCH}, headers=headers, timeout=(5, 12))
        sha = r.json().get("sha") if r.ok else None
        body = {"message": message, "content": content, "branch": GITHUB_CONFIG_BRANCH}
        if sha: body["sha"] = sha
        put = requests.put(api, headers=headers, json=body, timeout=(5, 15))
        if put.status_code >= 400:
            try: detail = put.json().get("message", put.text)
            except Exception: detail = put.text
            raise RuntimeError(f"GitHub publish failed: {detail}")
        return {"published": True, "commit": put.json().get("commit", {}).get("sha", "")}
    except Exception as e:
        raise RuntimeError(str(e))


def _save_admin_json(path, payload, message):
    # When GitHub persistence is configured, publish first. This prevents a
    # failed GitHub write from leaving a misleading local-only admin change
    # that would disappear on the next Render restart/redeploy.
    result = _github_publish(path, payload, message)
    _atomic_write_json(path, payload)
    _cache["map_ts"] = 0
    _cache["map_df"] = None
    return result


def _read_shop_directory():
    """Return a normalized list of all known shops, including unassigned shops."""
    shops = []
    try:
        if os.path.exists(SHOPS_JSON_PATH):
            with open(SHOPS_JSON_PATH, "r", encoding="utf-8-sig") as f:
                payload = json.load(f)
            raw = payload.get("shops", payload) if isinstance(payload, dict) else []
            if isinstance(raw, dict): raw = list(raw.values())
            for x in raw if isinstance(raw, list) else []:
                if isinstance(x, dict):
                    name = str(x.get("name", x.get("store_name", x.get("Store Name", ""))) or "").strip()
                    if name:
                        shops.append({"code": str(x.get("code", x.get("store_code", x.get("Store Code", ""))) or "").strip(),
                                      "name": name,
                                      "city": str(x.get("city", x.get("City", "")) or "").strip(),
                                      "region": str(x.get("region", x.get("Region", "")) or "").strip(),
                                      "status": str(x.get("status", "Active") or "Active").strip()})
    except Exception:
        shops = []
    # Backfill directory from current mapping so this feature can be added safely to an existing deployment.
    for r in _admin_mapping_rows():
        candidate = {"code": r["code"], "name": r["name"], "city": r["city"], "region": r["region"], "status": r["status"]}
        if not any((candidate["code"] and x["code"] == candidate["code"]) or (x["name"] == candidate["name"]) for x in shops):
            shops.append(candidate)
    seen = set(); out=[]
    for x in shops:
        key=(x["code"], x["name"])
        if key not in seen:
            seen.add(key); out.append(x)
    return sorted(out, key=lambda x: (x["name"].lower(), x["code"].lower()))


def _mapping_payload():
    try:
        with open(MAPPING_JSON_PATH, "r", encoding="utf-8-sig") as f:
            payload=json.load(f)
        if isinstance(payload, dict) and isinstance(payload.get("mappings"), dict):
            return {"mappings": payload["mappings"]}
        if isinstance(payload, dict):
            return {"mappings": payload.get("users", payload)}
    except Exception:
        pass
    return {"mappings": {}}


def _normalize_shop_obj(x):
    if isinstance(x, str): return {"code":"", "name":x.strip(), "city":"", "region":"", "status":"Active"}
    if not isinstance(x, dict): return None
    name=str(x.get("name", x.get("store_name", x.get("Store Name", x.get("shop_name", "")))) or "").strip()
    if not name: return None
    return {"code":str(x.get("code", x.get("store_code", x.get("Store Code", ""))) or "").strip(),
            "name":name,
            "city":str(x.get("city", x.get("City", "")) or "").strip(),
            "region":str(x.get("region", x.get("Region", "")) or "").strip(),
            "status":str(x.get("status", x.get("Status", "Active")) or "Active").strip()}


def _all_admin_users_safe():
    rows=[]
    for r in _admin_access_rows():
        rows.append(r)
    return rows


def _entry_key(df):
    return df["entry_no"].where(df["entry_no"] != "", "LEGACY-" + df["submitted_at"])


def _iso(ts, fallback=""):
    return ts.isoformat() if pd.notna(ts) else str(fallback or "")


def _submission_entry_groups(limit=250):
    """Latest entries, one row per entry number. Returns (groups, error_message)."""
    try:
        df = get_submissions()
    except Exception as e:
        return [], str(e)
    err = _subs.get("error", "")
    if df is None or df.empty: return [], err
    df = df[df["total"] > 0]
    if df.empty: return [], err
    g = (df.assign(_k=_entry_key(df))
           .groupby("_k", sort=False)
           .agg(submitted_at=("submitted_at", "first"), ts_=("_ts", "max"), email=("email", "first"), store_name=("store_name", "first"),
                sku_count=("ean_code", "count"), total_qty=("total", "sum"), submitted_by=("submitted_by", "first"))
           .reset_index().rename(columns={"_k": "entry_no"}))
    g = g.sort_values("ts_", ascending=False, na_position="last").head(limit)
    out = [{"entry_no": r.entry_no, "submitted_at": _iso(r.ts_, r.submitted_at), "email": r.email, "store_name": r.store_name,
            "sku_count": int(r.sku_count), "total_qty": float(r.total_qty), "submitted_by": r.submitted_by}
           for r in g.itertuples(index=False)]
    return out, err


def _upload_token(payload, expires_hours=None):
    exp=int(time.time()+3600*int(expires_hours or UPLOAD_LINK_HOURS))
    body=dict(payload, exp=exp)
    raw=json.dumps(body,separators=(",",":"),sort_keys=True).encode()
    encoded=base64.urlsafe_b64encode(raw).decode().rstrip("=")
    sig=hmac_sha256(SECRET_KEY.encode(), raw)
    return encoded+"."+sig


def hmac_sha256(key, data):
    import hmac
    return hmac.new(key, data, hashlib.sha256).hexdigest()


def _verify_upload_token(token):
    try:
        encoded,sig=token.split(".",1)
        raw=base64.urlsafe_b64decode(encoded+"="*((4-len(encoded)%4)%4))
        expected=hmac_sha256(SECRET_KEY.encode(), raw)
        if not secrets.compare_digest(sig, expected): return None
        payload=json.loads(raw.decode("utf-8"))
        if int(payload.get("exp",0)) < int(time.time()): return None
        if not payload.get("email") or not payload.get("store"): return None
        return payload
    except Exception:
        return None


def _read_upload_excel(file_storage):
    if not file_storage or not file_storage.filename:
        raise RuntimeError("Please choose an Excel file.")
    name=file_storage.filename.lower()
    if not name.endswith((".xlsx",".xlsm",".csv")):
        raise RuntimeError("Upload .xlsx, .xlsm or .csv only.")
    raw=file_storage.read()
    if not raw: raise RuntimeError("The uploaded file is empty.")
    if name.endswith(".csv"):
        df=pd.read_csv(io.BytesIO(raw), dtype=str, keep_default_na=False)
    else:
        df=pd.read_excel(io.BytesIO(raw), dtype=str)
    df.columns=[str(c).strip() for c in df.columns]
    df=df.loc[:,~df.columns.duplicated()].copy()
    return df


def _header_auto(headers, candidates):
    norm={re.sub(r"[^a-z0-9]","",str(h).lower()):h for h in headers}
    for c in candidates:
        k=re.sub(r"[^a-z0-9]","",c.lower())
        if k in norm:return norm[k]
    for h in headers:
        k=re.sub(r"[^a-z0-9]","",str(h).lower())
        if any(re.sub(r"[^a-z0-9]","",c.lower()) in k for c in candidates):return h
    return ""


def _normalize_ean(v):
    return _norm_ean_value(v)


def _remote_file_payload(file_storage):
    """Return the original uploaded file as a compact base64 payload for the Apps Script backend."""
    if not file_storage or not getattr(file_storage, "filename", ""):
        return None
    raw = file_storage.read()
    if not raw:
        raise RuntimeError("The uploaded file is empty.")
    name = str(file_storage.filename).strip()
    mime = str(file_storage.mimetype or "application/octet-stream")
    return {"file_name": name, "mime_type": mime, "size_bytes": len(raw), "base64": base64.b64encode(raw).decode("ascii")}


def _admin_build_submission(file_storage, email, store, ean_header, stock_header, tester_header="", entry_no="", issued_by=""):
    email=str(email or "").strip().lower(); store=str(store or "").strip()
    rec=_user_record(email)
    if not rec: raise RuntimeError("Target user does not exist.")
    if str(rec.get("status","Active")).strip().lower() not in {"active","enabled"}: raise RuntimeError("Target user is inactive.")
    mp=load_mapping(True)
    allowed=set(mp.loc[mp["Email ID"].astype(str).str.lower()==email,"Store Name"].astype(str).str.strip())
    if store not in allowed: raise RuntimeError("The selected store is not assigned to the target user. Assign it first.")
    original_file = _remote_file_payload(file_storage)
    if original_file:
        file_storage.stream.seek(0)
    df=_read_upload_excel(file_storage)
    if ean_header not in df.columns: raise RuntimeError("Selected EAN column was not found in the uploaded file.")
    if stock_header and stock_header not in df.columns: raise RuntimeError("Selected Stock column was not found in the uploaded file.")
    if tester_header and tester_header not in df.columns: raise RuntimeError("Selected Tester column was not found in the uploaded file.")
    if not stock_header and not tester_header: raise RuntimeError("Select at least Stock or Tester quantity column.")
    try: master=load_master(False)
    except Exception: master=pd.DataFrame(columns=MASTER_REQUIRED)
    try: stock=load_stock(False)
    except Exception: stock=pd.DataFrame(columns=["Store Name","EAN Code","Product Name"])
    master_map=dict(zip(master["EAN Code"].map(_normalize_ean),master["Product Name"].astype(str).str.strip())) if not master.empty else {}
    store_rows=stock[stock["Store Name"].astype(str).str.strip()==store] if not stock.empty and "Store Name" in stock else pd.DataFrame()
    store_map=dict(zip(store_rows["EAN Code"].map(_normalize_ean),store_rows["Product Name"].astype(str).str.strip())) if not store_rows.empty else {}
    cleaned=[]; skipped=0
    for _,r in df.iterrows():
        ean=_normalize_ean(r.get(ean_header,""))
        if not ean: skipped+=1; continue
        def num(h):
            if not h:return 0.0
            v=str(r.get(h,"0") or "0").strip().replace(",","")
            try:
                x=float(v)
                if pd.isna(x) or x<0 or x==float("inf"): return 0.0
                return x
            except Exception:return 0.0
        stock_qty=num(stock_header); tester_qty=num(tester_header)
        total=stock_qty+tester_qty
        if total<=0: skipped+=1; continue
        product=master_map.get(ean) or store_map.get(ean) or ""
        if not product: skipped+=1; continue
        cleaned.append({"EAN Code":ean,"Product Name":product,"Stock":stock_qty,"Tester":tester_qty,"Total":total})
    if not cleaned: raise RuntimeError("No valid rows with Total > 0 were found. Check the selected columns and EAN values.")
    # Keep one row per EAN; duplicate upload lines are summed instead of silently losing stock.
    agg={}
    for r in cleaned:
        key=r["EAN Code"]
        if key not in agg: agg[key]=r.copy()
        else:
            agg[key]["Stock"]+=r["Stock"]; agg[key]["Tester"]+=r["Tester"]; agg[key]["Total"]+=r["Total"]
    cleaned=list(agg.values())
    entry_no=str(entry_no or "").strip() or ("STK-"+datetime.now().strftime("%Y%m%d-%H%M%S")+"-"+secrets.token_hex(2).upper())
    actor=str(issued_by or session.get("user_email") or "admin").strip().lower()
    payload={"entry_no":entry_no,"email":email,"store_name":store,"rows":cleaned,"submitted_by":actor,"issued_by":actor,"audit_id":"AUD-"+datetime.now().strftime("%Y%m%d-%H%M%S")+"-"+secrets.token_hex(4).upper(),"client_ip":request.headers.get("X-Forwarded-For",request.remote_addr or "").split(",")[0].strip(),"user_agent":request.headers.get("User-Agent","")[:500],"submission_mode":"admin_upload"}
    if original_file:
        payload["file"] = original_file
    if SUBMISSION_API_URL:
        result=remote_request("POST",payload) or {}
        if not result.get("ok"):
            raise RuntimeError(result.get("error","Submission service rejected the upload."))
        saved=int(result.get("saved_rows",len(cleaned)) or 0)
        if saved!=len(cleaned): raise RuntimeError(f"Submission mismatch: sent {len(cleaned)} rows but service saved {saved}.")
    else:
        saved=save_local_submission(payload)
    remember_submission(entry_no,email,store,cleaned,actor)
    return {"entry_no":entry_no,"saved_rows":saved,"skipped_rows":skipped,"target_email":email,"store_name":store,"audit_id":result.get("audit_id","") if SUBMISSION_API_URL else payload.get("audit_id",""),"receipt_hash":result.get("receipt_hash","") if SUBMISSION_API_URL else ""}

def _admin_access_rows():
    users = _load_users_config().get("users", {})
    if not isinstance(users, dict):
        users = {}

    rows = []
    for email, rec in users.items():
        if not isinstance(rec, dict):
            continue
        access = rec.get("access", [])
        if isinstance(access, str):
            access = [access]
        access = [str(x).strip().lower() for x in access if str(x).strip()]
        status = str(rec.get("status", "Active") or "Active").strip()
        rows.append({
            "email": str(email).strip().lower(),
            "name": str(rec.get("name", "") or "").strip(),
            "access": access,
            "status": status,
            "is_admin": "admin" in access,
        })
    return rows


def _admin_mapping_rows():
    rows = []
    try:
        path = MAPPING_JSON_PATH
        with open(path, "r", encoding="utf-8-sig") as f:
            payload = json.load(f)

        if isinstance(payload.get("mappings"), dict):
            users = payload.get("mappings", {})
            normalized = {}
            for email, value in users.items():
                if isinstance(value, dict) and "shops" in value:
                    normalized[email] = value.get("shops", [])
                else:
                    normalized[email] = value
            users = normalized
        else:
            users = payload.get("users", payload)

        if isinstance(users, dict):
            for email, shops in users.items():
                if isinstance(shops, dict):
                    shops = [shops]
                if not isinstance(shops, list):
                    continue
                for shop in shops:
                    if isinstance(shop, str):
                        rows.append({
                            "email": str(email).strip().lower(),
                            "code": "",
                            "name": shop.strip(),
                            "city": "",
                            "region": "",
                            "status": "Active",
                        })
                    elif isinstance(shop, dict):
                        status = str(shop.get("status", shop.get("Status", "Active")) or "Active").strip()
                        rows.append({
                            "email": str(email).strip().lower(),
                            "code": str(shop.get("store_code", shop.get("Store Code", shop.get("code", ""))) or "").strip(),
                            "name": str(shop.get("store_name", shop.get("Store Name", shop.get("shop_name", shop.get("Shop Name", shop.get("name", ""))))) or "").strip(),
                            "city": str(shop.get("city", shop.get("City", "")) or "").strip(),
                            "region": str(shop.get("region", shop.get("Region", "")) or "").strip(),
                            "status": status,
                        })
    except Exception:
        # Admin overview should remain usable even if mapping JSON is unavailable.
        rows = []
    return [r for r in rows if r["name"]]



@app.get("/api/admin/config")
def admin_config():
    if not _admin_required(): return jsonify({"ok":False,"error":"Admin access required."}),403
    users=_all_admin_users_safe(); shops=_read_shop_directory(); mp=_admin_mapping_rows()
    assignments={}
    for r in mp: assignments.setdefault(r["email"],[]).append({"code":r["code"],"name":r["name"],"city":r["city"],"region":r["region"],"status":r["status"]})
    # Submissions are loaded by a separate call (/api/admin/submissions) so this page never waits on Google Sheets.
    return jsonify({"ok":True,"users":users,"shops":shops,"assignments":assignments,"persistence":{"github":bool(GITHUB_CONFIG_TOKEN and GITHUB_CONFIG_REPO),"database":DATABASE_PATH,"remote_submissions":bool(SUBMISSION_API_URL)}})


@app.get("/api/admin/submissions")
def admin_submissions():
    if not _admin_required(): return jsonify({"ok":False,"error":"Admin access required."}),403
    groups, err = _submission_entry_groups(250)
    return jsonify({"ok":True,"submissions":groups,"warning":err if (err and not groups) else "","stale":bool(err and groups)})


@app.get("/api/admin/audit")
def admin_audit():
    if not _admin_required(): return jsonify({"ok":False,"error":"Admin access required."}),403
    if not SUBMISSION_API_URL: return jsonify({"ok":True,"records":[],"warning":"Google Apps Script audit service is not configured."})
    try:
        result=remote_request("GET",query={"view":"audit","limit":"500"}) or {}
        if not result.get("ok"): return jsonify(result),502
        return jsonify({"ok":True,"records":result.get("records",[])})
    except Exception as e:return jsonify({"ok":False,"error":str(e)}),502


@app.post("/api/admin/user/save")
def admin_user_save():
    if not _admin_required(): return jsonify({"ok":False,"error":"Admin access required."}),403
    try:
        p=request.get_json(silent=True) or {}
        email=str(p.get("email","")).strip().lower(); old_email=str(p.get("old_email","")).strip().lower(); name=str(p.get("name","")).strip(); password=str(p.get("password","")).strip()
        status=str(p.get("status","Active") or "Active").strip(); role=str(p.get("role","") or "").strip()
        access=p.get("access",[]) or []
        if isinstance(access,str): access=[access]
        access=[str(x).strip().lower() for x in access if str(x).strip() in {"stock_entry","dashboard","admin"}]
        if "admin" in access: access=["stock_entry","dashboard","admin"]
        if not email or "@" not in email: return jsonify({"ok":False,"error":"Enter a valid email address."}),400
        if not name: return jsonify({"ok":False,"error":"Name is required."}),400
        payload=_load_users_config(); users=payload.get("users",{}) if isinstance(payload,dict) else {}
        if not isinstance(users,dict): users={}
        source_email=old_email or email
        if source_email != email and source_email == str(session.get("user_email","")).strip().lower():
            return jsonify({"ok":False,"error":"You cannot change the email of the currently signed-in admin."}),400
        if source_email != email and email in users:
            return jsonify({"ok":False,"error":"That new email is already registered."}),400
        old=users.get(source_email,{}) if isinstance(users.get(source_email,{}),dict) else {}
        if not old and not password: return jsonify({"ok":False,"error":"Password is required for a new user."}),400
        rec=dict(old); rec["name"]=name; rec["status"]=status; rec["access"]=access
        if role: rec["role"]=role
        elif "role" in rec: rec.pop("role",None)
        if password:
            from werkzeug.security import generate_password_hash
            rec.pop("password",None); rec["password_hash"]=generate_password_hash(password)
        elif "password_hash" not in rec and "password" not in rec:
            return jsonify({"ok":False,"error":"Existing user has no stored password. Set a new password."}),400
        if source_email != email and source_email in users: users.pop(source_email,None)
        users[email]=rec; payload["users"]=users
        pub=_save_admin_json(USERS_JSON_PATH,payload,f"Admin update user {email}")
        if source_email != email:
            mp_payload=_mapping_payload(); mappings=mp_payload.get("mappings",{}); mappings[email]=mappings.pop(source_email,{"shops":[]}); mp_payload["mappings"]=mappings
            _save_admin_json(MAPPING_JSON_PATH,mp_payload,f"Move shop mappings from {source_email} to {email}")
        return jsonify({"ok":True,"message":"User saved.","published":pub.get("published",False),"user":next((x for x in _admin_access_rows() if x.get("email")==email),{})})
    except Exception as e:
        return jsonify({"ok":False,"error":str(e)}),500


@app.post("/api/admin/user/delete")
def admin_user_delete():
    if not _admin_required(): return jsonify({"ok":False,"error":"Admin access required."}),403
    try:
        email=str((request.get_json(silent=True) or {}).get("email","")).strip().lower()
        if not email:return jsonify({"ok":False,"error":"Email is required."}),400
        if email==str(session.get("user_email","")).strip().lower(): return jsonify({"ok":False,"error":"You cannot delete the currently signed-in admin."}),400
        payload=_load_users_config(); users=payload.get("users",{})
        if email not in users:return jsonify({"ok":False,"error":"User not found."}),404
        del users[email]; payload["users"]=users
        pub=_save_admin_json(USERS_JSON_PATH,payload,f"Admin delete user {email}")
        # Remove the deleted user's shop assignments too.
        mp_payload=_mapping_payload(); mappings=mp_payload.get("mappings",{}); mappings.pop(email,None); mp_payload["mappings"]=mappings
        _save_admin_json(MAPPING_JSON_PATH,mp_payload,f"Remove mappings for deleted user {email}")
        return jsonify({"ok":True,"message":"User deleted.","published":pub.get("published",False)})
    except Exception as e:return jsonify({"ok":False,"error":str(e)}),500


@app.post("/api/admin/mapping/save")
def admin_mapping_save():
    if not _admin_required(): return jsonify({"ok":False,"error":"Admin access required."}),403
    try:
        p=request.get_json(silent=True) or {}; email=str(p.get("email","")).strip().lower(); raw=p.get("shops",[]) or []
        if not email:return jsonify({"ok":False,"error":"User email is required."}),400
        if not _user_record(email):return jsonify({"ok":False,"error":"Target user does not exist."}),404
        shops=[]
        for x in raw:
            z=_normalize_shop_obj(x)
            if z and z["name"]: shops.append(z)
        # Only active shops are usable by entry, but keep inactive assignments visible for admin.
        ded=[]; seen=set()
        for x in shops:
            k=(x["code"],x["name"])
            if k not in seen:seen.add(k);ded.append(x)
        payload=_mapping_payload(); payload["mappings"][email]={"shops":ded}
        pub=_save_admin_json(MAPPING_JSON_PATH,payload,f"Admin update shop mapping for {email}")
        return jsonify({"ok":True,"message":"Shop assignment updated.","shops":ded,"published":pub.get("published",False)})
    except Exception as e:return jsonify({"ok":False,"error":str(e)}),500


@app.post("/api/admin/shop/save")
def admin_shop_save():
    if not _admin_required(): return jsonify({"ok":False,"error":"Admin access required."}),403
    try:
        p=request.get_json(silent=True) or {}; z=_normalize_shop_obj(p)
        if not z:return jsonify({"ok":False,"error":"Shop name is required."}),400
        shops=_read_shop_directory(); old_code=str(p.get("original_code","") or "").strip(); old_name=str(p.get("original_name","") or "").strip()
        replaced=False
        for i,x in enumerate(shops):
            if (old_code and x["code"]==old_code) or (old_name and x["name"]==old_name) or (z["code"] and x["code"]==z["code"]):
                shops[i]=z; replaced=True
        if not replaced: shops.append(z)
        shops=sorted(shops,key=lambda x:(x["name"].lower(),x["code"].lower()))
        pub=_save_admin_json(SHOPS_JSON_PATH,{"shops":shops},f"Admin save shop {z['name']}")
        # Propagate changed shop metadata to all mappings by original code/name.
        mp=_mapping_payload(); mappings=mp.get("mappings",{}); before=json.dumps(mappings,sort_keys=True)
        for email,val in list(mappings.items()):
            raw=val.get("shops",[]) if isinstance(val,dict) else val
            out=[]
            for item in raw if isinstance(raw,list) else []:
                q=_normalize_shop_obj(item)
                if not q:continue
                if (old_code and q["code"]==old_code) or (old_name and q["name"]==old_name) or (z["code"] and q["code"]==z["code"]): q=dict(z)
                out.append(q)
            mappings[email]={"shops":out}
        mp["mappings"]=mappings
        if json.dumps(mappings,sort_keys=True)!=before: _save_admin_json(MAPPING_JSON_PATH,mp,f"Propagate shop directory update {z['name']}")
        return jsonify({"ok":True,"message":"Shop saved.","shop":z,"published":pub.get("published",False)})
    except Exception as e:return jsonify({"ok":False,"error":str(e)}),500


@app.post("/api/admin/shop/delete")
def admin_shop_delete():
    if not _admin_required(): return jsonify({"ok":False,"error":"Admin access required."}),403
    try:
        p=request.get_json(silent=True) or {}; code=str(p.get("code","") or "").strip(); name=str(p.get("name","") or "").strip()
        mp=_admin_mapping_rows()
        if any((code and r["code"]==code) or (name and r["name"]==name) for r in mp): return jsonify({"ok":False,"error":"This shop is assigned to a user. Remove its assignments first."}),400
        shops=[x for x in _read_shop_directory() if not ((code and x["code"]==code) or (name and x["name"]==name))]
        _save_admin_json(SHOPS_JSON_PATH,{"shops":shops},f"Admin delete shop {name or code}")
        return jsonify({"ok":True,"message":"Shop removed."})
    except Exception as e:return jsonify({"ok":False,"error":str(e)}),500


@app.get("/api/admin/export/<kind>")
def admin_export(kind):
    if not _admin_required(): return jsonify({"ok":False,"error":"Admin access required."}),403
    try:
        if kind=="users": path=USERS_JSON_PATH
        elif kind=="mapping": path=MAPPING_JSON_PATH
        elif kind=="shops":
            path=SHOPS_JSON_PATH
            if not os.path.exists(path): _atomic_write_json(path,{"shops":_read_shop_directory()})
        else:return jsonify({"ok":False,"error":"Unknown export."}),400
        return send_file(path,as_attachment=True,download_name=os.path.basename(path),mimetype="application/json")
    except Exception as e:return jsonify({"ok":False,"error":str(e)}),500


@app.post("/api/admin/upload-preview")
def admin_upload_preview():
    if not _admin_required(): return jsonify({"ok":False,"error":"Admin access required."}),403
    try:
        df=_read_upload_excel(request.files.get("file")); headers=[str(x) for x in df.columns]
        return jsonify({"ok":True,"headers":headers,"rows":int(len(df)),"suggestions":{"ean":_header_auto(headers,["ean","ean code","sku code","barcode","barcode no","product code"]),"stock":_header_auto(headers,["stock","stock qty","quantity","qty","physical stock"]),"tester":_header_auto(headers,["tester","tester qty","tester quantity"])},"sample":json_records(df.head(5))})
    except Exception as e:return jsonify({"ok":False,"error":str(e)}),400


@app.post("/api/admin/upload-submit")
def admin_upload_submit():
    if not _admin_required(): return jsonify({"ok":False,"error":"Admin access required."}),403
    try:
        p=request.form; result=_admin_build_submission(request.files.get("file"),p.get("email"),p.get("store"),p.get("ean_header"),p.get("stock_header"),p.get("tester_header"),p.get("entry_no"),str(session.get("user_email") or "admin"))
        return jsonify({"ok":True,"message":"Stock uploaded and submitted on behalf of the selected user.",**result})
    except Exception as e:return jsonify({"ok":False,"error":str(e)}),400


@app.post("/api/admin/upload-link")
def admin_upload_link():
    if not _admin_required(): return jsonify({"ok":False,"error":"Admin access required."}),403
    try:
        base=PUBLIC_BASE_URL or request.url_root.rstrip("/")
        return jsonify({"ok":True,"url":f"{base}/manual-upload","master":True,"message":"Master manual upload link ready. Users enter their registered email and shop on the page."})
    except Exception as e:return jsonify({"ok":False,"error":str(e)}),400


@app.get("/manual-upload")
def manual_upload_page():
    token=str(request.args.get("t","")).strip()
    return _render_manual_upload(token)


@app.get("/manual-upload/<path:token>")
def manual_upload_page_path(token):
    # Shareable-link variant. This avoids query-string stripping by some mobile
    # browsers, WhatsApp/email previews, or corporate link scanners.
    return _render_manual_upload(str(token or "").strip())


def _master_upload_identity(email, store):
    """Validate the email/shop pair for the single shared manual-upload link."""
    email = str(email or "").strip().lower()
    store = str(store or "").strip()
    if not email or not store:
        raise RuntimeError("Enter your email and shop name.")
    mp = load_mapping(True)
    if mp is None or mp.empty:
        raise RuntimeError("User/shop mapping is unavailable. Please contact the administrator.")
    email_col = mp["Email ID"].astype(str).str.strip().str.lower()
    store_col = mp["Store Name"].astype(str).str.strip()
    allowed = set(store_col[email_col == email])
    if not allowed:
        raise RuntimeError("This email is not registered for manual upload.")
    if store not in allowed:
        raise RuntimeError("This shop is not assigned to this email.")
    return {"email": email, "store": store}


def _render_manual_upload(token):
    # Master link: /manual-upload — no temporary token required.
    # Legacy signed links continue to work when a token is supplied.
    if not token:
        response=make_response(render_template("manual_upload.html",invalid=False,master_link=True,token="",email="",store="",expires_at=""))
        response.headers["Cache-Control"]="no-store, no-cache, must-revalidate, max-age=0"
        return response
    payload=_verify_upload_token(token)
    if not payload:
        response=make_response(render_template("manual_upload.html",invalid=True,master_link=False),403)
        response.headers["Cache-Control"]="no-store, no-cache, must-revalidate, max-age=0"
        return response
    response=make_response(render_template("manual_upload.html",invalid=False,master_link=False,token=token,email=payload["email"],store=payload["store"],expires_at=datetime.fromtimestamp(int(payload["exp"]),tz=timezone.utc).isoformat()))
    response.headers["Cache-Control"]="no-store, no-cache, must-revalidate, max-age=0"
    return response


@app.post("/manual-upload/preview")
def manual_upload_preview():
    try:
        token=str(request.form.get("token","")).strip()
        payload=_verify_upload_token(token) if token else _master_upload_identity(request.form.get("email"),request.form.get("store"))
        if not payload:return jsonify({"ok":False,"error":"This upload link is invalid or expired."}),403
        df=_read_upload_excel(request.files.get("file")); headers=[str(x) for x in df.columns]
        return jsonify({"ok":True,"headers":headers,"rows":int(len(df)),"suggestions":{"ean":_header_auto(headers,["ean","ean code","sku code","barcode","barcode no","product code"]),"stock":_header_auto(headers,["stock","stock qty","quantity","qty","physical stock"]),"tester":_header_auto(headers,["tester","tester qty","tester quantity"])}})
    except Exception as e:return jsonify({"ok":False,"error":str(e)}),400


@app.post("/manual-upload/submit")
def manual_upload_submit():
    try:
        token=str(request.form.get("token","")).strip()
        payload=_verify_upload_token(token) if token else _master_upload_identity(request.form.get("email"),request.form.get("store"))
        if not payload:return jsonify({"ok":False,"error":"This upload link is invalid or expired."}),403
        file_storage=request.files.get("file")
        if not file_storage or not file_storage.filename:
            raise RuntimeError("Choose a file first.")
        if str(file_storage.filename).lower().endswith(".pdf"):
            original_file=_remote_file_payload(file_storage)
            remote_payload={"entry_no":str(request.form.get("entry_no","")).strip() or ("PDF-"+datetime.now().strftime("%Y%m%d-%H%M%S")+"-"+secrets.token_hex(2).upper()),"email":payload["email"],"store_name":payload["store"],"rows":[],"submitted_by":str(payload.get("issued_by") or payload["email"]),"issued_by":str(payload.get("issued_by") or payload["email"]),"audit_id":"AUD-"+datetime.now().strftime("%Y%m%d-%H%M%S")+"-"+secrets.token_hex(4).upper(),"client_ip":request.headers.get("X-Forwarded-For",request.remote_addr or "").split(",")[0].strip(),"user_agent":request.headers.get("User-Agent","")[:500],"submission_mode":"pdf_upload","file":original_file}
            if SUBMISSION_API_URL:
                result=remote_request("POST",remote_payload) or {}
                if not result.get("ok"): raise RuntimeError(result.get("error","Submission service rejected the PDF upload."))
            else:
                raise RuntimeError("PDF uploads require the Google Apps Script submission service to be configured.")
            return jsonify({"ok":True,"message":"PDF uploaded successfully.",**result})
        result=_admin_build_submission(file_storage,payload["email"],payload["store"],request.form.get("ean_header"),request.form.get("stock_header"),request.form.get("tester_header"),request.form.get("entry_no"),payload.get("issued_by",""))
        return jsonify({"ok":True,"message":"Stock uploaded successfully.",**result})
    except Exception as e:return jsonify({"ok":False,"error":str(e)}),400

@app.get("/admin")
def admin():
    if not session.get("is_admin"):
        return render_template("access_denied.html", page="admin"), 403

    users = _admin_access_rows()
    shops = _admin_mapping_rows()

    active_users = sum(1 for r in users if str(r["status"]).lower() in {"active", "enabled"})
    inactive_users = len(users) - active_users
    admin_users = sum(1 for r in users if r["is_admin"])
    mapped_users = len(set(r["email"] for r in shops))
    unique_shops = len(set((r["code"], r["name"]) for r in shops))

    access_counts = {
        "stock_entry": sum(1 for r in users if "stock_entry" in r["access"]),
        "dashboard": sum(1 for r in users if "dashboard" in r["access"]),
        "admin": admin_users,
    }

    return render_template(
        "admin.html",
        rows=users,
        shops=shops,
        active_users=active_users,
        inactive_users=inactive_users,
        admin_users=admin_users,
        mapped_users=mapped_users,
        unique_shops=unique_shops,
        access_counts=access_counts,
        mapping_file_ok=bool(shops),
        users_file_ok=bool(users),
    )

@app.get("/")
@require_access("dashboard")
def index():
    # Preserve the user's previous workspace so Dashboard always provides a clear way back.
    from_entry = str(request.args.get("from", "")).strip().lower() == "entry"
    back_href = "/entry" if from_entry else "/choose"
    back_label = "← Back to Physical Stock Entry" if from_entry else "← Back to Workspace"
    return render_template("index.html", back_href=back_href, back_label=back_label)

@app.get("/download")
@app.get("/app")
def app_download(): return render_template("app_download.html")

@app.get("/entry")
@require_access("stock_entry")
def entry(): return render_template("entry.html", access=_access_destinations(), user_email=session.get("user_email", ""), is_admin=bool(session.get("is_admin")))

_resp_cache = {}
_resp_lock = threading.Lock()


def _fail(e, status=500):
    """Log the real problem; show users a readable message (deliberate config errors are kept verbatim)."""
    log.exception("Request failed: %s %s", request.method, request.path)
    msg = str(e) if isinstance(e, RuntimeError) else "The server could not complete this request. Please try again in a moment."
    return jsonify({"ok": False, "error": msg}), status


def _json_blob(name, version, build_payload):
    """Serialise (and gzip) a big JSON payload once per data version instead of once per request."""
    blob = _resp_cache.get(name)
    if blob and blob["v"] == version: return blob
    with _resp_lock:
        blob = _resp_cache.get(name)
        if blob and blob["v"] == version: return blob
        raw = app.json.dumps(build_payload()).encode("utf-8")
        blob = {"v": version, "raw": raw, "gz": gzip.compress(raw, compresslevel=5)}
        _resp_cache[name] = blob
        return blob


def _blob_response(blob):
    if "gzip" in request.headers.get("Accept-Encoding", ""):
        r = Response(blob["gz"], mimetype="application/json"); r.headers["Content-Encoding"] = "gzip"
    else:
        r = Response(blob["raw"], mimetype="application/json")
    r.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    r.headers["Pragma"] = "no-cache"
    r.headers["Vary"] = "Accept-Encoding"
    return r


def _as_of(ts):
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat() if ts else ""


@app.get("/healthz")
def healthz():
    return jsonify({"ok": True, "stock_loaded": _cache.get("stock_df") is not None, "ts": int(time.time())})


@app.get("/api/data")
@require_access("dashboard")
def api_data():
    try:
        force = request.args.get("refresh") == "1"
        stock = load_stock(force, copy=False)
        version = stock.attrs.get("_gen", 0)
        def build():
            source_columns = list(stock.attrs.get("source_columns") or [c for c in stock.columns if c not in {"Forecast Months","Forecast Qty","NOD Bucket"}])
            return {"ok": True, "source": _cache["stock_source"], "as_of": _as_of(_cache.get("stock_ts")), "rows": len(stock), "columns": list(stock.columns),
                    "source_columns": source_columns, "records": json_records(stock)}
        return _blob_response(_json_blob("data", version, build))
    except Exception as e: return _fail(e)

@app.get("/api/variance")
@require_access("dashboard")
def api_variance():
    try:
        force = request.args.get("refresh") == "1"
        var = load_variance(force, copy=False)
        stock = load_stock(force, copy=False)
        load_submissions_live()                     # refreshes the submission cache if it is stale
        version = (var.attrs.get("_gen", 0), stock.attrs.get("_gen", 0), submissions_version())
        def build():
            merged = merge_variance_actuals(var, stock)
            return {"ok": True, "source": _cache["var_source"], "as_of": _as_of(_cache.get("var_ts")), "rows": len(merged), "columns": list(merged.columns), "records": json_records(merged)}
        return _blob_response(_json_blob("variance", version, build))
    except Exception as e: return _fail(e)

@app.post("/api/data/sync")
@require_access("stock_entry")
def data_sync():
    """Force-refresh data sources used by Field Entry and Inward Validation."""
    try:
        p = request.get_json(silent=True) or {}
        email = str(p.get("email", "")).strip().lower()
        if not _enforce_identity(email):
            return jsonify({"ok": False, "error": "The submitted email does not match the signed-in account."}), 403
        mp = load_mapping(True)
        if email and email not in set(mp["Email ID"].astype(str).str.lower()):
            return jsonify({"ok": False, "error": "Email ID is not mapped to any shop."}), 403
        stock = load_stock(True, copy=False)
        master = load_master(True)
        try: get_submissions(True)
        except Exception: pass
        inward_rows = None
        inward_error = ""
        try:
            inward_df, _ = load_inward(True)
            inward_rows = int(len(inward_df))
        except Exception as e:
            inward_error = str(e)
        return jsonify({"ok": True, "message": "Data refreshed successfully.", "mapping_rows": int(len(mp)), "stock_rows": int(len(stock)), "master_rows": int(len(master)), "inward_rows": inward_rows, "inward_error": inward_error, "synced_at": datetime.now(timezone.utc).isoformat()})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500

@app.get("/api/entry-meta")
@require_access("stock_entry")
def entry_meta():
    try:
        email=request.args.get("email","").strip().lower()
        if not _enforce_identity(email):
            return jsonify({"ok":False,"error":"The requested email does not match the signed-in account."}),403
        store=request.args.get("store","").strip()

        # Fast path: email -> mapped shops comes entirely from mapping.json.
        # This request does NOT download/read the large Excel workbook.
        mp=load_mapping(False)
        stores=sorted(mp.loc[mp["Email ID"]==email,"Store Name"].unique().tolist()) if email else []
        if email and not stores:
            return jsonify({"ok":False,"error":"Email ID is not mapped to any shop."}),404
        if store and store not in stores and not session.get("is_admin"):
            return jsonify({"ok":False,"error":"This email is not mapped to the selected shop."}),403

        available=[]
        master_skus=[]
        if store:
            # Only after the user selects a shop do we load the heavier Excel sources.
            stock=load_stock(False, copy=False)
            master=load_master(False)
            store_stock=stock[stock["Store Name"].astype(str).str.strip()==store].copy()
            store_stock["Stock"]=pd.to_numeric(store_stock.get("Stock",0),errors="coerce").fillna(0)
            available=(store_stock.groupby(["EAN Code","Product Name"],as_index=False)["Stock"].sum().rename(columns={"Stock":"Current Stock"}).to_dict(orient="records"))
            master_skus=master[["EAN Code","Product Name"]].to_dict(orient="records")

        return jsonify({"ok":True,"stores":stores,"selected_store":store,"available_skus":available,"master_skus":master_skus,"mapping_source":_cache.get("map_source",""),"mapped_email":email})
    except Exception as e:
        return jsonify({"ok":False,"error":str(e)}),500

def _num(v, default=0.0):
    """Quantity parser: '12', 12.0, '' -> number; garbage / NaN / inf -> ValueError (HTTP 400, not 500)."""
    if v is None or (isinstance(v, str) and not v.strip()): return default
    x = float(str(v).replace(",", "").strip()) if isinstance(v, str) else float(v)
    if x != x or x in (float("inf"), float("-inf")): raise ValueError("Quantity must be a finite number.")
    return x


MAX_SUBMIT_ROWS = int(os.getenv("MAX_SUBMIT_ROWS", "5000"))


@app.post("/api/submit")
@require_access("stock_entry")
def submit():
    try:
        payload=request.get_json(silent=True) or {}; email=str(payload.get("email","")).strip().lower(); store=str(payload.get("store_name","")).strip(); rows=payload.get("rows",[])
        if not _enforce_identity(email): return jsonify({"ok":False,"error":"The submitted email does not match the signed-in account."}),403
        if not email or not store or not isinstance(rows,list) or not rows: return jsonify({"ok":False,"error":"Email, shop and at least one SKU are required."}),400
        if len(rows)>MAX_SUBMIT_ROWS: return jsonify({"ok":False,"error":f"Too many rows (maximum {MAX_SUBMIT_ROWS})."}),400
        mp,master=load_entry_sources(False)
        allowed=set(mp.loc[mp["Email ID"]==email,"Store Name"])
        if store not in allowed and not session.get("is_admin"): return jsonify({"ok":False,"error":"This email is not mapped to the selected shop."}),403
        stock=load_stock(False, copy=False)
        master_map=dict(zip(master["EAN Code"],master["Product Name"].astype(str))) if not master.empty else {}
        # Current-store SKUs are valid even if the master file is temporarily missing one.
        store_rows=stock.loc[stock["Store Name"].astype(str).str.strip()==store,["EAN Code","Product Name"]].drop_duplicates("EAN Code")
        store_map=dict(zip(store_rows["EAN Code"],store_rows["Product Name"].astype(str)))
        agg={}
        for r in rows:
            if not isinstance(r,dict): continue
            ean=_norm_ean_value(r.get("EAN Code",""))
            if not ean: continue
            product_name=master_map.get(ean) or store_map.get(ean) or str(r.get("Product Name","" )).strip()
            if not product_name: continue
            try:
                stock_qty=max(0.0,_num(r.get("Stock",0))); tester_qty=max(0.0,_num(r.get("Tester",0)))
            except (ValueError, TypeError):
                return jsonify({"ok":False,"error":f"Invalid quantity for EAN {ean}. Use numbers only."}),400
            if ean in agg:                                   # same SKU twice in one entry: add, never lose stock
                agg[ean]["Stock"]+=stock_qty; agg[ean]["Tester"]+=tester_qty; agg[ean]["Total"]+=stock_qty+tester_qty
            else:
                agg[ean]={"EAN Code":ean,"Product Name":product_name,"Stock":stock_qty,"Tester":tester_qty,"Total":stock_qty+tester_qty}
        cleaned=[r for r in agg.values() if r["Total"]>0]
        if not cleaned: return jsonify({"ok":False,"error":"Please enter quantity for at least one SKU."}),400
        entry_no=str(payload.get("entry_no", "")).strip() or ("STK-" + datetime.now().strftime("%Y%m%d-%H%M%S") + "-" + secrets.token_hex(2).upper())
        if entry_already_saved(entry_no):
            # The browser retried (slow network / double tap). The first copy is already stored.
            return jsonify({"ok":True,"message":"Stock was already submitted.","saved_rows":len(cleaned),"entry_no":entry_no,"duplicate":True})
        actor=str(session.get("user_email") or email).strip().lower()
        payload={"entry_no":entry_no,"email":email,"store_name":store,"rows":cleaned,"submitted_by":actor,"issued_by":actor,"audit_id":"AUD-"+datetime.now().strftime("%Y%m%d-%H%M%S")+"-"+secrets.token_hex(4).upper(),"client_ip":request.headers.get("X-Forwarded-For",request.remote_addr or "").split(",")[0].strip(),"user_agent":request.headers.get("User-Agent","")[:500],"submission_mode":"field_entry"}
        if SUBMISSION_API_URL:
            result=remote_request("POST",payload) or {}
            if not result.get("ok"):
                return jsonify({"ok":False,"error":result.get("error","Google Apps Script rejected the submission."),"remote":result}),502
            saved=int(result.get("saved_rows",len(cleaned)) or 0)
            if saved != len(cleaned):
                return jsonify({"ok":False,"error":f"Submission mismatch: sent {len(cleaned)} rows but Apps Script saved {saved}.","remote":result}),502
            remember_submission(entry_no,email,store,cleaned)
            return jsonify({"ok":True,"message":"Stock submitted successfully.","saved_rows":saved,"entry_no":entry_no,"remote":result})
        saved=save_local_submission(payload)
        remember_submission(entry_no,email,store,cleaned)
        return jsonify({"ok":True,"message":"Stock submitted successfully.","saved_rows":saved,"entry_no":entry_no})
    except Exception as e: return _fail(e)

@app.post("/api/entry-report-data")
@require_access("stock_entry")
def entry_report_data():
    """Return the quantity-only data needed to build the two post-submission PDFs."""
    try:
        payload=request.get_json(silent=True) or {}
        email=str(payload.get("email","")).strip().lower()
        if not _enforce_identity(email): return jsonify({"ok":False,"error":"The submitted email does not match the signed-in account."}),403
        store=str(payload.get("store_name","")).strip()
        rows=payload.get("rows",[]) or []
        if not email or not store:
            return jsonify({"ok":False,"error":"Email and shop are required."}),400

        mp,_=load_entry_sources(False)
        allowed=set(mp.loc[mp["Email ID"]==email,"Store Name"])
        if store not in allowed and not session.get("is_admin"):
            return jsonify({"ok":False,"error":"This email is not mapped to the selected shop."}),403

        stock=load_stock(False, copy=False)
        try: var=load_variance(False, copy=False)
        except Exception:
            log.exception("Variance data unavailable for the report; continuing without movement columns")
            var=pd.DataFrame(columns=["Store Name","EAN Code","Product Name"])

        # Submitted physical quantities keyed by EAN.
        submitted={}
        for r in rows:
            ean=_norm_ean_value(r.get("EAN Code",""))
            if not ean: continue
            try:
                physical=max(0.0,_num(r.get("Total",0))); stock_q=max(0.0,_num(r.get("Stock",0))); tester_q=max(0.0,_num(r.get("Tester",0)))
            except (ValueError, TypeError):
                return jsonify({"ok":False,"error":"Invalid quantity in report rows."}),400
            name=str(r.get("Product Name","")).strip()
            if ean in submitted:
                submitted[ean]["Physical Stock"]+=physical; submitted[ean]["Stock Qty"]+=stock_q; submitted[ean]["Tester Qty"]+=tester_q
            else:
                submitted[ean]={"Product Name":name,"Physical Stock":physical,"Stock Qty":stock_q,"Tester Qty":tester_q}

        st=stock[stock["Store Name"].astype(str).str.strip()==store].drop_duplicates("EAN Code",keep="last")
        st_map=st.set_index("EAN Code").to_dict("index")

        if len(var) and "Store Name" in var:
            vv=var[var["Store Name"].astype(str).str.strip()==store].drop_duplicates("EAN Code",keep="last")
        else:
            vv=var
        var_map=vv.set_index("EAN Code").to_dict("index") if len(vv) else {}

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
        return _fail(e)

# ======================================================================
# Inward Validation - Invoice/Document based, line-level validation
# ======================================================================
INWARD_EXCEL_URL = os.getenv("INWARD_EXCEL_URL", "").strip()
INWARD_SHEET = os.getenv("INWARD_SHEET", "").strip()
INWARD_CACHE_SECONDS = int(os.getenv("INWARD_CACHE_SECONDS", "60"))
INWARD_SUBMISSION_API_URL = os.getenv("INWARD_SUBMISSION_API_URL", "").strip()
INWARD_ENABLED = os.getenv("INWARD_ENABLED", "0").strip().lower() in {"1", "true", "yes", "on"}

# Exact columns the Entry page / variance CSV exposes.
# Only these six source columns are exposed by Inward Validation / variance CSV.
# Party and Transfer-to Code are shown once in the invoice header, not repeated per row.
INWARD_OUTPUT_HEADERS = [
    "Transfer-to Code", "Shop Name", "Document No.", "EAN", "Description", "Quantity"
]

# Source aliases. The six important business mappings are explicit:
# Transfer-to Code <- Code of Party
# Shop Name        <- Party Name
# Document No.     <- InvoiceNumber
# EAN              <- EAN
# Description      <- SKU Name
# Quantity         <- Sales Qty
INWARD_FIELD_ALIASES = {
    "Document No.": ["Document No.", "Document No", "InvoiceNumber", "Invoice Number", "Invoice No", "PO Number", "PO No", "External Document No."],
    "Line No.": ["Line No.", "Line No", "Line Number"],
    "Item No.": ["Item No.", "Item No", "Item Number"],
    "Quantity": ["Sales Qty", "Quantity", "Qty", "Order Qty", "PO Qty"],
    "Unit of Measure": ["Unit of Measure"],
    "EAN": ["EAN", "EAN Code", "Barcode"],
    "Description": ["SKU Name", "Description", "Product Name", "Item Name"],
    "Shortcut Dimension 1 Code": ["Shortcut Dimension 1 Code"],
    "Shortcut Dimension 2 Code": ["Shortcut Dimension 2 Code"],
    "Gen. Prod. Posting Group": ["Gen. Prod. Posting Group"],
    "Inventory Posting Group": ["Inventory Posting Group"],
    "Quantity (Base)": ["Quantity (Base)"],
    "Qty. per Unit of Measure": ["Qty. per Unit of Measure"],
    "Unit of Measure Code": ["Unit of Measure Code"],
    "Gross Weight": ["Gross Weight"],
    "Net Weight": ["Net Weight"],
    "Unit Volume": ["Unit Volume"],
    "Variant Code": ["Variant Code"],
    "Units per Parcel": ["Units per Parcel"],
    "Description 2": ["Description 2"],
    "Transfer Order No.": ["Transfer Order No.", "Transfer Order Number"],
    "Receipt Date": ["Receipt Date", "Wh Receiving Date", "Receiving Date"],
    "Shipping Agent Code": ["Shipping Agent Code"],
    "Shipping Agent Service Code": ["Shipping Agent Service Code"],
    "In-Transit Code": ["In-Transit Code", "In Transit Code"],
    "Transfer-from Code": ["Transfer-from Code", "Transfer From Code"],
    "Transfer-to Code": ["Code of Party", "Transfer-to Code", "Transfer To Code"],
    "Item Rcpt. Entry No.": ["Item Rcpt. Entry No.", "Item Receipt Entry No."],
    "Shipping Time": ["Shipping Time"],
    "Dimension Set ID": ["Dimension Set ID"],
    "Item Category Code": ["Item Category Code"],
    "Transfer-To Bin Code": ["Transfer-To Bin Code", "Transfer To Bin Code"],
    "Custom Duty Amount": ["Custom Duty Amount"],
    "Amount": ["Amount"],
    "GST Credit": ["GST Credit"],
    "GST Group Code": ["GST Group Code"],
    "HSN/SAC Code": ["HSN/SAC Code", "HSN Code", "SAC Code"],
    "Exempted": ["Exempted", "Exempt"],
    "GST Assessable Value": ["GST Assessable Value"],
    "Unit Price": ["Unit Price"],
    "Shop Name": ["Party Name", "Shop Name", "Customer Name", "Store Name", "Outlet Name"]
}

INWARD_IGNORE_PO = {"TESTERS", "TESTER", "NA", "N/A", "NIL", "NONE", "-", "0"}
_inward_cache = {"ts": 0.0, "df": None, "key": "", "source": "", "mode": "sku"}


def _hnorm(v):
    return re.sub(r"[^a-z0-9]+", " ", str(v).lower()).strip()


def _blank(v):
    if v is None: return True
    try: return bool(pd.isna(v))
    except (TypeError, ValueError): return False


def _txt(v):
    if _blank(v): return ""
    if isinstance(v, (pd.Timestamp, datetime)): return v.strftime("%d-%b-%Y")
    if isinstance(v, float) and v.is_integer(): return str(int(v))
    return str(v).strip()


def _po_key(v):
    s = _txt(v).strip().upper()
    s = re.sub(r"^(?:PO|P\.O\.|INVOICE|INV)\s*[:#-]?\s*", "", s)
    s = re.sub(r"\s+", "", s)
    return s.split(".")[0] if re.fullmatch(r"\d+\.0+", s) else s


def _qty(v):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return 0
    return int(f) if f.is_integer() else round(f, 3)


def normalize_sheet_url(url):
    u = (url or "").strip(); p = urlparse(u); host = p.netloc.lower()
    if host == "docs.google.com" and "/spreadsheets/" in p.path:
        m = re.search(r"/spreadsheets/d/([A-Za-z0-9_-]+)", p.path)
        if m: return f"https://docs.google.com/spreadsheets/d/{m.group(1)}/export?format=xlsx"
    if host == "drive.google.com":
        m = re.search(r"/file/d/([A-Za-z0-9_-]+)", p.path) or re.search(r"[?&]id=([A-Za-z0-9_-]+)", u)
        if m: return f"https://drive.google.com/uc?export=download&id={m.group(1)}"
    if "sharepoint.com" in host or "onedrive.live.com" in host or "1drv.ms" in host:
        q = parse_qs(p.query, keep_blank_values=True); q["download"] = ["1"]
        return urlunparse((p.scheme, p.netloc, p.path, p.params, urlencode(q, doseq=True), p.fragment))
    return u


def _download_inward(url):
    try:
        r = requests.get(normalize_sheet_url(url), timeout=(8, 60), allow_redirects=True, headers={"User-Agent": "Mozilla/5.0"})
        r.raise_for_status()
    except requests.RequestException as e:
        raise RuntimeError(f"Could not download the inward sheet: {e}")
    data = r.content; ctype = (r.headers.get("content-type") or "").lower(); head = data[:300].lstrip().lower()
    if data[:2] == b"PK": return data, "xlsx"
    if data[:4] == b"\xd0\xcf\x11\xe0": raise RuntimeError("The inward file is an old .xls workbook. Please save it as .xlsx.")
    if "html" in ctype or head.startswith((b"<!doctype", b"<html")):
        raise RuntimeError("The inward link did not return the Excel file. Use the SharePoint/OneDrive Excel share link with access for the dashboard.")
    return data, "csv"


def _find_inward_header(raw):
    for i in range(min(25, len(raw))):
        heads = [_hnorm(c) for c in raw.iloc[i].tolist()]
        cols = {}
        for field, aliases in INWARD_FIELD_ALIASES.items():
            wanted = {_hnorm(a) for a in aliases}
            for idx, h in enumerate(heads):
                if h in wanted:
                    cols[field] = idx; break
        if "Document No." in cols and "Quantity" in cols:
            return i, cols
    return None, {}


def _parse_inward(data, kind):
    if kind == "csv":
        try: frames = [("CSV", pd.read_csv(io.BytesIO(data), header=None, dtype=object, encoding="utf-8-sig"))]
        except UnicodeDecodeError: frames = [("CSV", pd.read_csv(io.BytesIO(data), header=None, dtype=object, encoding="latin-1"))]
    else:
        xls = pd.ExcelFile(io.BytesIO(data))
        names = ([INWARD_SHEET] if INWARD_SHEET in xls.sheet_names else []) + [s for s in xls.sheet_names if s != INWARD_SHEET]
        frames = ((s, pd.read_excel(xls, sheet_name=s, header=None, dtype=object)) for s in names)

    seen = []
    for sheet, raw in frames:
        i, cols = _find_inward_header(raw)
        if i is None:
            if len(raw): seen.append(f"{sheet}: " + " | ".join(_txt(c) for c in raw.iloc[0].tolist() if not _blank(c))[:180])
            continue

        body = raw.iloc[i + 1:].reset_index(drop=True)
        out = pd.DataFrame(index=body.index)
        for field in INWARD_OUTPUT_HEADERS:
            if field in cols:
                out[field] = body.iloc[:, cols[field]].map(_txt)
            else:
                out[field] = ""

        # Explicit business mappings requested for the new workbook.
        # These overwrite the canonical fields if a source alias exists.
        if "Code of Party" in [_txt(x) for x in raw.iloc[i].tolist()] and "Transfer-to Code" in cols:
            out["Transfer-to Code"] = out["Transfer-to Code"].map(_txt)
        out["Document No."] = out["Document No."].map(_txt)
        out["EAN"] = out["EAN"].map(_txt)
        out["Description"] = out["Description"].map(_txt)
        out["Shop Name"] = out["Shop Name"].map(_txt)
        out["Quantity"] = pd.to_numeric(out["Quantity"], errors="coerce").fillna(0)

        out["__Document Key"] = out["Document No."].map(_po_key)
        out["__Row"] = range(len(out))
        out["__Key"] = out["__Document Key"] + "|" + out["EAN"] + "|" + out["__Row"].astype(str)
        out = out[(out["__Document Key"] != "") & ((out["EAN"] != "") | (out["Description"] != ""))]
        if out.empty:
            continue
        out = out.reset_index(drop=True)
        return out, (f"Inward sheet - {sheet}" if kind == "xlsx" else "Inward CSV"), "line"

    raise RuntimeError("Could not find the required inward columns. Required: Document No./InvoiceNumber and Quantity/Sales Qty. First row seen -> " + (" | ".join(seen) or "sheet is empty"))


_inward_lock = threading.Lock()


def load_inward(force=False):
    key = INWARD_EXCEL_URL or "local"
    def fresh(): return _inward_cache["df"] is not None and _inward_cache["key"] == key and time.time() - _inward_cache["ts"] < INWARD_CACHE_SECONDS
    if not force and fresh():
        return _inward_cache["df"], _inward_cache["source"]
    with _inward_lock:
        if fresh() and (not force or time.time() - _inward_cache["ts"] < 5):
            return _inward_cache["df"], _inward_cache["source"]
        return _load_inward_uncached(key)


def _load_inward_uncached(key):
    if INWARD_EXCEL_URL:
        data, kind = _download_inward(INWARD_EXCEL_URL)
    else:
        local = os.path.join(app.root_path, "data", "inward.xlsx")
        if not os.path.exists(local): raise RuntimeError("Inward Excel link is not configured. Set INWARD_EXCEL_URL on the server.")
        with open(local, "rb") as f: data, kind = f.read(), "xlsx"
    df, source, mode = _parse_inward(data, kind)
    _inward_cache.update(ts=time.time(), df=df, key=key, source=source, mode=mode)
    return df, source


def _mapped_shop_sets(email):
    mp = load_mapping(False)
    rows = mp[mp["Email ID"] == email]
    names = {str(x).strip().casefold() for x in rows["Store Name"].tolist() if str(x).strip()}
    codes = {str(x).strip().casefold() for x in rows["Store Code"].tolist() if "Store Code" in rows.columns and str(x).strip()}
    return names, codes


def _inward_email_error(email):
    if not email: return "Email ID is required."
    names, codes = _mapped_shop_sets(email)
    return None if (names or codes) else "Email ID is not mapped to any shop."


def inward_po(text, email=""):
    key = _po_key(text)
    df, source = load_inward(False)
    hit = df[df["__Document Key"] == key].copy()
    if email and not hit.empty:
        names, codes = _mapped_shop_sets(email)
        if names or codes:
            shop_ok = hit["Shop Name"].astype(str).str.strip().str.casefold().isin(names)
            code_ok = hit["Transfer-to Code"].astype(str).str.strip().str.casefold().isin(codes)
            hit = hit[shop_ok | code_ok]
    if hit.empty and time.time() - _inward_cache["ts"] > 10:
        df, source = load_inward(True)
        hit = df[df["__Document Key"] == key].copy()
        if email and not hit.empty:
            names, codes = _mapped_shop_sets(email)
            hit = hit[hit["Shop Name"].astype(str).str.strip().str.casefold().isin(names) | hit["Transfer-to Code"].astype(str).str.strip().str.casefold().isin(codes)]
    if hit.empty: return [], {}, "", source, "line", ""

    lines = []
    for _, r in hit.iterrows():
        d = {h: _txt(r[h]) for h in INWARD_OUTPUT_HEADERS}
        qty = _qty(r["Quantity"])
        d.update({"Key": _txt(r["__Key"]), "Order Qty": qty})
        lines.append(d)

    first = _txt(hit.iloc[0]["Document No."])
    shops = sorted(set(_txt(x) for x in hit["Shop Name"] if _txt(x)))
    codes = sorted(set(_txt(x) for x in hit["Transfer-to Code"] if _txt(x)))
    documents = sorted(set(_txt(x) for x in hit["Document No."] if _txt(x)))
    meta = {
        "shop_count": len(shops),
        "shops": shops,
        "transfer_to_codes": codes,
        "documents": documents,
    }
    return lines, meta, first, source, "line", "document"


def _inward_labels(mode):
    return {"code": "EAN", "name": "Description"}


@app.post("/api/inward/sync")
@require_access("stock_entry")
def inward_sync():
    if not INWARD_ENABLED:
        return jsonify({"ok": False, "error": "Inward Validation is currently disabled."}), 404
    """Force-refresh the SharePoint/OneDrive inward Excel cache.

    This is intentionally separate from /api/inward/fetch so users can
    refresh the source workbook on demand when a newly-created invoice
    is not yet visible in the cached data.
    """
    try:
        p = request.get_json(silent=True) or {}
        email = str(p.get("email", "")).strip().lower()
        if not _enforce_identity(email): return jsonify({"ok": False, "error": "The submitted email does not match the signed-in account."}), 403
        err = _inward_email_error(email)
        if err:
            return jsonify({"ok": False, "error": err}), 403

        df, source = load_inward(True)
        synced_at = datetime.now(timezone.utc).isoformat()
        return jsonify({
            "ok": True,
            "source": source,
            "rows": int(len(df)),
            "synced_at": synced_at,
            "message": "Excel data refreshed successfully."
        })
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.get("/api/inward/fetch")
@require_access("stock_entry")
def inward_fetch():
    if not INWARD_ENABLED:
        return jsonify({"ok": False, "error": "Inward Validation is currently disabled."}), 404
    try:
        email = request.args.get("email", "").strip().lower(); po = request.args.get("po", "").strip()
        if not _enforce_identity(email): return jsonify({"ok": False, "error": "The requested email does not match the signed-in account."}), 403
        err = _inward_email_error(email)
        if err: return jsonify({"ok": False, "error": err}), 403
        if not po: return jsonify({"ok": False, "error": "Enter an Invoice Number."}), 400
        lines, meta, label, source, mode, by = inward_po(po, email)
        if not lines: return jsonify({"ok": False, "error": f"Invoice Number {po} was not found in the inward sheet for your mapped shop(s)."}), 404
        try:
            master = load_master(False)
            master_skus = master[["EAN Code", "Product Name"]].to_dict(orient="records") if not master.empty else []
        except Exception:
            master_skus = []
        resp = jsonify({"ok": True, "po": label, "matched_by": by, "mode": mode, "labels": _inward_labels(mode), "meta": meta, "source": source, "headers": INWARD_OUTPUT_HEADERS, "rows": lines, "master_skus": master_skus})
        resp.headers["Cache-Control"] = "no-store"
        return resp
    except Exception as e: return jsonify({"ok": False, "error": str(e)}), 500


@app.post("/api/inward/submit")
@require_access("stock_entry")
def inward_submit():
    if not INWARD_ENABLED:
        return jsonify({"ok": False, "error": "Inward Validation is currently disabled."}), 404
    try:
        p = request.get_json(force=True) or {}
        email = str(p.get("email", "")).strip().lower(); po = str(p.get("po", "")).strip()
        if not _enforce_identity(email): return jsonify({"ok": False, "error": "The submitted email does not match the signed-in account."}), 403
        err = _inward_email_error(email)
        if err: return jsonify({"ok": False, "error": err}), 403
        lines, _, label, _, mode, _ = inward_po(po, email)
        if not lines: return jsonify({"ok": False, "error": f"Invoice Number {po} was not found in the inward sheet for your mapped shop(s)."}), 404
        by_key = {l["Key"]: l for l in lines}
        got, bad = {}, 0
        submitted_added = []
        for r in p.get("rows", []) or []:
            key = str(r.get("Key", ""))
            raw = r.get("Received Qty")
            if raw is None or (isinstance(raw, str) and not raw.strip()): continue
            try: v = float(raw)
            except (TypeError, ValueError): bad += 1; continue
            if not (v == v and 0 <= v < float("inf")):
                bad += 1
                continue
            got[key] = v
            # Added SKU rows are explicitly marked by the UI and have Order Qty = 0.
            if key.startswith("__ADDED__|") and key not in by_key:
                ean = str(r.get("EAN", "")).strip()
                name = str(r.get("Description", "")).strip()
                if not ean: return jsonify({"ok": False, "error": "Added SKU is missing its EAN."}), 400
                try:
                    master = load_master(False)
                    mm = master[master["EAN Code"].astype(str).str.strip() == ean]
                except Exception:
                    mm = pd.DataFrame()
                if mm.empty:
                    return jsonify({"ok": False, "error": f"SKU {ean} is not available in SKU Master."}), 400
                if not name: name = str(mm.iloc[0]["Product Name"])
                added = {h: "" for h in INWARD_OUTPUT_HEADERS}
                added.update({"Key": key, "EAN": ean, "Description": name, "Quantity": 0, "Order Qty": 0})
                by_key[key] = added
                submitted_added.append(key)
        if bad: return jsonify({"ok": False, "error": f"Received qty is invalid for {bad} line(s). Use 0 or more."}), 400
        missing = [l for l in lines if l["Key"] not in got]
        missing += [by_key[k] for k in submitted_added if k not in got]
        if missing: return jsonify({"ok": False, "error": f"Received qty is missing for {len(missing)} line(s). Enter 0 if nothing was received."}), 400

        rows = []
        all_lines = lines + [by_key[k] for k in submitted_added]
        for l in all_lines:
            recv = got[l["Key"]]; var = round(recv - float(l["Order Qty"]), 3)
            row = {h: l.get(h, "") for h in INWARD_OUTPUT_HEADERS}
            row.update({"Code": l.get("EAN", ""), "Name": l.get("Description", ""), "Order Qty": l["Order Qty"],
                        "Received Qty": _qty(recv), "Variance Qty": _qty(var),
                        "Variance %": round(var / float(l["Order Qty"]) * 100, 1) if float(l["Order Qty"]) else None,
                        "Status": "Match" if var == 0 else ("Short" if var < 0 else "Excess")})
            rows.append(row)

        saved = save_remote_inward(email, label, rows) if INWARD_SUBMISSION_API_URL else save_local_inward(email, label, rows)
        return jsonify({"ok": True, "po": label, "mode": mode, "labels": _inward_labels(mode), "headers": INWARD_OUTPUT_HEADERS, "saved_rows": saved, "rows": rows, "submitted_at": datetime.now(timezone.utc).isoformat()})
    except Exception as e: return jsonify({"ok": False, "error": str(e)}), 500

def _mapped_stores_for(email):
    mp = load_mapping(False)
    return set(mp.loc[mp["Email ID"].astype(str).str.strip().str.lower() == email, "Store Name"].astype(str).str.strip())


@app.get("/api/submissions")
@require_access("stock_entry")
def submissions():
    """Submission history for the Entry page.

    Field users see entries for the shops mapped to them (so a colleague's or an admin's upload for
    the same shop is visible too); set HISTORY_SCOPE=own to restrict to entries under their own email.
    Only the latest HISTORY_MAX_ENTRIES entries are sent, newest first, with ISO timestamps.
    """
    try:
        is_admin = bool(session.get("is_admin"))
        email = str(session.get("user_email", "")).strip().lower()
        if not email:
            return jsonify({"ok": False, "error": "Authentication required."}), 401
        try:
            df = get_submissions()
        except Exception as e:
            log.exception("Submission history load failed")
            return jsonify({"ok": False, "error": f"Could not reach the submission service ({e}). Your saved entries are safe; please retry in a moment."}), 502
        df = df[df["total"] > 0]
        if not is_admin:
            mapped = _mapped_stores_for(email)
            own = df["email"] == email
            if HISTORY_SCOPE == "own": df = df[own]
            else: df = df[df["store_name"].isin(mapped) | own]
        if df.empty:
            return jsonify({"ok": True, "records": [], "warning": _subs.get("error", "")})
        df = df.assign(_k=_entry_key(df))
        latest = df.groupby("_k")["_ts"].max().sort_values(ascending=False, na_position="last").head(HISTORY_MAX_ENTRIES).index
        df = df[df["_k"].isin(latest)].copy()
        df["submitted_at"] = [_iso(t, a) for t, a in zip(df["_ts"], df["submitted_at"])]
        out = df[["entry_no", "submitted_at", "email", "store_name", "ean_code", "product_name", "stock", "tester", "total"]]
        return jsonify({"ok": True, "records": json_records(out), "warning": _subs.get("error", "")})
    except Exception as e:
        return _fail(e)


@app.get("/api/last-submissions")
@require_access("stock_entry")
def last_submissions():
    """Return the latest stock submission summary for each shop mapped to the email."""
    try:
        email = str(request.args.get("email", "")).strip().lower()
        if not _enforce_identity(email):
            return jsonify({"ok": False, "error": "The requested email does not match the signed-in account."}), 403
        if not email:
            return jsonify({"ok": False, "error": "Email ID is required."}), 400
        mapped = sorted(_mapped_stores_for(email))
        if not mapped:
            return jsonify({"ok": True, "records": []})
        try: df = get_submissions()
        except Exception as e:
            return jsonify({"ok": False, "error": f"Could not reach the submission service ({e})."}), 502
        df = df[(df["total"] > 0) & df["store_name"].isin(mapped)]
        out = []
        for store in mapped:
            z = df[df["store_name"] == store]
            if z.empty: continue
            z = z.assign(_k=_entry_key(z))
            last_key = z.sort_values("_ts", na_position="first").iloc[-1]["_k"]
            rows = z[z["_k"] == last_key]
            first = rows.iloc[0]
            out.append({"store_name": store, "submitted_at": _iso(rows["_ts"].max(), first["submitted_at"]), "email": str(first["email"]),
                        "total_qty": float(rows["total"].sum()), "sku_count": int(len(rows)), "entry_no": str(first["entry_no"])})
        return jsonify({"ok": True, "records": out})
    except Exception as e:
        return _fail(e)

@app.get("/api/export")
@require_access("dashboard")
def export():
    try:
        stock=load_stock(False, copy=False)
        for col in ["Type","Store Name","Pareto","Product Name","EAN Code"]:
            vals=request.args.getlist(col)
            if vals: stock=stock[stock[col].isin(vals)]
        return Response(stock.to_csv(index=False),mimetype="text/csv",headers={"Content-Disposition":"attachment; filename=stock_dashboard.csv"})
    except Exception as e: return jsonify({"ok":False,"error":str(e)}),500

@app.get("/api/variance-export")
@require_access("dashboard")
def variance_export():
    try:
        df=merge_variance_actuals(load_variance(False, copy=False), load_stock(False, copy=False))
        if request.args.get("store"): df=df[df["Store Name"]==request.args.get("store")]
        if request.args.get("sku"):
            q=request.args.get("sku").lower(); df=df[df["EAN Code"].str.lower().str.contains(q,na=False) | df["Product Name"].str.lower().str.contains(q,na=False)]
        if request.args.get("issues")=="1":
            df=df[(df["Stock Variance Qty"].abs()>0) | (df["Live Submission"] & (df["Difference Qty"].abs()>0))]
        return Response(df.to_csv(index=False),mimetype="text/csv",headers={"Content-Disposition":"attachment; filename=variance_analysis.csv"})
    except Exception as e: return jsonify({"ok":False,"error":str(e)}),500


# -----------------------------------------------------------------------------
# Warm the caches at start-up so the first person to open the app does not wait for the Excel download.
# -----------------------------------------------------------------------------
def _warmup():
    time.sleep(0.5)
    for name, fn in (("stock", load_stock), ("master", load_master), ("variance", load_variance), ("submissions", lambda: get_submissions())):
        try: fn()
        except Exception as e: log.warning("Warm-up of %s skipped: %s", name, e)


if os.getenv("WARMUP", "1").strip().lower() not in {"0", "false", "no"} and not os.getenv("PYTEST_CURRENT_TEST"):
    threading.Thread(target=_warmup, daemon=True, name="warmup").start()
