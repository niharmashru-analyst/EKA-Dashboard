"""Server-side drafts + 15-minute session timer (run: pytest tests/)."""
import os, sys, time
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
    A._store_df("stock", stock); A._cache["stock_source"] = "test"; A._store_df("master", master)
    A._cache["map_df"] = pd.DataFrame([{"Email ID": "u@x.com", "Store Name": "Shop 1", "Store Code": "", "City": "", "Region": ""}])
    A._cache["map_ts"] = time.time() + 10 ** 6
    c = A.app.test_client()
    with c.session_transaction() as s:
        s.update(user_email="u@x.com", access=["stock_entry", "dashboard"], is_admin=False)
    return c

SCOPE = {"email": "u@x.com", "store_name": "Shop 1"}
ITEMS = [{"e": "8901234567890", "n": "Lip", "s": 4, "t": 1, "a": 0}]


def test_draft_roundtrip_and_stale_write_ignored(client):
    assert client.get("/api/draft?email=u@x.com&store=Shop 1").get_json()["draft"] is None
    now = int(time.time() * 1000)
    r = client.put("/api/draft", json={**SCOPE, "items": ITEMS, "entry_no": "STK-9", "saved_at": now}).get_json()
    assert r["ok"] and r["saved_at"] == now
    d = client.get("/api/draft?email=u@x.com&store=Shop 1").get_json()["draft"]
    assert d["items"][0]["s"] == 4 and d["entry_no"] == "STK-9" and d["saved_at"] == now
    older = client.put("/api/draft", json={**SCOPE, "items": [{**ITEMS[0], "s": 99}], "saved_at": now - 5000}).get_json()
    assert older.get("stale") and client.get("/api/draft?email=u@x.com&store=Shop 1").get_json()["draft"]["items"][0]["s"] == 4
    assert client.delete("/api/draft?email=u@x.com&store=Shop 1").get_json()["ok"]
    assert client.get("/api/draft?email=u@x.com&store=Shop 1").get_json()["draft"] is None


def test_draft_is_sanitised_and_scoped(client):
    r = client.put("/api/draft", json={**SCOPE, "items": [{"e": "1", "s": "-5", "t": "abc"}, {"e": "", "s": 3}, {"e": "2", "s": 7.9, "t": 2000000}]}).get_json()
    assert r["ok"]
    items = client.get("/api/draft?email=u@x.com&store=Shop 1").get_json()["draft"]["items"]
    assert [(i["e"], i["s"], i["t"]) for i in items] == [("2", 7, 999999)]   # bad row dropped, numbers clamped
    assert client.put("/api/draft", json={"email": "u@x.com", "store_name": "Other Shop", "items": ITEMS}).status_code == 403
    assert client.put("/api/draft", json={"email": "someone@else.com", "store_name": "Shop 1", "items": ITEMS}).status_code == 403


def test_session_timer_persists_extends_and_is_enforced(client, monkeypatch):
    monkeypatch.setattr(A, "ENTRY_SESSION_ENFORCE", True)       # optional now (ENTRY_SESSION_ENFORCE=1); off by default
    a = client.post("/api/entry-session", json={**SCOPE, "action": "start"}).get_json()
    assert a["ok"] and 880 <= a["seconds_left"] <= 900
    time.sleep(1.1)
    b = client.post("/api/entry-session", json={**SCOPE, "action": "start"}).get_json()
    assert b["seconds_left"] <= a["seconds_left"] - 1            # a reload does not reset the clock
    body = {"email": "u@x.com", "store_name": "Shop 1", "entry_no": "STK-T1", "rows": [{"EAN Code": "8901234567890", "Stock": 3, "Tester": 0}]}
    # expire the session
    with A._db() as con: con.execute("UPDATE entry_sessions SET deadline=?", (time.time() - A.ENTRY_SESSION_GRACE - 5,))
    r = client.post("/api/submit", json=body)
    assert r.status_code == 409 and r.get_json()["code"] == "session_expired"
    ext = client.post("/api/entry-session", json={**SCOPE, "action": "extend"}).get_json()
    assert ext["seconds_left"] >= 890
    ok = client.post("/api/submit", json=body).get_json()
    assert ok["ok"] and ok["saved_rows"] == 1


def test_successful_submit_removes_draft_and_session(client):
    client.put("/api/draft", json={**SCOPE, "items": ITEMS}); client.post("/api/entry-session", json=SCOPE)
    body = {"email": "u@x.com", "store_name": "Shop 1", "entry_no": "STK-T2", "rows": [{"EAN Code": "8901234567890", "Stock": 4, "Tester": 1}]}
    assert client.post("/api/submit", json=body).get_json()["ok"]
    assert client.get("/api/draft?email=u@x.com&store=Shop 1").get_json()["draft"] is None
    with A._db() as con: assert con.execute("SELECT COUNT(*) FROM entry_sessions").fetchone()[0] == 0


def test_submit_without_session_still_works(client):
    body = {"email": "u@x.com", "store_name": "Shop 1", "entry_no": "STK-T3", "rows": [{"EAN Code": "8901234567890", "Stock": 2, "Tester": 0}]}
    assert client.post("/api/submit", json=body).get_json()["ok"]
