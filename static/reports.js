(function(){
var $=function(i){return document.getElementById(i)}, st={mode:"range",outlets:[],sel:new Set(),entry:new Set(),entries:[]};
function esc(s){return String(s==null?"":s).replace(/[&<>"']/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]})}
function fmtT(iso){if(!iso)return"—";var d=new Date(iso);return isNaN(d)?esc(iso):d.toLocaleString([], {day:"2-digit",month:"short",year:"numeric",hour:"2-digit",minute:"2-digit"})}
function msg(t,c){$("msg").innerHTML=t?'<div class="xmsg '+(c||"bad")+'">'+esc(t)+'</div>':""}
function get(u){return fetch(u,{credentials:"same-origin"}).then(function(r){return r.json().catch(function(){return{ok:false,error:"Server error"}})})}
function qs(){
  var p=new URLSearchParams(); p.set("mode",st.mode);
  if(st.mode==="entry"){st.entry.forEach(function(k){p.append("entry_no",k)});return p}
  if($("all").checked)p.set("all","1"); else st.sel.forEach(function(s){p.append("store",s)});
  if($("dFrom").value)p.set("from",$("dFrom").value); if($("dTo").value)p.set("to",$("dTo").value); return p}
function ready(){return st.mode==="entry"?st.entry.size>0:($("all").checked||st.sel.size>0)}
function refresh(){
  var ok=ready(); $("dlCsv").disabled=$("dlXlsx").disabled=!ok;
  if(!ok){$("info").textContent=st.mode==="entry"?"Pick a submission.":"Select outlets or choose all.";return}
  var p=qs(), t=Date.now(); st.t=t; $("info").textContent="Checking…";
  get("/api/reports/preview?"+p).then(function(d){if(st.t!==t)return; if(!d.ok){$("info").textContent=d.error;return}
    $("info").textContent=d.rows?d.rows.toLocaleString()+" rows • "+d.entries+" entries • "+d.outlets+" outlets • "+Math.round(d.qty).toLocaleString()+" qty":"No punched stock for this selection.";
    $("dlCsv").disabled=$("dlXlsx").disabled=!d.rows})}
function drawOutlets(){
  var q=$("oq").value.trim().toLowerCase(), rows=st.outlets.filter(function(o){return !q||o.outlet.toLowerCase().indexOf(q)>-1});
  $("olist").innerHTML=rows.length?rows.map(function(o){return '<label class="orow"><input type="checkbox" data-o="'+esc(o.outlet)+'"'+(st.sel.has(o.outlet)||$("all").checked?" checked":"")+($("all").checked?" disabled":"")+'><span class="nm">'+esc(o.outlet)+'<small>'+(o.entries?'Last: '+fmtT(o.last_submitted)+(o.last_entry_no?' • '+esc(o.last_entry_no):''):'No submissions yet')+'</small></span><span class="pill">'+o.entries+' entr'+(o.entries===1?"y":"ies")+'</span></label>'}).join(""):'<div class="empty2">No outlets match.</div>';
  $("allSub").textContent=st.outlets.length+" outlets";
  var cut=Date.now()-7*864e5, never=st.outlets.filter(function(o){return !o.entries}), old=st.outlets.filter(function(o){return o.entries&&new Date(o.last_submitted).getTime()<cut});
  var el=$("stale"); if(never.length||old.length){el.style.display="";el.innerHTML="⚠ "+never.length+" outlet"+(never.length===1?"":"s")+" never punched stock"+(old.length?", "+old.length+" not in the last 7 days":"")+". <a href='#' id='pickStale' style='color:inherit;font-weight:800'>Select them</a>"}else el.style.display="none";}
function drawEntries(){
  var q=$("eq").value.trim().toLowerCase();
  var rows=st.entries.filter(function(e){return !q||(e.entry_no+" "+e.outlet+" "+e.submitted_by).toLowerCase().indexOf(q)>-1});
  $("elist").innerHTML=rows.length?rows.map(function(e){return '<label class="orow"><input type="checkbox" data-k="'+esc(e.key)+'"'+(st.entry.has(e.key)?" checked":"")+'><span class="nm">'+esc(e.entry_no||"(older entry)")+' · '+esc(e.outlet)+'<small>'+fmtT(e.submitted_at)+' • '+esc(e.submitted_by)+'</small></span><span class="pill">'+e.skus+' SKUs • '+Math.round(e.qty)+'</span></label>'}).join(""):'<div class="empty2">No submissions found.</div>';}
function loadEntries(){var p=new URLSearchParams(); if($("eStore").value)p.set("store",$("eStore").value); get("/api/reports/entries?"+p).then(function(d){if(!d.ok){msg(d.error);return}st.entries=d.entries;drawEntries()})}
function setMode(m){st.mode=m;msg("");[].forEach.call($("mode").children,function(b){b.classList.toggle("on",b.dataset.m===m)});
  $("secOutlets").style.display=m==="entry"?"none":""; $("secEntry").style.display=m==="entry"?"":"none"; $("splitW").style.display=m==="entry"?"none":"";
  if(m==="entry")loadEntries(); refresh();}
$("mode").onclick=function(e){if(e.target.dataset.m)setMode(e.target.dataset.m)};
$("olist").onchange=function(e){var o=e.target.dataset.o; if(o==null)return; e.target.checked?st.sel.add(o):st.sel.delete(o); refresh()};
document.addEventListener("click",function(e){if(e.target&&e.target.id==="pickStale"){e.preventDefault();var cut=Date.now()-7*864e5;$("all").checked=false;st.sel.clear();st.outlets.forEach(function(o){if(!o.entries||new Date(o.last_submitted).getTime()<cut)st.sel.add(o.outlet)});drawOutlets();refresh()}});
$("all").onchange=function(){drawOutlets();refresh()};
$("oq").oninput=drawOutlets; $("eq").oninput=drawEntries; $("eStore").onchange=loadEntries;
$("dFrom").onchange=$("dTo").onchange=refresh;
$("elist").onchange=function(e){var k=e.target.dataset.k; if(k==null)return; if(e.target.checked){st.entry.clear();st.entry.add(k);drawEntries()}else st.entry.delete(k); refresh()};
function dl(fmt){var p=qs(); p.set("format",fmt); if($("split").checked)p.set("split","1"); msg("");
  var b=fmt==="csv"?$("dlCsv"):$("dlXlsx"), old=b.textContent; b.textContent="Preparing…"; b.disabled=true;
  fetch("/api/reports/download?"+p,{credentials:"same-origin"}).then(function(r){
    if(!r.ok)return r.json().then(function(d){throw new Error(d.error||"Download failed")});
    var cd=r.headers.get("Content-Disposition")||"", m=/filename="([^"]+)"/.exec(cd), name=m?m[1]:"stock_report."+fmt;
    return r.blob().then(function(bl){var a=document.createElement("a"),u=URL.createObjectURL(bl);a.href=u;a.download=name;document.body.appendChild(a);a.click();setTimeout(function(){URL.revokeObjectURL(u);a.remove()},1500);msg("Downloaded "+name,"good")})})
  .catch(function(e){msg(e.message)}).then(function(){b.textContent=old;refresh()})}
$("dlCsv").onclick=function(){dl("csv")}; $("dlXlsx").onclick=function(){dl("xlsx")};
get("/api/reports/outlets").then(function(d){if(!d.ok){msg(d.error||"Could not load outlets.");$("olist").innerHTML="";return}
  st.outlets=d.outlets; drawOutlets(); $("eStore").innerHTML='<option value="">All outlets</option>'+d.outlets.filter(function(o){return o.entries}).map(function(o){return '<option>'+esc(o.outlet)+'</option>'}).join("");
  if(d.warning)msg("Note: "+d.warning)});
refresh();
})();
