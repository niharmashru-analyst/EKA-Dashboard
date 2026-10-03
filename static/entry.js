let email = '', stores = [], selectedStore = '', master = [], rows = [];
let submissionHistory = [];
let lastSubmission = null;
let pendingEntryNo = '';   // reused if a submit has to be retried, so the server can ignore the duplicate
const OFFLINE_DB = 'cormate-field-entry-v1';
const OFFLINE_STORE = 'pending_submissions';
const DRAFT_STORE = 'drafts';
let offlineSyncTimer = null;
let offlineSyncBusy = false;
let currentPage = 1;
const PAGE_SIZE = 25;
let entrySearch = '';
let uidSeed = 1;
let entrySortTimer = null;
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));

function offlineDb() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) return reject(new Error('Offline storage is not supported by this browser.'));
    const req = indexedDB.open(OFFLINE_DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(OFFLINE_STORE)) db.createObjectStore(OFFLINE_STORE, { keyPath: 'entry_no' });
      if (!db.objectStoreNames.contains(DRAFT_STORE)) db.createObjectStore(DRAFT_STORE, { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('Could not open offline storage.'));
  });
}
async function offlinePut(storeName, value) {
  const db = await offlineDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).put(value);
    tx.oncomplete = () => { db.close(); resolve(true); };
    tx.onerror = () => { db.close(); reject(tx.error || new Error('Offline save failed.')); };
  });
}
async function offlineDelete(storeName, key) {
  const db = await offlineDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).delete(key);
    tx.oncomplete = () => { db.close(); resolve(true); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}
