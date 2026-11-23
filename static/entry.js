let email = '', stores = [], selectedStore = '', master = [], rows = [];
let submissionHistory = [];
let lastSubmission = null;
let pendingEntryNo = '';   // reused if a submit has to be retried, so the server can ignore the duplicate
let currentPage = 1;
const PAGE_SIZE = 25;
let entrySearch = '';
let uidSeed = 1, orderSeed = 1;
let lastTouchedUid = null;   // the SKU the user last worked on ("Next uncounted" continues from here)
let sortMode = 'stable';   // 'stable' = catalogue order (rows never jump while counting) | 'total' = highest Total first
try { sortMode = localStorage.getItem('eka:sortMode') === 'total' ? 'total' : 'stable'; } catch (_) {}
let entrySortTimer = null;
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
let entryStep=1;
function showSetup(){
  if(entryStep===2){ clearTimeout(entrySortTimer); saveDraft(false); }   // never lose punched quantities when leaving the screen
  entryStep=1; stopSession();
  document.body.classList.remove('entry-session');
  $('skuArea').classList.add('hidden');$('setupActions').style.display='flex';$('email').disabled=false;$('store').disabled=stores.length<=1;$('continueEntry').disabled=!email||!selectedStore;
  paintDraftBanner();
  window.scrollTo({top:0});
}

let entryLoadTimer = null;
function setEntryLoading(show, title='Loading SKU Entry', text='Preparing your shop data…') {
  const el = $('entryLoading'); if (!el) return;
  const bar = $('entryProgressBar'), pct = $('entryProgressPct');
  $('entryLoadingTitle').textContent = title; $('entryLoadingText').textContent = text;
  el.classList.toggle('open', show); el.setAttribute('aria-hidden', show ? 'false' : 'true');
  if (show) {
    let n=8; bar.style.width=n+'%'; pct.textContent=n+'%'; clearInterval(entryLoadTimer);
    entryLoadTimer=setInterval(()=>{ n=Math.min(92,n+Math.max(1,Math.round((92-n)*.10))); bar.style.width=n+'%'; pct.textContent=n+'%'; $('entryLoadingText').textContent=n<45?'Loading store stock data…':n<75?'Preparing SKU list…':'Almost ready…'; },350);
  } else { clearInterval(entryLoadTimer); bar.style.width='100%'; pct.textContent='100%'; }
}

async function syncData() {
  const button=$('syncData'), oldText=button?button.textContent:''; const currentEmail=$('email').value.trim().toLowerCase();
  if(button){button.disabled=true;button.textContent='↻ Syncing…';} msg('Refreshing the latest data…',true);
  try {
    const j=await getJson('/api/data/sync',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:currentEmail})});
    if(currentEmail) await loadMeta();
    msg(`Data synced successfully. ${Number(j.mapping_rows||0).toLocaleString('en-IN')} mapping row(s) refreshed.`,true);
  } catch(e){ msg(`Data sync failed: ${e.message}`); }
  finally { if(button){button.disabled=false;button.textContent=oldText||'↻ Sync Data';} }
}

function showPopup(title, text, good = true, showDownload = false) {
  let el = $('entryPopup');
  if (!el) {
    el = document.createElement('div');
    el.id = 'entryPopup';
    el.className = 'entry-popup-overlay';
    el.innerHTML = `<div class="entry-popup"><div id="entryPopupIcon" class="entry-popup-icon"></div><h3 id="entryPopupTitle"></h3><p id="entryPopupText"></p><div class="entry-popup-actions"><button id="entryPopupStockPdf" class="btn secondary">⬇ Stock Entry PDF</button><button id="entryPopupVariancePdf" class="btn secondary">⬇ Variance PDF</button><button id="entryPopupClose" class="btn">Done</button></div></div>`;
    document.body.appendChild(el);
    $('entryPopupClose').onclick = () => el.classList.remove('open');
    el.onclick = e => { if (e.target === el) el.classList.remove('open'); };
  }
  $('entryPopupIcon').textContent = good ? '✓' : '!';
  $('entryPopupIcon').className = `entry-popup-icon ${good ? 'good' : 'bad'}`;
  $('entryPopupTitle').textContent = title;
  $('entryPopupText').textContent = text;
  const stockBtn = $('entryPopupStockPdf');
  const varBtn = $('entryPopupVariancePdf');
  [stockBtn, varBtn].forEach(b => { if (b) b.style.display = showDownload ? 'inline-flex' : 'none'; });
  if (stockBtn) stockBtn.onclick = downloadSubmissionPdf;
  if (varBtn) varBtn.onclick = downloadVariancePdf;
  el.classList.add('open');
}

function msg(t, good = false) {
  $('entryMsg').innerHTML = `<div class="entry-msg ${good ? 'good' : 'bad'}">${esc(t)}</div>`;
}

function enteredCount() {
  return rows.filter(r => Number(r.stock || 0) !== 0 || Number(r.tester || 0) !== 0).length;
}
function enteredQty() {
  return rows.reduce((a, r) => a + Number(r.stock || 0) + Number(r.tester || 0), 0);
}
function updateSummary() {
  const total = rows.length, entered = enteredCount(), qty = enteredQty();
  $('skuCount').textContent = total.toLocaleString('en-IN');
  $('enteredCount').textContent = entered.toLocaleString('en-IN');
  $('enteredQty').textContent = qty.toLocaleString('en-IN');
  const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
  set('progressText', `${entered} of ${total} SKU${total === 1 ? '' : 's'} entered • ${qty.toLocaleString('en-IN')} Qty`);
  set('cntAll', total.toLocaleString('en-IN')); set('cntEntered', entered.toLocaleString('en-IN')); set('cntPending', (total - entered).toLocaleString('en-IN'));
  const sb = $('submitEntryTop'); if (sb && sb.textContent !== 'Submitting…') sb.disabled = !total;
}

const _wait = ms => new Promise(r => setTimeout(r, ms));
// GET requests are retried (server waking up, 502/503/504, flaky mobile data). POSTs are sent once.
async function getJson(url, options = {}) {
  // options.tries / options.timeout (ms) override the defaults; err.network marks "no/unclear answer from the server".
  const { tries: optTries, timeout: optTimeout, ...fetchOpts } = options;
  const isGet = !fetchOpts.method || String(fetchOpts.method).toUpperCase() === 'GET';
  const tries = optTries || (isGet ? 3 : 1);
  let lastErr;
  for (let i = 0; i < tries; i++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), optTimeout || (isGet ? 45000 : 90000));
    try {
      const r = await fetch(url, { cache: 'no-store', ...fetchOpts, signal: ctl.signal });
      clearTimeout(timer);
      if (r.status === 401) { location.href = '/login'; throw Error('Your session expired. Please sign in again.'); }
      let j;
      try { j = await r.json(); }
      catch (_) {
        if ([502, 503, 504].includes(r.status) && i < tries - 1) { await _wait(1500 * (i + 1)); continue; }
        const er = Error([502, 503, 504].includes(r.status) ? 'The server is starting up or busy. Please try again in a moment.' : `Server returned HTTP ${r.status}`);
        er.network = r.status >= 500; er.status = r.status; throw er;
      }
      if (!r.ok || !j.ok) { const er = Error(j.error || `Request failed (${r.status})`); er.code = j.code; er.status = r.status; throw er; }
      return j;
    } catch (e) {
      clearTimeout(timer);
      const transient = e.name === 'AbortError' || e instanceof TypeError;
      if (transient) {
        lastErr = Error(e.name === 'AbortError'
          ? (isGet ? 'The server is taking too long to respond. Please try again.' : 'The server did not confirm in time.')
          : 'Network problem — check your connection and try again.');
        lastErr.network = true;
      } else lastErr = e;
      if (transient && i < tries - 1) { await _wait(1500 * (i + 1)); continue; }
      throw lastErr;
    }
  }
  throw lastErr;
}

async function loadMeta() {
  email = $('email').value.trim().toLowerCase();
  if (!email) {
    $('store').disabled = true;
    $('store').innerHTML = '<option>Enter email first</option>';
    return;
  }
  try {
    const j = await getJson('/api/entry-meta?email=' + encodeURIComponent(email) + '&_ts=' + Date.now());
    stores = j.stores || [];
    master = j.master_skus || [];
    if (stores.length === 1) {
      selectedStore = stores[0];
      $('store').innerHTML = `<option value="${esc(stores[0])}">${esc(stores[0])}</option>`;
      $('store').disabled = true;
      $('continueEntry').disabled = false;
    } else {
      selectedStore = '';
      $('store').disabled = false;
      $('store').innerHTML = '<option value="">Select shop</option>' + stores.map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
      $('skuArea').innerHTML = '';
      rows = [];
      currentPage = 1;
      updateSummary();
      $('continueEntry').disabled = true;
    }
    $('continueEntry').disabled = !selectedStore;
    msg(`${stores.length} shop(s) mapped to your signed-in account.`, true);
    if (entryStep !== 2) paintDraftBanner();
    loadLastSubmissions();   // not awaited: a slow submission service must never block shop selection
  } catch (e) {
    msg(e.message);
    $('store').disabled = true;
    $('skuArea').innerHTML = '';
    rows = [];
    currentPage = 1;
    updateSummary();
  }
}

/* Master SKUs come from the JSON feed (/api/master-skus.json): ETag-revalidated and cached on the device, so reopening
   the entry screen costs a 304. Falls back to the cached copy (works offline) or whatever the server sent inline. */
async function loadMasterFeed(fallback) {
  const KEY = 'eka:master:v1'; let cached = null;
  try { cached = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) {}
  try {
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 12000);
    const r = await fetch('/api/master-skus.json', { credentials: 'same-origin', signal: ctl.signal, headers: cached && cached.etag ? { 'If-None-Match': cached.etag } : {} });
    clearTimeout(t);
    if (r.status === 304 && cached) return cached.skus;
    if (r.ok) {
      const j = await r.json(), skus = (j.skus || []).map(x => ({ 'EAN Code': x['EAN Code'], 'Product Name': x['Product Name'] }));
      try { localStorage.setItem(KEY, JSON.stringify({ etag: r.headers.get('ETag') || '', skus })); } catch (e) {}
      return skus;
    }
  } catch (e) {}
  return (cached && cached.skus) || fallback || [];
}

