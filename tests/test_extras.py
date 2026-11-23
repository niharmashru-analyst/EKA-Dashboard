"""Master JSON, stock reports, sales dashboard (run: pytest tests/)."""
import os, sys, time, io
os.environ.update(SECRET_KEY="test-secret", ADMIN_PASSWORD="adminpw", SESSION_COOKIE_SECURE="0", WARMUP="0")
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import pandas as pd, pytest
import app as A
import extras


@pytest.fixture
def env(tmp_path, monkeypatch):
    monkeypatch.setattr(A, "DATABASE_PATH", str(tmp_path / "s.db")); A._db_ready = False
    monkeypatch.setattr(A, "SUBMISSION_API_URL", "")
    monkeypatch.setattr(extras, "SALES_FILE", str(tmp_path / "sales.xlsx")); extras._reset = True
    A._subs.update(df=None, ts=0.0, error="", refreshing=False); A._recent.clear(); A._resp_cache.clear()
    rows = {"Type": ["EBO"] * 3, "Store Name": ["Shop 1", "Shop 1", "Shop 2"], "EAN Code": [8901234567890.0, 8901234567891.0, 8901234567890.0],
            "Product Name": ["Lip", "Kajal", "Lip"], "Pareto": ["Top 10"] * 3, "Stock": [10, 0, 4], "Total MRP Value": [100] * 3,
            "L3M Avg Qty": [31, 20, 5], "L3M Avg Value": [50] * 3, "NOD": [0] * 3}
    A._store_df("stock", A.clean_stock(pd.DataFrame(rows))); A._cache["stock_source"] = "test"
    A._store_df("master", A.clean_master(pd.DataFrame({"EAN Code": [8901234567890.0, 8901234567891.0], "Product Name": ["Lip", "Kajal"]})))
    A._cache["map_df"] = pd.DataFrame([{"Email ID": "u@x.com", "Store Name": "Shop 1", "Store Code": "S1", "City": "", "Region": ""},
                                       {"Email ID": "v@x.com", "Store Name": "Shop 2", "Store Code": "S2", "City": "", "Region": ""}])
    A._cache["map_ts"] = time.time() + 10 ** 6
    extras_mod = extras
    return A.app


def login(app, email, access, admin=False):
    c = app.test_client()
    with c.session_transaction() as s: s.update(user_email=email, access=access, is_admin=admin, user_name="T")
    return c


def punch(c, email, store, no, rows):
    r = c.post("/api/submit", json={"email": email, "store_name": store, "entry_no": no, "rows": rows}); assert r.get_json()["ok"], r.get_json()


def test_master_json_auth_etag_and_token(env, monkeypatch):
    assert env.test_client().get("/api/master-skus.json").status_code == 401
    c = login(env, "u@x.com", ["stock_entry"])
    r = c.get("/api/master-skus.json"); d = r.get_json()
    assert d["count"] == 2 and "Product Name" in d["columns"] and r.headers["ETag"]
    assert c.get("/api/master-skus.json", headers={"If-None-Match": r.headers["ETag"]}).status_code == 304
    monkeypatch.setattr(extras, "MASTER_JSON_TOKEN", "tok123")
    assert env.test_client().get("/api/master-skus.json?token=tok123").status_code == 200
    assert env.test_client().get("/api/master-skus.json", headers={"Authorization": "Bearer nope"}).status_code == 401


