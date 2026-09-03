let DATA=[], FILTERED=[], filters={}, page="overview", charts=[], sortState={};
const COLS=["Type","Store Name","EAN Code","Product Name","Pareto","Stock","Total MRP Value","L3M Avg Qty","L3M Avg Value","NOD"];
const FILTER_FIELDS=["Type","Store Name","Pareto","NOD Bucket"];
const money=n=>"₹"+Number(n||0).toLocaleString("en-IN",{maximumFractionDigits:0});
const num=n=>Number(n||0).toLocaleString("en-IN",{maximumFractionDigits:1});
// All money-type figures render in Lacs (or Crores once they cross 1 Cr),
// always to 2 decimals, per the requested "Lacs with 2 decimals" format.
// The exact rupee value is still available via a hover tooltip (title attr).
function moneyL(n){
 n=Number(n||0);
 if(Math.abs(n)>=1e7)return "₹"+(n/1e7).toFixed(2)+" Cr";
 return "₹"+(n/1e5).toFixed(2)+" L";
}
// NOD (Number of Days) is always shown as a whole number — never with
// decimals — wherever it appears: KPI tiles, tables, tooltips.
const nod0=n=>Math.round(Number(n||0)).toLocaleString("en-IN");
const esc=s=>String(s??"").replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[m]));
const sum=(a,c)=>a.reduce((x,r)=>x+Number(r[c]||0),0);
const uniq=c=>[...new Set(DATA.map(r=>r[c]).filter(x=>x!==""))].sort((a,b)=>String(a).localeCompare(String(b),undefined,{numeric:true}));
const pct=(a,b)=>b?((a/b)*100).toFixed(1)+"%":"0%";
const MONEY_COLS=new Set(["total mrp value","l3m avg value","mrp"]);
const INT_COLS=new Set(["stock","l3m avg qty","rows","avg","stock / l3m avg qty"]);
function fmt(c,v){
 const key=String(c).toLowerCase();
 if(key==="nod")return nod0(v);
 if(v===""||v==null)return (MONEY_COLS.has(key)||INT_COLS.has(key))?"—":"";
 if(MONEY_COLS.has(key))return moneyL(v);
 if(INT_COLS.has(key))return num(v);
 return v;
}
function isNumCol(c){const key=String(c).toLowerCase();return key==="nod"||MONEY_COLS.has(key)||INT_COLS.has(key)}

/* ---------------- NOD colour bands ----------------
   0-14 => red, 15-30 => yellow, 30+ => green. Used for the coloured
   badge in every table/modal and for the dedicated "NOD Bucket" filter. */
function nodColorClass(v){const n=Number(v||0);return n<15?"nod-red":(n<=30?"nod-yellow":"nod-green")}
function nodBucketLabel(v){const n=Number(v||0);return n<15?"0-14 (Red)":(n<=30?"15-30 (Yellow)":"30+ (Green)")}
function nodDotClass(label){
 if(/red/i.test(label))return "nod-dot-red";
 if(/yellow/i.test(label))return "nod-dot-yellow";
 if(/green/i.test(label))return "nod-dot-green";
 return "";
}
function renderNod(v){const n=Number(v||0);return `<span class="nod-badge ${nodColorClass(n)}">${nod0(n)}</span>`}

/* ---------------- Cell rendering ---------------- */
function cellHtml(c,v){
 const key=String(c).toLowerCase();
 if(key==="nod")return renderNod(v);
 if(MONEY_COLS.has(key)){
  if(v===""||v==null)return "—";
  return `<span title="${esc(money(v))}">${esc(moneyL(v))}</span>`;
 }
 return esc(fmt(c,v));
}

/* ---------------- Filtering ---------------- */
function filtered(){
 return DATA.filter(r=>FILTER_FIELDS.every(c=>!filters[c]||!filters[c].length||filters[c].includes(String(r[c]))));
}
function applyLocalFilters(){
 const q=(filters.__q||"").toLowerCase();
 FILTERED=filtered().filter(r=>!q||String(r["Product Name"]).toLowerCase().includes(q)||String(r["EAN Code"]).toLowerCase().includes(q));
}