async function loadSku() {
  selectedStore=$('store').value||selectedStore; if(!selectedStore) return;
  pendingEntryNo='';
  const button=$('continueEntry'); if(button){button.disabled=true;button.textContent='Loading…';}
  setEntryLoading(true,'Loading SKU Entry',`Preparing ${selectedStore}…`);
  try {
    const j=await getJson('/api/entry-meta?email='+encodeURIComponent(email)+'&store='+encodeURIComponent(selectedStore)+'&master=0&_ts='+Date.now());
    master=await loadMasterFeed(j.master_skus||master); const available=j.available_skus||[];
    orderSeed=1; rows=available.map(x=>({uid:uidSeed++,idx:orderSeed++,ean:String(x['EAN Code']??'').trim(),name:String(x['Product Name']??''),stock:0,tester:0,added:false})); entrySearch=''; currentPage=1; entryStep=2;
    await fetchServerDraft();            // newest of device draft / server draft wins
    const restored=applyDraft();
    $('setupActions').style.display='none'; $('email').disabled=true; $('store').disabled=true;
    setEntryLoading(true,'Loading SKU Entry',`${rows.length.toLocaleString('en-IN')} SKU(s) found. Building the entry table…`);
    document.body.classList.add('entry-session');
    render(); paintSaveState(); startSession();
    msg(restored?`Draft restored — ${restored} SKU(s) with quantities are back. Keep punching or submit.`:`${rows.length.toLocaleString('en-IN')} SKU(s) loaded for ${selectedStore}.`,true);
    window.scrollTo({top:0});
  } catch(e){ entryStep=1; msg(e.message); }
  finally { setEntryLoading(false); if(button){button.disabled=!selectedStore;} paintDraftBanner(); }
}

function applyOrder() {
  if (sortMode === 'total') {
    rows.sort((a, b) => {
      const d = rowTotal(b) - rowTotal(a);
      return d || String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' });
    });
  } else rows.sort((a, b) => a.idx - b.idx);
}

function renderLastSubmissions(records) {
  const box = $('lastSubmissionPanel');
  if (!box) return;
  const list = Array.isArray(records) ? records : [];
  if (!stores.length) { box.classList.add('hidden'); return; }
  const byStore = {};
  list.forEach(r => { byStore[String(r.store_name || '').trim()] = r; });
  box.innerHTML = `<div class="last-sub-head"><div><b>Last Submission • Shop Wise</b><span>Latest stock submission available for each mapped shop</span></div><span class="last-sub-refresh">Live</span></div><div class="last-sub-grid">${stores.map(store => {
    const r = byStore[store];
    const date = r && r.submitted_at ? new Date(r.submitted_at) : null;
    const when = date && !Number.isNaN(date.getTime()) ? date.toLocaleString('en-IN', {day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'}) : 'No submission yet';
    const total = r ? Number(r.total_qty || 0).toLocaleString('en-IN') : '—';
    const skus = r ? Number(r.sku_count || 0).toLocaleString('en-IN') : '—';
    const active = String(store) === String(selectedStore) ? ' active' : '';
    return `<div class="last-sub-item${active}"><div class="last-sub-store">${esc(store)}</div><div class="last-sub-time">${esc(when)}</div><div class="last-sub-meta"><span>${skus} SKU</span><span>${total} Qty</span></div>${r && r.email ? `<div class="last-sub-by">By ${esc(r.email)}</div>` : ''}</div>`;
  }).join('')}</div>`;
  box.classList.remove('hidden');
}

