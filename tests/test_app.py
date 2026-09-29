import json, os, sys
import pandas as pd
import pytest

os.environ.update(SECRET_KEY="test-secret", ADMIN_PASSWORD="adminpw", SESSION_COOKIE_SECURE="0")
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import app as A  # noqa: E402

NIHAR = "nihar.mashru@reneecosmetics.in"
PW = "ChangeMe@2026"  # sample password shipped in users.json (hashed)


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(A, "DATABASE_PATH", str(tmp_path / "s.db"))
    A._LOGIN_FAILS.clear()
    return A.app.test_client()


def login(c, email=NIHAR, pw=PW, **extra):
    return c.post("/login", json={"email": email, "password": pw, **extra})


# ---------------------------------------------------------------- auth
def test_anonymous_api_is_401(client):
    assert client.get("/api/data").status_code == 401


def test_login_ok_and_wrong_password(client):
    assert login(client).status_code == 200
    assert login(client, pw="nope").status_code == 401


def test_login_rate_limited(client):
    codes = [login(client, pw=f"bad{i}").status_code for i in range(7)]
    assert codes[:5] == [401] * 5 and codes[5:] == [429, 429]
    assert login(client).status_code == 429  # even the right password is refused during lockout


def test_cross_site_post_blocked(client):
    r = client.post("/login", json={"email": NIHAR, "password": PW}, headers={"Origin": "https://evil.example"})
    assert r.status_code == 403


@pytest.mark.parametrize("bad", ["https://evil.example", "//evil.example", "/\\evil.example", "javascript:alert(1)"])
def test_open_redirect_blocked(client, bad):
    assert login(client, next=bad).get_json()["redirect"] in ("/choose", "/", "/entry")


def test_deep_link_preserved(client):
    assert login(client, next="/entry?x=1").get_json()["redirect"] == "/entry?x=1"


def test_disabled_user_loses_access_immediately(client, tmp_path, monkeypatch):
    f = tmp_path / "users.json"
    rec = json.load(open(A.USERS_JSON_PATH, encoding="utf-8-sig"))
    f.write_text(json.dumps(rec))
    monkeypatch.setattr(A, "USERS_JSON_PATH", str(f))
    assert login(client).status_code == 200
    assert client.get("/choose").status_code == 200
    rec["users"][NIHAR]["status"] = "Inactive"
    f.write_text(json.dumps(rec))
    assert client.get("/api/submissions").status_code == 401


def test_legacy_sha256_hash_now_verifies():
    import hashlib
    rec = {"password_hash": hashlib.sha256(b"secret123").hexdigest()}
    assert A._check_password(rec, "secret123") and not A._check_password(rec, "other")


def test_admin_sees_all_stores_in_entry_meta(client):
    login(client, "admin@cormate.com", "adminpw")
    j = client.get("/api/entry-meta?email=admin@cormate.com").get_json()
    assert j["ok"] and "Mumbai Airport" in j["stores"]


def test_health_and_headers(client):
    r = client.get("/healthz")
    assert r.status_code == 200 and r.headers["X-Content-Type-Options"] == "nosniff"


# ---------------------------------------------------------------- calculations
def _stock(rows):
    base = dict(Type="A", **{"Store Name": "S1"}, Pareto="Others")
    return A.clean_stock(pd.DataFrame([{**base, "EAN Code": str(i), "Product Name": "p", "Total MRP Value": 0,
                                        "L3M Avg Value": 0, "NOD": 0, **r} for i, r in enumerate(rows)]))


def test_nod_is_float_and_correct():
    df = _stock([{"Stock": 100, "L3M Avg Qty": 62}, {"Stock": 50, "L3M Avg Qty": 0}])
    assert str(df["NOD"].dtype) == "float64"          # was 'object' (pd.NA leak)
    assert df.loc[0, "NOD"] == 50.0 and df.loc[1, "NOD"] == 0.0


def test_variance_sign_and_ean_normalisation():
    v = pd.DataFrame({"Store Name": ["S"], "EAN Code": [8901234567890.0], "Product Name": ["p"],
                      "Opening Stock Qty": [10], "Inward Qty": [20], "Tertiary Qty": [5], "Closing Stock Qty": [20]})
    o = A.clean_variance(v)
    assert o.loc[0, "Calculated Closing Qty"] == 25 and o.loc[0, "Stock Variance Qty"] == 5
    assert o.loc[0, "EAN Code"] == "8901234567890"


# ---------------------------------------------------------------- input validation / export
@pytest.mark.parametrize("v", ["abc", "nan", "inf", 10**9])
def test_qty_rejected(v):
    with pytest.raises(A.BadInput):
        A._qty_in(v)


def test_qty_clamps_and_defaults():
    assert A._qty_in(None) == 0 and A._qty_in("") == 0 and A._qty_in(-3) == 0 and A._qty_in("4.5") == 4.5


def test_submit_bad_quantity_is_400_not_500(client, monkeypatch):
    stock = pd.DataFrame({"Store Name": ["Mumbai Airport"], "EAN Code": ["1"], "Product Name": ["p"]})
    monkeypatch.setattr(A, "load_stock", lambda force=False: stock)
    monkeypatch.setattr(A, "load_master", lambda force=False: pd.DataFrame(columns=["EAN Code", "Product Name"]))
    login(client)
    body = {"email": NIHAR, "store_name": "Mumbai Airport", "rows": [{"EAN Code": "1", "Stock": "abc"}]}
    assert client.post("/api/submit", json=body).status_code == 400
    body["rows"][0]["Stock"] = 3
    r = client.post("/api/submit", json=body)
    assert r.status_code == 200 and r.get_json()["saved_rows"] == 1


def test_csv_formula_injection_neutralised():
    df = pd.DataFrame({"Product Name": ["=HYPERLINK(\"http://x\")", "ok"], "Stock": [1, 2]})
    assert A._csv_safe(df).loc[0, "Product Name"].startswith("'=")


def test_unexpected_errors_do_not_leak_internals(client, monkeypatch):
    def boom(force=False): raise KeyError("secret/internal/path")
    monkeypatch.setattr(A, "load_stock", boom)
    login(client)
    j = client.get("/api/data").get_json()
    assert "secret" not in j["error"]


def test_login_page_renders_with_deep_link_and_versioned_assets(client):
    html = client.get("/login?next=/entry%3Fa%3D1").get_data(as_text=True)
    assert 'const NEXT="/entry?a=1"' in html.replace("\\u0026", "&")
    import re
    assert re.search(r"dashboard\.css\?v=\d{6,}", html)          # mtime-based, not a hand-bumped number
    assert "{{" not in html                                        # no unrendered template syntax