/* ------------- Filter bar (persistent, searchable multi-select) -------------
   Rendered once into #filterBar (separate from #app) so toggling a checkbox
   only re-renders the page content underneath — the open dropdown itself is
   never rebuilt, so it doesn't snap shut after every click. */
function triggerLabel(col){
 const sel=filters[col]||[];
 if(!sel.length)return `All ${col.toLowerCase()}`;
 if(sel.length<=2)return sel.map(v=>esc(v)).join(", ");
 return `${sel.length} selected`;
}
function multiFieldHtml(col){
 const opts=uniq(col), sel=new Set(filters[col]||[]);
 const isNod=col==="NOD Bucket";
 return `<div class="filter"><label>${esc(col)}</label>
  <div class="multi" data-col="${esc(col)}">
    <button type="button" class="multi-trigger"><span class="multi-trigger-label">${triggerLabel(col)}</span><span class="chev">⌄</span></button>
    <div class="multi-menu">
      <input class="multi-search" placeholder="Search ${esc(col.toLowerCase())}…">
      <div class="multi-options">${opts.length?opts.map(v=>`<label class="multi-option"><input type="checkbox" value="${esc(v)}" ${sel.has(v)?"checked":""}><span>${isNod?`<span class="nod-dot ${nodDotClass(v)}"></span>`:""}${esc(v)}</span></label>`).join(""):'<div class="multi-empty">No values</div>'}</div>
      <div class="multi-foot"><button type="button" class="link-btn select-all">Select all</button><button type="button" class="link-btn clear-one">Clear</button></div>
    </div>
  </div></div>`;
}
function filterBarHtml(){
 let h='<div class="filters"><div class="filter-head"><b>Filters</b><button id="clear" class="link">Clear all</button></div><div class="filter-grid">';
 FILTER_FIELDS.forEach(c=>{h+=multiFieldHtml(c)});
 h+=`<div class="filter"><label>Search SKU / EAN</label><input id="search" placeholder="Product or EAN…" value="${esc(filters.__q||"")}"></div>`;
 h+='</div></div>';
 return h;
}
function renderFilterBar(){
 document.getElementById("filterBar").innerHTML=filterBarHtml();
 bindFilterBar();
}
function bindFilterBar(){
 document.querySelectorAll(".multi").forEach(m=>{
  const col=m.dataset.col;
  const trigger=m.querySelector(".multi-trigger");
  const menu=m.querySelector(".multi-menu");
  trigger.onclick=e=>{
   e.stopPropagation();
   const wasOpen=m.classList.contains("open");
   document.querySelectorAll(".multi.open").forEach(x=>x.classList.remove("open"));
   if(!wasOpen)m.classList.add("open");
  };
  menu.onclick=e=>e.stopPropagation();
  const search=m.querySelector(".multi-search");
  if(search)search.oninput=()=>{
   const q=search.value.toLowerCase();
   m.querySelectorAll(".multi-option").forEach(o=>{o.style.display=o.textContent.toLowerCase().includes(q)?"":"none"});
  };
  m.querySelectorAll(".multi-option input").forEach(cb=>cb.onchange=()=>{
   const vals=[...m.querySelectorAll(".multi-option input:checked")].map(x=>x.value);
   if(vals.length)filters[col]=vals; else delete filters[col];
   trigger.querySelector(".multi-trigger-label").textContent=triggerLabel(col);
   render();
  });
  const selAll=m.querySelector(".select-all");
  if(selAll)selAll.onclick=()=>{
   m.querySelectorAll(".multi-option input").forEach(cb=>cb.checked=true);
   filters[col]=uniq(col);
   trigger.querySelector(".multi-trigger-label").textContent=triggerLabel(col);
   render();
  };
  const clrOne=m.querySelector(".clear-one");
  if(clrOne)clrOne.onclick=()=>{
   m.querySelectorAll(".multi-option input").forEach(cb=>cb.checked=false);
   delete filters[col];
   trigger.querySelector(".multi-trigger-label").textContent=triggerLabel(col);
   render();
  };
 });
 const q=document.getElementById("search"); if(q)q.oninput=()=>{filters.__q=q.value;render()};
 const cl=document.getElementById("clear");if(cl)cl.onclick=()=>{filters={};renderFilterBar();render()};
}
document.addEventListener("click",()=>document.querySelectorAll(".multi.open").forEach(x=>x.classList.remove("open")));

