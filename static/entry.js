let email = '', stores = [], selectedStore = '', master = [], rows = [];
let submissionHistory = [];
let lastSubmission = null;
let pendingEntryNo = '';   // reused if a submit has to be retried, so the server can ignore the duplicate
let currentPage = 1;
const PAGE_SIZE = 25;
let entrySearch = '';
let uidSeed = 1;
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
  const isGet = !options.method || String(options.method).toUpperCase() === 'GET';
  const tries = isGet ? 3 : 1;
  let lastErr;
  for (let i = 0; i < tries; i++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), isGet ? 45000 : 90000);
    try {
      const r = await fetch(url, { cache: 'no-store', ...options, signal: ctl.signal });
      clearTimeout(timer);
      if (r.status === 401) { location.href = '/login'; throw Error('Your session expired. Please sign in again.'); }
      let j;
      try { j = await r.json(); }
      catch (_) {
        if ([502, 503, 504].includes(r.status) && i < tries - 1) { await _wait(1500 * (i + 1)); continue; }
        throw Error([502, 503, 504].includes(r.status) ? 'The server is starting up or busy. Please try again in a moment.' : `Server returned HTTP ${r.status}`);
      }
      if (!r.ok || !j.ok) throw Error(j.error || `Request failed (${r.status})`);
      return j;
    } catch (e) {
      clearTimeout(timer);
      const transient = e.name === 'AbortError' || e instanceof TypeError;
      lastErr = e.name === 'AbortError'
        ? Error(isGet ? 'The server is taking too long to respond. Please try again.' : 'The server did not confirm in time. Check "My Submission History" before submitting again.')
        : (e instanceof TypeError ? Error('Network problem — check your connection and try again.') : e);
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

async function loadSku() {
  selectedStore=$('store').value||selectedStore; if(!selectedStore) return;
  pendingEntryNo='';
  const button=$('continueEntry'); if(button){button.disabled=true;button.textContent='Loading…';}
  setEntryLoading(true,'Loading SKU Entry',`Preparing ${selectedStore}…`);
  try {
    const j=await getJson('/api/entry-meta?email='+encodeURIComponent(email)+'&store='+encodeURIComponent(selectedStore)+'&_ts='+Date.now());
    master=j.master_skus||master; const available=j.available_skus||[];
    rows=available.map(x=>({uid:uidSeed++,ean:String(x['EAN Code']??'').trim(),name:String(x['Product Name']??''),stock:0,tester:0,added:false})); entrySearch=''; currentPage=1; entryStep=2;
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

function sortRowsByTotal() {
  rows.sort((a, b) => {
    const totalDiff = (Number(b.stock || 0) + Number(b.tester || 0)) - (Number(a.stock || 0) + Number(a.tester || 0));
    if (totalDiff) return totalDiff;
    return String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' });
  });
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
   DRAFT (auto-save) + 15-MINUTE SESSION TIMER
   Quantities are saved on this device (localStorage) as the user types, keyed by
   signed-in email + shop, and restored when they come back to the same shop.
   The draft is removed only after a successful final submit.
   ===================================================================== */
const SESSION_SECONDS = 15 * 60;       // timer length
const WARN_SECONDS = 3 * 60;           // "save a draft" prompt appears with this much time left
const DRAFT_TTL_MS = 72 * 3600 * 1000; // drafts older than this are ignored
let sessionDeadline = 0, sessionTick = null, warned = false, expired = false;
let draftTimer = null, dirty = false, lastSavedAt = null, storageOk = true;

const draftKey = () => `eka:draft:v1:${email}|${selectedStore}`;
const fmtClock = ms => new Date(ms).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

function toast(text) {
  let el = $('entryToast');
  if (!el) { el = document.createElement('div'); el.id = 'entryToast'; el.className = 'entry-toast'; el.setAttribute('role', 'status'); document.body.appendChild(el); }
  el.textContent = text; el.classList.add('show');
  clearTimeout(el._t); el._t = setTimeout(() => el.classList.remove('show'), 3000);
}

function readDraft() {
  if (!email || !selectedStore) return null;
  try {
    const raw = localStorage.getItem(draftKey()); if (!raw) return null;
    const d = JSON.parse(raw);
    if (!d || !Array.isArray(d.items)) return null;
    if (Date.now() - Number(d.savedAt || 0) > DRAFT_TTL_MS) { localStorage.removeItem(draftKey()); return null; }
    return d;
  } catch (_) { return null; }
}
const draftStats = d => {
  const items = (d && d.items || []).filter(i => Number(i.s) > 0 || Number(i.t) > 0);
  return { skus: items.length, qty: items.reduce((a, i) => a + (Number(i.s) || 0) + (Number(i.t) || 0), 0) };
};

function saveDraft(manual) {
  if (entryStep !== 2 || !email || !selectedStore) return;
  clearTimeout(draftTimer);
  try {
    const items = rows.filter(r => rowTotal(r) > 0 || r.added).map(r => ({ e: r.ean, n: r.name, s: Number(r.stock) || 0, t: Number(r.tester) || 0, a: r.added ? 1 : 0 }));
    if (!items.some(i => i.s > 0 || i.t > 0)) { localStorage.removeItem(draftKey()); lastSavedAt = null; }
    else { const savedAt = Date.now(); localStorage.setItem(draftKey(), JSON.stringify({ v: 1, savedAt, entryNo: pendingEntryNo, items })); lastSavedAt = savedAt; }
    storageOk = true; dirty = false;
  } catch (_) { storageOk = false; }
  paintSaveState();
  if (manual) {
    const s = draftStats({ items: rows.map(r => ({ s: r.stock, t: r.tester })) });
    if (!storageOk) toast('Could not save the draft on this device. Please submit before closing.');
    else if (!s.skus) toast('Nothing to save yet — enter a quantity first.');
    else toast(`Draft saved • ${s.skus} SKU • ${s.qty.toLocaleString('en-IN')} Qty. You can leave and resume later.`);
    const b = $('saveDraftBtn');
    if (b && storageOk && s.skus) { b.textContent = '✓ Saved'; b.classList.add('flash'); setTimeout(() => { b.textContent = '💾 Save Draft'; b.classList.remove('flash'); }, 1600); }
  }
}
function clearDraft() {
  clearTimeout(draftTimer); dirty = false; lastSavedAt = null;
  try { localStorage.removeItem(draftKey()); } catch (_) {}
  paintSaveState();
}
function markDirty() {
  dirty = true; paintSaveState();
  clearTimeout(draftTimer); draftTimer = setTimeout(() => saveDraft(false), 600);   // debounced auto-save
}
function flushDraft() { if (entryStep === 2 && dirty) saveDraft(false); }
function paintSaveState() {
  const el = $('saveState'); if (!el) return;
  if (!storageOk) { el.className = 'sb-save err'; el.innerHTML = '<i></i>Can’t save a draft on this device — submit before closing'; return; }
  el.className = 'sb-save' + (dirty ? ' saving' : lastSavedAt ? ' saved' : '');
  el.innerHTML = dirty ? '<i></i>Saving draft…' : lastSavedAt ? `<i></i>Draft auto-saved • ${fmtClock(lastSavedAt)}` : '<i></i>Auto-save is on — counts are kept on this device as you type';
}

// Put saved quantities back onto the freshly loaded SKU list.
function applyDraft() {
  const d = readDraft(); if (!d) return 0;
  const byEan = new Map(rows.map(r => [String(r.ean).trim(), r]));
  d.items.forEach(it => {
    const ean = String(it.e || '').trim(); if (!ean) return;
    let r = byEan.get(ean);
    if (!r) { r = { uid: uidSeed++, ean, name: String(it.n || ''), stock: 0, tester: 0, added: true }; rows.push(r); byEan.set(ean, r); }
    r.stock = Math.max(0, parseInt(it.s, 10) || 0); r.tester = Math.max(0, parseInt(it.t, 10) || 0);
  });
  pendingEntryNo = d.entryNo || '';
  lastSavedAt = d.savedAt || null;
  sortRowsByTotal();
  return draftStats(d).skus;
}

// Banner on the shop-selection screen.
function paintDraftBanner() {
  const b = $('draftBanner'), btn = $('continueEntry'); if (!b) return;
  const d = readDraft(), s = draftStats(d);
  if (!d || !s.skus) { b.classList.add('hidden'); b.innerHTML = ''; if (btn) btn.textContent = 'Continue to SKU Entry →'; return; }
  b.classList.remove('hidden');
  b.innerHTML = `<div><b>💾 Saved draft found for ${esc(selectedStore)}</b><span>${s.skus} SKU • ${s.qty.toLocaleString('en-IN')} Qty • saved ${esc(fmtWhen(d.savedAt))}</span></div><button class="btn secondary small" id="discardDraft" type="button">Discard</button>`;
  if (btn) btn.textContent = 'Resume Draft →';
  $('discardDraft').onclick = () => { if (confirm('Discard the saved draft? The quantities you punched will be lost.')) { clearDraft(); paintDraftBanner(); } };
}

/* ---------- 15-minute session timer ---------- */
function startSession() {
  sessionDeadline = Date.now() + SESSION_SECONDS * 1000; warned = false; expired = false;
  $('timerPrompt')?.classList.add('hidden'); $('timeUpModal')?.classList.remove('open');
  clearInterval(sessionTick); sessionTick = setInterval(tickSession, 1000); tickSession();
}
function stopSession() { clearInterval(sessionTick); sessionTick = null; }
function tickSession() {
  if (!sessionTick) return;
  const left = Math.max(0, Math.ceil((sessionDeadline - Date.now()) / 1000));
  const t = $('timerText'), chip = $('sessionTimer'), bar = $('timerBar');
  if (t) t.textContent = `${String(Math.floor(left / 60)).padStart(2, '0')}:${String(left % 60).padStart(2, '0')}`;
  if (chip) { chip.classList.toggle('warn', left > 0 && left <= WARN_SECONDS); chip.classList.toggle('over', left === 0); }
  if (bar) bar.style.width = (left / SESSION_SECONDS * 100) + '%';
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
    $('tuExtend').onclick = () => { el.classList.remove('open'); startSession(); };
    $('tuSubmit').onclick = () => { el.classList.remove('open'); submitAll(); };
    $('tuLater').onclick = () => { el.classList.remove('open'); showSetup(); };
  }
  const s = draftStats({ items: rows.map(r => ({ s: r.stock, t: r.tester })) });
  $('timeUpText').textContent = s.skus
    ? `${s.skus} SKU • ${s.qty.toLocaleString('en-IN')} Qty are saved as a draft on this device, so you will not have to punch them again.`
    : 'No quantities have been entered yet. Keep counting, or come back later.';
  el.classList.add('open');
}

document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushDraft(); else tickSession(); });
window.addEventListener('pagehide', flushDraft);
setInterval(() => { if (dirty) saveDraft(false); }, 10000);   // safety net on top of the debounced save

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
        <button id="kbToggle" class="kb-toggle" type="button" title="Switch between number pad and normal keyboard">${searchMode === 'numeric' ? 'ABC' : '123'}</button>
      </div>
    </div>
    <div class="entry-chips" id="entryChips">
      <button class="chip active" data-f="all" type="button">All <b id="cntAll">0</b></button>
      <button class="chip" data-f="entered" type="button">Entered <b id="cntEntered">0</b></button>
      <button class="chip" data-f="pending" type="button">Not entered <b id="cntPending">0</b></button>
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
    clearTimeout(entrySortTimer);
    // Tap = select the old value so typing overwrites it. Only if this box STILL has focus:
    // select() can pull focus back to a stale box, which makes focus ping-pong and mis-routes keystrokes.
    const x = e.target; setTimeout(() => { if (document.activeElement === x) { try { x.select(); } catch (_) {} } }, 0);
  });
  list.addEventListener('focusout', e => {
    if (!e.target.classList || !e.target.classList.contains('entry-num')) return;
    // Re-sort only once the user has finished with the quantity boxes, and only if the order really changed.
    clearTimeout(entrySortTimer);
    entrySortTimer = setTimeout(() => {
      const a = document.activeElement;
      if (a && a.classList && a.classList.contains('entry-num')) return;
      sortRowsByTotal();
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
    <div class="entry-page-note">Showing <b>${filtered.length ? start + 1 : 0}–${Math.min(start + PAGE_SIZE, filtered.length)}</b> of <b>${filtered.length}</b> matching SKUs${entrySearch || entryFilter !== 'all' ? ` • ${rows.length} total` : ''} • highest Total stays on top</div>
    <div class="entry-table-wrap"><table class="entry-table"><thead><tr><th>EAN / SKU</th><th>Product</th><th>Stock</th><th>Tester</th><th>Total ↓</th></tr></thead><tbody>
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
  const row = { uid: uidSeed++, ean: String(found['EAN Code']).trim(), name: String(found['Product Name'] || ''), stock: 0, tester: 0, added: true };
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

async function submitAll() {
  if (!rows.length || !selectedStore) return;
  const button = $('submitEntryTop');
  if (button) { button.disabled = true; button.textContent = 'Submitting…'; }
  saveDraft(false);   // keep a copy until the server confirms
  msg('Submitting entered SKU quantities…', true);
  const enteredRows = rows.filter(r => Number(r.stock || 0) + Number(r.tester || 0) > 0).map(r => ({ ean: r.ean, name: r.name, stock: Number(r.stock || 0), tester: Number(r.tester || 0), total: Number(r.stock || 0) + Number(r.tester || 0) }));
  if (!enteredRows.length) { showPopup('Nothing to submit', 'Please enter Stock or Tester quantity for at least one SKU.', false, false); if (button) { button.disabled=false; button.textContent='Submit Stock'; } return; }
  if (!pendingEntryNo) pendingEntryNo = 'STK-' + new Date().toISOString().replace(/[-:TZ.]/g,'').slice(0,14) + '-' + Math.random().toString(36).slice(2,6).toUpperCase();
  const entryNo = pendingEntryNo;
  try {
    const payload = {
      email,
      store_name: selectedStore,
      entry_no: entryNo,
      rows: enteredRows.map(r => ({ 'EAN Code': r.ean, 'Product Name': r.name, 'Stock': r.stock, 'Tester': r.tester, 'Total': r.total }))
    };
    const j = await getJson('/api/submit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const saved = Number(j.saved_rows || 0);

    // Fetch the exact system/movement snapshot needed for the variance PDF.
    // This is deliberately separate from the save call so submission speed is
    // not affected if PDF data preparation has an issue.
    let reportRows = [];
    try {
      const report = await getJson('/api/entry-report-data', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      reportRows = report.rows || [];
    } catch (_) {}

    lastSubmission = { entryNo: j.entry_no || entryNo, email, store: selectedStore, rows: enteredRows, reportRows, savedRows: saved, timestamp: new Date() };
    showPopup('Submission Successful', `Entry No. ${j.entry_no || entryNo} • ${saved.toLocaleString('en-IN')} SKU rows submitted for ${selectedStore}.`, true, true);
    msg(`${saved.toLocaleString('en-IN')} SKU rows submitted successfully.`, true);
    pendingEntryNo = '';
    clearDraft();       // final submit done: the draft is no longer needed
    loadLastSubmissions();
    rows.forEach(r => { r.stock = 0; r.tester = 0; });
    currentPage = 1; entryFilter = 'all';
    render(); paintSaveState(); startSession();
  } catch (e) {
    showPopup('Submission Failed', (e.message || 'The submission could not be completed.') + ' Your quantities are still on screen and saved as a draft — tap Submit again (it will not create a duplicate).', false, false);
    loadLastSubmissions();
    msg(`Submission failed: ${e.message}`, false);
  } finally {
    const b = $('submitEntryTop');
    if (b) { b.disabled = !rows.length; b.textContent = 'Submit Stock'; }
  }
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
