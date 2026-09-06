let email='', stores=[], selectedStore='', master=[], rows=[];
const $=id=>document.getElementById(id);
const esc=s=>String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));

function msg(t,good=false){$('entryMsg').innerHTML=`<div class="entry-msg ${good?'good':'bad'}">${esc(t)}</div>`}
function enteredCount(){return rows.filter(r=>Number(r.stock||0)!==0 || Number(r.tester||0)!==0).length}
function enteredQty(){return rows.reduce((a,r)=>a+Number(r.stock||0)+Number(r.tester||0),0)}
function updateSummary(){
  const total=rows.length, entered=enteredCount(), qty=enteredQty();
  $('skuCount').textContent=total.toLocaleString('en-IN');
  $('enteredCount').textContent=entered.toLocaleString('en-IN');
  $('enteredQty').textContent=qty.toLocaleString('en-IN');
  $('progressText').textContent=`${entered} of ${total} SKU${total===1?'':'s'} entered`;
}

async function loadMeta(){
  email=$('email').value.trim().toLowerCase();
  if(!email){$('store').disabled=true;$('store').innerHTML='<option>Enter email first</option>';return}
  try{
    let r=await fetch('/api/entry-meta?email='+encodeURIComponent(email));
    let j=await r.json();if(!j.ok)throw Error(j.error);
    stores=j.stores||[];master=j.master_skus||[];
    if(stores.length===1){
      selectedStore=stores[0];
      $('store').innerHTML=`<option>${esc(stores[0])}</option>`;
      $('store').disabled=true;
      await loadSku();
    }else{
      $('store').disabled=false;
      $('store').innerHTML='<option value="">Select shop</option>'+stores.map(s=>`<option value="${esc(s)}">${esc(s)}</option>`).join('');
      $('skuArea').innerHTML='';
      $('submitEntry').disabled=true;
      rows=[];updateSummary();
    }
    msg('Email verified. '+stores.length+' shop(s) mapped.',true)
  }catch(e){
    msg(e.message);$('store').disabled=true;$('skuArea').innerHTML='';$('submitEntry').disabled=true;rows=[];updateSummary();
  }
}

async function loadSku(){
  selectedStore=$('store').value||selectedStore;if(!selectedStore)return;
  try{
    let r=await fetch('/api/entry-meta?email='+encodeURIComponent(email)+'&store='+encodeURIComponent(selectedStore));
    let j=await r.json();if(!j.ok)throw Error(j.error);
    master=j.master_skus||[];
    const available=j.available_skus||[];
    rows=available.map(x=>({ean:String(x['EAN Code']),name:x['Product Name'],stock:0,tester:0}));
    render();
    $('submitEntry').disabled=!rows.length;
    msg(`${rows.length.toLocaleString('en-IN')} SKU(s) loaded for ${selectedStore}.`,true);
  }catch(e){msg(e.message)}
}

function render(){
  $('skuArea').classList.remove('hidden');
  const entered=enteredCount();
  $('skuArea').innerHTML=`
    <div class="entry-toolbar">
      <div><b>${esc(selectedStore)}</b><div class="muted entry-progress" id="progressText">${entered} of ${rows.length} SKU${rows.length===1?'':'s'} entered</div></div>
      <button id="addSku" class="link-btn">+ Add SKU From Master</button>
    </div>
    <div id="masterPicker" class="master-picker hidden">
      <div class="master-picker-head"><b>Add SKU From Master</b><button id="closeMaster" class="picker-close">✕</button></div>
      <input id="masterSearch" class="master-search" placeholder="Search EAN / SKU / Product name…" autocomplete="off">
      <div id="masterResults" class="master-results"></div>
    </div>
    <div class="entry-table-wrap"><table class="entry-table"><thead><tr><th>EAN / SKU</th><th>Product</th><th>Stock</th><th>Tester</th><th>Total</th></tr></thead><tbody>
    ${rows.map((r,i)=>`<tr><td>${esc(r.ean)}</td><td>${esc(r.name)}</td><td><input class="entry-num" data-i="${i}" data-k="stock" type="number" min="0" step="1" value="${r.stock}"></td><td><input class="entry-num" data-i="${i}" data-k="tester" type="number" min="0" step="1" value="${r.tester}"></td><td class="total-cell" id="tot-${i}">${r.stock+r.tester}</td></tr>`).join('')}
    </tbody></table></div>`;

  document.querySelectorAll('.entry-num').forEach(x=>x.oninput=()=>{
    rows[+x.dataset.i][x.dataset.k]=Math.max(0,Number(x.value||0));
    $('tot-'+x.dataset.i).textContent=rows[+x.dataset.i].stock+rows[+x.dataset.i].tester;
    updateSummary();
  });

  $('addSku').onclick=()=>openMasterPicker();
  $('closeMaster').onclick=()=>closeMasterPicker();
  $('masterSearch').oninput=renderMasterResults;
  renderMasterResults();
  updateSummary();
}

function openMasterPicker(){
  $('masterPicker').classList.remove('hidden');
  $('masterSearch').value='';
  renderMasterResults();
  $('masterSearch').focus();
}
function closeMasterPicker(){$('masterPicker').classList.add('hidden')}

function renderMasterResults(){
  const q=($('masterSearch')?.value||'').trim().toLowerCase();
  const existing=new Set(rows.map(r=>String(r.ean).trim()));
  const options=master.filter(m=>!existing.has(String(m['EAN Code']).trim()) && (!q || String(m['EAN Code']).toLowerCase().includes(q) || String(m['Product Name']).toLowerCase().includes(q)));
  const box=$('masterResults');
  if(!box)return;
  if(!options.length){box.innerHTML='<div class="master-empty">No new SKU found in SKU Master.</div>';return}
  box.innerHTML=options.slice(0,100).map(m=>`<button class="master-option" data-ean="${esc(m['EAN Code'])}"><span><b>${esc(m['EAN Code'])}</b><small>${esc(m['Product Name'])}</small></span><span>＋</span></button>`).join('');
  box.querySelectorAll('.master-option').forEach(b=>b.onclick=()=>addMasterSku(b.dataset.ean));
}

function addMasterSku(ean){
  const found=master.find(m=>String(m['EAN Code']).trim()===String(ean).trim());
  if(!found)return;
  if(rows.some(r=>String(r.ean).trim()===String(ean).trim())){msg('SKU is already in the table.');return}
  rows.push({ean:String(found['EAN Code']),name:found['Product Name'],stock:0,tester:0});
  closeMasterPicker();
  render();
  msg(`${found['Product Name']} added from SKU Master.`,true);
}

$('email').addEventListener('blur',loadMeta);
$('email').addEventListener('keydown',e=>{if(e.key==='Enter')loadMeta()});
$('store').onchange=loadSku;

$('submitEntry').onclick=async()=>{
  if(!rows.length)return;
  const b=$('submitEntry');b.disabled=true;b.textContent='Submitting…';
  try{
    let r=await fetch('/api/submit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,store_name:selectedStore,rows:rows.map(r=>({'EAN Code':r.ean,'Stock':r.stock,'Tester':r.tester}))})});
    let j=await r.json();if(!j.ok)throw Error(j.error);
    msg(`Submitted successfully • ${j.saved_rows} SKU rows saved.`,true);
    rows.forEach(r=>{r.stock=0;r.tester=0});
    render();
  }catch(e){msg(e.message)}finally{b.disabled=false;b.textContent='Submit Stock'}
};

updateSummary();