/* ---------------- Sortable tables ---------------- */
function sortIndicatorHtml(id,col){
 const st=sortState[id];
 if(!st||st.col!==col||!st.dir)return"";
 return `<span class="sort-arrow">${st.dir==="asc"?"▲":"▼"}</span>`;
}
function sortRows(id,rows,getVal){
 const st=sortState[id];
 if(!st||!st.col||!st.dir)return rows;
 const col=st.col, dir=st.dir==="desc"?-1:1;
 return[...rows].sort((a,b)=>{
  const va=getVal(a,col), vb=getVal(b,col);
  const na=Number(va), nb=Number(vb);
  const bothNum=va!==""&&va!=null&&vb!==""&&vb!=null&&!Number.isNaN(na)&&!Number.isNaN(nb);
  if(bothNum)return(na-nb)*dir;
  return String(va??"").localeCompare(String(vb??""),undefined,{numeric:true})*dir;
 });
}
function bindSort(id){
 document.querySelectorAll(`table[data-sort-id="${id}"] th[data-col]`).forEach(th=>{
  th.onclick=()=>{
   const col=th.dataset.col;
   let st=sortState[id]||{};
   if(st.col===col){
    st.dir=st.dir==="asc"?"desc":(st.dir==="desc"?null:"asc");
    if(!st.dir)st.col=null;
   } else { st.col=col; st.dir="asc"; }
   sortState[id]=st;
   render();
  };
 });
}
/* Modal tables have their own tiny sort loop so that re-sorting them never
   triggers a full page re-render (which would rebuild #app and could yank
   focus away while the modal is open). */
