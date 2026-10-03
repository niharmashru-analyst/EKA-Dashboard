"""Regression tests for the stability / visibility fixes (run: pip install pytest && pytest)."""
import os, sys, time, threading
os.environ.update(SECRET_KEY="test-secret", ADMIN_PASSWORD="adminpw", SESSION_COOKIE_SECURE="0", WARMUP="0")
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import pandas as pd
import pytest
import app as A


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(A, "DATABASE_PATH", str(tmp_path / "s.db")); A._db_ready = False
    monkeypatch.setattr(A, "SUBMISSION_API_URL", "")
    A._subs.update(df=None, ts=0.0, error="", refreshing=False); A._recent.clear(); A._resp_cache.clear()
    stock = A.clean_stock(pd.DataFrame({"Type": ["EBO"], "Store Name": ["Shop 1"], "EAN Code": [8901234567890.0], "Product Name": ["Lip"],
                                       "Pareto": ["Top 10"], "Stock": [10], "Total MRP Value": [100], "L3M Avg Qty": [5], "L3M Avg Value": [50], "NOD": [0]}))
    master = A.clean_master(pd.DataFrame({"EAN Code": [8901234567890.0], "Product Name": ["Lip"]}))
    A._store_df("stock", stock); A._cache["stock_source"] = "test"
    A._store_df("master", master)
    A._cache["map_df"] = pd.DataFrame([{"Email ID": "u@x.com", "Store Name": "Shop 1", "Store Code": "", "City": "", "Region": ""}])
    A._cache["map_ts"] = time.time() + 10 ** 6
    c = A.app.test_client()
    with c.session_transaction() as s:
        s.update(user_email="u@x.com", access=["stock_entry", "dashboard"], is_admin=False)
    return c


def test_ean_normalisation():
    for raw in (8901234567890.0, "8901234567890.0", " 8901234567890 ", "8.90123456789E+12"):
        assert A._norm_ean_value(raw) == "8901234567890"
    assert A._norm_ean_value(None) == "" and A._norm_ean_value(float("nan")) == ""


def test_submission_is_visible_immediately_and_retry_is_idempotent(client):
    body = {"email": "u@x.com", "store_name": "Shop 1", "entry_no": "STK-1", "rows": [{"EAN Code": "8901234567890.0", "Stock": "4", "Tester": 1}]}
    assert client.post("/api/submit", json=body).get_json()["ok"]
    again = client.post("/api/submit", json=body).get_json()
    assert again["ok"] and again.get("duplicate")
    recs = client.get("/api/submissions").get_json()["records"]
    assert len(recs) == 1 and recs[0]["ean_code"] == "8901234567890" and recs[0]["total"] == 5


def test_bad_quantity_is_400_not_500(client):
    r = client.post("/api/submit", json={"email": "u@x.com", "store_name": "Shop 1", "rows": [{"EAN Code": "8901234567890", "Stock": "abc"}]})
    assert r.status_code == 400


def test_submission_history_survives_remote_outage(client, monkeypatch):
    client.post("/api/submit", json={"email": "u@x.com", "store_name": "Shop 1", "entry_no": "STK-2", "rows": [{"EAN Code": "8901234567890", "Stock": 2}]})
    monkeypatch.setattr(A, "_fetch_submissions_raw", lambda: (_ for _ in ()).throw(RuntimeError("sheet down")))
    A._subs["ts"] = 0.0
    j = client.get("/api/submissions").get_json()
    assert j["ok"] and [r["entry_no"] for r in j["records"]] == ["STK-2"]


def test_stale_data_served_when_refresh_fails():
    calls = []
    def build():
        calls.append(1)
        if len(calls) > 1: raise RuntimeError("download failed")
        return pd.DataFrame({"a": [1]})
    A._cache.pop("t_df", None)
    assert len(A._swr("t", 0, build)) == 1
    assert len(A._swr("t", 0, build)) == 1          # stale copy returned, refresh runs in background and fails quietly
    time.sleep(0.3)
    assert len(A._swr("t", 0, build)) == 1


def test_concurrent_requests_share_one_rebuild():
    A._cache.pop("c_df", None); calls = []
    def build():
        calls.append(1); time.sleep(0.2); return pd.DataFrame({"a": [1]})
    ts = [threading.Thread(target=lambda: A._swr("c", 60, build)) for _ in range(12)]
    [t.start() for t in ts]; [t.join() for t in ts]
    assert len(calls) == 1


def test_api_data_cached_and_gzip(client):
    r = client.get("/api/data", headers={"Accept-Encoding": "gzip"})
    assert r.status_code == 200 and r.headers["Content-Encoding"] == "gzip"
    import gzip, json
    assert json.loads(gzip.decompress(r.data))["records"][0]["EAN Code"] == "8901234567890"


def test_admin_config_never_waits_for_submissions(client):
    with client.session_transaction() as s:
        s.update(is_admin=True, access=["stock_entry", "dashboard", "admin"])
    j = client.get("/api/admin/config").get_json()
    assert j["ok"] and "submissions" not in j
    assert client.get("/api/admin/submissions").get_json()["ok"]