def test_reports_access_and_downloads(env):
    u = login(env, "u@x.com", ["stock_entry"]); v = login(env, "v@x.com", ["stock_entry"])
    punch(u, "u@x.com", "Shop 1", "STK-1", [{"EAN Code": "8901234567890", "Stock": 3, "Tester": 1}, {"EAN Code": "8901234567891", "Stock": 2, "Tester": 0}])
    punch(v, "v@x.com", "Shop 2", "STK-2", [{"EAN Code": "8901234567890", "Stock": 7, "Tester": 0}])
    assert u.get("/api/reports/outlets").status_code in (302, 401, 403)          # no 'reports' right
    r = login(env, "r@x.com", ["reports"])
    assert r.get("/reports").status_code == 200
    outs = {o["outlet"]: o for o in r.get("/api/reports/outlets").get_json()["outlets"]}
    assert outs["Shop 1"]["entries"] == 1 and outs["Shop 1"]["last_entry_no"] == "STK-1"
    assert r.get("/api/reports/download?format=csv").status_code == 400            # nothing selected
    a = r.get("/api/reports/download?mode=range&all=1&format=csv"); body = a.data.decode("utf-8-sig")
    assert a.status_code == 200 and "STK-1" in body and "STK-2" in body and "attachment" in a.headers["Content-Disposition"]
    one = r.get("/api/reports/download?mode=range&store=Shop 2&format=csv").data.decode("utf-8-sig")
    assert "STK-2" in one and "STK-1" not in one
    e = r.get("/api/reports/download?mode=entry&entry_no=STK-1&format=csv").data.decode("utf-8-sig")
    assert "STK-1" in e and "STK-2" not in e
    x = r.get("/api/reports/download?mode=range&all=1&format=xlsx&split=1")
    from openpyxl import load_workbook
    wb = load_workbook(io.BytesIO(x.data)); assert {"Summary", "Shop 1", "Shop 2"} <= set(wb.sheetnames)
    assert r.get("/api/reports/download?mode=entry&entry_no=NOPE&format=csv").status_code == 404
    assert r.get("/api/reports/entries?store=Shop 1").get_json()["entries"][0]["entry_no"] == "STK-1"


def test_sales_upload_scoping_and_sku_stock(env):
    from openpyxl import Workbook
    wb = Workbook(); t = wb.active; t.title = "T"; t.append(["Outlet", "Month", "Target", "Achievement"]); t.append(["Shop 1", "Nov 2026", 1000, 400]); t.append(["S2", "Nov 2026", 500, 600])
    s = wb.create_sheet("S"); s.append(["Outlet", "Month", "EAN Code", "Product Name", "Qty", "Net Sales"]); s.append(["Shop 1", "Nov 2026", "8901234567890", "Lip", 4, 400]); s.append(["Shop 2", "Nov 2026", "8901234567890", "Lip", 6, 600])
    buf = io.BytesIO(); wb.save(buf); buf.seek(0)
    admin = login(env, "a@x.com", ["admin", "sales"], True)
    up = admin.post("/api/admin/sales-upload", data={"file": (buf, "s.xlsx")}, content_type="multipart/form-data").get_json()
    assert up["ok"] and up["periods"] == ["Nov 2026"]
    own = login(env, "u@x.com", ["sales"]); allx = login(env, "h@x.com", ["sales", "dashboard"])
    so = own.get("/api/sales/summary").get_json(); assert [o["outlet"] for o in so["outlets"]] == ["Shop 1"] and so["outlets"][0]["pending"] == 600 and not so["scope_all"]
    sa = allx.get("/api/sales/summary").get_json(); assert {o["outlet"] for o in sa["outlets"]} == {"Shop 1", "Shop 2"}
    assert next(o for o in sa["outlets"] if o["outlet"] == "Shop 2")["excess"] == 100   # code "S2" resolved to Shop 2
    assert own.get("/api/sales/outlet?outlet=Shop 2").status_code == 403
    rows = {r["ean"]: r for r in own.get("/api/sales/outlet?outlet=Shop 1").get_json()["rows"]}
    assert rows["8901234567890"]["sales_qty"] == 4 and rows["8901234567890"]["stock"] == 10
    assert rows["8901234567891"]["status"] == "out"                                  # sells nothing, stock 0, L3M 20
    assert login(env, "u@x.com", ["stock_entry"]).get("/api/sales/summary").status_code in (302, 401, 403)


def test_outlet_name_matching():
    k = extras._okey
    assert k("RENEE - AHMEDABAD EBO") == k("Ahmedabad EBO") and k("Delhi T2") == k("Delhi T-2") and k("RENEE - ERODE KIOSK") == k("Erode")
    assert k("ZED - PUNE EBO") != k("Pune EBO") and k("RENEE - AHMEDABAD KIOSK") != k("Ahmedabad EBO")


def test_sales_link_requires_admin_and_https(env):
    assert login(env, "u@x.com", ["sales"]).get("/api/admin/sales-link").status_code == 403
    a = login(env, "a@x.com", ["admin"], True)
    assert a.post("/api/admin/sales-link", json={"url": "http://x"}).status_code == 400