function bindModalSort(rows,cols){
 document.querySelectorAll(`table[data-sort-id="modal-detail"] th[data-col]`).forEach(th=>{
  th.onclick=()=>{
   const col=th.dataset.col;
   let st=sortState["modal-detail"]||{};
   if(st.col===col){
    st.dir=st.dir==="asc"?"desc":(st.dir==="desc"?null:"asc");
    if(!st.dir)st.col=null;
   } else { st.col=col; st.dir="asc"; }
   sortState["modal-detail"]=st;
   document.getElementById("modalBody").innerHTML=table(rows,cols,500,"modal-detail");
   bindModalSort(rows,cols);
  };
 });
}
function bindRowClick(sortId,handler){
 document.querySelectorAll(`table[data-sort-id="${sortId}"] tbody tr[data-key]`).forEach(tr=>{
  tr.onclick=()=>handler(tr.dataset.key);
 });
}
function kpi(title,value,sub,cls=""){return `<div class="kpi ${cls}"><div class="k-title">${title}</div><div class="k-value">${value}</div><div class="k-sub">${sub}</div></div>`}
function chart(id,opt){let e=document.getElementById(id);if(!e)return;try{let old=echarts.getInstanceByDom(e);if(old)old.dispose();let c=echarts.init(e);c.setOption(opt);charts.push(c)}catch(x){e.innerHTML='<div class="empty">Chart could not render.</div>'}}
// Light Salesforce-style chart theme, matched to modern-trade-dashboard-web.
const PALETTE=["#0176D3","#1B96FF","#032D60","#04844B","#B65C00","#706E6B","#89A9C4","#EA001E"];
const base={color:PALETTE,textStyle:{fontFamily:"Inter",color:"#3E3E3C"},tooltip:{backgroundColor:"#FFFFFF",borderColor:"#DDDBDA",textStyle:{color:"#181818"},extraCssText:"box-shadow:0 2px 6px rgba(0,0,0,.08);border-radius:8px"},grid:{left:55,right:22,top:45,bottom:45}};
const axisLine={lineStyle:{color:"#DDDBDA"}}, axisLabel={color:"#706E6B"}, splitLine={lineStyle:{color:"#F3F2F2"}};
// Puts Pareto bands back into their natural order (Top 10, Top 25, ... Tail,
// Discontinued) instead of an alphabetical jumble.
function paretoOrder(name){
 const s=String(name||"");
 const m=s.match(/^(\d+)\./);
 if(m)return parseInt(m[1],10);
 if(/discontinued/i.test(s))return 900;
 if(/tail/i.test(s))return 800;
 return 999;
}
function table(rows,cols=COLS,max=100,sortId=null,clickable=false){
 if(!rows.length)return '<div class="empty">No records match the current filters.</div>';
 const sorted=sortId?sortRows(sortId,rows,(r,c)=>r[c]):rows;
 const thead=cols.map(c=>`<th class="sortable" data-col="${esc(c)}">${esc(c)}${sortId?sortIndicatorHtml(sortId,c):""}</th>`).join("");
 const body=sorted.slice(0,max).map(r=>`<tr${clickable?` class="clickable" data-key="${esc(r.__key??"")}"`:""}>${cols.map(c=>`<td class="${isNumCol(c)?"num":""}">${cellHtml(c,r[c])}</td>`).join("")}</tr>`).join("");
 return `<div class="table-wrap"><table${sortId?` data-sort-id="${sortId}"`:""}><thead><tr>${thead}</tr></thead><tbody>${body}</tbody></table></div>${sorted.length>max?`<div class="table-foot">Showing ${max.toLocaleString()} of ${sorted.length.toLocaleString()} rows</div>`:""}`;
}

/* ---------------- Detail modal (SKU ⇄ Store drill-through) ----------------
   Clicking a row in SKU Explorer opens every store carrying that SKU;
   clicking a row in Store Analysis opens every SKU stocked at that store. */
function openModal(title,subtitle,rows,cols){
 delete sortState["modal-detail"];
 document.getElementById("modalTitle").textContent=title;
 document.getElementById("modalSub").textContent=subtitle;
 document.getElementById("modalBody").innerHTML=table(rows,cols,500,"modal-detail");
 bindModalSort(rows,cols);
 document.getElementById("modalOverlay").classList.add("open");
}
function closeModal(){document.getElementById("modalOverlay").classList.remove("open")}

