"""Browser tests for the Field Entry screen (numeric qty, drafts, timer, review, offline queue, scan, order).
Run:  pytest tests/test_entry_e2e.py      (needs `pip install playwright pytest` + `playwright install chromium`; skipped otherwise)"""
import os, sys, time, sqlite3, threading
os.environ.update(SECRET_KEY="e2e-secret", ADMIN_PASSWORD="adminpw", SESSION_COOKIE_SECURE="0", WARMUP="0")
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import pytest
pytest.importorskip("playwright.sync_api")
from playwright.sync_api import sync_playwright
from werkzeug.serving import make_server
import pandas as pd
import app as A

EMAIL, STORE = "u@x.com", "Shop 1"
KEY = f"eka:draft:v1:{EMAIL}|{STORE}"
N = 60
EANS = [8901234560000 + i * 7 for i in range(N)]


@pytest.fixture(scope="module")
def server(tmp_path_factory):
    db = str(tmp_path_factory.mktemp("e2e") / "e2e.db")
    saved = (A.DATABASE_PATH, A.SUBMISSION_API_URL, A._db_ready)
    A.DATABASE_PATH, A.SUBMISSION_API_URL, A._db_ready = db, "", False
    names = [f"Product {i + 1}" for i in range(N)]
    stock = A.clean_stock(pd.DataFrame({"Type": ["EBO"] * N, "Store Name": [STORE] * N, "EAN Code": [float(e) for e in EANS], "Product Name": names,
                                       "Pareto": ["Top 10"] * N, "Stock": [5] * N, "Total MRP Value": [100] * N, "L3M Avg Qty": [5] * N, "L3M Avg Value": [50] * N, "NOD": [0] * N}))
    master = A.clean_master(pd.DataFrame({"EAN Code": [float(e) for e in EANS] + [8909990000001.0], "Product Name": names + ["Master Only Tint"]}))
    A._store_df("stock", stock); A._cache["stock_source"] = "e2e"; A._store_df("master", master)
    A._cache["map_df"] = pd.DataFrame([{"Email ID": EMAIL, "Store Name": STORE, "Store Code": "", "City": "", "Region": ""}]); A._cache["map_ts"] = time.time() + 10 ** 6
    srv = make_server("127.0.0.1", 0, A.app, threaded=True)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield {"base": f"http://127.0.0.1:{srv.server_port}", "db": db}
    srv.shutdown(); A.DATABASE_PATH, A.SUBMISSION_API_URL, A._db_ready = saved


@pytest.fixture(scope="module")
def browser():
    with sync_playwright() as p:
        b = p.chromium.launch(); yield b; b.close()


@pytest.fixture
def page(browser, server):
    ctx = browser.new_context(viewport={"width": 390, "height": 800}, is_mobile=True, has_touch=True)
    cookie = A.app.session_interface.get_signing_serializer(A.app).dumps({"user_email": EMAIL, "access": ["stock_entry", "dashboard"], "is_admin": False})
    ctx.add_cookies([{"name": A.app.config.get("SESSION_COOKIE_NAME", "session"), "value": cookie, "url": server["base"]}])
    with sqlite3.connect(server["db"]) if os.path.exists(server["db"]) else sqlite3.connect(":memory:") as con:
        for t in ("entry_drafts", "entry_sessions", "submissions"):
            try: con.execute(f"DELETE FROM {t}")
            except sqlite3.OperationalError: pass
    pg = ctx.new_page(); pg.base = server["base"]; pg.ctx = ctx; pg.db = server["db"]
    pg.goto(server["base"] + "/entry"); pg.evaluate("localStorage.clear()"); pg.reload()
    yield pg
    ctx.close()


def start(pg):
    pg.wait_for_selector("#continueEntry:not([disabled])"); pg.click("#continueEntry"); pg.wait_for_selector(".sku-entry-card")


def punch(pg, i, stock, tester=None):
    pg.locator(".sku-entry-card").nth(i).locator(".entry-num").nth(0).tap(); pg.keyboard.type(str(stock)); pg.keyboard.press("Enter")
    if tester is not None: pg.keyboard.type(str(tester))
    pg.keyboard.press("Enter")


def rows_js(pg, expr="r=>[r.stock,r.tester]"): return pg.evaluate(f"rows.filter(r=>r.stock||r.tester).map({expr})")


def test_search_input_survives_typing(page):
    start(page)
    page.evaluate("document.getElementById('entrySearch').__m=1"); page.tap("#entrySearch")
    for ch in "8901234":
        page.keyboard.type(ch)
        assert page.evaluate("!!document.getElementById('entrySearch').__m && document.activeElement.id==='entrySearch'")


def test_qty_is_digits_only_and_enter_moves_on(page):
    start(page)
    inp = page.locator(".sku-entry-card .entry-num").first
    assert inp.evaluate("e=>[e.type,e.inputMode]") == ["text", "numeric"]
    inp.tap(); page.keyboard.type("1a2.-e3"); assert inp.input_value() == "123"
    page.keyboard.press("Enter"); assert page.evaluate("document.activeElement.dataset.k") == "tester"
    page.keyboard.type("007"); assert page.evaluate("document.activeElement.value") == "7"