const fmtWhen = v => { const d = new Date(v); return Number.isNaN(d.getTime()) ? 'Date unavailable' : d.toLocaleString('en-IN', {day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'}); };
let _historyBusy = false;
let _submissionHistoryCollapsed = false;

function toggleSubmissionHistory(forceState) {
  const box = $('lastSubmissionPanel');
  if (!box) return;
  const body = box.querySelector('#submissionHistoryBody');
  const btn = box.querySelector('#toggleSubmissionHistory');
  if (!body || !btn) return;
  _submissionHistoryCollapsed = typeof forceState === 'boolean' ? forceState : !_submissionHistoryCollapsed;
  body.classList.toggle('submission-history-collapsed', _submissionHistoryCollapsed);
  btn.textContent = _submissionHistoryCollapsed ? '⌄' : '⌃';
  btn.setAttribute('aria-expanded', String(!_submissionHistoryCollapsed));
  btn.setAttribute('title', _submissionHistoryCollapsed ? 'Expand My Submission History' : 'Collapse My Submission History');
}

async function loadLastSubmissions() {
  const box=$('lastSubmissionPanel'); if(!box || !email || _historyBusy) return;
  _historyBusy = true;
  if (!submissionHistory.length) { box.classList.remove('hidden'); box.innerHTML='<div class="submission-empty">Loading your submission history…</div>'; }
  try {
    const j=await getJson('/api/submissions?_ts='+Date.now());
    submissionHistory=j.records||[];
    const groups={};
    submissionHistory.forEach(r=>{
      const store=String(r.store_name||'').trim();
      const ts=String(r.submitted_at||'');
      const key=String(r.entry_no||'').trim() || ('LEGACY-'+ts);
      if(!groups[key]) groups[key]={entry_no:String(r.entry_no||''),submitted_at:ts,email:String(r.email||''),store_name:store,rows:[]};
      groups[key].rows.push(r);
    });
    const entries=Object.values(groups).sort((a,b)=>(new Date(b.submitted_at)||0)-(new Date(a.submitted_at)||0)).slice(0,50);
    box.classList.remove('hidden');
    const warn=j.warning?`<div class="submission-empty" style="margin-bottom:8px">Showing saved data — the live refresh is temporarily unavailable.</div>`:'';
    box.innerHTML=`<div class="last-sub-head submission-history-toggle" id="submissionHistoryToggle" role="button" tabindex="0" aria-controls="submissionHistoryBody" aria-expanded="${!_submissionHistoryCollapsed}"><div><b>My Submission History</b><span>Select an entry to view SKU-wise quantities. Only &gt;0 quantities are shown.</span></div><div class="submission-history-head-right"><span class="last-sub-refresh">${entries.length} entries</span><button type="button" class="submission-history-collapse-btn" id="toggleSubmissionHistory" aria-expanded="${!_submissionHistoryCollapsed}" aria-label="Toggle My Submission History">${_submissionHistoryCollapsed ? '⌄' : '⌃'}</button></div></div><div id="submissionHistoryBody" class="${_submissionHistoryCollapsed ? 'submission-history-collapsed' : ''}">${warn}<div class="submission-history-list">${entries.length ? entries.map((e,i)=>{const qty=e.rows.reduce((a,r)=>a+Number(r.total||0),0);const no=e.entry_no||'Historical entry';const by=e.email&&e.email!==email?` • by ${esc(e.email)}`:'';return `<button class="submission-history-item" data-entry-index="${i}"><div><b>${esc(no)}</b><span>${esc(e.store_name)}${by}</span></div><div><span>${esc(fmtWhen(e.submitted_at))}</span><span>${e.rows.length} SKU • ${qty.toLocaleString('en-IN')} Qty</span></div></button>`;}).join(''):`<div class="submission-empty">No submitted stock entries found for your mapped shops.</div>`}</div></div>`;
    const historyToggle=box.querySelector('#submissionHistoryToggle');
    const historyButton=box.querySelector('#toggleSubmissionHistory');
    if(historyButton) historyButton.onclick=(ev)=>{ev.stopPropagation();toggleSubmissionHistory();};
    if(historyToggle) historyToggle.onclick=(ev)=>{if(ev.target.closest('#toggleSubmissionHistory')) return; toggleSubmissionHistory();};
    if(historyToggle) historyToggle.onkeydown=(ev)=>{if(ev.key==='Enter'||ev.key===' '){ev.preventDefault();toggleSubmissionHistory();}};
    box.querySelectorAll('.submission-history-item').forEach(b=>b.onclick=()=>showSubmissionDetail(entries[Number(b.dataset.entryIndex)]));
  } catch(e) {
    box.classList.remove('hidden');
    box.innerHTML=`<div class="submission-empty">Could not load submission history: ${esc(e.message)} <button class="btn secondary small" id="retryHistory" type="button">Retry</button></div>`;
    const rb=$('retryHistory'); if(rb) rb.onclick=()=>loadLastSubmissions();
  } finally { _historyBusy = false; }
}
function showSubmissionDetail(entry){
  if(!entry) return;
  const when=fmtWhen(entry.submitted_at);
  const qty=entry.rows.reduce((a,r)=>a+Number(r.total||0),0);
  const no=entry.entry_no || 'Historical Entry';
  $('lastSubmissionPanel').innerHTML=`<div class="submission-detail"><div class="submission-detail-head"><div><button class="btn secondary small" id="backSubmissionHistory">← Back</button><div class="submission-kicker">SUBMISSION ENTRY</div><h3>${esc(no)}</h3><span>${esc(entry.store_name)} • ${esc(when)}</span></div><div class="submission-detail-kpi"><b>${entry.rows.length}</b><small>SKUs</small><b>${qty.toLocaleString('en-IN')}</b><small>Total Qty</small></div></div><div class="submission-detail-table"><table><thead><tr><th>EAN / SKU</th><th>Product</th><th>Stock</th><th>Tester</th><th>Total</th></tr></thead><tbody>${entry.rows.filter(r=>Number(r.total||0)>0).map(r=>`<tr><td>${esc(r.ean_code||'')}</td><td>${esc(r.product_name||'')}</td><td>${Number(r.stock||0).toLocaleString('en-IN')}</td><td>${Number(r.tester||0).toLocaleString('en-IN')}</td><td><b>${Number(r.total||0).toLocaleString('en-IN')}</b></td></tr>`).join('')}</tbody></table></div></div>`;
  $('backSubmissionHistory').onclick=()=>loadLastSubmissions();
}

/* =====================================================================
   DRAFTS (auto-save: device + server) and the SERVER-AUTHORITATIVE 15-MINUTE TIMER
   - Every keystroke is saved to this device (localStorage) within 0.6 s, and pushed to the server a few
     seconds later, so a count also survives cleared app data / a different phone.
   - On opening a shop the newest of {device draft, server draft} is restored.
   - The draft is removed only after a successful final submit (or Discard).
   ===================================================================== */
const SESSION_SECONDS = 15 * 60;       // fallback timer length (the server's value wins when reachable)
const WARN_SECONDS = 3 * 60;           // "save a draft" prompt appears with this much time left
const DRAFT_TTL_MS = 72 * 3600 * 1000; // drafts older than this are ignored
const BIG_QTY = 500;                   // a single Stock/Tester value at or above this is flagged on the review screen
let sessionDeadline = 0, sessionTick = null, warned = false, expired = false, sessionEnforced = true;
let draftTimer = null, serverTimer = null, pushing = false;
let dirty = false, serverDirty = false, serverOk = null, lastSavedAt = null, storageOk = true;
const serverDraftCache = {}, serverDraftTried = {};

const scopeKey = () => `${email}|${selectedStore}`;
const draftKey = () => `eka:draft:v1:${scopeKey()}`;
const fmtClock = ms => new Date(ms).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const jsonHeaders = { 'Content-Type': 'application/json' };

function toast(text) {
  let el = $('entryToast');
  if (!el) { el = document.createElement('div'); el.id = 'entryToast'; el.className = 'entry-toast'; el.setAttribute('role', 'status'); document.body.appendChild(el); }
  el.textContent = text; el.classList.add('show');
  clearTimeout(el._t); el._t = setTimeout(() => el.classList.remove('show'), 3200);
}

/* ---------- draft: device copy ---------- */
function readLocalDraft() {
  if (!email || !selectedStore) return null;
  try {
    const raw = localStorage.getItem(draftKey()); if (!raw) return null;
    const d = JSON.parse(raw);
    if (!d || !Array.isArray(d.items)) return null;
    if (Date.now() - Number(d.savedAt || 0) > DRAFT_TTL_MS) { localStorage.removeItem(draftKey()); return null; }
    return { savedAt: Number(d.savedAt) || 0, entryNo: d.entryNo || '', items: d.items, synced: !!d.synced };
  } catch (_) { return null; }
}
const draftStats = d => {
  const items = (d && d.items || []).filter(i => Number(i.s) > 0 || Number(i.t) > 0);
  return { skus: items.length, qty: items.reduce((a, i) => a + (Number(i.s) || 0) + (Number(i.t) || 0), 0) };
};
const currentItems = () => rows.filter(r => rowTotal(r) > 0 || r.added).map(r => ({ e: r.ean, n: r.name, s: Number(r.stock) || 0, t: Number(r.tester) || 0, a: r.added ? 1 : 0 }));

// The newest of the device draft and the server draft (ignoring anything older than a submission that is still queued).
function bestDraft() {
  const l = readLocalDraft(), s = serverDraftCache[scopeKey()] || null;
  const d = !l ? s : (!s ? l : (s.savedAt > l.savedAt ? s : l));
  if (!d) return null;
  const q = latestQueuedAt(email, selectedStore);
  return q && d.savedAt <= q ? null : d;
}

function saveDraft(manual) {
  if (entryStep !== 2 || !email || !selectedStore) return;
  clearTimeout(draftTimer);
  try {
    const items = currentItems();
    const hadDraft = !!(lastSavedAt || serverDraftCache[scopeKey()]);   // only tell the server "empty" if a draft really existed
    if (!items.some(i => i.s > 0 || i.t > 0)) { localStorage.removeItem(draftKey()); lastSavedAt = null; if (!hadDraft) { storageOk = true; dirty = false; paintSaveState(); if (manual) toast('Nothing to save yet — enter a quantity first.'); return; } }
    else { const savedAt = Date.now(); localStorage.setItem(draftKey(), JSON.stringify({ v: 1, savedAt, entryNo: pendingEntryNo, items, synced: false })); lastSavedAt = savedAt; }
    storageOk = true; dirty = false;
  } catch (_) { storageOk = false; }
  serverDirty = true;
  clearTimeout(serverTimer); serverTimer = setTimeout(pushDraft, manual ? 0 : 3000);
  paintSaveState();
  if (manual) {
    const s = draftStats({ items: currentItems() });
    if (!s.skus) toast('Nothing to save yet — enter a quantity first.');
    else if (!storageOk && serverOk === false) toast('Could not save the draft. Please submit before closing.');
    else toast(`Draft saved • ${s.skus} SKU • ${s.qty.toLocaleString('en-IN')} Qty. You can leave and resume later.`);
    const b = $('saveDraftBtn');
    if (b && s.skus && (storageOk || serverOk)) { b.textContent = '✓ Saved'; b.classList.add('flash'); setTimeout(() => { b.textContent = '💾 Save Draft'; b.classList.remove('flash'); }, 1600); }
  }
}

/* ---------- draft: server copy ---------- */
async function pushDraft() {
  if (!serverDirty || pushing || !email || !selectedStore) return;
  pushing = true;
  const snapAt = lastSavedAt, snapKey = scopeKey();
  try {
    await getJson('/api/draft', { method: 'PUT', headers: jsonHeaders, tries: 1, timeout: 15000,
      body: JSON.stringify({ email, store_name: selectedStore, entry_no: pendingEntryNo, saved_at: snapAt || Date.now(), items: snapAt ? currentItems() : [] }) });
    serverOk = true;
    if (snapKey === scopeKey() && snapAt === lastSavedAt) {
      serverDirty = false;
      try { const raw = localStorage.getItem(draftKey()); if (raw) { const d = JSON.parse(raw); if (d.savedAt === snapAt) { d.synced = true; localStorage.setItem(draftKey(), JSON.stringify(d)); } } } catch (_) {}
    } else { serverDirty = true; clearTimeout(serverTimer); serverTimer = setTimeout(pushDraft, 1500); }
  } catch (_) { serverOk = false; }
  finally { pushing = false; paintSaveState(); }
}
async function fetchServerDraft() {
  if (!email || !selectedStore) return null;
  const k = scopeKey(); serverDraftTried[k] = true;
  try {
    const j = await getJson(`/api/draft?email=${encodeURIComponent(email)}&store=${encodeURIComponent(selectedStore)}&_ts=${Date.now()}`, { tries: 1, timeout: 7000 });
    const d = j.draft;
    serverDraftCache[k] = d ? { savedAt: Number(d.saved_at) || 0, entryNo: d.entry_no || '', items: d.items || [], synced: true } : null;
    serverOk = true;
  } catch (_) { serverOk = false; }
  return serverDraftCache[k] || null;
}

function clearDraft(alsoServer = true) {
  clearTimeout(draftTimer); clearTimeout(serverTimer);
  dirty = false; serverDirty = false; lastSavedAt = null;
  try { localStorage.removeItem(draftKey()); } catch (_) {}
  serverDraftCache[scopeKey()] = null;
  if (alsoServer && email && selectedStore) getJson(`/api/draft?email=${encodeURIComponent(email)}&store=${encodeURIComponent(selectedStore)}`, { method: 'DELETE', tries: 1, timeout: 8000 }).catch(() => {});
  paintSaveState();
}
function markDirty() {
  dirty = true; paintSaveState();
  clearTimeout(draftTimer); draftTimer = setTimeout(() => saveDraft(false), 600);   // debounced device save
}
function flushDraft() { if (entryStep === 2 && dirty) saveDraft(false); }
function paintSaveState() {
  const el = $('saveState'); if (!el) return;
  const cloud = serverDirty ? (serverOk === false ? ' • ☁ will sync when online' : ' • ☁ syncing…') : (serverOk ? ' • ☁ synced' : '');
  if (!storageOk && serverOk !== true) { el.className = 'sb-save err'; el.innerHTML = '<i></i>Can’t save a draft right now — submit before closing'; return; }
  el.className = 'sb-save' + (dirty ? ' saving' : lastSavedAt ? ' saved' : '');
  el.innerHTML = dirty ? '<i></i>Saving draft…' : lastSavedAt ? `<i></i>Draft auto-saved • ${fmtClock(lastSavedAt)}${cloud}` : '<i></i>Auto-save is on — your counts are saved as you type';
}

// Put saved quantities back onto the freshly loaded SKU list.
function applyDraft() {
  const d = bestDraft(); if (!d) return 0;
  const byEan = new Map(rows.map(r => [String(r.ean).trim(), r]));
  d.items.forEach(it => {
    const ean = String(it.e || '').trim(); if (!ean) return;
    let r = byEan.get(ean);
    if (!r) { r = { uid: uidSeed++, idx: orderSeed++, ean, name: String(it.n || ''), stock: 0, tester: 0, added: true }; rows.push(r); byEan.set(ean, r); }
    r.stock = Math.max(0, parseInt(it.s, 10) || 0); r.tester = Math.max(0, parseInt(it.t, 10) || 0);
  });
  pendingEntryNo = d.entryNo || '';
  lastSavedAt = d.savedAt || null;
  const local = readLocalDraft();
  if (!local || local.savedAt < d.savedAt) {                    // adopt the server copy locally
    try { localStorage.setItem(draftKey(), JSON.stringify({ v: 1, savedAt: d.savedAt, entryNo: d.entryNo, items: d.items, synced: true })); } catch (_) {}
  } else if (!local.synced) serverDirty = true;                  // device copy is newer: push it up
  applyOrder();
  if (serverDirty) { clearTimeout(serverTimer); serverTimer = setTimeout(pushDraft, 2000); }
  return draftStats(d).skus;
}

// Banner on the shop-selection screen.
function paintDraftBanner() {
  const b = $('draftBanner'), btn = $('continueEntry'); if (!b) return;
  if (email && selectedStore && !serverDraftTried[scopeKey()]) fetchServerDraft().then(paintDraftBanner);   // look on the server too
  const d = bestDraft(), s = draftStats(d);
  if (!d || !s.skus) { b.classList.add('hidden'); b.innerHTML = ''; if (btn) btn.textContent = 'Continue to SKU Entry →'; return; }
  b.classList.remove('hidden');
  b.innerHTML = `<div><b>💾 Saved draft found for ${esc(selectedStore)}</b><span>${s.skus} SKU • ${s.qty.toLocaleString('en-IN')} Qty • saved ${esc(fmtWhen(d.savedAt))}</span></div><button class="btn secondary small" id="discardDraft" type="button">Discard</button>`;
  if (btn) btn.textContent = 'Resume Draft →';
  $('discardDraft').onclick = () => { if (confirm('Discard the saved draft? The quantities you punched will be lost.')) { clearDraft(true); paintDraftBanner(); } };
}

/* ---------- 15-minute session timer (server decides; device clock is only a fallback) ---------- */
async function syncSession(action) {
  try {
    const j = await getJson('/api/entry-session', { method: 'POST', headers: jsonHeaders, tries: 1, timeout: 8000, body: JSON.stringify({ email, store_name: selectedStore, action }) });
    sessionEnforced = !!j.enforced;
    sessionDeadline = Date.now() + Number(j.seconds_left || 0) * 1000;
    tickSession();
  } catch (_) { /* offline: the local countdown keeps running */ }
}
function startSession(action = 'start') {
  sessionDeadline = Date.now() + SESSION_SECONDS * 1000; warned = false; expired = false;
  $('timerPrompt')?.classList.add('hidden'); $('timeUpModal')?.classList.remove('open');
  clearInterval(sessionTick); sessionTick = setInterval(tickSession, 1000); tickSession();
  syncSession(action);
}
function stopSession() { clearInterval(sessionTick); sessionTick = null; }
function tickSession() {
  if (!sessionTick) return;
  const left = Math.max(0, Math.ceil((sessionDeadline - Date.now()) / 1000));
  const t = $('timerText'), chip = $('sessionTimer'), bar = $('timerBar');
  if (t) t.textContent = `${String(Math.floor(left / 60)).padStart(2, '0')}:${String(left % 60).padStart(2, '0')}`;
  if (chip) { chip.classList.toggle('warn', left > 0 && left <= WARN_SECONDS); chip.classList.toggle('over', left === 0); }
  if (bar) bar.style.width = Math.min(100, left / SESSION_SECONDS * 100) + '%';
  if (left > WARN_SECONDS) { warned = false; expired = false; $('timerPrompt')?.classList.add('hidden'); }
  if (left > 0 && left <= WARN_SECONDS && !warned) {
    warned = true; flushDraft();
    const p = $('timerPrompt'); if (p) { $('timerPromptTime').textContent = left > 60 ? Math.ceil(left / 60) + ' minutes' : 'Less than a minute'; p.classList.remove('hidden'); }
  }
  if (left === 0 && !expired) { expired = true; saveDraft(false); showTimeUp(); }
}
function showTimeUp() {
  let el = $('timeUpModal');
  if (!el) {
    el = document.createElement('div'); el.id = 'timeUpModal'; el.className = 'entry-popup-overlay';
    el.innerHTML = `<div class="entry-popup" role="dialog" aria-modal="true" aria-labelledby="timeUpTitle"><div class="entry-popup-icon warn">⏱</div><h3 id="timeUpTitle">Your 15 minutes are up</h3><p id="timeUpText"></p><div class="entry-popup-actions timeup-actions"><button id="tuExtend" class="btn" type="button">Keep counting (+15 min)</button><button id="tuSubmit" class="btn secondary" type="button">Submit stock now</button><button id="tuLater" class="btn secondary" type="button">Finish later (draft is saved)</button></div></div>`;
    document.body.appendChild(el);
    $('tuExtend').onclick = () => { el.classList.remove('open'); startSession('extend'); };
    $('tuSubmit').onclick = () => { el.classList.remove('open'); openReview(); };
    $('tuLater').onclick = () => { el.classList.remove('open'); showSetup(); };
  }
  const s = draftStats({ items: currentItems() });
  $('timeUpText').textContent = s.skus
    ? `${s.skus} SKU • ${s.qty.toLocaleString('en-IN')} Qty are saved as a draft, so you will not have to punch them again.${sessionEnforced ? ' To submit, tap “Keep counting” first.' : ''}`
    : 'No quantities have been entered yet. Keep counting, or come back later.';
  $('tuSubmit').style.display = sessionEnforced ? 'none' : '';
  el.classList.add('open');
}

document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushDraft(); else { tickSession(); pushDraft(); flushOutbox(); } });
window.addEventListener('pagehide', flushDraft);
window.addEventListener('online', () => { pushDraft(); flushOutbox(); });
setInterval(() => { if (dirty) saveDraft(false); if (serverDirty && !pushing) pushDraft(); }, 10000);   // safety net

/* =====================================================================
   OFFLINE-SAFE SUBMIT (outbox)
   If the network drops while submitting, the entry is kept on the device and sent automatically when
   the connection is back. The server ignores a repeated entry number, so a retry can never double-count.
   ===================================================================== */
const OUTBOX_KEY = 'eka:outbox:v1';
let flushing = false;
const readOutbox = () => { try { const a = JSON.parse(localStorage.getItem(OUTBOX_KEY) || '[]'); return Array.isArray(a) ? a : []; } catch (_) { return []; } };
function writeOutbox(a) { try { localStorage.setItem(OUTBOX_KEY, JSON.stringify(a)); } catch (_) {} paintOutbox(); }
const myOutbox = () => readOutbox().filter(x => x.email === String($('email').value || '').trim().toLowerCase());
function latestQueuedAt(em, st) { return readOutbox().filter(x => x.email === em && x.store === st).reduce((a, x) => Math.max(a, x.queuedAt || 0), 0); }
function queueOutbox(payload) {
  const a = readOutbox().filter(x => x.entryNo !== payload.entry_no);
  a.push({ entryNo: payload.entry_no, email: payload.email, store: payload.store_name, queuedAt: Date.now(), payload, error: '' });
  writeOutbox(a);
}
function paintOutbox() {
  const box = $('outboxBanner'); if (!box) return;
  const items = myOutbox();
  if (!items.length) { box.classList.add('hidden'); box.innerHTML = ''; return; }
  box.classList.remove('hidden');
  box.innerHTML = items.map(x => {
    const n = x.payload.rows.length, q = x.payload.rows.reduce((a, r) => a + Number(r.Total || 0), 0);
    return `<div class="outbox-item ${x.error ? 'err' : ''}"><div><b>${x.error ? '⚠ Could not send' : '⏳ Waiting to send'} — ${esc(x.store)}</b><span>${n} SKU • ${q.toLocaleString('en-IN')} Qty • ${esc(x.entryNo)}${x.error ? ' • ' + esc(x.error) : ' • sends automatically when you are online'}</span></div><div class="outbox-actions"><button class="btn small" type="button" data-outbox-send>Send now</button>${x.error ? `<button class="btn secondary small" type="button" data-outbox-drop="${esc(x.entryNo)}">Discard</button>` : ''}</div></div>`;
  }).join('');
  box.querySelectorAll('[data-outbox-send]').forEach(b => b.onclick = () => flushOutbox(true));
  box.querySelectorAll('[data-outbox-drop]').forEach(b => b.onclick = () => { if (confirm('Discard this submission? These quantities will not be sent.')) writeOutbox(readOutbox().filter(x => x.entryNo !== b.dataset.outboxDrop)); });
}
const postSubmit = payload => getJson('/api/submit', { method: 'POST', headers: jsonHeaders, body: JSON.stringify(payload) });
async function flushOutbox(manual) {
  if (flushing) return;
  const mine = myOutbox(); if (!mine.length) return;
  flushing = true;
  try {
    for (const item of mine) {
      try {
        let j;
        try { j = await postSubmit(item.payload); }
        catch (e) {
          if (e.code !== 'session_expired') throw e;                // it was submitted in time while offline: renew the clock once and resend
          await getJson('/api/entry-session', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ email: item.email, store_name: item.store, action: 'extend' }) });
          j = await postSubmit(item.payload);
        }
        writeOutbox(readOutbox().filter(x => x.entryNo !== item.entryNo));
        await onSubmitted(item.payload, j, false);
      } catch (e) {
        if (e.network) { if (manual) toast('Still offline — it will send automatically when you reconnect.'); break; }
        writeOutbox(readOutbox().map(x => x.entryNo === item.entryNo ? { ...x, error: e.message || 'Rejected by the server' } : x));
      }
    }
  } finally { flushing = false; paintOutbox(); }
}
setInterval(() => { if (myOutbox().some(x => !x.error)) flushOutbox(); }, 20000);