function overview(){
 const d=FILTERED, sku=new Set(d.map(r=>r["EAN Code"]).filter(Boolean)).size, stores=new Set(d.map(r=>r["Store Name"]).filter(Boolean)).size;
 const stock=sum(d,"Stock"), mrp=sum(d,"Total MRP Value"), l3q=sum(d,"L3M Avg Qty"), nod=d.length?sum(d,"NOD")/d.length:0;
 let html=`<div class="kpis">
  ${kpi("SKU / EAN",""+sku,`${d.length.toLocaleString()} rows`)}
  ${kpi("Stores",stores,"Unique stores")}
  ${kpi("Total Stock",num(stock),"Units")}
  ${kpi("Total MRP Value",moneyL(mrp),"Filtered MRP")}
  ${kpi("L3M Avg Qty",num(l3q),"Sum of SKU averages")}
  ${kpi("Avg NOD",`<span class="nod-text ${nodColorClass(nod)}">${nod0(nod)}</span>`,"Days • across filtered rows")}
 </div>
 <div class="grid2">
  <div class="card"><div class="card-title">MRP Value by Pareto <span class="muted">share of total MRP value</span></div><div id="paretoChart" class="chart"></div></div>
  <div class="card"><div class="card-title">Stock vs L3M Avg Qty by Pareto <span class="muted">units, grouped by Pareto band</span></div><div id="paretoBar" class="chart"></div></div>
 </div>
 <div class="grid2">
  <div class="card"><div class="card-title">Top SKUs by Stock Value <span class="muted">₹ in Lacs</span></div><div id="topSku" class="chart chart-tall"></div></div>
  <div class="card"><div class="card-title">Store Stock Distribution <span class="muted">units, top 12 stores</span></div><div id="storeChart" class="chart chart-tall"></div></div>
 </div>
 <div class="card"><div class="card-title">Filtered Data Preview <span class="muted">• click a column header to sort • all columns available in Data Table</span></div>${table(d,COLS,15,"overview-preview")}</div>`;
 document.getElementById("app").innerHTML=html;
 bindSort("overview-preview");

 const pv={};d.forEach(r=>{const k=r.Pareto||"Unclassified";pv[k]=(pv[k]||0)+Number(r["Total MRP Value"]||0)});
 chart("paretoChart",{...base,legend:{bottom:0,left:"center",itemWidth:11,itemHeight:11,textStyle:{color:"#3E3E3C",fontSize:11}},tooltip:{trigger:"item",formatter:p=>`${esc(p.name)}<br>${moneyL(p.value)} (${p.percent}%)`,...base.tooltip},series:[{type:"pie",radius:["40%","66%"],center:["50%","44%"],avoidLabelOverlap:true,label:{formatter:p=>`${p.name}\n${p.percent}%`,color:"#3E3E3C",fontSize:11},labelLine:{length:10,length2:10},data:Object.entries(pv).sort((a,b)=>b[1]-a[1]).map(([name,value])=>({name,value}))}]});

 // Replaces the old scatter plot (unreadable, overlapping bubbles/labels)
 // with a grouped bar comparing Stock vs L3M Avg Qty per Pareto band —
 // same information, actually legible.
 const byp={};d.forEach(r=>{const p=r.Pareto||"Unclassified";(byp[p]??={stock:0,avg:0});byp[p].stock+=+r.Stock||0;byp[p].avg+=+r["L3M Avg Qty"]||0});
 const order=Object.keys(byp).sort((a,b)=>paretoOrder(a)-paretoOrder(b));
 chart("paretoBar",{...base,tooltip:{...base.tooltip,trigger:"axis",formatter:p=>{const rows=p.map(it=>`${esc(it.marker)}${esc(it.seriesName)}: ${num(it.value)}`).join("<br>");return `${esc(p[0]?.name||"")}<br>${rows}`}},legend:{top:0,textStyle:{color:"#3E3E3C"}},grid:{left:20,right:20,top:40,bottom:10,containLabel:true},xAxis:{type:"category",data:order,axisLine,axisLabel:{...axisLabel,interval:0,rotate:order.length>5?20:0}},yAxis:{type:"value",axisLine,axisLabel:{...axisLabel,hideOverlap:true},splitLine},series:[
  {name:"Stock",type:"bar",data:order.map(k=>byp[k].stock),itemStyle:{color:PALETTE[0]}},
  {name:"L3M Avg Qty",type:"bar",data:order.map(k=>byp[k].avg),itemStyle:{color:PALETTE[1]}}
 ]});

 const skuMap={};d.forEach(r=>{const k=r["Product Name"]||r["EAN Code"];skuMap[k]=(skuMap[k]||0)+Number(r["Total MRP Value"]||0)});
 const top=Object.entries(skuMap).sort((a,b)=>b[1]-a[1]).slice(0,10).reverse();
 chart("topSku",{...base,tooltip:{...base.tooltip,formatter:p=>{const it=Array.isArray(p)?p[0]:p;return `${esc(it.name)}<br>${moneyL(it.value)}`}},grid:{left:20,right:75,top:10,bottom:10,containLabel:true},xAxis:{type:"value",axisLine,splitNumber:4,axisLabel:{...axisLabel,formatter:v=>moneyL(v),hideOverlap:true},splitLine},yAxis:{type:"category",data:top.map(x=>x[0]),axisLine,axisLabel:{...axisLabel,fontSize:11}},series:[{type:"bar",data:top.map(x=>x[1]),itemStyle:{color:PALETTE[0]},label:{show:true,position:"right",formatter:p=>moneyL(p.value),color:"#3E3E3C",fontSize:11}}]});

 const sm={};d.forEach(r=>{const k=r["Store Name"]||"Unknown";sm[k]=(sm[k]||0)+Number(r.Stock||0)});
 let st=Object.entries(sm).sort((a,b)=>b[1]-a[1]).slice(0,12).reverse();
 chart("storeChart",{...base,tooltip:{...base.tooltip,formatter:p=>{const it=Array.isArray(p)?p[0]:p;return `${esc(it.name)}<br>${num(it.value)} units`}},grid:{left:20,right:60,top:10,bottom:10,containLabel:true},xAxis:{type:"value",axisLine,splitNumber:4,axisLabel:{...axisLabel,formatter:v=>num(v),hideOverlap:true},splitLine},yAxis:{type:"category",data:st.map(x=>x[0]),axisLine,axisLabel:{...axisLabel,fontSize:11}},series:[{type:"bar",data:st.map(x=>x[1]),itemStyle:{color:PALETTE[1]},label:{show:true,position:"right",formatter:p=>num(p.value),color:"#3E3E3C",fontSize:11}}]});
}