def test_review_flags_big_numbers_and_submit_clears_draft(page):
    start(page); punch(page, 0, 600, 1); punch(page, 1, 4, 9)
    page.tap("#submitEntryTop"); page.wait_for_selector("#reviewModal.open")
    assert page.locator(".review-row").count() == 2
    assert page.locator(".review-row.flag").count() == 2          # 600 is large; tester 9 > stock 4
    assert "Review before submitting" in page.inner_text("#reviewTitle")
    page.tap("#reviewBack"); assert not page.evaluate("document.getElementById('reviewModal').classList.contains('open')")
    page.tap("#submitEntryTop"); page.tap("#reviewGo")
    page.wait_for_selector("#entryPopup.open"); assert "Submission Successful" in page.inner_text("#entryPopupTitle")
    assert page.evaluate(f"localStorage.getItem('{KEY}')") is None
    with sqlite3.connect(page.db) as con: assert con.execute("SELECT COUNT(*), SUM(total) FROM submissions").fetchone() == (2, 614)


def test_offline_submit_is_queued_then_sent(page):
    start(page); punch(page, 0, 12, 3)
    page.ctx.set_offline(True)
    page.tap("#submitEntryTop"); page.tap("#reviewGo")
    page.wait_for_selector("#entryPopup.open"); assert "will send automatically" in page.inner_text("#entryPopupTitle")
    page.tap("#entryPopupClose")
    assert page.evaluate("JSON.parse(localStorage.getItem('eka:outbox:v1')).length") == 1
    assert "Waiting to send" in page.inner_text("#outboxBanner")
    page.ctx.set_offline(False); page.evaluate("window.dispatchEvent(new Event('online'))")
    page.wait_for_function("document.getElementById('outboxBanner').classList.contains('hidden')", timeout=15000)
    assert page.evaluate("localStorage.getItem('eka:outbox:v1')") == "[]"
    with sqlite3.connect(page.db) as con: assert con.execute("SELECT COUNT(*), SUM(total) FROM submissions").fetchone() == (1, 15)


def test_draft_comes_back_from_server_after_device_storage_is_wiped(page):
    start(page); punch(page, 0, 8, 2)
    page.tap("#saveDraftBtn"); page.wait_for_function("!serverDirty", timeout=10000)
    page.evaluate("localStorage.clear()"); page.reload(); start(page)
    assert "Draft restored" in page.inner_text("#entryMsg") and rows_js(page) == [[8, 2]]


def test_catalogue_order_is_stable_and_total_sort_is_opt_in(page):
    start(page)
    first = page.evaluate("rows.slice(0,5).map(r=>r.uid)")
    page.locator(".sku-entry-card").nth(3).locator(".entry-num").nth(0).tap(); page.keyboard.type("50"); page.keyboard.press("Enter"); page.keyboard.press("Enter")
    page.wait_for_timeout(500)
    assert page.evaluate("rows.slice(0,5).map(r=>r.uid)") == first                      # nothing jumped
    page.tap("#sortToggle"); assert page.evaluate("rows[0].stock") == 50                  # opt-in: highest total first


def test_scan_jumps_to_sku_adds_master_sku_and_rejects_unknown(page):
    start(page); page.tap("#scanBtn"); page.wait_for_selector("#scanModal.open")
    page.fill("#scanManual", "0" + str(EANS[7])); page.tap("#scanGo")                    # UPC-A style leading zero still matches
    page.wait_for_function("!document.getElementById('scanModal').classList.contains('open')")
    assert page.locator(".sku-entry-card").count() == 1 and page.evaluate("document.activeElement.dataset.k") == "stock"
    page.tap("#clearSearch"); page.tap("#scanBtn"); page.fill("#scanManual", "123456789"); page.tap("#scanGo")
    assert "not in this shop" in page.inner_text("#scanStatus")
    page.fill("#scanManual", "8909990000001"); page.tap("#scanGo")
    page.wait_for_selector(".added-sku-item"); assert page.evaluate("rows.some(r=>r.added&&r.ean==='8909990000001')")


def test_next_uncounted_continues_after_the_last_sku_touched(page):
    start(page)
    for i in (0, 1):
        page.locator(".sku-entry-card").nth(i).locator(".entry-num").nth(0).tap(); page.keyboard.type("1")
    page.evaluate("document.activeElement.blur()"); page.tap("#nextUncounted")
    assert page.evaluate("rows.find(r=>String(r.uid)===document.activeElement.dataset.uid).idx") == 3   # idx is 1-based: 3rd SKU
    page.keyboard.type("2"); page.evaluate("document.activeElement.blur()"); page.tap("#nextUncounted")
    assert page.evaluate("rows.find(r=>String(r.uid)===document.activeElement.dataset.uid).idx") == 4


def test_server_enforces_the_timer_and_extend_unlocks_submit(page):
    start(page); punch(page, 0, 5); page.wait_for_function("sessionEnforced===true && sessionDeadline>Date.now()+800000")
    with sqlite3.connect(page.db) as con: con.execute("UPDATE entry_sessions SET deadline=?", (time.time() - 600,))
    page.evaluate("sessionDeadline=Date.now()+1000"); page.wait_for_selector("#timeUpModal.open", timeout=6000)
    assert not page.is_visible("#tuSubmit")                                              # no submit once time is up
    page.tap("#tuExtend"); page.wait_for_function("sessionDeadline>Date.now()+800000")
    page.tap("#submitEntryTop"); page.tap("#reviewGo"); page.wait_for_selector("#entryPopup.open")
    assert "Submission Successful" in page.inner_text("#entryPopupTitle")


def test_sign_out_removes_synced_drafts_from_the_device(page):
    start(page); punch(page, 0, 3)
    page.tap("#saveDraftBtn"); page.wait_for_function("!serverDirty", timeout=10000)
    assert page.evaluate(f"localStorage.getItem('{KEY}')") is not None
    page.evaluate("document.querySelector('a[href=\"/logout\"]').click()"); page.wait_for_url("**/login")
    assert page.evaluate(f"localStorage.getItem('{KEY}')") is None