/* =====================================================================
   JUMP TO A ROW (used by scan, review and "next uncounted")
   ===================================================================== */
function gotoRow(row, opts = {}) {
  const s = $('entrySearch');
  if (opts.search) { entrySearch = row.ean; if (s) s.value = row.ean; $('clearSearch')?.classList.remove('hidden'); currentPage = 1; }
  else {
    const q = String(entrySearch || '').trim().toLowerCase();
    const idx = rows.filter(r => !r.added && matchesSearch(r, q)).indexOf(row);
    if (idx >= 0) currentPage = Math.floor(idx / PAGE_SIZE) + 1;
  }
  entryFilter = 'all';
  document.querySelectorAll('#entryChips .chip[data-f]').forEach(c => c.classList.toggle('active', c.dataset.f === 'all'));
  renderList();
  const box = [...document.querySelectorAll(`.entry-num[data-uid="${row.uid}"][data-k="stock"]`)].find(el => el.offsetParent !== null);
  if (box) { box.scrollIntoView({ block: 'center', behavior: 'smooth' }); box.focus({ preventScroll: true }); }
}
function nextUncounted() {
  const q = String(entrySearch || '').trim().toLowerCase();
  const base = rows.filter(r => !r.added && matchesSearch(r, q));
  if (!base.length) return;
  let ref = base.findIndex(r => String(r.uid) === String(lastTouchedUid));          // continue from the SKU last worked on
  if (ref < 0) { const v = visibleSet().visible; ref = v.length ? base.indexOf(v[0]) - 1 : -1; }   // otherwise from the top of this page
  const order = [...base.slice(ref + 1), ...base.slice(0, ref + 1)];
  const nxt = order.find(r => rowTotal(r) === 0);
  if (!nxt) { toast('Every SKU has a quantity — nothing left uncounted.'); return; }
  gotoRow(nxt);
}

/* =====================================================================
   REVIEW BEFORE SUBMIT
   ===================================================================== */
function openReview() {
  if (!rows.length || !selectedStore) return;
  if (expired && sessionEnforced) { showTimeUp(); return; }
  const ent = rows.filter(r => rowTotal(r) > 0);
  if (!ent.length) { showPopup('Nothing to submit', 'Please enter Stock or Tester quantity for at least one SKU.', false, false); return; }
  saveDraft(false);
  const n = v => Number(v).toLocaleString('en-IN');
  const stock = ent.reduce((a, r) => a + Number(r.stock || 0), 0), tester = ent.reduce((a, r) => a + Number(r.tester || 0), 0);
  const flagOf = r => Math.max(r.stock, r.tester) >= BIG_QTY ? `Large quantity — is ${n(Math.max(r.stock, r.tester))} correct?` : (r.stock > 0 && r.tester > r.stock ? 'Tester is higher than Stock' : '');
  const flagged = ent.filter(r => flagOf(r));
  const blank = rows.length - ent.length;
  let el = $('reviewModal');
  if (!el) { el = document.createElement('div'); el.id = 'reviewModal'; el.className = 'review-overlay'; document.body.appendChild(el); }
  el.innerHTML = `<div class="review-card" role="dialog" aria-modal="true" aria-labelledby="reviewTitle">
    <div class="review-head"><div><h3 id="reviewTitle">Review before submitting</h3><p>${esc(selectedStore)} • ${esc(email)}</p></div><button id="reviewX" class="picker-close" type="button" aria-label="Close">✕</button></div>
    <div class="review-stats"><div><small>SKUs</small><b>${n(ent.length)}</b></div><div><small>Stock</small><b>${n(stock)}</b></div><div><small>Tester</small><b>${n(tester)}</b></div><div><small>Total Qty</small><b>${n(stock + tester)}</b></div></div>
    ${flagged.length ? `<div class="review-warn"><b>⚠ Please double-check ${flagged.length} entr${flagged.length === 1 ? 'y' : 'ies'}</b><span>Tap a row below to go back and correct it.</span></div>` : ''}
    ${blank ? `<div class="review-note"><span>${n(blank)} SKU${blank === 1 ? ' has' : 's have'} no quantity and will not be submitted.</span><button id="reviewBlank" class="link-btn" type="button">Show them</button></div>` : ''}
    <div class="review-list">${ent.map(r => `<button type="button" class="review-row ${flagOf(r) ? 'flag' : ''}" data-uid="${r.uid}"><span class="rr-name"><b>${esc(r.name || 'Unnamed Product')}</b><small>${esc(r.ean)}${flagOf(r) ? ' • ⚠ ' + esc(flagOf(r)) : ''}</small></span><span class="rr-q"><small>Stock</small>${n(r.stock)}</span><span class="rr-q"><small>Tester</small>${n(r.tester)}</span><span class="rr-q tot"><small>Total</small>${n(rowTotal(r))}</span></button>`).join('')}</div>
    <div class="review-foot"><button id="reviewBack" class="btn secondary" type="button">← Back to edit</button><button id="reviewGo" class="btn" type="button">Confirm &amp; Submit</button></div></div>`;
  const close = () => el.classList.remove('open');
  $('reviewX').onclick = $('reviewBack').onclick = close;
  el.onclick = e => { if (e.target === el) close(); };
  $('reviewBlank')?.addEventListener('click', () => { close(); entryFilter = 'pending'; currentPage = 1; document.querySelectorAll('#entryChips .chip[data-f]').forEach(c => c.classList.toggle('active', c.dataset.f === 'pending')); renderList(); window.scrollTo({ top: 0, behavior: 'smooth' }); });
  el.querySelectorAll('.review-row').forEach(b => b.onclick = () => { const r = rows.find(x => String(x.uid) === b.dataset.uid); close(); if (r) gotoRow(r, { search: true }); });
  $('reviewGo').onclick = async () => { $('reviewGo').disabled = true; close(); await doSubmit(); };
  el.classList.add('open');
  $('reviewGo').focus();
}