function products(){
 let d=FILTERED, m={};
 d.forEach(r=>{
  const k=r["Product Name"]||r["EAN Code"];
  if(!m[k])m[k]={"Product Name":k,"EAN Code":r["EAN Code"],"Rows":0,"Stock":0,"Total MRP Value":0,"L3M Avg Qty":0,"NOD":0,__key:k};
  const g=m[k];
  g["Rows"]++; g["Stock"]+=+r.Stock||0; g["Total MRP Value"]+=+r["Total MRP Value"]||0; g["L3M Avg Qty"]+=+r["L3M Avg Qty"]||0; g["NOD"]+=+r.NOD||0;
 });
 let rows=Object.values(m).map(r=>({...r,"NOD":r.Rows?r.NOD/r.Rows:0,"Stock / L3M Avg Qty":r["L3M Avg Qty"]?r["Stock"]/r["L3M Avg Qty"]:""})).sort((a,b)=>b["Total MRP Value"]-a["Total MRP Value"]);
 const cols=["Product Name","EAN Code","Rows","Stock","Total MRP Value","L3M Avg Qty","Stock / L3M Avg Qty","NOD"];
 document.getElementById("app").innerHTML=`<div class="kpis">${kpi("Unique Products",rows.length,"Product names")}${kpi("Stock Units",num(sum(d,"Stock")),"Across filtered rows")}${kpi("MRP Value",moneyL(sum(d,"Total MRP Value")),"Total")}${kpi("L3M Avg Qty",num(sum(d,"L3M Avg Qty")),"Total")}</div><div class="card"><div class="card-title">SKU Explorer <span class="muted">sorted by MRP value • click a column to sort • click a row to see its store-wise details</span></div>${table(rows,cols,500,"products",true)}</div>`;
 bindSort("products");
 bindRowClick("products",key=>{
  const detail=FILTERED.filter(x=>(x["Product Name"]||x["EAN Code"])===key);
  if(!detail.length)return;
  const name=detail[0]["Product Name"]||key;
  openModal(name,`${detail.length} store row(s) • EAN ${detail[0]["EAN Code"]||"—"}`,detail,["Store Name","Type","Pareto","Stock","Total MRP Value","L3M Avg Qty","L3M Avg Value","NOD"]);
 });
}

