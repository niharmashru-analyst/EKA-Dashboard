const COLS_VERSION='v5';
let DATA=[],VAR=[],FILTERED=[],filters={},page='overview',charts=[];
let paretoMode='qty',varianceMetric='qty',varianceShop='',varianceSkuSearch='',varianceIssueOnly=false,DATA_COLUMNS=[],storePerfView='top',skuPerfView='top';
const FILTER_FIELDS=['Type','Store Name','Pareto','NOD Bucket','Stock Health'];
const SKU_FILTER_KEY='__sku';
const moneyL=n=>'₹'+Number(n||0).toLocaleString('en-IN',{maximumFractionDigits:2});
const qty=n=>Math.round(Number(n||0)).toLocaleString('en-IN');
const pct1=n=>Number(n||0).toFixed(1)+'%';
const esc=s=>String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
const sum=(a,c)=>a.reduce((x,r)=>x+Number(r[c]||0),0);
const uniq=c=>[...new Set(DATA.map(r=>r[c]).filter(x=>x!==''&&x!=null))].sort((a,b)=>String(a).localeCompare(String(b),undefined,{numeric:true}));
const valueCols=new Set(['total mrp value','l3m avg value','ly value','current month value','mrp','stock value','opening stock value','inward value','tertiary value','closing stock value','calculated closing value','difference value','actual closing value']);
const qtyCols=new Set(['stock','l3m avg qty','ly qty','current month qty','ideal stock','forecast qty','rows','avg','stock qty','opening stock qty','inward qty','tertiary qty','closing stock qty','calculated closing qty','difference qty','skucount','system stock qty','actual closing qty','nod count']);
function fmt(c,v){let k=String(c).toLowerCase();if(k==='mrp'||k==='unit mrp')return Number(v||0).toLocaleString('en-IN',{maximumFractionDigits:2});if(k==='nod')return Math.round(Number(v||0)).toLocaleString('en-IN');if(v===''||v==null)return '—';if(valueCols.has(k))return moneyL(v);if(qtyCols.has(k))return qty(v);return v}
function nodClass(v){let n=Number(v||0);return n<15?'nod-red':n<=30?'nod-yellow':'nod-green'}
function nodBucket(v){let n=Number(v||0);if(n<15)return 'NOD <15';if(n<=30)return 'NOD 15–30';if(n<=60)return 'NOD 31–60';return 'NOD >60'}
function canonicalType(v){let s=String(v??'').trim().toLowerCase();if(s==='ebo'||s.includes('exclusive brand'))return 'EBO';if(s==='kiosk'||s==='kiosks')return 'Kiosk';if(s==='airport'||s.includes('airport'))return 'Airport';return String(v??'').trim()||'Other'}
function normalizePareto(v){let s=String(v??'').trim().toLowerCase().replace(/\s+/g,' ');if(s.includes('top 10'))return 'Top 10';if(s.includes('top 25'))return 'Top 25';if(s.includes('top 50'))return 'Top 50';if(s.includes('top 100'))return 'Top 100';if(s.includes('top 200'))return 'Top 200';if(s.includes('discontinued'))return 'Discontinued';if(s.includes('tail'))return 'Tail';if(s.includes('other'))return 'Others';return String(v??'').trim()||'Others'}
const PARETO_ORDER=['Top 10','Top 25','Top 50','Top 100','Top 200','Tail','Discontinued','Others'];
function sortedParetoCats(m){const known=PARETO_ORDER.filter(k=>k in m);const extra=Object.keys(m).filter(k=>!PARETO_ORDER.includes(k)).sort((a,b)=>a.localeCompare(b));return[...known,...extra]}
// Growth % = Current Month vs LY (year-over-year). If LY was 0, the outlet/SKU
// is treated as "not active last year" rather than producing a misleading
// +infinite / -100% style number — Growth % is left null (rendered as a
// "Not Active LY" badge) so it never pollutes averages or rankings.
function growthPct(cm,ly){const l=Number(ly||0),c=Number(cm||0);return l>0?((c-l)/l*100):null}
function stockHealth(stock,l3m,nod){const s=Number(stock||0),l=Number(l3m||0);if(s>0&&l<=0)return 'Dead Stock';if(Number(nod||0)>60)return 'Slow Moving';return 'Healthy'}
function healthClass(v){return v==='Dead Stock'?'nod-red':v==='Slow Moving'?'nod-yellow':'nod-green'}
function healthCounts(rows){return {dead:rows.filter(r=>r['Stock Health']==='Dead Stock').length,slow:rows.filter(r=>r['Stock Health']==='Slow Moving').length,healthy:rows.filter(r=>r['Stock Health']==='Healthy').length}}
function cell(c,v){let k=String(c).toLowerCase();if(k==='nod')return `<span class="nod-badge ${nodClass(v)}">${fmt(c,v)}</span>`;if(k==='movement check'||k==='live submission'||k==='ly active')return `<span class="check-badge ${v?'ok':'error'}">${v?'YES':'NO'}</span>`;if(k==='growth %'){if(v===null||v===undefined||v==='')return `<span class="nod-badge nod-yellow">Not Active LY</span>`;let n=Number(v);return `<span class="${n>=0?'positive':'negative'}">${n>=0?'+':''}${n.toFixed(1)}%</span>`}if(k==='stock health')return `<span class="nod-badge ${healthClass(v)}">${esc(v)}</span>`;if(k==='performance')return `<span class="nod-badge ${v==='Top Performer'?'nod-green':v==='Underperforming'?'nod-red':'nod-yellow'}">${esc(v)}</span>`;return esc(fmt(c,v))}
function kpi(t,v,s='',cls=''){return `<div class="kpi ${cls}"><div class="k-title">${esc(t)}</div><div class="k-value">${v}</div><div class="k-sub">${esc(s)}</div></div>`}
function perfDetailTooltip(x){
  x=x||{};
  return `<b>${esc(x['Store Name']??x['Product Name']??'')}</b>`+
    `<br><span style="font-weight:600">Growth %: ${x['Growth %']===null||x['Growth %']===undefined?'Not Active LY':pct1(x['Growth %'])}</span>`+
    `<br><br><b>Quantity</b>`+
    `<br>CM: ${qty(x['Current Month Qty'])}`+
    `<br>LY: ${qty(x['LY Qty'])}`+
    `<br>L3M Avg: ${qty(x['L3M Avg Qty'])}`+
    `<br>Stock: ${qty(x.Stock)}`;
}
function chart(id,opt,clickFn){let e=document.getElementById(id);if(!e)return;try{let old=echarts.getInstanceByDom(e);if(old)old.dispose();let c=echarts.init(e);c.setOption(opt,true);c.resize();if(clickFn)c.on('click',clickFn);charts.push(c)}catch(err){e.innerHTML='<div class="empty">Chart could not render.</div>'}}
const palette=['#2563EB','#0EA5E9','#0F766E','#7C3AED','#D97706','#475569','#14B8A6','#DC2626'];
const base={color:palette,textStyle:{fontFamily:'Manrope',color:'#172033'},tooltip:{trigger:'axis',backgroundColor:'#fff',borderColor:'#D9E1EC',textStyle:{color:'#172033'}},grid:{left:55,right:45,top:70,bottom:65,containLabel:true},axisLabel:{color:'#64748B',fontSize:11},splitLine:{lineStyle:{color:'#E7EDF5'}}};
function apply(){
  let q=(filters.__q||'').toLowerCase();
  const selectedSkus=new Set(filters[SKU_FILTER_KEY]||[]);
  FILTERED=DATA
    .filter(r=>FILTER_FIELDS.every(c=>!filters[c]||!filters[c].length||filters[c].includes(String(r[c]))))
    .filter(r=>!selectedSkus.size||selectedSkus.has(String(r['EAN Code']??'').trim()))
    .filter(r=>!q||String(r['Product Name']).toLowerCase().includes(q)||String(r['EAN Code']).toLowerCase().includes(q))
}
function triggerLabel(c){let s=filters[c]||[];if(c===SKU_FILTER_KEY)return !s.length?'All SKUs':s.length<=2?s.join(', '):s.length+' SKUs selected';return !s.length?'All '+c.toLowerCase():s.length<=2?s.join(', '):s.length+' selected'}
function filterBar(){
  let h='<div class="filters"><div class="filter-head"><b>Filters</b><button id="clear" class="link">Clear all</button></div><div class="filter-grid">';
  FILTER_FIELDS.forEach(c=>{
    let opts=uniq(c),sel=new Set(filters[c]||[]);
    h+=`<div class="filter"><label>${esc(c)}</label><div class="multi" data-col="${esc(c)}"><button class="multi-trigger" type="button"><span>${esc(triggerLabel(c))}</span><span>⌄</span></button><div class="multi-menu"><input class="multi-search" placeholder="Search…"><div class="multi-options">${opts.map(v=>`<label class="multi-option"><input type="checkbox" value="${esc(v)}" ${sel.has(v)?'checked':''}><span>${esc(v)}</span></label>`).join('')}</div><div class="multi-foot"><button class="link-btn select-visible" type="button">Select visible</button><button class="link-btn clear-one" type="button">Clear</button></div></div></div></div>`
  });
  const skuOpts=[...new Map(DATA.map(r=>{
    const e=String(r['EAN Code']??'').trim(),n=String(r['Product Name']??'').trim();
    return [e,{ean:e,name:n}]
  }).filter(([e])=>e).sort((a,b)=>a[0].localeCompare(b[0],undefined,{numeric:true})))];
  const skuSel=new Set(filters[SKU_FILTER_KEY]||[]);
  h+=`<div class="filter"><label>SKU / EAN — Multiple Select</label><div class="multi" data-col="${SKU_FILTER_KEY}"><button class="multi-trigger" type="button"><span>${esc(triggerLabel(SKU_FILTER_KEY))}</span><span>⌄</span></button><div class="multi-menu"><input class="multi-search" placeholder="Search SKU, EAN or product name…"><div class="multi-options">${skuOpts.map(([e,x])=>`<label class="multi-option" title="${esc(x.name)}"><input type="checkbox" value="${esc(e)}" ${skuSel.has(e)?'checked':''}><span><b>${esc(e)}</b>${x.name?` — ${esc(x.name)}`:''}</span></label>`).join('')}</div><div class="multi-foot"><button class="link-btn select-visible" type="button">Select visible</button><button class="link-btn clear-one" type="button">Clear</button></div></div></div></div>`;
  h+=`</div></div>`;return h
}
function renderFilters(){
  document.getElementById('filterBar').innerHTML=filterBar();
  document.querySelectorAll('.multi').forEach(m=>{
    let c=m.dataset.col;
    m.querySelector('.multi-trigger').onclick=e=>{
      e.stopPropagation();
      document.querySelectorAll('.multi.open').forEach(x=>x.classList.remove('open'));
      m.classList.add('open');
    };
    m.querySelector('.multi-menu').onclick=e=>e.stopPropagation();
    const search=m.querySelector('.multi-search');
    search.oninput=e=>{
      let q=e.target.value.toLowerCase();
      m.querySelectorAll('.multi-option').forEach(x=>{
        x.style.display=x.textContent.toLowerCase().includes(q)?'':'none';
      });
    };
    let lastIndex=-1;
    const boxes=[...m.querySelectorAll('.multi-option input')];
    boxes.forEach((cb,i)=>{
      cb.onchange=e=>{
        if(e.shiftKey && lastIndex>=0){
          const from=Math.min(lastIndex,i),to=Math.max(lastIndex,i);
          boxes.slice(from,to+1).forEach(b=>b.checked=cb.checked);
        }
        lastIndex=i;
        const v=boxes.filter(b=>b.checked).map(b=>b.value);
        v.length?filters[c]=v:delete filters[c];
        render();
      };
    });
    m.querySelector('.select-visible').onclick=()=>{
      const visible=boxes.filter(b=>b.closest('.multi-option').style.display!=='none');
      visible.forEach(b=>b.checked=true);
      const v=boxes.filter(b=>b.checked).map(b=>b.value);
      v.length?filters[c]=v:delete filters[c];
      render();
    };
    m.querySelector('.clear-one').onclick=()=>{delete filters[c];render()};
  });
  document.getElementById('clear').onclick=()=>{filters={};render()};
}
document.addEventListener('click',()=>document.querySelectorAll('.multi.open').forEach(x=>x.classList.remove('open')));
function getCols(id,baseCols){try{let x=JSON.parse(localStorage.getItem(COLS_VERSION+'_cols_'+id)||'null');if(Array.isArray(x))return x.filter(c=>baseCols.includes(c)).concat(baseCols.filter(c=>!x.includes(c)))}catch(_){}return baseCols}
function columnChooser(id,cols){return `<div class="column-picker hidden" id="picker-${esc(id)}"><div class="column-picker-head"><b>Change column sequence</b><button class="picker-close" data-close-picker="${esc(id)}">✕</button></div><div id="picker-list-${esc(id)}">${cols.map((c,i)=>`<div class="column-item" draggable="true" data-col="${esc(c)}"><span class="column-drag">☷</span><span>${esc(c)}</span><span><button data-up="${esc(c)}" ${i?'':'disabled'}>▲</button><button data-down="${esc(c)}" ${i<cols.length-1?'':'disabled'}>▼</button></span></div>`).join('')}</div><div class="column-picker-foot"><button class="btn small" data-save-cols="${esc(id)}">Apply</button><button class="btn secondary small" data-reset-cols="${esc(id)}">Reset</button></div></div>`}
function table(rows,cols,id,limit=250,rowClickCol=null){
  cols=getCols(id,cols);
  const safeRows=(rows||[]).some(r=>Object.prototype.hasOwnProperty.call(r,'Pareto'))?paretoSort(rows):((rows||[]).slice());
  const pageSize=Math.min(Math.max(Number(limit)||250,50),500);
  const stateKey='__tablePage_'+id;
  const page=Math.max(0,Math.min(Number(window[stateKey]||0),Math.max(0,Math.ceil(safeRows.length/pageSize)-1)));
  const start=page*pageSize;
  const shown=safeRows.slice(start,start+pageSize);
  const pages=Math.max(1,Math.ceil(safeRows.length/pageSize));
  return `<div class="table-tools"><div class="muted">${safeRows.length.toLocaleString('en-IN')} rows${safeRows.length>pageSize?' • paginated for performance':''}</div><button class="btn secondary small" data-open-picker="${esc(id)}">⚙ Columns</button>${columnChooser(id,cols)}</div><div class="table-wrap"><table data-sort-id="${esc(id)}"><thead><tr>${cols.map(c=>`<th class="eka-sortable" title="Click to sort">${esc(c)}</th>`).join('')}</tr></thead><tbody>${shown.map((r,ri)=>`<tr data-row-index="${start+ri}" ${rowClickCol?'data-click-value="'+esc(r[rowClickCol]??'')+'"':''}>${cols.map(c=>`<td class="${typeof r[c]==='number'?'num':''}">${cell(c,r[c])}</td>`).join('')}</tr>`).join('')}</tbody></table></div><div class="table-foot table-pagination"><button class="btn secondary small" data-table-page="${esc(id)}" data-page-dir="-1" ${page<=0?'disabled':''}>‹ Prev</button><span>Page ${page+1} of ${pages}</span><button class="btn secondary small" data-table-page="${esc(id)}" data-page-dir="1" ${page>=pages-1?'disabled':''}>Next ›</button></div>`
}
document.addEventListener('dragstart',e=>{const item=e.target.closest('.column-item');if(!item)return;item.classList.add('dragging');e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text/plain',item.dataset.col);});
document.addEventListener('dragend',e=>{e.target.closest('.column-item')?.classList.remove('dragging');});
document.addEventListener('dragover',e=>{const item=e.target.closest('.column-item');const list=e.target.closest('[id^="picker-list-"]');if(!item||!list)return;e.preventDefault();const dragging=list.querySelector('.column-item.dragging');if(!dragging||dragging===item)return;const r=item.getBoundingClientRect();list.insertBefore(dragging,e.clientY<r.top+r.height/2?item:item.nextSibling);});

document.addEventListener('click',e=>{let o=e.target.closest('[data-open-picker]');if(o){document.querySelectorAll('.column-picker').forEach(x=>x.classList.add('hidden'));document.getElementById('picker-'+o.dataset.openPicker)?.classList.remove('hidden')}let close=e.target.closest('[data-close-picker]');if(close)document.getElementById('picker-'+close.dataset.closePicker)?.classList.add('hidden');let up=e.target.closest('[data-up]'),down=e.target.closest('[data-down]');if(up||down){let p=(up||down).closest('.column-picker'),list=[...p.querySelectorAll('.column-item')],i=list.findIndex(x=>x.dataset.col===(up||down).dataset[up?'up':'down']);let j=up?i-1:i+1;if(i<0||j<0||j>=list.length)return;list[j].parentNode.insertBefore(list[i],up?list[j]:list[j].nextSibling);[...p.querySelectorAll('button[data-up],button[data-down]')].forEach(b=>{let items=[...p.querySelectorAll('.column-item')],ix=items.findIndex(x=>x.dataset.col===b.dataset.up||x.dataset.col===b.dataset.down);b.disabled=b.hasAttribute('data-up')?ix===0:ix===items.length-1})}let save=e.target.closest('[data-save-cols]');if(save){let p=document.getElementById('picker-'+save.dataset.saveCols),arr=[...p.querySelectorAll('.column-item')].map(x=>x.dataset.col);localStorage.setItem(COLS_VERSION+'_cols_'+save.dataset.saveCols,JSON.stringify(arr));p.classList.add('hidden');render()}let reset=e.target.closest('[data-reset-cols]');if(reset){localStorage.removeItem(COLS_VERSION+'_cols_'+reset.dataset.resetCols);render()}});
function chartFormat(v,mode){return mode==='value'?moneyL(v):qty(v)}
function paretoSummary(d){let m={};d.forEach(r=>{let p=normalizePareto(r.Pareto);m[p]??={stockQty:0,stockVal:0,l3mQty:0,l3mVal:0,cmQty:0,cmVal:0,lyQty:0,lyVal:0};let g=m[p];g.stockQty+=+r.Stock||0;g.stockVal+=+r['Total MRP Value']||0;g.l3mQty+=+r['L3M Avg Qty']||0;g.l3mVal+=+r['L3M Avg Value']||0;g.cmQty+=+r['Current Month Qty']||0;g.cmVal+=+r['Current Month Value']||0;g.lyQty+=+r['LY Qty']||0;g.lyVal+=+r['LY Value']||0});return m}
function overview(){let d=FILTERED,byType={};d.forEach(r=>{let t=canonicalType(r.Type);byType[t]??={ly:0,l3m:0,cm:0,lyVal:0,l3mVal:0,cmVal:0};byType[t].ly+=+r['LY Qty']||0;byType[t].l3m+=+r['L3M Avg Qty']||0;byType[t].cm+=+r['Current Month Qty']||0;byType[t].lyVal+=+r['LY Value']||0;byType[t].l3mVal+=+r['L3M Avg Value']||0;byType[t].cmVal+=+r['Current Month Value']||0});let types=['EBO','Kiosk','Airport'];types.forEach(t=>{byType[t]??={ly:0,l3m:0,cm:0,lyVal:0,l3mVal:0,cmVal:0}});let p=paretoSummary(d),cats=sortedParetoCats(p),overviewSkuRows=aggregateSku(d),overviewNc=nodCounts(overviewSkuRows),overviewNod=totalNod(overviewSkuRows);document.getElementById('app').innerHTML=`<div class="kpi-section"><div class="kpi-row-label">QUANTITY</div><div class="kpis kpis-4">${kpi('Stock Qty',qty(sum(d,'Stock')),'Current stock')}${kpi('LY Qty',qty(sum(d,'LY Qty')),'Last year')}${kpi('L3M Avg Qty',qty(sum(d,'L3M Avg Qty')),'Run rate')}${kpi('Current Month Qty',qty(sum(d,'Current Month Qty')),'Current month')}</div><div class="kpi-row-label">NOD DETAILS</div><div class="kpis kpis-6">${kpi('NOD',qty(overviewNod)+' Days','Overall stock cover')}${kpi('NOD <15',qty(overviewNc.lt15),'SKU count','bad')}${kpi('NOD 15–30',qty(overviewNc.n15_30),'SKU count')}${kpi('NOD 31–60',qty(overviewNc.n31_60),'SKU count')}${kpi('NOD >60',qty(overviewNc.gt60),'SKU count','bad')}${kpi('Dead Stock SKUs',qty(overviewSkuRows.filter(r=>r['Stock Health']==='Dead Stock').length),'Stock but no L3M movement','bad')}</div></div><div class="grid2"><div class="card"><div class="card-title">Pareto Contribution — Quantity</div><div id="paretoChart" class="chart"></div></div><div class="card"><div class="card-title">Stock vs L3M Average — Quantity</div><div id="stockSalesChart" class="chart"></div></div></div><div class="card"><div class="card-title">Type-wise Sales — Quantity</div><div id="typeQtyChart" class="chart"></div></div>`;let total=p?Object.values(p).reduce((a,x)=>a+(paretoMode==='value'?x.stockVal:x.stockQty),0):0;chart('paretoChart',{...base,tooltip:{trigger:'item',formatter:q=>{let g=p[q.name]||{};let lines=[`<b>${esc(q.name)}</b>`,`Contribution: ${pct1(q.percent)}`];if(paretoMode==='value')lines.push(`Stock Value: ${moneyL(g.stockVal)}`,`L3M Avg Value: ${moneyL(g.l3mVal)}`,`Current Month Value: ${moneyL(g.cmVal)}`,`LY Value: ${moneyL(g.lyVal)}`);else lines.push(`Stock Qty: ${qty(g.stockQty)}`,`L3M Avg Qty: ${qty(g.l3mQty)}`,`Current Month Qty: ${qty(g.cmQty)}`,`LY Qty: ${qty(g.lyQty)}`);return lines.join('<br>')},},series:[{type:'pie',radius:['42%','68%'],data:cats.map(k=>({name:k,value:paretoMode==='value'?p[k].stockVal:p[k].stockQty})),label:{show:true,formatter:q=>`${q.name}\n${paretoMode==='value'?moneyL(q.value):qty(q.value)} (${pct1(q.percent)})`},labelLine:{show:true}}]});let stockSales= cats.map(k=>p[k]);chart('stockSalesChart',{...base,legend:{show:true,top:5},grid:{...base.grid,bottom:cats.length>6?95:75},dataZoom:cats.length>8?[{type:'inside'},{type:'slider',bottom:8,height:16}]:undefined,tooltip:{trigger:'axis',axisPointer:{type:'shadow'},backgroundColor:'#fff',borderColor:'#D9E1EC',textStyle:{color:'#172033'},formatter:ps=>{let i=ps[0]?.dataIndex??0,name=cats[i],g=p[name]||{};let lines=[`<b>${esc(name)}</b>`];if(paretoMode==='value')lines.push(`Stock Value: ${moneyL(g.stockVal)}`,`L3M Avg Value: ${moneyL(g.l3mVal)}`);else lines.push(`Stock Qty: ${qty(g.stockQty)}`,`L3M Avg Qty: ${qty(g.l3mQty)}`);return lines.join('<br>')}},xAxis:{type:'category',data:cats,axisLabel:{rotate:cats.length>5?32:0,interval:0,fontSize:10,formatter:v=>String(v).length>14?String(v).slice(0,14)+'…':v}},yAxis:{type:'value',axisLabel:{formatter:v=>chartFormat(v,paretoMode)}},series:[{name:paretoMode==='value'?'Stock Value':'Stock Qty',type:'bar',data:stockSales.map(x=>paretoMode==='value'?x.stockVal:x.stockQty),barMaxWidth:28,label:{show:false}},{name:paretoMode==='value'?'L3M Avg Value':'L3M Avg Qty',type:'bar',data:stockSales.map(x=>paretoMode==='value'?x.l3mVal:x.l3mQty),barMaxWidth:28,label:{show:false}}]});chart('typeQtyChart',{...base,legend:{show:true,top:5},xAxis:{type:'category',data:types},yAxis:{type:'value',axisLabel:{formatter:qty}},series:[{name:'LY Qty',type:'bar',data:types.map(t=>byType[t].ly),label:{show:true,position:'top',formatter:q=>qty(q.value)}},{name:'L3M Avg Qty',type:'bar',data:types.map(t=>byType[t].l3m),label:{show:true,position:'top',formatter:q=>qty(q.value)}},{name:'CM Qty',type:'bar',data:types.map(t=>byType[t].cm),label:{show:true,position:'top',formatter:q=>qty(q.value)}}]});chart('typeValueChart',{...base,legend:{show:true,top:5},xAxis:{type:'category',data:types},yAxis:{type:'value',axisLabel:{formatter:moneyL}},series:[{name:'LY Value',type:'bar',data:types.map(t=>byType[t].lyVal),label:{show:true,position:'top',formatter:q=>moneyL(q.value)}},{name:'L3M Avg Value',type:'bar',data:types.map(t=>byType[t].l3mVal),label:{show:true,position:'top',formatter:q=>moneyL(q.value)}},{name:'CM Value',type:'bar',data:types.map(t=>byType[t].cmVal),label:{show:true,position:'top',formatter:q=>moneyL(q.value)}}]})}
function totalNod(rows){const stock=sum(rows,'Stock'),l3m=sum(rows,'L3M Avg Qty');return l3m>0?stock*31/l3m:0}
function nodCounts(rows){
  return {
    total:rows.filter(r=>Number(r['L3M Avg Qty']||0)>0).length,
    lt15:rows.filter(r=>Number(r['L3M Avg Qty']||0)>0 && Number(r.NOD)<15).length,
    n15_30:rows.filter(r=>Number(r['L3M Avg Qty']||0)>0 && Number(r.NOD)>=15 && Number(r.NOD)<=30).length,
    n31_60:rows.filter(r=>Number(r['L3M Avg Qty']||0)>0 && Number(r.NOD)>30 && Number(r.NOD)<=60).length,
    gt60:rows.filter(r=>Number(r['L3M Avg Qty']||0)>0 && Number(r.NOD)>60).length
  }
}
function isNumericColumn(rows,c){
  let vals=rows.map(r=>r[c]).filter(v=>v!==''&&v!=null);
  if(!vals.length)return false;
  return vals.filter(v=>typeof v==='number' || (typeof v==='string'&&v.trim()!==''&&Number.isFinite(Number(v)))).length/vals.length>=0.8;
}
function aggregateBy(rows,keyCol,countCols=[]){
  // Aggregate at the requested business grain while retaining EVERY source
  // Excel column in the resulting row. Numeric source columns are summed;
  // descriptive columns use the first non-blank value; columns listed in
  // countCols are instead replaced with a distinct-count label (e.g. "23
  // Outlets") since a single arbitrary value for them would be misleading
  // and made the aggregated table look like a plain per-row data dump.
  const groups=new Map();
  const sourceCols=[...DATA_COLUMNS];
  const numericCols=sourceCols.filter(c=>c!==keyCol && isNumericColumn(rows,c));
  rows.forEach(r=>{
    const raw=r[keyCol];
    const key=String(raw??'').trim();
    if(!key)return; // do not create a fake blank outlet/SKU
    if(!groups.has(key)){
      const g={};
      sourceCols.forEach(c=>g[c]=r[c]);
      g[keyCol]=key;
      numericCols.forEach(c=>g[c]=0);
      g['__rowCount']=0;
      countCols.forEach(c=>g['__set_'+c]=new Set());
      groups.set(key,g);
    }
    const g=groups.get(key);
    sourceCols.forEach(c=>{
      if(numericCols.includes(c)) g[c]=(Number(g[c])||0)+(Number(r[c])||0);
      else if((g[c]===undefined || g[c]===null || String(g[c]).trim()==='') && r[c]!==undefined) g[c]=r[c];
    });
    countCols.forEach(c=>{const v=String(r[c]??'').trim();if(v)g['__set_'+c].add(v)});
    g['__rowCount']++;
  });
  return [...groups.values()].map(g=>{
    const avg=Number(g['L3M Avg Qty']||0);
    g.NOD=avg>0 ? Number(g.Stock||0)*31/avg : 0;
    g['NOD Bucket']=nodBucket(g.NOD);
    g['Forecast Qty']=Number(g['Forecast Qty']||0);
    if(!g['Forecast Qty']){
      const p=normalizePareto(g.Pareto);
      const months=p==='Top 10'?2:p==='Top 25'?1.5:1;
      g['Forecast Qty']=avg*months;
    }
    g['Growth %']=growthPct(g['Current Month Qty'],g['LY Qty']);
    g['LY Active']=Number(g['LY Qty']||0)>0;
    g['Stock Health']=stockHealth(g.Stock,g['L3M Avg Qty'],g.NOD);
    const countLabel={'Store Name':'Outlets','EAN Code':'SKUs','Product Name':'Products'};
    countCols.forEach(c=>{
      const set=g['__set_'+c];
      g[c]=set.size<=1?(set.size?[...set][0]:g[c]):`${set.size} ${countLabel[c]||c+' variants'}`;
      delete g['__set_'+c];
    });
    return g;
  });
}
function aggregateSku(rows){
  // SKU Explorer = exactly one row per unique Product Name.
  // NOTE: EAN Code is NOT used as the grouping key — in this data the same
  // product can carry a different EAN Code per outlet, so grouping by EAN
  // failed to merge rows at all and the "aggregated" table looked identical
  // to the raw per-row Data Table. Product Name is the field that stays
  // consistent for the same SKU across outlets, so it is the true key.
  // The EAN Code / Store Name columns are shown as distinct-count labels
  // (via countCols) instead of one arbitrary outlet's EAN/store.
  return aggregateBy(rows,'Product Name',['Store Name','EAN Code']);
}
function aggregateStore(rows){
  // Store Analysis = exactly one row per unique outlet/store. EAN Code and
  // Product Name are shown as distinct-count labels (e.g. "312 SKUs") since
  // a store carries many SKUs, not one.
  return aggregateBy(rows,'Store Name',['EAN Code','Product Name']);
}
function isValueColumn(c){
  const k=String(c||'').trim().toLowerCase();
  return k.includes(' value') || k.endsWith('value') || k.includes('total mrp value') || k.includes('difference value') || k.includes('stock value');
}
function tableCols(rows){
  const source=DATA_COLUMNS.filter(c=>rows.some(r=>Object.prototype.hasOwnProperty.call(r,c)) && !isValueColumn(c));
  const extras=[];
  if(rows.some(r=>Object.prototype.hasOwnProperty.call(r,'Forecast Qty')))extras.push('Forecast Qty');
  if(rows.some(r=>Object.prototype.hasOwnProperty.call(r,'NOD')))extras.push('NOD');
  if(rows.some(r=>Object.prototype.hasOwnProperty.call(r,'NOD Bucket')))extras.push('NOD Bucket');
  if(rows.some(r=>Object.prototype.hasOwnProperty.call(r,'Growth %')))extras.push('Growth %');
  if(rows.some(r=>Object.prototype.hasOwnProperty.call(r,'LY Active')))extras.push('LY Active');
  if(rows.some(r=>Object.prototype.hasOwnProperty.call(r,'Stock Health')))extras.push('Stock Health');
  if(rows.some(r=>Object.prototype.hasOwnProperty.call(r,'Performance')))extras.push('Performance');
  if(rows.some(r=>Object.prototype.hasOwnProperty.call(r,'Rank')))extras.push('Rank');
  return source.concat(extras.filter(c=>!source.includes(c) && !isValueColumn(c)));
}
function paretoRank(v){const p=normalizePareto(v);const i=PARETO_ORDER.indexOf(p);return i<0?PARETO_ORDER.length:i}
function paretoSort(rows){
  return (rows||[]).slice().sort((a,b)=>{
    const pa=paretoRank(a.Pareto), pb=paretoRank(b.Pareto);
    if(pa!==pb)return pa-pb;
    const sa=Number(a.Stock||0), sb=Number(b.Stock||0);
    if(sb!==sa)return sb-sa;
    return String(a['Product Name']??a['Store Name']??a['EAN Code']??'').localeCompare(String(b['Product Name']??b['Store Name']??b['EAN Code']??''),undefined,{numeric:true,sensitivity:'base'});
  });
}
function comboSkuOption(id,arr,title){if(!arr.length){document.getElementById(id).innerHTML='<div class="empty">No SKUs available.</div>';return}let a=arr.slice().sort((x,y)=>(+y.Stock||0)-(+x.Stock||0)).slice(0,5);chart(id,{...base,animation:false,grid:{left:55,right:25,top:55,bottom:90,containLabel:true},tooltip:{trigger:'axis',axisPointer:{type:'shadow'},formatter:ps=>{let i=ps[0]?.dataIndex??0,x=a[i]||{};return `<b>${esc(x['Product Name'])}</b><br>Stock: ${qty(x.Stock)}<br>L3M Avg: ${qty(x['L3M Avg Qty'])}<br>CM: ${qty(x['Current Month Qty'])}<br>LY: ${qty(x['LY Qty'])}`}},legend:{show:true,top:5},xAxis:{type:'category',data:a.map(x=>x['Product Name']),axisLabel:{rotate:25,fontSize:9,interval:0,formatter:v=>String(v).length>20?String(v).slice(0,20)+'…':v}},yAxis:{type:'value',axisLabel:{formatter:qty}},series:[{name:'Stock Qty',type:'bar',data:a.map(x=>+x.Stock||0),barMaxWidth:32,label:{show:true,position:'top',formatter:q=>qty(q.value)}},{name:'L3M Avg',type:'line',data:a.map(x=>+x['L3M Avg Qty']||0),symbol:'circle',symbolSize:7},{name:'CM',type:'line',data:a.map(x=>+x['Current Month Qty']||0),symbol:'circle',symbolSize:7},{name:'LY',type:'line',data:a.map(x=>+x['LY Qty']||0),symbol:'circle',symbolSize:7}]},()=>openChartModal(title,arr))}
function openChartModal(title,arr){
  let ov=document.getElementById('modalOverlay');
  document.getElementById('modalTitle').textContent=title+' — Full View';
  document.getElementById('modalSub').textContent=`${arr.length} SKUs • quantity view`;
  document.getElementById('modalBody').innerHTML=`<div class="modal-tools"><span class="muted">All SKUs shown below • Quantity only</span></div><div id="modalChart" class="modal-chart"></div>`;
  ov.classList.add('open');
  requestAnimationFrame(()=>{let el=document.getElementById('modalChart');if(!el)return;let c=echarts.init(el);c.setOption({...base,animation:false,grid:{left:75,right:55,top:85,bottom:125,containLabel:true},tooltip:{trigger:'axis',axisPointer:{type:'shadow'},formatter:ps=>{let i=ps[0]?.dataIndex??0,x=arr[i]||{};return `<b>${esc(x['Product Name'])}</b><br>Stock: ${qty(x.Stock)}<br>L3M Avg: ${qty(x['L3M Avg Qty'])}<br>CM: ${qty(x['Current Month Qty'])}<br>LY: ${qty(x['LY Qty'])}`}},legend:{show:true,top:8},dataZoom:[{type:'inside'},{type:'slider',bottom:18,height:18,start:0,end:100}],xAxis:{type:'category',data:arr.map(x=>x['Product Name']),axisLabel:{rotate:35,interval:0,fontSize:10,formatter:v=>String(v).length>26?String(v).slice(0,26)+'…':v}},yAxis:{type:'value',axisLabel:{formatter:qty}},series:[{name:'Stock Qty',type:'bar',data:arr.map(x=>+x.Stock||0),barMaxWidth:34},{name:'L3M Avg Qty',type:'line',data:arr.map(x=>+x['L3M Avg Qty']||0),symbol:'circle',symbolSize:7},{name:'CM Qty',type:'line',data:arr.map(x=>+x['Current Month Qty']||0),symbol:'circle',symbolSize:7},{name:'LY Qty',type:'line',data:arr.map(x=>+x['LY Qty']||0),symbol:'circle',symbolSize:7}]});c.resize();charts.push(c)});
}
function products(){
  const rows=aggregateSku(FILTERED);
  const top10=rows.filter(x=>normalizePareto(x.Pareto)==='Top 10').sort((a,b)=>(+b.Stock||0)-(+a.Stock||0));
  const top25=rows.filter(x=>normalizePareto(x.Pareto)==='Top 25').sort((a,b)=>(+b.Stock||0)-(+a.Stock||0));
  const nc=nodCounts(rows);
  const hc=healthCounts(rows);
  const cols=tableCols(rows);
  document.getElementById('app').innerHTML=`<div class="kpis kpis-4">${kpi('Total Unique SKUs',qty(rows.length),'One row per unique SKU')}${kpi('Stock Qty',qty(sum(rows,'Stock')),'Current stock')}${kpi('NOD',qty(totalNod(rows))+' Days','Overall stock cover')}</div><div class="kpis kpis-5">${kpi('NOD <15',qty(nc.lt15),'SKU count','bad')}${kpi('NOD 15–30',qty(nc.n15_30),'SKU count')}${kpi('NOD 31–60',qty(nc.n31_60),'SKU count')}${kpi('NOD >60',qty(nc.gt60),'SKU count','bad')}${kpi('Dead Stock SKUs',qty(hc.dead),'Stock but no L3M movement','bad')}</div><div class="grid2"><div class="card clickable-card"><div class="card-title">Top 10 Pareto SKUs — Top 5 Preview <span class="muted">Click chart for all 10</span></div><div id="top10Chart" class="chart"></div></div><div class="card clickable-card"><div class="card-title">Top 25 Pareto SKUs — Top 5 Preview <span class="muted">Click chart for all 25</span></div><div id="top25Chart" class="chart"></div></div></div><div class="card"><div class="card-title">Best &amp; Worst Performing SKUs <span class="muted">By Growth % (Current Month vs LY)</span> <span class="seg"><button id="skuPerfTop" class="${skuPerfView==='top'?'active':''}">Top Performing</button><button id="skuPerfWorst" class="${skuPerfView==='worst'?'active':''}">Low Performing</button></span></div><div id="skuPerfRankChart" class="chart chart-tall"></div><div class="rank-detail-wrap"><div class="card-title rank-detail-title">${skuPerfView==='worst'?'Worst 10':'Top 10'} SKU Sales Details <span class="muted">Quantity • CM, LY, L3M Avg &amp; Stock</span></div><div class="table-wrap rank-detail-table"><table><thead><tr><th>Rank</th><th>EAN Code</th><th>Product Name</th><th>Growth %</th><th>CM Qty</th><th>LY Qty</th><th>L3M Avg Qty</th><th>Stock Qty</th></tr></thead><tbody id="skuRankDetails"></tbody></table></div></div></div><div class="card"><div class="card-title">SKU Explorer <span class="muted">${rows.length.toLocaleString('en-IN')} unique SKUs • click a row to see every outlet for that SKU</span></div>${table(rows,cols,'products',250,'Product Name')}</div>`;
  comboSkuOption('top10Chart',top10,'Top 10 Pareto SKUs');
  comboSkuOption('top25Chart',top25,'Top 25 Pareto SKUs');
  const skuPerfSorted=rows.filter(r=>r['Growth %']!==null&&r['Growth %']!==undefined).slice().sort((a,b)=>(b['Growth %']??-Infinity)-(a['Growth %']??-Infinity));
  const skuPerfCutoff=Math.min(10,skuPerfSorted.length);
  const skuRankRows=skuPerfView==='worst'?skuPerfSorted.slice(-skuPerfCutoff).reverse():skuPerfSorted.slice(0,skuPerfCutoff);
  const skuChartRows=skuRankRows.slice().reverse();
  const skuDetailBody=document.getElementById('skuRankDetails');
  if(skuDetailBody){
    skuDetailBody.innerHTML=skuRankRows.map((x,i)=>`<tr>
      <td>${i+1}</td><td>${esc(x['EAN Code']??'')}</td><td>${esc(x['Product Name']??'')}</td>
      <td class="num">${pct1(x['Growth %'])}</td>
      <td class="num">${qty(x['Current Month Qty'])}</td>
      <td class="num">${qty(x['LY Qty'])}</td>
      <td class="num">${qty(x['L3M Avg Qty'])}</td>
      <td class="num">${qty(x.Stock)}</td>
    </tr>`).join('');
  }
  if(skuChartRows.length)chart('skuPerfRankChart',{...base,grid:{left:95,right:85,top:20,bottom:20,containLabel:true},tooltip:{trigger:'item',formatter:q=>perfDetailTooltip(q.data?.sku)},xAxis:{type:'value',axisLabel:{formatter:v=>pct1(v)}},yAxis:{type:'category',data:skuChartRows.map(x=>x['Product Name']),axisLabel:{fontSize:9,formatter:v=>String(v).length>28?String(v).slice(0,28)+'…':v}},series:[{name:'Growth %',type:'bar',data:skuChartRows.map(x=>({value:+x['Growth %'].toFixed(1),itemStyle:{color:x['Growth %']>=0?'#0F766E':'#DC2626'},sku:x})),label:{show:true,position:'right',formatter:q=>pct1(q.value)}}]});
  else document.getElementById('skuPerfRankChart').innerHTML='<div class="empty">No SKUs with LY sales to calculate Growth yet.</div>';
  document.getElementById('skuPerfTop')?.addEventListener('click',()=>{skuPerfView='top';products()});
  document.getElementById('skuPerfWorst')?.addEventListener('click',()=>{skuPerfView='worst';products()});

  document.querySelectorAll('table[data-sort-id="products"] tbody tr').forEach(tr=>tr.onclick=()=>{
    const key=tr.dataset.clickValue;
    const detail=FILTERED.filter(x=>String(x['Product Name']??'').trim()===String(key).trim());
    if(detail.length)openDetailModal(key,'All outlets for this SKU',detail,'sku');
  });
}

function stores(){
  const rows=aggregateStore(FILTERED);
  const skuRows=aggregateSku(FILTERED);
  const nc=nodCounts(skuRows);
  const hc=healthCounts(rows);
  const top=rows.slice().sort((a,b)=>(+b.Stock||0)-(+a.Stock||0)).slice(0,15);
  const mom=rows.slice().sort((a,b)=>Math.abs((+b['Current Month Qty']||0)-(+b['LY Qty']||0))-Math.abs((+a['Current Month Qty']||0)-(+a['LY Qty']||0))).slice(0,12);
  const types=['EBO','Kiosk','Airport'];
  // Store performance ranking — rank every outlet by Growth % (CM vs LY)
  // without reordering the main table, and tag the top/bottom
  // ~20% so under/over performers are easy to spot at a glance.
  const perfSorted=rows.slice().sort((a,b)=>(b['Growth %']??-Infinity)-(a['Growth %']??-Infinity));
  const cutoff=Math.max(1,Math.ceil(rows.length*0.2));
  const rankMap=new Map(perfSorted.map((r,i)=>[r['Store Name'],i+1]));
  rows.forEach(r=>{const rank=rankMap.get(r['Store Name']);r['Rank']=rank;r['Performance']=rank<=cutoff?'Top Performer':rank>rows.length-cutoff?'Underperforming':'Steady'});
  let cols=tableCols(rows);
  cols=['Rank',...cols.filter(c=>c!=='Rank')];
  document.getElementById('app').innerHTML=`<div class="kpis kpis-4">${kpi('Total Stores',qty(rows.length),'One row per unique outlet')}${kpi('Stock Qty',qty(sum(rows,'Stock')),'Current stock')}${kpi('L3M Avg Qty',qty(sum(rows,'L3M Avg Qty')),'Run rate')}</div><div class="kpis kpis-4">${kpi('Current Month Qty',qty(sum(rows,'Current Month Qty')),'Current month')}${kpi('LY Qty',qty(sum(rows,'LY Qty')),'Last year')}${kpi('NOD',qty(totalNod(rows))+' Days','Overall stock cover')}${kpi('CM vs LY',(growthPct(sum(rows,'Current Month Qty'),sum(rows,'LY Qty'))==null?'Not Active LY':pct1(growthPct(sum(rows,'Current Month Qty'),sum(rows,'LY Qty')))),'Growth')}</div><div class="kpis kpis-5">${kpi('NOD <15',qty(nc.lt15),'SKU count','bad')}${kpi('NOD 15–30',qty(nc.n15_30),'SKU count')}${kpi('NOD 31–60',qty(nc.n31_60),'SKU count')}${kpi('NOD >60',qty(nc.gt60),'SKU count','bad')}${kpi('Dead Stock Outlets',qty(hc.dead),'Stock but no L3M movement','bad')}</div><div class="grid2"><div class="card"><div class="card-title">Store Stock vs Sales Run Rate — Top 15</div><div id="storePerfChart" class="chart chart-tall"></div></div><div class="card"><div class="card-title">Store Sales Momentum — Top 12</div><div id="storeMomentumChart" class="chart chart-tall"></div></div></div><div class="grid2"><div class="card"><div class="card-title">Store NOD Distribution</div><div id="storeNodChart" class="chart"></div></div><div class="card"><div class="card-title">Type-wise Store Performance</div><div id="storeTypeChart" class="chart"></div></div></div><div class="card"><div class="card-title">Best &amp; Worst Performing Stores <span class="muted">By Growth % (Current Month vs LY)</span> <span class="seg"><button id="spTop" class="${storePerfView==='top'?'active':''}">Top Performing</button><button id="spWorst" class="${storePerfView==='worst'?'active':''}">Worst Performing</button></span></div><div id="storePerfRankChart" class="chart chart-tall"></div><div class="rank-detail-wrap"><div class="card-title rank-detail-title">${storePerfView==='worst'?'Worst 10':'Top 10'} Store Sales Details <span class="muted">Quantity • CM, LY, L3M Avg & Stock</span></div><div class="table-wrap rank-detail-table"><table><thead><tr><th>Rank</th><th>Store Name</th><th>Growth %</th><th>CM Qty</th><th>LY Qty</th><th>L3M Avg Qty</th><th>Stock Qty</th></tr></thead><tbody id="storeRankDetails"></tbody></table></div></div></div><div class="card"><div class="card-title">Store Analysis <span class="muted">${rows.length.toLocaleString('en-IN')} unique outlets • click a row to see every SKU in that outlet</span></div>${table(rows,cols,'stores',Infinity,'Store Name')}</div>`;
  const topR=top.slice().reverse();
  chart('storePerfChart',{...base,legend:{show:true,top:5},dataZoom:[{type:'inside'},{type:'slider',bottom:8,height:16}],xAxis:{type:'value',axisLabel:{formatter:qty}},yAxis:{type:'category',data:topR.map(x=>x['Store Name']),axisLabel:{fontSize:9}},series:[{name:'Stock',type:'bar',data:topR.map(x=>+x.Stock||0),label:{show:true,position:'right',formatter:q=>qty(q.value)}},{name:'L3M Avg',type:'bar',data:topR.map(x=>+x['L3M Avg Qty']||0),label:{show:true,position:'right',formatter:q=>qty(q.value)}},{name:'CM',type:'bar',data:topR.map(x=>+x['Current Month Qty']||0),label:{show:true,position:'right',formatter:q=>qty(q.value)}}]});
  chart('storeMomentumChart',{...base,legend:{show:true,top:5},dataZoom:[{type:'inside'},{type:'slider',bottom:8,height:16}],xAxis:{type:'category',data:mom.map(x=>x['Store Name']),axisLabel:{rotate:28,fontSize:9,interval:0,formatter:v=>String(v).length>18?String(v).slice(0,18)+'…':v}},yAxis:{type:'value',axisLabel:{formatter:qty}},series:[{name:'LY',type:'line',data:mom.map(x=>+x['LY Qty']||0),symbol:'circle',symbolSize:7,label:{show:true,position:'top',formatter:q=>qty(q.value)}},{name:'L3M Avg',type:'line',data:mom.map(x=>+x['L3M Avg Qty']||0),symbol:'circle',symbolSize:7,label:{show:true,position:'top',formatter:q=>qty(q.value)}},{name:'CM',type:'line',data:mom.map(x=>+x['Current Month Qty']||0),symbol:'circle',symbolSize:7,label:{show:true,position:'top',formatter:q=>qty(q.value)}}]});
  const buckets={'NOD <15':nc.lt15,'NOD 15–30':nc.n15_30,'NOD 31–60':nc.n31_60,'NOD >60':nc.gt60};
  chart('storeNodChart',{...base,xAxis:{type:'category',data:Object.keys(buckets)},yAxis:{type:'value',axisLabel:{formatter:qty}},series:[{name:'SKUs',type:'bar',data:Object.values(buckets),barMaxWidth:55,label:{show:true,position:'top',formatter:q=>qty(q.value)}}]});
  const tm={}; FILTERED.forEach(r=>{const t=canonicalType(r.Type);tm[t]??={stock:0,l3m:0,cm:0,ly:0};tm[t].stock+=+r.Stock||0;tm[t].l3m+=+r['L3M Avg Qty']||0;tm[t].cm+=+r['Current Month Qty']||0;tm[t].ly+=+r['LY Qty']||0}); types.forEach(t=>tm[t]??={stock:0,l3m:0,cm:0,ly:0});
  chart('storeTypeChart',{...base,legend:{show:true,top:5},xAxis:{type:'category',data:types},yAxis:{type:'value',axisLabel:{formatter:qty}},series:[{name:'Stock',type:'bar',data:types.map(t=>tm[t].stock),label:{show:true,position:'top',formatter:q=>qty(q.value)}},{name:'L3M Avg',type:'line',data:types.map(t=>tm[t].l3m),symbol:'circle',symbolSize:7,label:{show:true,position:'top',formatter:q=>qty(q.value)}},{name:'CM',type:'line',data:types.map(t=>tm[t].cm),symbol:'circle',symbolSize:7,label:{show:true,position:'top',formatter:q=>qty(q.value)}},{name:'LY',type:'line',data:types.map(t=>tm[t].ly),symbol:'circle',symbolSize:7,label:{show:true,position:'top',formatter:q=>qty(q.value)}}]});
  const validPerf=rows.filter(r=>r['Growth %']!==null&&r['Growth %']!==undefined).slice().sort((a,b)=>b['Growth %']-a['Growth %']);
  const detailRows=storePerfView==='worst'?validPerf.slice(-10).reverse():validPerf.slice(0,10);
  const detailBody=document.getElementById('storeRankDetails');
  if(detailBody){
    detailBody.innerHTML=detailRows.map(x=>`<tr>
      <td>${esc(x.Rank??'')}</td>
      <td>${esc(x['Store Name']??'')}</td>
      <td class="num">${pct1(x['Growth %'])}</td>
      <td class="num">${qty(x['Current Month Qty'])}</td>
      <td class="num">${qty(x['LY Qty'])}</td>
      <td class="num">${qty(x['L3M Avg Qty'])}</td>
      <td class="num">${qty(x.Stock)}</td>
    </tr>`).join('');
  }
  const rankChartRows=storePerfView==='worst'?validPerf.slice(-10):validPerf.slice(0,10).reverse();
  if(rankChartRows.length)chart('storePerfRankChart',{...base,grid:{left:55,right:85,top:20,bottom:20,containLabel:true},tooltip:{trigger:'item',formatter:q=>perfDetailTooltip(q.data?.store)},xAxis:{type:'value',axisLabel:{formatter:v=>pct1(v)}},yAxis:{type:'category',data:rankChartRows.map(x=>x['Store Name']),axisLabel:{fontSize:9}},series:[{name:'Growth %',type:'bar',data:rankChartRows.map(x=>({value:+x['Growth %'].toFixed(1),itemStyle:{color:x['Growth %']>=0?'#0F766E':'#DC2626'},store:x})),label:{show:true,position:'right',formatter:q=>pct1(q.value)}}]});
  else document.getElementById('storePerfRankChart').innerHTML='<div class="empty">No stores with LY sales to calculate Growth yet.</div>';
  document.getElementById('spTop')?.addEventListener('click',()=>{storePerfView='top';stores()});
  document.getElementById('spWorst')?.addEventListener('click',()=>{storePerfView='worst';stores()});
  document.querySelectorAll('table[data-sort-id="stores"] tbody tr').forEach(tr=>tr.onclick=()=>{const store=tr.dataset.clickValue;const detail=FILTERED.filter(r=>String(r['Store Name']??'').trim()===String(store).trim());if(detail.length)openDetailModal(store,'All SKUs in this outlet',detail,'store')});
}

function dataTable(){document.getElementById('app').innerHTML=`<div class="card"><div class="card-title">Complete Data Table</div>${table(FILTERED,tableCols(FILTERED),'datatable',250)}</div>`}
function openDetailModal(title,sub,rows,mode){let ov=document.getElementById('modalOverlay');document.getElementById('modalTitle').textContent=title;document.getElementById('modalSub').textContent=sub;document.getElementById('modalBody').innerHTML=`<div class="modal-filters"><input id="modalSearch" placeholder="Search SKU / EAN / Product / Shop…"><select id="modalFilter"><option value="">All ${mode==='sku'?'Shops':'SKUs'}</option></select></div><div id="modalTable"></div>`;let opts=mode==='sku'?[...new Set(rows.map(r=>r['Store Name']))]:[...new Set(rows.map(r=>r['Product Name']))];document.getElementById('modalFilter').innerHTML+=opts.sort().map(x=>`<option value="${esc(x)}">${esc(x)}</option>`).join('');let cols=tableCols(rows);function draw(){let q=(document.getElementById('modalSearch').value||'').toLowerCase(),f=document.getElementById('modalFilter').value;let rr=rows.filter(r=>!q||String(r['Product Name']).toLowerCase().includes(q)||String(r['EAN Code']).toLowerCase().includes(q)||String(r['Store Name']).toLowerCase().includes(q)).filter(r=>!f||(mode==='sku'?r['Store Name']===f:r['Product Name']===f));document.getElementById('modalTable').innerHTML=table(rr,cols,'modal-'+mode,2000)}document.getElementById('modalSearch').oninput=draw;document.getElementById('modalFilter').onchange=draw;draw();ov.classList.add('open')}
async function fetchJson(url,opts){let r=await fetch(url,opts);let ct=r.headers.get('content-type')||'';if(!ct.includes('application/json')){throw Error(r.status===504||r.status===502||r.status===503?'The server took too long to refresh the data (gateway timeout). Please try again in a moment.':`Server returned an unexpected response (HTTP ${r.status}).`)}return r.json()}
async function loadStock(force=false){let q=new URLSearchParams({_ts:Date.now()});if(force)q.set('refresh','1');let j=await fetchJson('/api/data?'+q,{cache:'no-store'});if(!j.ok)throw Error(j.error);DATA_COLUMNS=j.source_columns||j.columns||[];DATA=j.records.map(r=>({...r,Type:canonicalType(r.Type),Pareto:normalizePareto(r.Pareto),NOD:(Number(r['L3M Avg Qty']||0)>0?(Number(r.Stock||0)*31/Number(r['L3M Avg Qty']||1)):0)}));DATA=DATA.map(r=>({...r,'NOD Bucket':nodBucket(r.NOD),'Growth %':growthPct(r['Current Month Qty'],r['LY Qty']),'LY Active':Number(r['LY Qty']||0)>0,'Stock Health':stockHealth(r.Stock,r['L3M Avg Qty'],r.NOD)}));document.getElementById('sourceBadge').textContent=`${j.source} • ${j.rows.toLocaleString('en-IN')} rows`;renderFilters();render()}
async function ensureVarianceLoaded(force=false){if(force||!VAR.length){let j=await fetchJson('/api/variance?_ts='+Date.now()+(force?'&refresh=1':''),{cache:'no-store'});if(!j.ok)throw Error(j.error);VAR=j.records||[]}render()}
function varianceCols(rows){
  const preferred=['Store Name','EAN Code','Product Name','Opening Stock Qty','Inward Qty','Tertiary Qty','Calculated Closing Qty','Closing Stock Qty','Movement Check Qty','Movement Check','System Stock Qty','Actual Closing Qty','Difference Qty','Live Submission'];
  const present=new Set((rows&&rows.length)?Object.keys(rows[0]):[]);
  return preferred.filter(c=>present.has(c));
}
function variance(){
  let rows=VAR.slice();
  if(varianceShop)rows=rows.filter(r=>r['Store Name']===varianceShop);
  if(varianceSkuSearch){let q=varianceSkuSearch.toLowerCase();rows=rows.filter(r=>String(r['EAN Code']).toLowerCase().includes(q)||String(r['Product Name']).toLowerCase().includes(q))}
  let allIssues=rows.filter(r=>!r['Movement Check']||(r['Live Submission']&&Math.abs(+r['Difference Qty']||0)>0));
  if(varianceIssueOnly)rows=allIssues;
  const abs=rows.reduce((a,r)=>a+Math.abs(+r['Difference Qty']||0),0),shops=[...new Set(VAR.map(r=>r['Store Name']).filter(Boolean))].sort(),live=rows.filter(r=>r['Live Submission']),liveQty=sum(live,'Actual Closing Qty');
  document.getElementById('app').innerHTML=`<div class="variance-note"><span>BETA</span> Variance Analysis — Quantity basis only.</div><div class="variance-filters"><span class="seg"><button class="active">Qty</button></span><select id="vShop"><option value="">All Shops</option>${shops.map(s=>`<option ${s===varianceShop?'selected':''} value="${esc(s)}">${esc(s)}</option>`).join('')}</select><input id="vSku" placeholder="Search SKU / EAN / Product" value="${esc(varianceSkuSearch)}"><label class="check"><input id="issueOnly" type="checkbox" ${varianceIssueOnly?'checked':''}> Issues only</label><button id="vCsv" class="btn secondary small">Download CSV</button></div><div class="kpis kpis-5">${kpi('Opening Stock',qty(sum(rows,'Opening Stock Qty')),'Opening Qty')}${kpi('Inward Receipts',qty(sum(rows,'Inward Qty')),'Inward Qty')}${kpi('Tertiary',qty(sum(rows,'Tertiary Qty')),'Dispatch Qty')}${kpi('System Closing',qty(sum(rows,'System Stock Qty')),'Current Stock Qty')}${kpi('Field Actual',qty(liveQty),'Latest submitted Qty')}</div><div class="kpis kpis-4">${kpi('Reconciled Rows',qty(rows.filter(r=>r['Movement Check']).length),'Op + Inward − Tertiary = Closing',rows.filter(r=>r['Movement Check']).length?'good':'')}${kpi('Error Rows',qty(rows.filter(r=>!r['Movement Check']).length),'Movement errors',rows.filter(r=>!r['Movement Check']).length?'bad':'good')}${kpi('Physical Variance',qty(abs),'Actual vs system stock')}${kpi('Issue Rate',pct1(rows.length?allIssues.length/rows.length*100:0),'Movement or physical issue',allIssues.length?'bad':'good')}</div><div class="grid2"><div class="card"><div class="card-title">Movement Reconciliation — Qty</div><div id="movementChart" class="chart"></div></div><div class="card"><div class="card-title">Physical Variance by Shop — Qty</div><div id="varianceShopChart" class="chart chart-tall"></div></div></div><div class="grid2"><div class="card"><div class="card-title">Top Variance SKUs — Qty</div><div id="varianceSkuChart" class="chart chart-tall"></div></div><div class="card"><div class="card-title">Variance Direction — Qty</div><div id="varianceDirectionChart" class="chart"></div></div></div><div class="card"><div class="card-title">Variance Detail — Quantity</div>${table(rows,varianceCols(rows),'variance',5000)}</div>`;
  document.getElementById('vShop').onchange=e=>{varianceShop=e.target.value;render()};document.getElementById('vSku').oninput=e=>{varianceSkuSearch=e.target.value;render()};document.getElementById('issueOnly').onchange=e=>{varianceIssueOnly=e.target.checked;render()};document.getElementById('vCsv').onclick=()=>location.href='/api/variance-export?store='+encodeURIComponent(varianceShop)+'&sku='+encodeURIComponent(varianceSkuSearch)+'&issues='+(varianceIssueOnly?'1':'0');
  let mv={Opening:0,Inward:0,Tertiary:0,Closing:0};rows.forEach(r=>{mv.Opening+=+r['Opening Stock Qty']||0;mv.Inward+=+r['Inward Qty']||0;mv.Tertiary+=+r['Tertiary Qty']||0;mv.Closing+=+r['Closing Stock Qty']||0});chart('movementChart',{...base,xAxis:{type:'category',data:Object.keys(mv)},yAxis:{type:'value',axisLabel:{formatter:qty}},series:[{name:'Qty',type:'bar',data:Object.values(mv),barMaxWidth:55,label:{show:true,position:'top',formatter:q=>qty(q.value)}}]});
  let sm={};allIssues.filter(r=>r['Live Submission']).forEach(r=>{sm[r['Store Name']]=(sm[r['Store Name']]||0)+Math.abs(+r['Difference Qty']||0)});let se=Object.entries(sm).sort((a,b)=>b[1]-a[1]).slice(0,10).reverse();if(se.length)chart('varianceShopChart',{...base,xAxis:{type:'value',axisLabel:{formatter:qty}},yAxis:{type:'category',data:se.map(x=>x[0]),axisLabel:{fontSize:9}},series:[{name:'Variance Qty',type:'bar',data:se.map(x=>x[1]),label:{show:true,position:'right',formatter:q=>qty(q.value)}}]});else document.getElementById('varianceShopChart').innerHTML='<div class="empty">No physical variance submitted yet.</div>';
  let vs=allIssues.filter(r=>r['Live Submission']).map(r=>({n:r['Product Name'],v:Math.abs(+r['Difference Qty']||0)})).sort((a,b)=>b.v-a.v).slice(0,10).reverse();if(vs.length)chart('varianceSkuChart',{...base,xAxis:{type:'value',axisLabel:{formatter:qty}},yAxis:{type:'category',data:vs.map(x=>x.n),axisLabel:{fontSize:9}},series:[{name:'Variance Qty',type:'bar',data:vs.map(x=>x.v),label:{show:true,position:'right',formatter:q=>qty(q.value)}}]});else document.getElementById('varianceSkuChart').innerHTML='<div class="empty">No physical variance submitted yet.</div>';
  let shortage=allIssues.filter(r=>r['Live Submission']&&+r['Difference Qty']<0).length,excess=allIssues.filter(r=>r['Live Submission']&&+r['Difference Qty']>0).length;chart('varianceDirectionChart',{...base,xAxis:{type:'category',data:['Shortage','Excess']},yAxis:{type:'value',axisLabel:{formatter:qty}},series:[{name:'SKUs',type:'bar',data:[shortage,excess],label:{show:true,position:'top',formatter:q=>qty(q.value)}}]});
}
function render(){apply();charts.forEach(c=>c.dispose());charts=[];document.getElementById('pageTitle').innerHTML=page==='variance'?'Variance Analysis <span class="variance-page-badge">BETA</span>':{overview:'Overview',products:'SKU Explorer',stores:'Store Analysis',table:'Data Table'}[page];document.getElementById('filterBar').style.display=page==='variance'?'none':'';if(page==='overview')overview();else if(page==='products')products();else if(page==='stores')stores();else if(page==='table')dataTable();else variance()}
async function load(){try{await loadStock(false)}catch(e){document.getElementById('app').innerHTML=`<div class="error"><b>Data load failed</b><br>${esc(e.message)}</div>`}}
document.querySelectorAll('.nav').forEach(b=>b.onclick=async()=>{document.querySelectorAll('.nav').forEach(x=>x.classList.remove('active'));b.classList.add('active');page=b.dataset.page;closeSidebar();if(page==='variance'){document.getElementById('filterBar').style.display='none';try{await ensureVarianceLoaded(false)}catch(e){document.getElementById('app').innerHTML=`<div class="error">${esc(e.message)}</div>`}}else render()});
function openSidebar(){document.getElementById('sidebar')?.classList.add('open');document.getElementById('sidebarBackdrop')?.classList.add('open')}
function closeSidebar(){document.getElementById('sidebar')?.classList.remove('open');document.getElementById('sidebarBackdrop')?.classList.remove('open')}
document.getElementById('menuToggle')?.addEventListener('click',()=>{const s=document.getElementById('sidebar');s?.classList.contains('open')?closeSidebar():openSidebar()});
document.getElementById('sidebarBackdrop')?.addEventListener('click',closeSidebar);
document.addEventListener('keydown',e=>{if(e.key==='Escape')closeSidebar()});
document.getElementById('refresh').onclick=async()=>{let b=document.getElementById('refresh');b.disabled=true;b.textContent='↻ Refreshing…';try{if(page==='variance'){VAR=[];await ensureVarianceLoaded(true)}else await loadStock(true)}catch(e){document.getElementById('app').innerHTML=`<div class="error"><b>Refresh failed</b><br>${esc(e.message)}</div>`}finally{b.disabled=false;b.textContent='↻ Refresh'}};
document.getElementById('modalClose').onclick=()=>document.getElementById('modalOverlay').classList.remove('open');document.getElementById('modalOverlay').onclick=e=>{if(e.target.id==='modalOverlay')e.currentTarget.classList.remove('open')};load();window.onresize=()=>charts.forEach(c=>c.resize());


/* 3-state table sorting: click 1 = ascending, click 2 = descending, click 3 = original order. */
document.addEventListener("click", function(e) {
  const th = e.target.closest("table thead th");
  if (!th || e.target.closest("button, input, select, a")) return;
  const table = th.closest("table");
  if (!table || !table.tBodies.length) return;
  const headers = [...table.querySelectorAll("thead th")];
  const idx = headers.indexOf(th);
  if (idx < 0) return;

  const rows = [...table.tBodies[0].rows];
  const current = th.dataset.ekaDir || "none";
  const direction = current === "none" ? "asc" : current === "asc" ? "desc" : "none";

  // Capture the first rendered order once, so the third click can restore it.
  rows.forEach((r,i) => {
    if (r.dataset.ekaOriginalOrder === undefined) r.dataset.ekaOriginalOrder = String(i);
  });

  if (direction === "none") {
    rows.sort((a,b) => Number(a.dataset.ekaOriginalOrder) - Number(b.dataset.ekaOriginalOrder));
  } else {
    rows.sort((ra, rb) => {
      const a0 = (ra.cells[idx]?.textContent ?? "").trim().replace(/,/g, "");
      const b0 = (rb.cells[idx]?.textContent ?? "").trim().replace(/,/g, "");
      const an = Number(a0.replace(/[₹$%]/g, ""));
      const bn = Number(b0.replace(/[₹$%]/g, ""));
      let c;
      if (Number.isFinite(an) && Number.isFinite(bn)) c = an - bn;
      else c = a0.localeCompare(b0, undefined, {numeric:true, sensitivity:"base"});
      return direction === "asc" ? c : -c;
    });
  }

  const body = table.tBodies[0];
  rows.forEach(r => body.appendChild(r));

  headers.forEach(h => {
    h.classList.remove("eka-sort-asc","eka-sort-desc");
    h.removeAttribute("aria-sort");
    h.dataset.ekaDir = "none";
  });
  th.dataset.ekaDir = direction;
  if (direction !== "none") {
    th.classList.add(direction === "asc" ? "eka-sort-asc" : "eka-sort-desc");
    th.setAttribute("aria-sort", direction === "asc" ? "ascending" : "descending");
  }
}, true);