/* =====================================================================
   SUBMIT (with offline queue)
   ===================================================================== */
const newEntryNo = () => 'STK-' + new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14) + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();
function setSubmitting(on) {
  const b = $('submitEntryTop'); if (!b) return;
  b.disabled = on || !rows.length; b.textContent = on ? 'Submitting…' : 'Submit Stock';
}
async function doSubmit() {
  const enteredRows = rows.filter(r => rowTotal(r) > 0).map(r => ({ ean: r.ean, name: r.name, stock: Number(r.stock || 0), tester: Number(r.tester || 0), total: rowTotal(r) }));
  if (!enteredRows.length) { showPopup('Nothing to submit', 'Please enter Stock or Tester quantity for at least one SKU.', false, false); return; }
  if (!pendingEntryNo) pendingEntryNo = newEntryNo();
  saveDraft(false);   // keep a copy until the server confirms
  const payload = { email, store_name: selectedStore, entry_no: pendingEntryNo,
    rows: enteredRows.map(r => ({ 'EAN Code': r.ean, 'Product Name': r.name, 'Stock': r.stock, 'Tester': r.tester, 'Total': r.total })) };
  setSubmitting(true); msg('Submitting entered SKU quantities…', true);
  try {
    const j = await postSubmit(payload);
    await onSubmitted(payload, j, true);
  } catch (e) {
    if (e.code === 'session_expired') { expired = true; showTimeUp(); msg('Your session ended — tap “Keep counting” to continue.', false); }
    else if (e.network) {
      // No connection (or no confirmation): park it safely; the server de-duplicates by entry number.
      queueOutbox(payload);
      clearDraft(true);
      pendingEntryNo = ''; rows.forEach(r => { r.stock = 0; r.tester = 0; }); currentPage = 1;
      render(); paintSaveState(); startSession();
      showPopup('Saved — will send automatically', `${enteredRows.length} SKU • ${enteredRows.reduce((a, r) => a + r.total, 0).toLocaleString('en-IN')} Qty could not be sent right now. It is kept safely on this phone and will be submitted automatically as soon as you are online.`, true, false);
      msg('Waiting for connection — submission queued.', true);
      flushOutbox();
    } else {
      showPopup('Submission Failed', (e.message || 'The submission could not be completed.') + ' Your quantities are still on screen and saved as a draft — tap Submit again (it will not create a duplicate).', false, false);
      loadLastSubmissions(); msg(`Submission failed: ${e.message}`, false);
    }
  } finally { setSubmitting(false); }
}
// Runs after the server confirmed a submission. fromScreen=false when it was sent later from the outbox.
async function onSubmitted(payload, j, fromScreen) {
  const saved = Number(j.saved_rows || 0), entryNo = j.entry_no || payload.entry_no;
  const enteredRows = payload.rows.map(r => ({ ean: r['EAN Code'], name: r['Product Name'], stock: Number(r.Stock || 0), tester: Number(r.Tester || 0), total: Number(r.Total || 0) }));
  // Separate call so PDF data problems can never slow down or fail the save itself.
  let reportRows = [];
  try { reportRows = (await getJson('/api/entry-report-data', { method: 'POST', headers: jsonHeaders, body: JSON.stringify(payload) })).rows || []; } catch (_) {}
  lastSubmission = { entryNo, email: payload.email, store: payload.store_name, rows: enteredRows, reportRows, savedRows: saved, timestamp: new Date() };
  showPopup('Submission Successful', `Entry No. ${entryNo} • ${saved.toLocaleString('en-IN')} SKU rows submitted for ${payload.store_name}.${fromScreen ? '' : ' (sent from the offline queue)'}`, true, true);
  msg(`${saved.toLocaleString('en-IN')} SKU rows submitted successfully.`, true);
  loadLastSubmissions();
  if (fromScreen) {
    pendingEntryNo = '';
    clearDraft(false);       // the server already removed its copy on a successful submit
    rows.forEach(r => { r.stock = 0; r.tester = 0; });
    currentPage = 1; entryFilter = 'all';
    render(); paintSaveState(); startSession();
  }
}
const submitAll = openReview;   // every Submit button goes through the review screen first

/* =====================================================================
   BARCODE SCANNER (camera)
   Uses the browser's built-in BarcodeDetector when present; otherwise loads a small scanner library on demand.
   ===================================================================== */
const SCAN_LIB = 'https://cdnjs.cloudflare.com/ajax/libs/html5-qrcode/2.3.8/html5-qrcode.min.js';
let scanStream = null, scanTimer = null, scanBusy = false, html5Scanner = null, lastScan = { code: '', t: 0 };
const canonEan = s => String(s || '').replace(/\D/g, '').replace(/^0+/, '');    // EAN-13 / UPC-A differ only by a leading zero
const setScanStatus = (t, bad) => { const el = $('scanStatus'); if (el) { el.textContent = t; el.classList.toggle('bad', !!bad); } };
const loadScript = src => new Promise((res, rej) => { if ([...document.scripts].some(s => s.src === src)) return res(); const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('scanner library could not load')); document.head.appendChild(s); });

function openScanner() {
  let el = $('scanModal');
  if (!el) {
    el = document.createElement('div'); el.id = 'scanModal'; el.className = 'scan-overlay';
    el.innerHTML = `<div class="scan-card" role="dialog" aria-modal="true" aria-label="Scan barcode">
      <div class="review-head"><div><h3>Scan barcode</h3><p>Point the camera at the EAN on the product</p></div><button id="scanX" class="picker-close" type="button" aria-label="Close">✕</button></div>
      <div class="scan-view"><video id="scanVideo" playsinline muted></video><div id="scanReader"></div><div class="scan-frame"></div></div>
      <p id="scanStatus" class="scan-status"></p>
      <div class="scan-manual"><input id="scanManual" type="text" inputmode="numeric" pattern="[0-9]*" enterkeyhint="go" placeholder="…or type the EAN here" autocomplete="off"><button id="scanGo" class="btn" type="button">Find</button></div></div>`;
    document.body.appendChild(el);
    $('scanX').onclick = closeScanner;
    el.onclick = e => { if (e.target === el) closeScanner(); };
    $('scanManual').addEventListener('input', e => { e.target.value = e.target.value.replace(/\D+/g, ''); });
    const go = () => { const v = $('scanManual').value; if (v) { lastScan = { code: '', t: 0 }; onScanned(v); } };
    $('scanGo').onclick = go; $('scanManual').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
  }
  $('scanManual').value = '';
  el.classList.add('open');
  startScan();
}
async function startScan() {
  stopScan();
  const v = $('scanVideo'), reader = $('scanReader');
  v.style.display = ''; reader.style.display = 'none';
  if (!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) { setScanStatus('The camera is not available here — type the EAN below.', true); return; }
  setScanStatus('Starting camera…');
  if ('BarcodeDetector' in window) {
    try {
      let formats = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39'];
      try { const sup = await window.BarcodeDetector.getSupportedFormats(); formats = formats.filter(f => sup.includes(f)); } catch (_) {}
      if (!formats.length) throw new Error('no barcode formats');
      const det = new window.BarcodeDetector({ formats });
      scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
      v.srcObject = scanStream; await v.play();
      setScanStatus('Point the camera at the barcode');
      scanTimer = setInterval(async () => {
        if (scanBusy || v.readyState < 2) return; scanBusy = true;
        try { const c = await det.detect(v); if (c[0]) onScanned(c[0].rawValue); } catch (_) {}
        scanBusy = false;
      }, 250);
      return;
    } catch (e) {
      stopScan();
      if (e && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) { setScanStatus('Camera permission is blocked. Allow camera access for this app, or type the EAN below.', true); return; }
    }
  }
  try {                                                         // fallback: scanner library
    await loadScript(SCAN_LIB);
    v.style.display = 'none'; reader.style.display = '';
    const F = window.Html5QrcodeSupportedFormats;
    html5Scanner = new window.Html5Qrcode('scanReader', { formatsToSupport: [F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E, F.CODE_128, F.CODE_39], verbose: false });
    await html5Scanner.start({ facingMode: 'environment' }, { fps: 10, qrbox: { width: 280, height: 140 } }, txt => onScanned(txt), () => {});
    setScanStatus('Point the camera at the barcode');
  } catch (e) {
    v.style.display = ''; reader.style.display = 'none';
    setScanStatus(/denied|permission|NotAllowed/i.test(String(e && (e.name || e.message || e))) ? 'Camera permission is blocked. Allow camera access, or type the EAN below.' : 'Could not start the camera — type the EAN below.', true);
  }
}
function stopScan() {
  clearInterval(scanTimer); scanTimer = null; scanBusy = false;
  if (scanStream) { scanStream.getTracks().forEach(t => t.stop()); scanStream = null; }
  const v = $('scanVideo'); if (v) { try { v.pause(); } catch (_) {} v.srcObject = null; }
  if (html5Scanner) { const h = html5Scanner; html5Scanner = null; Promise.resolve().then(() => h.stop()).catch(() => {}).finally(() => { try { h.clear(); } catch (_) {} }); }
}
function closeScanner() { stopScan(); $('scanModal')?.classList.remove('open'); }
function onScanned(raw) {
  const code = String(raw || '').replace(/\D/g, ''); if (!code) return;
  const now = Date.now(); if (code === lastScan.code && now - lastScan.t < 1800) return; lastScan = { code, t: now };
  const c = canonEan(code);
  const row = rows.find(r => canonEan(r.ean) === c);
  if (row) { closeScanner(); gotoRow(row, { search: true }); toast(`Found: ${row.name || row.ean}`); try { navigator.vibrate && navigator.vibrate(60); } catch (_) {} return; }
  const m = master.find(x => canonEan(x['EAN Code']) === c);
  if (m) { closeScanner(); addMasterSku(String(m['EAN Code']).trim()); return; }
  setScanStatus(`Barcode ${code} is not in this shop's list or the SKU Master. Scan another or type the EAN.`, true);
}
document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeScanner(); $('reviewModal')?.classList.remove('open'); } });