function stores(){
 let d=FILTERED,m={};
 d.forEach(r=>{
  const k=r["Store Name"]||"Unknown";
  (m[k]??={store:k,rows:0,stock:0,mrp:0,avg:0,nod:0,__key:k});
  const g=m[k];
  g.rows++;g.stock+=+r.Stock||0;g.mrp+=+r["Total MRP Value"]||0;g.avg+=+r["L3M Avg Qty"]||0;g.nod+=+r.NOD||0;
 });
 let rows=Object.values(m).map(r=>({...r,nod:r.rows?r.nod/r.rows:0})).sort((a,b)=>b.stock-a.stock);
 const avgNod=d.length?sum(d,"NOD")/d.length:0;
 document.getElementById("app").innerHTML=`<div class="kpis">${kpi("Stores",rows.length,"Filtered")}${kpi("Total Stock",num(sum(d,"Stock")),"Units")}${kpi("MRP Value",moneyL(sum(d,"Total MRP Value")),"Filtered")}${kpi("Avg NOD",`<span class="nod-text ${nodColorClass(avgNod)}">${nod0(avgNod)}</span>`,"Rows weighted")}</div><div class="card"><div class="card-title">Store Performance <span class="muted">click a column to sort • click a row to see its SKU-wise details</span></div>${table(rows,["store","rows","stock","mrp","avg","nod"],500,"stores",true)}</div>`;
 bindSort("stores");
 bindRowClick("stores",key=>{
  const detail=FILTERED.filter(x=>(x["Store Name"]||"Unknown")===key);
  if(!detail.length)return;
  openModal(key,`${detail.length} SKU row(s)`,detail,["Product Name","EAN Code","Type","Pareto","Stock","Total MRP Value","L3M Avg Qty","L3M Avg Value","NOD"]);
 });
}

function dataTable(){
 let d=FILTERED, cols=[...COLS];
 let html=`<div class="card"><div class="table-tools"><div><div class="card-title">Complete Data Table</div><div class="muted">${d.length.toLocaleString()} filtered rows • 10 source columns • click a column to sort</div></div><button id="csv" class="btn">⇩ Export CSV</button></div>${table(d,cols,1000,"datatable")}</div>`;
 document.getElementById("app").innerHTML=html;
 bindSort("datatable");
 document.getElementById("csv").onclick=()=>{let p=new URLSearchParams();FILTER_FIELDS.forEach(c=>{(filters[c]||[]).forEach(v=>p.append(c,v))});location.href="/api/export?"+p.toString()};
}

function render(){
 applyLocalFilters(); charts.forEach(c=>c.dispose());charts=[];
 const titles={overview:"SKU Stock Overview",products:"SKU Explorer",stores:"Store Analysis",table:"Complete Data Table"};
 document.getElementById("pageTitle").textContent=titles[page];
 ({overview,products,stores,table:dataTable}[page])();
}
async function boot(refresh=false){
 document.getElementById("sourceBadge").textContent="Loading Excel…";
 try{
  let r=await fetch("/api/data"+(refresh?"?refresh=1":""));
  let j=await r.json();
  if(!j.ok)throw Error(j.error);
  DATA=j.records.map(r=>({...r,"NOD Bucket":nodBucketLabel(r.NOD)}));
  document.getElementById("sourceBadge").textContent=`${j.source} • ${j.rows.toLocaleString()} rows`;
  renderFilterBar();
  render();
 } catch(e){
  document.getElementById("app").innerHTML=`<div class="error"><b>Excel could not be loaded.</b><br>${esc(e.message)}<br><small>Set EXCEL_URL in Render → Environment. The link must be publicly accessible to the Render server.</small></div>`;
  document.getElementById("sourceBadge").textContent="Data error";
 }
}
document.querySelectorAll(".nav").forEach(b=>b.onclick=()=>{document.querySelectorAll(".nav").forEach(x=>x.classList.remove("active"));b.classList.add("active");page=b.dataset.page;render()});
document.getElementById("refresh").onclick=()=>boot(true);
document.getElementById("modalClose").onclick=closeModal;
document.getElementById("modalOverlay").onclick=e=>{if(e.target.id==="modalOverlay")closeModal()};
document.addEventListener("keydown",e=>{if(e.key==="Escape")closeModal()});
boot();
window.onresize=()=>charts.forEach(c=>c.resize());
