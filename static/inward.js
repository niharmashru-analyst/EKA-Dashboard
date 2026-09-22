/* Field Entry sidebar + Inward Validation.
   Self-contained on purpose (IIFE, own helpers) so it can't clash with entry.js. */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  const fmt = n => Number(n || 0).toLocaleString('en-IN');
  const r3 = n => Math.round(n * 1000) / 1000;

  /* ---------------------------------------------------------- sidebar / pages */
  const PAGES = { stock: 'page-stock', inward: 'page-inward' };
  const openSide = () => { $('entrySide').classList.add('open'); $('entrySideBackdrop').classList.add('open'); };
  const closeSide = () => { $('entrySide').classList.remove('open'); $('entrySideBackdrop').classList.remove('open'); };

  function showPage(name) {
    if (!PAGES[name]) name = 'stock';
    Object.entries(PAGES).forEach(([k, id]) => $(id).classList.toggle('hidden', k !== name));
    document.querySelectorAll('#entrySide .nav').forEach(b => b.classList.toggle('active', b.dataset.page === name));
    if (name === 'inward' && !$('inEmail').value) { const e = ($('email') && $('email').value || '').trim(); if (e) $('inEmail').value = e; }
    if (location.hash !== '#' + name) history.replaceState(null, '', '#' + name);
    closeSide();
  }
  document.querySelectorAll('#entrySide .nav').forEach(b => b.onclick = () => showPage(b.dataset.page));
  $('entryMenu').onclick = () => $('entrySide').classList.contains('open') ? closeSide() : openSide();
  $('entrySideBackdrop').onclick = closeSide;
  window.addEventListener('hashchange', () => showPage(location.hash.slice(1)));

  /* ------------------------------------------------------------------ helpers */
  function msg(t, good = false) {
    $('inMsg').innerHTML = t ? `<div class="entry-msg ${good ? 'good' : 'bad'}">${esc(t)}</div>` : '';
  }
  async function getJson(url, options = {}) {
    const r = await fetch(url, { cache: 'no-store', ...options });
    let j;
    try { j = await r.json(); } catch (_) { throw Error(`Server returned HTTP ${r.status}`); }
    if (!r.ok || !j.ok) throw Error(j.error || `Request failed (${r.status})`);
    return j;
  }

  /* -------------------------------------------------------------------- state */
  let po = null;          // { query, label, email, lines:[{key, ean, name, order, received|null}] }
  let warnedMissing = false;  // true while the 'no received qty' banner is showing
  let lastReport = null;  // data behind the CSV, kept so it can be downloaded again from the popup
  let master = [];       // SKU master returned with the invoice fetch, used for Add SKU

  const entered = () => po ? po.lines.filter(l => l.received !== null).length : 0;
  const statusOf = v => v === null ? 'pending' : (v === 0 ? 'match' : (v < 0 ? 'short' : 'excess'));
  const STATUS_LABEL = { pending: 'Pending', match: 'Match', short: 'Short', excess: 'Excess' };

  /* -------------------------------------------------------------------- fetch */
  async function fetchPo() {
    const email = $('inEmail').value.trim().toLowerCase();
    const q = $('inPo').value.trim();
    if (!email) { msg('Enter your company email first.'); $('inEmail').focus(); return; }
    if (!q) { msg('Enter an Invoice Number.'); $('inPo').focus(); return; }
    if (po && entered() > 0 && !confirm('Fetching again will discard the quantities you have entered. Continue?')) return;
    const btn = $('inFetch');
    btn.disabled = true; btn.textContent = 'Fetching…'; msg('');
    try {
      const j = await getJson(`/api/inward/fetch?email=${encodeURIComponent(email)}&po=${encodeURIComponent(q)}&_ts=${Date.now()}`);
      po = {
        query: q, label: j.po, email, meta: j.meta || {}, mode: j.mode || 'line', headers: j.headers || [], labels: j.labels || { code: 'EAN', name: 'Description' },
        master: j.master_skus || [],
        lines: j.rows.map(r => ({ key: r['Key'], ean: r['EAN'], name: r['Description'], order: Number(r['Quantity']) || 0, received: null, details: r, added: false }))
      };
      master = po.master || [];
      render();
      const n = po.lines.length, unit = po.mode === 'order' ? 'order line' : 'SKU';
      msg(`Invoice ${j.po} loaded — ${n.toLocaleString('en-IN')} line${n === 1 ? '' : 's'}. ` +
          (po.mode === 'order' && n > 1 ? 'Enter the received qty only for the order line(s) you received.' : 'Enter the received qty.'), true);
    } catch (e) {
      po = null; $('inResult').classList.add('hidden'); $('inResult').innerHTML = '';
      msg(e.message);
    } finally { btn.disabled = false; btn.textContent = 'Fetch'; }
  }

  /* --------------------------------------------------------------- sync data */
  async function syncData() {
    const email = $('inEmail').value.trim().toLowerCase();
    if (!email) { msg('Enter your company email first.'); $('inEmail').focus(); return; }
    if (po && entered() > 0 && !confirm('Syncing will refresh the Excel data and discard the quantities you have already entered if the invoice is reloaded. Continue?')) return;

    const btn = $('inSync');
    const fetchBtn = $('inFetch');
    btn.disabled = true;
    fetchBtn.disabled = true;
    btn.textContent = '↻ Syncing…';
    msg('Refreshing the latest dashboard and entry data…');

    try {
      const j = await getJson('/api/data/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email })
      });

      const q = $('inPo').value.trim();
      if (q) {
        // The normal Fetch now reads the freshly refreshed cache, saving the user
        // from manually trying the invoice again.
        po = null;
        $('inResult').classList.add('hidden');
        $('inResult').innerHTML = '';
        await fetchPo();
        msg(`Data synced successfully. Invoice ${q} was checked again against the latest data.`, true);
      } else {
        const rows = Number(j.inward_rows || 0).toLocaleString('en-IN');
        msg(`Data synced successfully — ${rows} source row(s) refreshed. You can now fetch the Invoice Number.`, true);
      }
    } catch (e) {
      msg(`Data sync failed: ${e.message}`);
    } finally {
      btn.disabled = false;
      fetchBtn.disabled = false;
      btn.textContent = '↻ Sync Data';
    }
  }

  /* ------------------------------------------------------------------- render */
  function render() {
    const m = po.meta || {};
    const party = (m.shops || []).filter(Boolean).join(', ') || '—';
    const transfer = (m.transfer_to_codes || []).filter(Boolean).join(', ') || '—';
    const documentNo = (m.documents || []).filter(Boolean).join(', ') || po.label || '—';
    $('inResult').classList.remove('hidden');
    $('inResult').innerHTML = `
      <div class="inward-po-head">
        <div class="inward-info-grid">
          <div class="inward-info"><span>PARTY NAME</span><strong>${esc(party)}</strong></div>
          <div class="inward-info"><span>TRANSFER-TO CODE</span><strong>${esc(transfer)}</strong></div>
          <div class="inward-info"><span>DOCUMENT NO.</span><strong>${esc(documentNo)}</strong></div>
        </div>
      </div>
      <div class="entry-summary inward-summary">
        <div class="entry-stat"><span>Lines Entered</span><strong id="inStatSku">0</strong><small id="inStatSkuSub"></small></div>
        <div class="entry-stat"><span>Sales Qty</span><strong id="inStatOrder">0</strong><small>Total Quantity on this Invoice</small></div>
        <div class="entry-stat"><span>Received Qty</span><strong id="inStatRecv">0</strong><small>Entered so far</small></div>
        <div class="entry-stat"><span>Net Variance</span><strong id="inStatVar">0</strong><small>Received − Sales Qty</small></div>
      </div>
      <div class="entry-submit-bar"><div><b>Ready to submit?</b><span class="muted" id="inProgress"></span></div><button id="inSubmit" class="btn" type="button">Submit &amp; Download Variance CSV</button></div>
      <div class="inward-tools">
        <div class="inward-filter-group">
          <input id="inSearch" class="inward-search" placeholder="Search EAN / Description / Quantity…" autocomplete="off">
          <select id="inStatusFilter" class="inward-status-filter" aria-label="Filter by status">
            <option value="all">All Status</option>
            <option value="issues">Issues Only (Short + Excess)</option>
            <option value="short">Short</option>
            <option value="excess">Excess</option>
            <option value="match">Match</option>
            <option value="pending">Pending</option>
          </select>
          <button id="inAddSku" class="btn secondary inward-add-sku" type="button">+ Add SKU</button>
        </div>
        <span class="muted">Variance = Received − Sales Qty · negative = short, positive = excess</span>
      </div>
      <div class="master-picker hidden" id="inMasterPicker">
        <div class="master-picker-head"><b>Add SKU From Master</b><button id="inCloseMaster" class="picker-close" type="button">✕</button></div>
        <input id="inMasterSearch" class="master-search" placeholder="Search EAN / SKU / Product name…" autocomplete="off">
        <div id="inMasterResults" class="master-results"></div>
      </div>
      <div class="inward-table-wrap"><table class="inward-table"><thead><tr><th>#</th><th>EAN</th><th class="name">Description</th><th>Sales Qty</th><th>Received Qty</th><th>Variance</th><th>Status</th></tr></thead><tbody>
      ${po.lines.map((l, i) => {
        const d = l.details || {};
        const search = [d['EAN'], d['Description'], d['Quantity']].join(' ');
        const addedBadge = l.added ? ' <span class="in-added-badge">Added SKU</span>' : '';
        return `<tr data-i="${i}" data-s="${esc(search.toLowerCase())}"><td>${i + 1}</td><td>${esc(d['EAN'] ?? '')}</td><td class="name">${esc(d['Description'] ?? '')}${addedBadge}</td><td>${esc(d['Quantity'] ?? '')}</td><td><input class="inward-num" data-i="${i}" type="number" inputmode="numeric" min="0" step="1" placeholder="Enter qty"></td><td id="inVar-${i}">–</td><td id="inSt-${i}"><span class="in-pill pending">Pending</span></td></tr>`;
      }).join('')}
      </tbody></table></div>`;

    document.querySelectorAll('.inward-num').forEach(x => {
      x.oninput = () => onQty(x);
      x.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); focusNext(x); } };
    });
    $('inSearch').oninput = applyFilters;
    $('inStatusFilter').onchange = applyFilters;
    $('inSubmit').onclick = submit;
    $('inAddSku').onclick = openMasterPicker;
    $('inCloseMaster').onclick = closeMasterPicker;
    $('inMasterSearch').oninput = renderMasterResults;
    renderMasterResults();
    paintSummary();
  }

  function openMasterPicker() {
    $('inMasterPicker').classList.remove('hidden');
    $('inMasterSearch').value = '';
    renderMasterResults();
    $('inMasterSearch').focus();
  }

  function closeMasterPicker() { $('inMasterPicker').classList.add('hidden'); }

  function renderMasterResults() {
    const q = ($('inMasterSearch')?.value || '').trim().toLowerCase();
    const existing = new Set((po?.lines || []).map(l => String(l.ean).trim().toLowerCase()));
    const options = (master || []).filter(m => {
      const ean = String(m['EAN Code'] ?? '').trim();
      const name = String(m['Product Name'] ?? '');
      return ean && !existing.has(ean.toLowerCase()) && (!q || ean.toLowerCase().includes(q) || name.toLowerCase().includes(q));
    });
    const box = $('inMasterResults');
    if (!box) return;
    if (!options.length) { box.innerHTML = '<div class="master-empty">No new SKU found in SKU Master.</div>'; return; }
    box.innerHTML = options.slice(0, 100).map(m => `<button class="master-option" data-ean="${esc(m['EAN Code'])}" type="button"><span><b>${esc(m['EAN Code'])}</b><small>${esc(m['Product Name'])}</small></span><span>＋</span></button>`).join('');
    box.querySelectorAll('.master-option').forEach(b => b.onclick = () => addMasterSku(b.dataset.ean));
  }

  function addMasterSku(ean) {
    const found = (master || []).find(m => String(m['EAN Code']).trim() === String(ean).trim());
    if (!found || !po) return;
    if (po.lines.some(l => String(l.ean).trim() === String(ean).trim())) { msg('SKU is already in the validation table.'); return; }
    const e = String(found['EAN Code']).trim();
    const name = String(found['Product Name'] || '').trim();
    po.lines.push({
      key: `__ADDED__|${e}`, ean: e, name, order: 0, received: null, added: true,
      details: { EAN: e, Description: name, Quantity: 0, Key: `__ADDED__|${e}`, 'Order Qty': 0 }
    });
    closeMasterPicker();
    render();
    msg(`${name} added from SKU Master. Sales Qty is 0, so any received quantity will appear as Excess.`, true);
  }

  function onQty(x) {
    const l = po.lines[+x.dataset.i], raw = x.value.trim(), n = Number(raw);
    const ok = raw !== '' && isFinite(n) && n >= 0;
    l.received = ok ? n : null;
    x.classList.toggle('bad', raw !== '' && !ok);
    paintRow(+x.dataset.i); paintSummary(); applyFilters();
    if (warnedMissing && (po.mode === 'order' ? entered() > 0 : entered() === po.lines.length)) { warnedMissing = false; msg(''); }
  }

  function paintRow(i) {
    const l = po.lines[i], v = l.received === null ? null : r3(l.received - l.order), s = statusOf(v);
    const cell = $('inVar-' + i);
    cell.textContent = v === null ? '–' : (v > 0 ? '+' : '') + fmt(v);
    cell.className = v === null ? '' : 'var-' + s;
    $('inSt-' + i).innerHTML = `<span class="in-pill ${s}">${STATUS_LABEL[s]}</span>`;
    cell.parentElement.className = s === 'short' ? 'is-short' : (s === 'excess' ? 'is-excess' : '');
  }

  function paintSummary() {
    const n = po.lines.length, ent = entered();
    const order = po.lines.reduce((a, l) => a + l.order, 0);
    const recv = po.lines.reduce((a, l) => a + (l.received ?? 0), 0);
    const net = r3(po.lines.reduce((a, l) => a + (l.received === null ? 0 : l.received - l.order), 0));
    $('inStatSku').textContent = `${fmt(ent)} / ${fmt(n)}`;
    $('inStatSkuSub').textContent = ent === n ? 'All lines entered' : (`${fmt(n - ent)} still to enter`);
    $('inStatOrder').textContent = fmt(order);
    $('inStatRecv').textContent = fmt(recv);
    $('inStatVar').textContent = (net > 0 ? '+' : '') + fmt(net);
    $('inProgress').textContent = ` ${fmt(ent)} of ${fmt(n)} ${'line'}(s) entered`;
  }

  function applyFilters() {
    const q = $('inSearch').value.trim().toLowerCase();
    const status = $('inStatusFilter') ? $('inStatusFilter').value : 'all';
    document.querySelectorAll('.inward-table tbody tr').forEach(tr => {
      const i = Number(tr.dataset.i);
      const l = po && po.lines[i];
      const current = l ? statusOf(l.received === null ? null : r3(l.received - l.order)) : 'pending';
      const statusOk = status === 'all' || (status === 'issues' ? (current === 'short' || current === 'excess') : current === status);
      const searchOk = !q || tr.dataset.s.includes(q);
      tr.style.display = statusOk && searchOk ? '' : 'none';
    });
  }

  // Keep this alias for validation/error flows that intentionally clear the search.
  function applySearch() { applyFilters(); }

  function focusNext(x) {
    const inputs = [...document.querySelectorAll('.inward-num')].filter(i => i.closest('tr').style.display !== 'none');
    const nxt = inputs[inputs.indexOf(x) + 1];
    if (nxt) nxt.focus(); else $('inSubmit').focus();
  }

  /* ------------------------------------------------------------------- submit */
  async function submit() {
    if (!po) return;
    const missing = po.lines.map((l, i) => l.received === null ? i : -1).filter(i => i >= 0);
    if (missing.length) {
      $('inSearch').value = ''; applySearch();
      missing.forEach(i => document.querySelector(`.inward-num[data-i="${i}"]`).classList.add('bad'));
      const first = document.querySelector(`.inward-num[data-i="${missing[0]}"]`);
      first.scrollIntoView({ block: 'center', behavior: 'smooth' }); first.focus();
      warnedMissing = true;
      msg(`${missing.length} line(s) still have no received qty. Enter 0 if nothing was received.`);
      return;
    }
    warnedMissing = false;
    const btn = $('inSubmit');
    btn.disabled = true; btn.textContent = 'Submitting…'; msg('');
    try {
      const j = await getJson('/api/inward/submit', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: po.email, po: po.query, rows: po.lines.map(l => ({ 'Key': l.key, 'EAN': l.ean, 'Description': l.name, 'Received Qty': l.received })) })
      });
      lastReport = { po: j.po, email: po.email, at: new Date(j.submitted_at), rows: j.rows, labels: j.labels, headers: j.headers || po.headers || [] };
      downloadCsv();
      const c = s => j.rows.filter(r => r['Status'] === s).length;
      const net = r3(j.rows.reduce((a, r) => a + r['Variance Qty'], 0));
      showPopup('Inward Validation Submitted',
        `Invoice ${j.po}: ${fmt(j.rows.length)} ${j.mode === 'order' ? 'order line' : 'SKU'}(s) verified — ${c('Match')} matched, ${c('Short')} short, ${c('Excess')} excess (net variance ${net > 0 ? '+' : ''}${fmt(net)}). The variance CSV has been downloaded.`, true, true);
      po = null; $('inResult').classList.add('hidden'); $('inResult').innerHTML = ''; $('inPo').value = '';
      msg(`Invoice ${j.po} submitted successfully.`, true);
    } catch (e) {
      showPopup('Submission Failed', (e.message || 'The submission could not be completed.') + ' Your entries were not cleared.', false, false);
      msg(`Submission failed: ${e.message}`);
      btn.disabled = false; btn.textContent = 'Submit & Download Variance CSV';
    }
  }

  /* ---------------------------------------------------------------------- CSV */
  function csvCell(v, isText) {
    let s = v === null || v === undefined ? '' : String(v);
    if (isText && /^[=+\-@\t\r]/.test(s)) s = "'" + s;   // stop Excel treating text as a formula
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function downloadCsv() {
    if (!lastReport) return;
    const { po: label, email, at, rows } = lastReport;
    const p = n => String(n).padStart(2, '0');
    const stamp = `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())} ${p(at.getHours())}:${p(at.getMinutes())}`;
    const sorted = [...rows].sort((a, b) => (a['Status'] === 'Match') - (b['Status'] === 'Match') || Math.abs(b['Variance Qty']) - Math.abs(a['Variance Qty']));
    const baseHeaders = lastReport.headers || [];
    const head = [...baseHeaders, 'Received Qty', 'Variance Qty', 'Variance %', 'Status', 'Received By', 'Submitted At'];
    const lines = [head.map(x => csvCell(x, true)).join(',')].concat(sorted.map(r => [
      ...baseHeaders.map(h => csvCell(r[h], true)),
      r['Received Qty'], r['Variance Qty'], r['Variance %'] === null ? '' : r['Variance %'], r['Status'], csvCell(email, true), stamp
    ].join(',')));
    const blob = new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `Inward_Variance_${String(label).replace(/[^a-z0-9]+/gi, '_')}_${stamp.slice(0, 10)}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  /* -------------------------------------------------------------------- popup */
  function showPopup(title, text, good, canDownload) {
    let el = $('inwardPopup');
    if (!el) {
      el = document.createElement('div');
      el.id = 'inwardPopup'; el.className = 'entry-popup-overlay';
      el.innerHTML = '<div class="entry-popup"><div id="inPopIcon" class="entry-popup-icon"></div><h3 id="inPopTitle"></h3><p id="inPopText"></p><div class="entry-popup-actions"><button id="inPopCsv" class="btn secondary">⬇ Variance CSV</button><button id="inPopClose" class="btn">Done</button></div></div>';
      document.body.appendChild(el);
      $('inPopClose').onclick = () => el.classList.remove('open');
      $('inPopCsv').onclick = downloadCsv;
      el.onclick = e => { if (e.target === el) el.classList.remove('open'); };
    }
    $('inPopIcon').textContent = good ? '✓' : '!';
    $('inPopIcon').className = 'entry-popup-icon ' + (good ? 'good' : 'bad');
    $('inPopTitle').textContent = title;
    $('inPopText').textContent = text;
    $('inPopCsv').style.display = canDownload ? 'inline-flex' : 'none';
    el.classList.add('open');
  }

  /* --------------------------------------------------------------------- init */
  $('inFetch').onclick = fetchPo;
  $('inSync').onclick = syncData;
  $('inPo').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); fetchPo(); } });
  $('inEmail').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('inPo').focus(); } });
  showPage(location.hash.slice(1));
})();