/* =====================================================================
   ENTRY SCREEN
   The "shell" (session bar, search, filter chips, master picker) is built
   ONCE per session. Only #entryList is rebuilt when rows / filter / page
   change, so the search box is never destroyed while someone types and the
   phone keyboard (including its numeric layout) stays open.
   ===================================================================== */
let entryFilter = 'all';
let searchMode = 'text';
try { searchMode = localStorage.getItem('eka:searchMode') === 'numeric' ? 'numeric' : 'text'; } catch (_) {}
let listSig = '';

const rowTotal = r => Number(r.stock || 0) + Number(r.tester || 0);
const matchesSearch = (r, q) => !q || String(r.ean || '').toLowerCase().includes(q) || String(r.name || '').toLowerCase().includes(q);
const matchesFilter = r => entryFilter === 'all' || (entryFilter === 'entered' ? rowTotal(r) > 0 : rowTotal(r) === 0);

// Quantity box: digits only. type=text + inputmode=numeric gives the phone's number pad
// without the quirks of type=number (e, +, -, ., scroll-wheel changes, silent '' values).
const qtyInput = (r, k) => `<input class="entry-num" data-uid="${r.uid}" data-k="${k}" type="text" inputmode="numeric" pattern="[0-9]*" enterkeyhint="next" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" maxlength="6" placeholder="0" aria-label="${k === 'stock' ? 'Stock' : 'Tester'} quantity" value="${Number(r[k]) > 0 ? Number(r[k]) : ''}">`;

function visibleSet() {
  const q = String(entrySearch || '').trim().toLowerCase();
  const filtered = rows.filter(r => !r.added && matchesSearch(r, q) && matchesFilter(r));
  const added = rows.filter(r => r.added && matchesSearch(r, q) && matchesFilter(r));
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  currentPage = Math.min(currentPage, pages);
  const start = (currentPage - 1) * PAGE_SIZE;
  return { filtered, added, pages, start, visible: filtered.slice(start, start + PAGE_SIZE) };
}

function render() { buildShell(); renderList(); }

function buildShell() {
  entryFilter = 'all';
  $('skuArea').classList.remove('hidden');
  $('skuArea').innerHTML = `
    <div class="session-bar" id="sessionBar">
      <div class="sb-row sb-top">
        <button id="backToSetup" class="btn secondary small sb-back" type="button" aria-label="Back to shop selection">←<span> Back</span></button>
        <div class="sb-store"><b>${esc(selectedStore)}</b><span id="progressText"></span></div>
        <div class="sb-timer" id="sessionTimer" role="timer" aria-label="Session time left"><span class="sb-timer-ic" aria-hidden="true">⏱</span><span class="sb-timer-txt"><strong id="timerText">15:00</strong><small>left</small></span></div>
      </div>
      <div class="sb-row sb-actions">
        <button id="saveDraftBtn" class="btn secondary" type="button">💾 Save Draft</button>
        <button id="submitEntryTop" class="btn" type="button" ${rows.length ? '' : 'disabled'}>Submit Stock</button>
      </div>
      <div class="sb-save" id="saveState"></div>
      <div class="sb-progress" aria-hidden="true"><i id="timerBar"></i></div>
    </div>
    <div class="timer-prompt hidden" id="timerPrompt" role="alert">
      <div><b>⏱ <span id="timerPromptTime">3 minutes</span> left</b><span>Save your counts as a draft so you never have to punch them again.</span></div>
      <div class="timer-prompt-actions"><button id="tpSave" class="btn small" type="button">Save Draft</button><button id="tpClose" class="btn secondary small" type="button" aria-label="Dismiss">✕</button></div>
    </div>
    <div class="entry-search-sort">
      <div class="entry-search-wrap">
        <span aria-hidden="true">⌕</span>
        <input id="entrySearch" type="text" inputmode="${searchMode === 'numeric' ? 'numeric' : 'text'}" enterkeyhint="search" value="${esc(entrySearch)}" placeholder="Search EAN / SKU / Product name…" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" aria-label="Search EAN, SKU or product name">
        <button id="clearSearch" class="search-clear ${entrySearch ? '' : 'hidden'}" type="button" aria-label="Clear search">✕</button>
        <button id="scanBtn" class="scan-btn" type="button" aria-label="Scan barcode with camera">📷<span> Scan</span></button>
        <button id="kbToggle" class="kb-toggle" type="button" title="Switch between number pad and normal keyboard">${searchMode === 'numeric' ? 'ABC' : '123'}</button>
      </div>
    </div>
    <div class="entry-chips" id="entryChips">
      <button class="chip active" data-f="all" type="button">All <b id="cntAll">0</b></button>
      <button class="chip" data-f="entered" type="button">Entered <b id="cntEntered">0</b></button>
      <button class="chip" data-f="pending" type="button">Not entered <b id="cntPending">0</b></button>
      <button id="nextUncounted" class="chip chip-next" type="button">Next uncounted ↓</button>
      <button id="sortToggle" class="chip chip-sort" type="button" title="Choose how the list is ordered"></button>
      <button id="addSku" class="link-btn chip-add" type="button">+ Add SKU from Master</button>
    </div>
    <div class="master-picker hidden" id="masterPicker">
      <div class="master-picker-head"><b>Add SKU From Master</b><button id="closeMaster" class="picker-close" type="button" aria-label="Close">✕</button></div>
      <input id="masterSearch" class="master-search" type="text" inputmode="${searchMode === 'numeric' ? 'numeric' : 'text'}" placeholder="Search EAN / SKU / Product name…" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">
      <div id="masterResults" class="master-results"></div>
    </div>
    <div id="entryList"></div>`;

  /* ---- search: update ONLY the list, never the input ---- */
  const search = $('entrySearch'), clear = $('clearSearch'), kb = $('kbToggle');
  let searchTimer = null;
  search.addEventListener('input', () => {
    entrySearch = search.value; currentPage = 1;
    clear.classList.toggle('hidden', !entrySearch);
    clearTimeout(searchTimer); searchTimer = setTimeout(renderList, 120);
  });
  search.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); search.blur(); } });
  clear.addEventListener('pointerdown', e => e.preventDefault());      // keep the keyboard open
  clear.addEventListener('click', () => { search.value = ''; entrySearch = ''; currentPage = 1; clear.classList.add('hidden'); renderList(); search.focus(); });

  /* Number pad <-> normal keyboard toggle that does not close the keyboard. */
  kb.addEventListener('pointerdown', e => e.preventDefault());
  kb.addEventListener('click', () => {
    searchMode = searchMode === 'numeric' ? 'text' : 'numeric';
    try { localStorage.setItem('eka:searchMode', searchMode); } catch (_) {}
    kb.textContent = searchMode === 'numeric' ? 'ABC' : '123';
    [search, $('masterSearch')].forEach(el => el.setAttribute('inputmode', searchMode === 'numeric' ? 'numeric' : 'text'));
    const target = document.activeElement === $('masterSearch') ? $('masterSearch') : search;
    target.blur(); target.focus();                                       // re-ask the OS for the right keyboard layout
  });

  $('entryChips').addEventListener('click', e => {
    const c = e.target.closest('.chip[data-f]'); if (!c) return;
    entryFilter = c.dataset.f; currentPage = 1;
    document.querySelectorAll('#entryChips .chip[data-f]').forEach(x => x.classList.toggle('active', x === c));
    renderList();
  });

  const paintSort = () => { $('sortToggle').textContent = sortMode === 'total' ? 'Order: Highest total' : 'Order: Catalogue'; };
  paintSort();
  $('sortToggle').onclick = () => { sortMode = sortMode === 'total' ? 'stable' : 'total'; try { localStorage.setItem('eka:sortMode', sortMode); } catch (_) {} paintSort(); applyOrder(); currentPage = 1; renderList(); };
  $('nextUncounted').onclick = nextUncounted;
  $('scanBtn').onclick = openScanner;
  $('backToSetup').onclick = showSetup;
  $('addSku').onclick = openMasterPicker;
  $('closeMaster').onclick = closeMasterPicker;
  $('masterSearch').addEventListener('input', renderMasterResults);
  $('saveDraftBtn').onclick = () => saveDraft(true);
  $('submitEntryTop').onclick = submitAll;
  $('tpSave').onclick = () => { saveDraft(true); $('timerPrompt').classList.add('hidden'); };
  $('tpClose').onclick = () => $('timerPrompt').classList.add('hidden');

  /* ---- quantity boxes: delegated, so they survive list re-renders ---- */
  const list = $('entryList');
  list.addEventListener('input', onQtyInput);
  list.addEventListener('focusin', e => {
    if (!e.target.classList || !e.target.classList.contains('entry-num')) return;
    clearTimeout(entrySortTimer); lastTouchedUid = e.target.dataset.uid;
    // Tap = select the old value so typing overwrites it. Only if this box STILL has focus:
    // select() can pull focus back to a stale box, which makes focus ping-pong and mis-routes keystrokes.
    const x = e.target, v0 = x.value;
    setTimeout(() => { if (document.activeElement === x && x.value === v0) { try { x.select(); } catch (_) {} } }, 0);   // never after typing has begun
  });
  list.addEventListener('focusout', e => {
    if (!e.target.classList || !e.target.classList.contains('entry-num')) return;
    // Re-sort only once the user has finished with the quantity boxes, and only if the order really changed.
    clearTimeout(entrySortTimer);
    entrySortTimer = setTimeout(() => {
      const a = document.activeElement;
      if (a && a.classList && a.classList.contains('entry-num')) return;
      if (sortMode !== 'total') return;                      // catalogue order never moves under the user's thumb
      applyOrder();
      if (listSignature() !== listSig) renderList();
    }, 180);
  });
  list.addEventListener('keydown', e => {
    if (e.key !== 'Enter' || !e.target.classList || !e.target.classList.contains('entry-num')) return;
    e.preventDefault();                                                    // Enter / "Next" jumps to the next box
    const all = [...list.querySelectorAll('.entry-num')].filter(el => el.offsetParent !== null);
    const nx = all[all.indexOf(e.target) + 1];
    if (nx) nx.focus(); else e.target.blur();
  });
  list.addEventListener('click', e => {
    const t = e.target;
    if (t.closest('#prevPage')) { if (currentPage > 1) { currentPage--; renderList(true); } return; }
    if (t.closest('#nextPage')) { currentPage++; renderList(true); return; }
    const ah = t.closest('#toggleAddedSkus');
    if (ah) {
      const l = $('addedSkuList'), ch = $('addedSkuChevron'), open = !l.classList.contains('collapsed');
      l.classList.toggle('collapsed', open); ah.setAttribute('aria-expanded', String(!open)); if (ch) ch.textContent = open ? '⌄' : '⌃'; return;
    }
    const th = t.closest('[data-toggle-added]');
    if (th) { const body = $('added-body-' + th.dataset.toggleAdded); if (body) { const closed = body.classList.toggle('collapsed'); th.querySelector('strong').textContent = closed ? '⌄' : '⌃'; } }
  });
}