async function offlineAll(storeName) {
  const db = await offlineDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = () => { const out=req.result||[]; db.close(); resolve(out); };
    req.onerror = () => { db.close(); reject(req.error); };
  });
}
function csvCell(v) { return '"' + String(v ?? '').replace(/"/g, '""') + '"'; }
function submissionPayload() {
  const enteredRows = rows.filter(r => Number(r.stock || 0) + Number(r.tester || 0) > 0)
    .map(r => ({ 'EAN Code': r.ean, 'Product Name': r.name, 'Stock': Number(r.stock || 0), 'Tester': Number(r.tester || 0), 'Total': Number(r.stock || 0) + Number(r.tester || 0) }));
  if (!pendingEntryNo) pendingEntryNo = 'STK-' + new Date().toISOString().replace(/[-:TZ.]/g,'').slice(0,14) + '-' + Math.random().toString(36).slice(2,6).toUpperCase();
  return { email, store_name:selectedStore, entry_no:pendingEntryNo, rows:enteredRows };
}
function downloadSubmissionCsv(payload, filenameSuffix='backup') {
  if (!payload || !payload.rows || !payload.rows.length) return false;
  const lines = [['Entry No','Submitted At','Email','Store Name','EAN / SKU','Product Name','Stock','Tester','Total']];
  const now = new Date().toISOString();
  payload.rows.forEach(r => lines.push([payload.entry_no,now,payload.email,payload.store_name,r['EAN Code'],r['Product Name'],r.Stock,r.Tester,r.Total]));
  const csv = '\uFEFF' + lines.map(row => row.map(csvCell).join(',')).join('\r\n');
  const blob = new Blob([csv], {type:'text/csv;charset=utf-8'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href=url; a.download=`Stock_${String(payload.store_name||'Store').replace(/[^a-z0-9]+/gi,'_')}_${payload.entry_no}_${filenameSuffix}.csv`;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(url),1000);
  return true;
}
async function saveDraft() {
  if (!email || !selectedStore || !rows.length) return;
  try { await offlinePut(DRAFT_STORE, {key: email+'|'+selectedStore, email, store_name:selectedStore, rows:rows.map(r=>({uid:r.uid,ean:r.ean,name:r.name,stock:Number(r.stock||0),tester:Number(r.tester||0)})), updated_at:new Date().toISOString()}); } catch(e) { console.warn('Draft save failed',e); }
}
async function clearDraft() {
  if (!email || !selectedStore) return;
  try { await offlineDelete(DRAFT_STORE, email+'|'+selectedStore); } catch(e) {}
}
async function queueSubmission(payload, reason='offline') {
  await offlinePut(OFFLINE_STORE, { ...payload, queued_at:new Date().toISOString(), reason, attempts:0 });
}
async function syncPendingSubmissions() {
  if (offlineSyncBusy || !navigator.onLine) return;
  offlineSyncBusy=true;
  try {
    const pending=await offlineAll(OFFLINE_STORE);
    for (const item of pending) {
      try {
        const j=await getJson('/api/submit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(item),skipOfflineQueue:true});
        await offlineDelete(OFFLINE_STORE,item.entry_no);
        if (email===String(item.email||'').toLowerCase()) {
          lastSubmission={entryNo:j.entry_no||item.entry_no,email:item.email,store:item.store_name,rows:item.rows.map(r=>({ean:r['EAN Code'],name:r['Product Name'],stock:Number(r.Stock||0),tester:Number(r.Tester||0),total:Number(r.Total||0)})),reportRows:[],savedRows:Number(j.saved_rows||item.rows.length),timestamp:new Date()};
        }
      } catch(e) {
        console.warn('Pending submission sync deferred:', e.message);
        break;
      }
    }
    const left=await offlineAll(OFFLINE_STORE);
    const banner=$('offlineStatus');
    if (banner) { banner.classList.toggle('open',left.length>0); banner.textContent=left.length?`⚠ ${left.length} stock submission(s) saved on this device and waiting to sync.`:'✓ All saved submissions are synced.'; }
    if (!left.length) loadLastSubmissions();
  } catch(e) { console.warn('Offline queue unavailable',e); }
  finally { offlineSyncBusy=false; }
}
function startOfflineSync() {
  window.addEventListener('online',()=>syncPendingSubmissions());
  window.addEventListener('offline',()=>{const b=$('offlineStatus');if(b){b.classList.add('open');b.textContent='⚠ Offline mode: entries will be saved on this device and synced automatically when connection returns.';}});
  syncPendingSubmissions();
  clearInterval(offlineSyncTimer); offlineSyncTimer=setInterval(syncPendingSubmissions,10000);
}
let entryStep=1;
function showSetup(){entryStep=1;$('skuArea').classList.add('hidden');$('setupActions').style.display='flex';$('email').disabled=false;$('store').disabled=stores.length<=1;$('continueEntry').disabled=!email||!selectedStore;}

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
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  currentPage = Math.min(currentPage, pages);
  $('progressText') && ($('progressText').textContent = `${entered} of ${total} SKU${total === 1 ? '' : 's'} entered`);
}

const _wait = ms => new Promise(r => setTimeout(r, ms));
// GET requests are retried (server waking up, 502/503/504, flaky mobile data). POSTs are sent once.
async function getJson(url, options = {}) {
  const isGet = !options.method || String(options.method).toUpperCase() === 'GET';
  const skipOfflineQueue = !!options.skipOfflineQueue;
  if (options.skipOfflineQueue) { options = {...options}; delete options.skipOfflineQueue; }
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
    rows=available.map(x=>({uid:uidSeed++,ean:String(x['EAN Code']??'').trim(),name:String(x['Product Name']??''),stock:0,tester:0})); entrySearch=''; currentPage=1; entryStep=2;
    $('setupActions').style.display='none'; $('email').disabled=true; $('store').disabled=true;
    setEntryLoading(true,'Loading SKU Entry',`${rows.length.toLocaleString('en-IN')} SKU(s) found. Building the entry table…`);
    render(); await restoreDraftForCurrentStore(); msg(`${rows.length.toLocaleString('en-IN')} SKU(s) loaded for ${selectedStore}.`,true);
  } catch(e){ msg(e.message); }
  finally { setEntryLoading(false); if(button){button.disabled=!selectedStore;button.textContent='Continue to SKU Entry →';} }
}

function filteredRows() {
  const q = String(entrySearch || '').trim().toLowerCase();
  if (!q) return rows.slice();
  return rows.filter(r => String(r.ean || '').toLowerCase().includes(q) || String(r.name || '').toLowerCase().includes(q));
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
    box.innerHTML=`<div class="last-sub-head"><div><b>My Submission History</b><span>Select an entry to view SKU-wise quantities. Only &gt;0 quantities are shown.</span></div><span class="last-sub-refresh">${entries.length} entries</span></div>${warn}<div class="submission-history-list">${entries.length ? entries.map((e,i)=>{const qty=e.rows.reduce((a,r)=>a+Number(r.total||0),0);const no=e.entry_no||'Historical entry';const by=e.email&&e.email!==email?` • by ${esc(e.email)}`:'';return `<button class="submission-history-item" data-entry-index="${i}"><div><b>${esc(no)}</b><span>${esc(e.store_name)}${by}</span></div><div><span>${esc(fmtWhen(e.submitted_at))}</span><span>${e.rows.length} SKU • ${qty.toLocaleString('en-IN')} Qty</span></div></button>`;}).join(''):`<div class="submission-empty">No submitted stock entries found for your mapped shops.</div>`}</div>`;
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

function render() {
  $('skuArea').classList.remove('hidden');
  const filtered = filteredRows();
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  currentPage = Math.min(currentPage, pages);
  const start = (currentPage - 1) * PAGE_SIZE;
  const visible = filtered.slice(start, start + PAGE_SIZE);
  const entered = enteredCount();

  $('skuArea').innerHTML = `
    <div class="entry-toolbar">
      <div><button id="backToSetup" class="btn secondary small">← Back</button> <b>${esc(selectedStore)}</b><div class="muted entry-progress" id="progressText">${entered} of ${rows.length} SKU${rows.length === 1 ? '' : 's'} entered</div></div>
      <button id="addSku" class="link-btn">+ Add SKU From Master</button>
    </div>
    <div class="entry-submit-bar">
      <div><b>Ready to submit?</b><span class="muted"> ${entered} SKU(s) entered • ${enteredQty().toLocaleString('en-IN')} total Qty</span></div>
      <div class="entry-submit-actions"><button id="downloadCsvTop" class="btn secondary" ${entered ? '' : 'disabled'}>⬇ CSV Backup</button><button id="submitEntryTop" class="btn" ${rows.length ? '' : 'disabled'}>Submit Stock</button></div>
    </div>
    <div class="entry-search-sort">
      <div class="entry-search-wrap"><span>⌕</span><input id="entrySearch" type="search" value="${esc(entrySearch)}" placeholder="Search EAN / SKU / Product name…" autocomplete="off"></div>
      <div class="entry-sort-note"><b>Total ↓</b><span>Highest entered Stock + Tester stays on top</span></div>
    </div>
    <div class="master-picker hidden" id="masterPicker">
      <div class="master-picker-head"><b>Add SKU From Master</b><button id="closeMaster" class="picker-close">✕</button></div>
      <input id="masterSearch" class="master-search" placeholder="Search EAN / SKU / Product name…" autocomplete="off">
      <div id="masterResults" class="master-results"></div>
    </div>
    <div class="entry-page-note">Showing <b>${filtered.length ? start + 1 : 0}–${Math.min(start + PAGE_SIZE, filtered.length)}</b> of <b>${filtered.length}</b> matching SKUs${entrySearch ? ` • ${rows.length} total` : ''}</div>
    <div class="entry-table-wrap"><table class="entry-table"><thead><tr><th>EAN / SKU</th><th>Product</th><th>Stock</th><th>Tester</th><th>Total ↓</th></tr></thead><tbody>
    ${visible.map((r) => { const i = rows.indexOf(r); return `<tr><td>${esc(r.ean)}</td><td>${esc(r.name)}</td><td><input class="entry-num" data-uid="${r.uid}" data-k="stock" type="number" min="0" step="1" value="${Number(r.stock || 0)}"></td><td><input class="entry-num" data-uid="${r.uid}" data-k="tester" type="number" min="0" step="1" value="${Number(r.tester || 0)}"></td><td class="total-cell" id="tot-${r.uid}">${Number(r.stock || 0) + Number(r.tester || 0)}</td></tr>`; }).join('')}
    ${visible.length ? '' : `<tr><td colspan="5" class="entry-empty-row">No SKU matches your search.</td></tr>`}
    </tbody></table></div>
    <div class="entry-mobile-list">
      ${visible.map((r) => { const total = Number(r.stock || 0) + Number(r.tester || 0); return `<article class="sku-entry-card" data-uid-card="${r.uid}">
        <div class="sku-card-top"><div class="sku-card-thumb">R</div><div class="sku-card-info"><b>${esc(r.name || 'Unnamed Product')}</b><span>SKU / EAN: ${esc(r.ean || '—')}</span></div><div class="sku-card-total"><small>Total</small><strong id="mobile-tot-${r.uid}">${total}</strong></div></div>
        <div class="sku-card-inputs"><label><span>Stock</span><input class="entry-num" data-uid="${r.uid}" data-k="stock" type="number" min="0" step="1" value="${Number(r.stock || 0)}"></label><label><span>Tester</span><input class="entry-num" data-uid="${r.uid}" data-k="tester" type="number" min="0" step="1" value="${Number(r.tester || 0)}"></label></div>
      </article>`; }).join('')}
      ${visible.length ? '' : `<div class="entry-mobile-empty">No SKU matches your search.</div>`}
    </div>
    <div class="entry-pagination">
      <button class="btn secondary small" id="prevPage" ${currentPage <= 1 ? 'disabled' : ''}>← Previous</button>
      <span>Page <b>${currentPage}</b> of <b>${pages}</b></span>
      <button class="btn secondary small" id="nextPage" ${currentPage >= pages ? 'disabled' : ''}>Next →</button>
    </div>`;

  const searchBox = $('entrySearch');
  if (searchBox) {
    searchBox.oninput = () => { entrySearch = searchBox.value; currentPage = 1; render(); const s=$('entrySearch'); if(s){s.focus();s.setSelectionRange(s.value.length,s.value.length);} };
  }

  // IMPORTANT: Never re-render the SKU table while the user is typing.
  // Rebuilding skuArea.innerHTML on every quantity input causes Android/mobile
  // keyboards to lose focus, making it look like the page is refreshing and
  // making multi-digit quantities difficult to punch.
  document.querySelectorAll('.entry-num').forEach(x => {
    x.oninput = () => {
      const row = rows.find(r => String(r.uid) === String(x.dataset.uid));
      if (!row) return;

      const raw = x.value;
      row[x.dataset.k] = raw === '' ? 0 : Math.max(0, Number(raw));

      const total = Number(row.stock || 0) + Number(row.tester || 0);
      const cell = $('tot-' + row.uid);
      if (cell) cell.textContent = total;
      const mobileCell = $('mobile-tot-' + row.uid);
      if (mobileCell) mobileCell.textContent = total;

      updateSummary();
      clearTimeout(window.__draftTimer); window.__draftTimer=setTimeout(saveDraft,350);
      const top = $('submitEntryTop');
      if (top) top.disabled = !rows.length;
    };

    // Sort only after the user has finished with the input. If they move
    // directly from Stock to Tester, do not sort/re-render in between.
    x.onblur = () => {
      clearTimeout(entrySortTimer);
      entrySortTimer = setTimeout(() => {
        const active = document.activeElement;
        if (active && active.classList && active.classList.contains('entry-num')) return;
        sortRowsByTotal();
        render();
      }, 180);
    };

    // Prevent native change handling from triggering a table rebuild.
    x.onchange = () => {};
  });

  $('backToSetup').onclick = showSetup;
  $('addSku').onclick = openMasterPicker;
  $('closeMaster').onclick = closeMasterPicker;
  $('masterSearch').oninput = renderMasterResults;
  $('prevPage').onclick = () => { if (currentPage > 1) { currentPage--; render(); } };
  $('nextPage').onclick = () => { if (currentPage < pages) { currentPage++; render(); } };
  $('submitEntryTop').onclick = submitAll;
  const csvBtn=$('downloadCsvTop'); if(csvBtn) csvBtn.onclick=()=>{ const p=submissionPayload(); if(!p.rows.length){msg('Enter at least one quantity before downloading the CSV.',false);return;} downloadSubmissionCsv(p,'manual-backup'); msg('CSV backup downloaded. Keep this file until the submission is confirmed.',true); };
  renderMasterResults();
  updateSummary();
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
  box.innerHTML = options.slice(0, 100).map(m => `<button class="master-option" data-ean="${esc(m['EAN Code'])}"><span><b>${esc(m['EAN Code'])}</b><small>${esc(m['Product Name'])}</small></span><span>＋</span></button>`).join('');
  box.querySelectorAll('.master-option').forEach(b => b.onclick = () => addMasterSku(b.dataset.ean));
}

function addMasterSku(ean) {
  const found = master.find(m => String(m['EAN Code']).trim() === String(ean).trim());
  if (!found) return;
  if (rows.some(r => String(r.ean).trim() === String(ean).trim())) { msg('SKU is already in the table.'); return; }
  rows.push({ uid:uidSeed++, ean: String(found['EAN Code']).trim(), name: String(found['Product Name'] || ''), stock: 0, tester: 0 });
  currentPage = Math.ceil(rows.length / PAGE_SIZE);
  render();
  msg(`${found['Product Name']} added from SKU Master.`, true);
}

async function submitAll() {
  if (!rows.length || !selectedStore) return;
  const button = $('submitEntryTop');
  if (button) { button.disabled = true; button.textContent = 'Saving…'; }
  const payload = submissionPayload();
  if (!payload.rows.length) { showPopup('Nothing to submit', 'Please enter Stock or Tester quantity for at least one SKU.', false, false); if (button) { button.disabled=false; button.textContent='Submit Stock'; } return; }

  // ALWAYS create a device-side CSV backup first. This happens directly from the
  // user's click, so mobile browsers are much less likely to block the download.
  downloadSubmissionCsv(payload, 'auto-backup');
  try { await offlinePut(OFFLINE_STORE, { ...payload, queued_at:new Date().toISOString(), reason:'backup-before-submit', attempts:0 }); } catch(e) { console.warn('Could not create offline queue',e); }
  msg(navigator.onLine ? 'CSV backup created. Submitting stock…' : 'No internet. CSV backup created and stock saved safely on this device.', true);

  try {
    const j = await getJson('/api/submit', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload), skipOfflineQueue:true });
    const saved = Number(j.saved_rows || 0);
    await offlineDelete(OFFLINE_STORE,payload.entry_no);
    await clearDraft();

    let reportRows=[];
    try {
      const report=await getJson('/api/entry-report-data',{method:'POST',headers:{'Content-Type':'application/json'},body:payload,skipOfflineQueue:true});
      reportRows=report.rows||[];
    } catch (_) {}
    lastSubmission={entryNo:j.entry_no||payload.entry_no,email,store:selectedStore,rows:payload.rows.map(r=>({ean:r['EAN Code'],name:r['Product Name'],stock:r.Stock,tester:r.Tester,total:r.Total})),reportRows,savedRows:saved,timestamp:new Date()};
    showPopup('Submission Successful',`Entry No. ${j.entry_no||payload.entry_no} • ${saved.toLocaleString('en-IN')} SKU rows submitted for ${selectedStore}. CSV backup has also been saved.`,true,true);
    msg(`${saved.toLocaleString('en-IN')} SKU rows submitted successfully. CSV backup downloaded.`,true);
    pendingEntryNo='';
    loadLastSubmissions();
    rows.forEach(r=>{r.stock=0;r.tester=0;}); currentPage=1; render();
  } catch(e) {
    // The entry is already safely in IndexedDB + CSV. Do NOT clear the form.
    try { await queueSubmission(payload, navigator.onLine?'server-unavailable':'offline'); } catch(_) {}
    showPopup('Saved Offline — Not Lost',`Entry ${payload.entry_no} is saved on this device and the CSV backup was downloaded. It will automatically submit when the server/connection is available again. Do not clear your browser data until it syncs.`,true,false);
    msg(`Saved safely on this device. Waiting to sync: ${payload.entry_no}`,true);
    const b=$('offlineStatus'); if(b){b.classList.add('open');b.textContent='⚠ Submission saved locally and waiting to sync. Keep this page/app installed/open; it will retry automatically.';}
  } finally {
    const b=$('submitEntryTop'); if(b){b.disabled=!rows.length;b.textContent='Submit Stock';}
    const c=$('downloadCsvTop'); if(c)c.disabled=enteredCount()===0;
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
async function restoreDraftForCurrentStore() {
  if (!email || !selectedStore) return;
  try {
    const all=await offlineAll(DRAFT_STORE); const d=all.find(x=>x.key===email+'|'+selectedStore);
    if (!d || !Array.isArray(d.rows)) return;
    const positive=d.rows.filter(r=>Number(r.stock||0)||Number(r.tester||0));
    if (!positive.length) return;
    const byEan=new Map(rows.map(r=>[String(r.ean).trim(),r]));
    positive.forEach(r=>{const target=byEan.get(String(r.ean).trim());if(target){target.stock=Number(r.stock||0);target.tester=Number(r.tester||0);}});
    render(); msg(`Recovered ${positive.length} entered SKU(s) from this device.`,true);
  } catch(e) { console.warn('Draft restore failed',e); }
}
if ($('email') && $('email').value.trim()) { loadMeta(); }
startOfflineSync();

$('store').onchange = () => { selectedStore=$('store').value||''; $('continueEntry').disabled=!selectedStore; loadLastSubmissions(); };
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
    if(name==='inward') return;
    Object.keys(pages).forEach(k=>{if(pages[k]) pages[k].classList.toggle('hidden',k!==name);});
    navs.forEach(n=>n.classList.toggle('active',n.dataset.page===name));
  }
  navs.forEach(n=>n.addEventListener('click',()=>openPage(n.dataset.page)));
})();