function listSignature() {
  const v = visibleSet();
  return v.visible.map(r => r.uid).join(',') + '|' + v.added.map(r => r.uid).join(',') + '|' + v.filtered.length + '|' + currentPage;
}

function onQtyInput(e) {
  const x = e.target;
  if (!x.classList || !x.classList.contains('entry-num')) return;
  const clean = x.value.replace(/\D+/g, '').replace(/^0+(?=\d)/, '');     // digits only, no leading zeros
  if (clean !== x.value) x.value = clean;
  const row = rows.find(r => String(r.uid) === String(x.dataset.uid));
  if (!row) return;
  row[x.dataset.k] = clean === '' ? 0 : parseInt(clean, 10);
  // The table and the phone cards both exist in the DOM; keep the hidden twin in sync.
  document.querySelectorAll(`.entry-num[data-uid="${row.uid}"][data-k="${x.dataset.k}"]`).forEach(o => { if (o !== x) o.value = clean; });
  const total = rowTotal(row);
  document.querySelectorAll(`[data-total-for="${row.uid}"]`).forEach(el => { el.textContent = total; });
  document.querySelectorAll(`[data-row="${row.uid}"]`).forEach(el => el.classList.toggle('has-qty', total > 0));
  updateSummary();
  markDirty();
}

function renderList(scrollTop) {
  const list = $('entryList'); if (!list) return;
  const { filtered, added, pages, start, visible } = visibleSet();
  listSig = listSignature();
  list.innerHTML = `
    <div class="entry-page-note">Showing <b>${filtered.length ? start + 1 : 0}–${Math.min(start + PAGE_SIZE, filtered.length)}</b> of <b>${filtered.length}</b> matching SKUs${entrySearch || entryFilter !== 'all' ? ` • ${rows.length} total` : ''} ${sortMode === 'total' ? ' • highest Total first' : ''}</div>
    <div class="entry-table-wrap"><table class="entry-table"><thead><tr><th>EAN / SKU</th><th>Product</th><th>Stock</th><th>Tester</th><th>Total</th></tr></thead><tbody>
    ${visible.map(r => `<tr data-row="${r.uid}" class="${rowTotal(r) > 0 ? 'has-qty' : ''}"><td>${esc(r.ean)}</td><td>${esc(r.name)}</td><td>${qtyInput(r, 'stock')}</td><td>${qtyInput(r, 'tester')}</td><td class="total-cell" data-total-for="${r.uid}">${rowTotal(r)}</td></tr>`).join('')}
    ${visible.length ? '' : `<tr><td colspan="5" class="entry-empty-row">No SKU matches your search.</td></tr>`}
    </tbody></table></div>
    <div class="entry-mobile-list">
      ${visible.map(r => `<article class="sku-entry-card ${rowTotal(r) > 0 ? 'has-qty' : ''}" data-row="${r.uid}">
        <div class="sku-card-top"><div class="sku-card-thumb">R</div><div class="sku-card-info"><b>${esc(r.name || 'Unnamed Product')}</b><span>SKU / EAN: ${esc(r.ean || '—')}</span></div><div class="sku-card-total"><small>Total</small><strong data-total-for="${r.uid}">${rowTotal(r)}</strong></div></div>
        <div class="sku-card-inputs"><label><span>Stock</span>${qtyInput(r, 'stock')}</label><label><span>Tester</span>${qtyInput(r, 'tester')}</label></div>
      </article>`).join('')}
      ${visible.length ? '' : `<div class="entry-mobile-empty">No SKU matches your search.</div>`}
    </div>
    ${added.length ? `<section class="added-sku-section" id="addedSkuSection">
        <button type="button" class="added-sku-header" id="toggleAddedSkus" aria-expanded="true">
          <span><b>Added SKUs</b><small>${added.length} SKU(s) added from Master</small></span><strong id="addedSkuChevron">⌃</strong>
        </button>
        <div class="added-sku-list" id="addedSkuList">
          ${added.map(r => `<article class="added-sku-item ${rowTotal(r) > 0 ? 'has-qty' : ''}" data-added-uid="${r.uid}" data-row="${r.uid}">
              <button type="button" class="added-sku-item-head" data-toggle-added="${r.uid}"><span><b>${esc(r.name || 'Unnamed Product')}</b><small>${esc(r.ean || '—')} • Total <span data-total-for="${r.uid}">${rowTotal(r)}</span></small></span><strong>⌃</strong></button>
              <div class="added-sku-item-body" id="added-body-${r.uid}">
                <div class="added-sku-inputs"><label>Stock${qtyInput(r, 'stock')}</label><label>Tester${qtyInput(r, 'tester')}</label></div>
              </div>
            </article>`).join('')}
        </div>
      </section>` : ''}
    <div class="entry-pagination">
      <button class="btn secondary small" id="prevPage" type="button" ${currentPage <= 1 ? 'disabled' : ''}>← Previous</button>
      <span>Page <b>${currentPage}</b> of <b>${pages}</b></span>
      <button class="btn secondary small" id="nextPage" type="button" ${currentPage >= pages ? 'disabled' : ''}>Next →</button>
    </div>`;
  renderMasterResults();
  updateSummary();
  if (scrollTop) { const bar = $('sessionBar'); if (bar) window.scrollTo({ top: Math.max(0, list.getBoundingClientRect().top + window.scrollY - bar.offsetHeight - 70), behavior: 'smooth' }); }
}

function openMasterPicker() {
  $('masterPicker').classList.remove('hidden');
  $('masterSearch').value = '';
  renderMasterResults();
  $('masterSearch').focus();
}
function closeMasterPicker() { $('masterPicker').classList.add('hidden'); }

function renderMasterResults() {
  const q = ($('masterSearch')?.value || '').trim().toLowerCase();
  const existing = new Set(rows.map(r => String(r.ean).trim().toLowerCase()));
  const options = master.filter(m => {
    const ean = String(m['EAN Code'] ?? '').trim();
    const name = String(m['Product Name'] ?? '');
    return ean && !existing.has(ean.toLowerCase()) && (!q || ean.toLowerCase().includes(q) || name.toLowerCase().includes(q));
  });
  const box = $('masterResults');
  if (!box) return;
  if (!options.length) { box.innerHTML = '<div class="master-empty">No new SKU found in SKU Master.</div>'; return; }
  box.innerHTML = options.slice(0, 100).map(m => `<button class="master-option" type="button" data-ean="${esc(m['EAN Code'])}"><span><b>${esc(m['EAN Code'])}</b><small>${esc(m['Product Name'])}</small></span><span>＋</span></button>`).join('');
  box.querySelectorAll('.master-option').forEach(b => b.onclick = () => addMasterSku(b.dataset.ean));
}

function addMasterSku(ean) {
  const found = master.find(m => String(m['EAN Code']).trim() === String(ean).trim());
  if (!found) return;
  if (rows.some(r => String(r.ean).trim() === String(ean).trim())) { toast('SKU is already in the table.'); return; }
  const row = { uid: uidSeed++, idx: orderSeed++, ean: String(found['EAN Code']).trim(), name: String(found['Product Name'] || ''), stock: 0, tester: 0, added: true };
  rows.push(row);
  // Make sure the new row is visible, then jump straight to its Stock box.
  entrySearch = ''; entryFilter = 'all'; currentPage = 1;
  const s = $('entrySearch'); if (s) s.value = '';
  $('clearSearch')?.classList.add('hidden');
  document.querySelectorAll('#entryChips .chip[data-f]').forEach(c => c.classList.toggle('active', c.dataset.f === 'all'));
  closeMasterPicker();
  renderList();
  markDirty();
  const item = document.querySelector(`[data-added-uid="${row.uid}"]`);
  if (item) { item.scrollIntoView({ block: 'center', behavior: 'smooth' }); const inp = item.querySelector('.entry-num'); if (inp) inp.focus({ preventScroll: true }); }
  toast(`${row.name || 'SKU'} added — punch its quantity below.`);
}

async function deliverGeneratedPdf(doc, filename) {
  // Native CORMATE app: stream the PDF to Android in small chunks so large
  // reports do not hit Android's Binder transaction limit.
  if (window.Android && typeof window.Android.beginPdf === 'function' && typeof window.Android.appendPdfChunk === 'function' && typeof window.Android.finishPdf === 'function') {
    try {
      const bytes = new Uint8Array(doc.output('arraybuffer'));
      window.Android.beginPdf(filename);
      const chunkSize = 48 * 1024;
      for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        const chunk = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length));
        let binary = '';
        const step = 0x8000;
        for (let i = 0; i < chunk.length; i += step) {
          binary += String.fromCharCode(...chunk.subarray(i, Math.min(i + step, chunk.length)));
        }
        window.Android.appendPdfChunk(btoa(binary));
      }
      const ok = window.Android.finishPdf();
      if (ok !== false) {
        msg(`PDF saved to Downloads: ${filename}`, true);
        return true;
      }
    } catch (e) {
      console.warn('Native PDF save failed', e);
      msg('Could not save the PDF inside the app. Opening the mobile share option instead.', false);
    }
  }

  // Normal mobile/desktop browser path.
  try {
    doc.save(filename);
    return true;
  } catch (e) {
    console.warn('Direct PDF download failed', e);
  }

  // Last-resort mobile browser fallback: offer the generated file through the
  // native share sheet where supported.
  try {
    const blob = doc.output('blob');
    const file = new File([blob], filename, { type: 'application/pdf' });
    if (navigator.share && (!navigator.canShare || navigator.canShare({ files: [file] }))) {
      await navigator.share({ title: filename, files: [file] });
      return true;
    }
  } catch (e) {
    console.warn('PDF share fallback failed', e);
  }
  msg('PDF generated, but this browser blocked the download. Please use the Share/Save option if shown.', false);
  return false;
}

function downloadSubmissionPdf() {
  if (!lastSubmission || !lastSubmission.rows.length) return;
  if (!window.jspdf) { msg('PDF library failed to load. Check your internet connection and try again.', false); return; }
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const marginX = 14;
  let y = 18;

  doc.setFont('helvetica', 'bold'); doc.setFontSize(15); doc.setTextColor(23, 32, 51);
  doc.text('RENEE • E.K.A.', marginX, y);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(100, 116, 139);
  doc.text('FIELD STOCK ENTRY', marginX, y + 5);

  doc.setFont('helvetica', 'bold'); doc.setFontSize(17); doc.setTextColor(23, 32, 51);
  doc.text('Stock Verification Report', pageWidth - marginX, y, { align: 'right' });
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(100, 116, 139);
  doc.text('Generated from field stock submission', pageWidth - marginX, y + 5, { align: 'right' });

  y += 12;
  doc.setDrawColor(217, 225, 236); doc.line(marginX, y, pageWidth - marginX, y);
  y += 8;

  const ts = lastSubmission.timestamp;
  const dateStr = ts.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  const timeStr = ts.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
  const pdfRows = lastSubmission.rows.filter(r => Number(r.total || 0) > 0);
  if (!pdfRows.length) { msg('No Stock / Tester quantity was entered, so there is nothing to put in the Stock Verification PDF.', false); return; }
  const totalStock = pdfRows.reduce((a, r) => a + r.stock, 0);
  const totalTester = pdfRows.reduce((a, r) => a + r.tester, 0);
  const totalQty = totalStock + totalTester;

  const details = [
    ['Entry No.', lastSubmission.entryNo || '—'],
    ['Shop / Store', lastSubmission.store],
    ['Submitted By', lastSubmission.email],
    ['Date & Time', `${dateStr}, ${timeStr}`],
    ['SKUs Submitted', String(pdfRows.length)]
  ];
  doc.setFontSize(9.5);
  details.forEach((d, i) => {
    const col = i % 2, row = Math.floor(i / 2);
    const x = marginX + col * 92;
    const yy = y + row * 7;
    doc.setFont('helvetica', 'bold'); doc.setTextColor(71, 85, 105); doc.text(d[0] + ':', x, yy);
    doc.setFont('helvetica', 'normal'); doc.setTextColor(23, 32, 51); doc.text(String(d[1]), x + 34, yy);
  });
  y += Math.ceil(details.length / 2) * 7 + 6;

  doc.autoTable({
    startY: y,
    margin: { left: marginX, right: marginX, bottom: 26 },
    head: [['#', 'EAN / SKU Code', 'Product Name', 'Stock Qty', 'Tester Qty', 'Total Qty']],
    body: pdfRows.map((r, i) => [i + 1, r.ean, r.name, r.stock, r.tester, r.total]),
    foot: [['', '', 'Total', totalStock, totalTester, totalQty]],
    styles: { font: 'helvetica', fontSize: 9, cellPadding: 2.6, textColor: [30, 41, 59], lineColor: [217, 225, 236], lineWidth: 0.1 },
    headStyles: { fillColor: [23, 32, 51], textColor: 255, fontStyle: 'bold', fontSize: 8.5 },
    footStyles: { fillColor: [241, 245, 249], textColor: [15, 23, 42], fontStyle: 'bold' },
    alternateRowStyles: { fillColor: [248, 250, 252] },
    columnStyles: { 0: { cellWidth: 9, halign: 'center' }, 3: { halign: 'right', cellWidth: 22 }, 4: { halign: 'right', cellWidth: 22 }, 5: { halign: 'right', cellWidth: 24 } }
  });

  let finalY = doc.lastAutoTable.finalY + 16;
  if (finalY > pageHeight - 40) { doc.addPage(); finalY = 24; }

  doc.setDrawColor(148, 163, 184);
  doc.line(marginX, finalY, marginX + 62, finalY);
  doc.line(pageWidth - marginX - 62, finalY, pageWidth - marginX, finalY);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(71, 85, 105);
  doc.text('BA Signature', marginX, finalY + 5);
  doc.text('Store Manager Signature', pageWidth - marginX - 62, finalY + 5);

  const pageCount = doc.internal.getNumberOfPages();
  for (let p = 1; p <= pageCount; p++) {
    doc.setPage(p);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(148, 163, 184);
    doc.text('Generated by RENEE • E.K.A. Field Entry', marginX, pageHeight - 10);
    doc.text(`Page ${p} of ${pageCount}`, pageWidth - marginX, pageHeight - 10, { align: 'right' });
  }

  const safeStore = String(lastSubmission.store).replace(/[^a-z0-9]+/gi, '_');
  deliverGeneratedPdf(doc, `Stock_Verification_${safeStore}_${ts.toISOString().slice(0, 10)}.pdf`);
}

async function downloadVariancePdf() {
  if (!lastSubmission || !lastSubmission.reportRows || !lastSubmission.reportRows.length) {
    msg('Variance PDF data is not available. Please submit again or refresh the page.', false);
    return;
  }
  if (!window.jspdf) { msg('PDF library failed to load. Check your internet connection and try again.', false); return; }
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'landscape' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const marginX = 10;
  let y = 14;
  const data = lastSubmission.reportRows;
  const sum = key => data.reduce((a, r) => a + Number(r[key] || 0), 0);

  doc.setFont('helvetica', 'bold'); doc.setFontSize(15); doc.setTextColor(23,32,51);
  doc.text('RENEE', marginX, y); doc.setTextColor(37,99,235); doc.text(' • E.K.A.', marginX + 21, y);
  doc.setFont('helvetica','bold'); doc.setFontSize(16); doc.setTextColor(23,32,51); doc.text('Variance Analysis Report', pageWidth-marginX, y, {align:'right'});
  y += 7; doc.setFont('helvetica','normal'); doc.setFontSize(8); doc.setTextColor(100,116,139);
  doc.text(`Entry No.: ${lastSubmission.entryNo || '—'}   |   Store: ${lastSubmission.store}   |   Submitted By: ${lastSubmission.email}`, marginX, y);
  doc.text(`Date: ${lastSubmission.timestamp.toLocaleDateString('en-IN')}`, pageWidth-marginX, y, {align:'right'});
  y += 7; doc.setDrawColor(217,225,236); doc.line(marginX,y,pageWidth-marginX,y); y += 6;

  const totals = [
    ['Opening', sum('Opening Stock')], ['Inward', sum('Inward')], ['Tertiary', sum('Tertiary')],
    ['System Closing', sum('System Stock')], ['Physical Stock', sum('Physical Stock')], ['Variance', sum('Variance')]
  ];
  let tx=marginX;
  totals.forEach(([label,val])=>{ doc.setFont('helvetica','bold'); doc.setFontSize(8); doc.setTextColor(71,85,105); doc.text(label,tx,y); doc.setFontSize(11); doc.setTextColor(23,32,51); doc.text(String(Math.round(val)),tx,y+5); tx+=44; });
  y += 12;

  doc.autoTable({
    startY:y, margin:{left:marginX,right:marginX,bottom:15},
    head:[['#','EAN / SKU','Product Name','Opening','Inward','Tertiary','Movement Closing','System Stock','Physical Stock','Variance']],
    body:data.map((r,i)=>[i+1,r['EAN Code'],r['Product Name'],Math.round(r['Opening Stock']),Math.round(r['Inward']),Math.round(r['Tertiary']),Math.round(r['Movement Closing']),Math.round(r['System Stock']),Math.round(r['Physical Stock']),Math.round(r['Variance'])]),
    foot:[['','','TOTAL',Math.round(sum('Opening Stock')),Math.round(sum('Inward')),Math.round(sum('Tertiary')),Math.round(sum('Movement Closing')),Math.round(sum('System Stock')),Math.round(sum('Physical Stock')),Math.round(sum('Variance'))]],
    styles:{font:'helvetica',fontSize:7,cellPadding:1.8,textColor:[30,41,59],lineColor:[217,225,236],lineWidth:.1},
    headStyles:{fillColor:[23,32,51],textColor:255,fontStyle:'bold',fontSize:7},
    footStyles:{fillColor:[241,245,249],textColor:[15,23,42],fontStyle:'bold'},
    alternateRowStyles:{fillColor:[248,250,252]},
    columnStyles:{0:{cellWidth:7,halign:'center'},1:{cellWidth:25,halign:'center'},2:{cellWidth:68},3:{halign:'center',cellWidth:17},4:{halign:'center',cellWidth:17},5:{halign:'center',cellWidth:17},6:{halign:'center',cellWidth:21},7:{halign:'center',cellWidth:19},8:{halign:'center',cellWidth:19},9:{halign:'center',cellWidth:18}}
  });
  const pages=doc.internal.getNumberOfPages();
  for(let p=1;p<=pages;p++){doc.setPage(p);doc.setFont('helvetica','normal');doc.setFontSize(7);doc.setTextColor(148,163,184);doc.text('Generated by RENEE • E.K.A. Field Entry',marginX,pageHeight-7);doc.text(`Page ${p} of ${pages}`,pageWidth-marginX,pageHeight-7,{align:'right'});}
  const safeStore=String(lastSubmission.store).replace(/[^a-z0-9]+/gi,'_');
  await deliverGeneratedPdf(doc, `Variance_Analysis_${safeStore}_${lastSubmission.timestamp.toISOString().slice(0,10)}.pdf`);
}


$('email').addEventListener('blur', loadMeta);
$('email').addEventListener('keydown', e => { if (e.key === 'Enter') loadMeta(); });

// The authenticated session already contains the user's email.
// Fetch its mapped shops automatically; no second email confirmation is required.
if ($('email') && $('email').value.trim()) {
  loadMeta();
}
$('store').onchange = () => { selectedStore=$('store').value||''; $('continueEntry').disabled=!selectedStore; paintDraftBanner(); loadLastSubmissions(); };
$('continueEntry').onclick = loadSku;
$('syncData').onclick = syncData;

updateSummary();
showSetup();
paintOutbox(); flushOutbox();     // anything left in the offline queue from an earlier session goes out now

// Sign-out: push the latest draft first, then drop device copies the server already holds (shared phones).
document.addEventListener('click', async e => {
  const a = e.target.closest && e.target.closest('a[href="/logout"]'); if (!a) return;
  e.preventDefault();
  try { flushDraft(); if (serverDirty) await Promise.race([pushDraft(), _wait(3500)]); } catch (_) {}
  try {
    Object.keys(localStorage).filter(k => k.startsWith('eka:draft:v1:')).forEach(k => {
      try { const d = JSON.parse(localStorage.getItem(k)); if (!d || d.synced) localStorage.removeItem(k); } catch (_) { localStorage.removeItem(k); }
    });
  } catch (_) {}
  location.href = a.href;
});


/* ===== iOS Home Screen instructions ===== */
(function(){
  const modal=document.getElementById('iosInstallModal');
  const btn=document.getElementById('iosInstallBtnEntry');
  if(!modal) return;
  const open=()=>{modal.classList.add('open');modal.setAttribute('aria-hidden','false');document.body.classList.add('app-install-open');};
  const close=()=>{modal.classList.remove('open');modal.setAttribute('aria-hidden','true');document.body.classList.remove('app-install-open');};
  if(btn) btn.addEventListener('click',open);
  modal.querySelectorAll('[data-close-ios]').forEach(x=>x.addEventListener('click',close));
  document.addEventListener('keydown',e=>{if(e.key==='Escape') close();});
})();

/* Dashboard sidebar */
(function(){
  const navs=document.querySelectorAll('.sidebar .nav[data-page]');
  const pages={stock:document.getElementById('page-stock'),inward:document.getElementById('page-inward'),dashboard:document.getElementById('page-dashboard')};
  function openPage(name){
    if(name==='inward' && !document.querySelector('.sidebar .nav[data-page="inward"]:not([disabled])')) return;
    Object.keys(pages).forEach(k=>{if(pages[k]) pages[k].classList.toggle('hidden',k!==name);});
    navs.forEach(n=>n.classList.toggle('active',n.dataset.page===name));
  }
  navs.forEach(n=>n.addEventListener('click',()=>openPage(n.dataset.page)));
})();
