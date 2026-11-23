(function(){
var $=function(i){return document.getElementById(i)}, S={data:null,sku:null,chart:null};
function esc(s){return String(s==null?"":s).replace(/[&<>"']/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]})}
function cur(){return S.data&&S.data.unit==="₹"?"₹":""}
function n(v,d){if(v==null||isNaN(v))return"—";return Number(v).toLocaleString("en-IN",{maximumFractionDigits:d||0})}
function money(v){return cur()+n(v)}
function short(v){v=Number(v)||0;var a=Math.abs(v),p=cur();if(a>=1e7)return p+(v/1e7).toFixed(2)+" Cr";if(a>=1e5)return p+(v/1e5).toFixed(2)+" L";if(a>=1e3)return p+(v/1e3).toFixed(1)+" K";return p+Math.round(v)}
function msg(t,c){$("msg").innerHTML=t?'<div class="xmsg '+(c||"bad")+'">'+esc(t)+'</div>':""}
function get(u){return fetch(u,{credentials:"same-origin"}).then(function(r){return r.json().catch(function(){return{ok:false,error:"Server error"}})})}
function kp(el,items){el.innerHTML=items.map(function(i){return '<div><span>'+esc(i[0])+'</span><b'+(i[3]?' style="color:'+i[3]+'"':'')+'>'+esc(i[1])+'</b><small>'+esc(i[2]||"")+'</small></div>'}).join("")}
function pctColor(p){return p==null?"":p>=100?"#42d392":p>=70?"#ffc857":"#ff5b6e"}
function load(refresh){
  var p=new URLSearchParams(); if($("period").value)p.set("period",$("period").value); if(refresh)p.set("refresh","1");
  msg(""); get("/api/sales/summary?"+p).then(function(d){
    if(!d.ok){$("body").style.display="none";msg(d.error||"Could not load sales data.");return}
    S.data=d; $("body").style.display="";
    if(!$("period").options.length||refresh||$("period").dataset.src!==d.periods.join("|")){$("period").innerHTML=d.periods.map(function(x){return '<option'+(x===d.period?" selected":"")+'>'+esc(x)+'</option>'}).join("");$("period").dataset.src=d.periods.join("|")}
    $("period").value=d.period;
    var keep=$("outlet").value; $("outlet").innerHTML=(d.scope_all||d.outlets.length>1?'<option value="__all__">'+(d.scope_all?"All outlets":"All my outlets")+'</option>':"")+d.outlets.map(function(o){return '<option>'+esc(o.outlet)+'</option>'}).join("");
    if(keep&&[].some.call($("outlet").options,function(o){return o.value===keep}))$("outlet").value=keep; else if(d.outlets.length===1)$("outlet").value=d.outlets[0].outlet;
    $("outW").style.display=d.outlets.length>1?"":"none"; $("period").parentNode.style.display=d.periods.length?"":"none";
    msg(d.has_targets?"":"Targets are not loaded yet — the Target sheet is empty. Showing sales only; add Name + Target rows to see Target vs Achievement and pending.","good");
    $("meta").textContent="Source: "+d.source+" • updated "+new Date(d.as_of).toLocaleString();
    draw(); loadSku();
  }).catch(function(){msg("Network problem — please try again.")})}
function draw(){
  var d=S.data,t=d.totals,o=d.outlets,sel=$("outlet").value, one=sel&&sel!=="__all__"?o.filter(function(x){return x.outlet===sel})[0]:null, tt=one||t;
  var pct=tt.pct, items=[["Target",d.has_targets?money(tt.target):"—",d.period||""],[d.has_targets?"Achieved":"Sales",money(tt.achievement),""],["Pending",d.has_targets?money(tt.pending):"—",tt.pending>0?"to reach target":"Target met 🎉"],["Achievement",pct==null?"—":n(pct,1)+"%","",pctColor(pct)]];
  if(!one&&t.required_per_day)items.push(["Needed per day",short(t.required_per_day),d.days.days_left+" days left"]);
  if(!one&&t.projected)items.push(["Projected",short(t.projected),"at current pace"]);
  if(one&&one.rank)items.push(["Rank",one.rank+" / "+o.filter(function(x){return x.pct!=null}).length,""]);
  kp($("kpis"),items);
  var rows=o.slice().sort(function(a,b){return(b.pct==null?-1:b.pct)-(a.pct==null?-1:a.pct)});
  $("otbl").tBodies[0].innerHTML=rows.map(function(r){var w=Math.min(r.pct||0,100);return '<tr'+(one&&r.outlet===one.outlet?' style="background:rgba(255,43,138,.07)"':'')+'><td>'+(r.rank||"–")+'</td><td><b>'+esc(r.outlet)+'</b></td><td class="n">'+money(r.target)+'</td><td class="n">'+money(r.achievement)+'</td><td class="n">'+money(r.pending)+'</td><td><div class="bar"><i class="'+((r.pct||0)>=100?"ok":"")+'" style="width:'+w+'%"></i></div></td><td class="n" style="color:'+pctColor(r.pct)+';font-weight:800">'+(r.pct==null?"—":n(r.pct,1)+"%")+'</td></tr>'}).join("")||'<tr><td colspan="7" class="empty2">No outlet data for this month.</td></tr>';
  var top=rows.slice(0,25); if(!S.chart)S.chart=echarts.init($("chart"));
  var light=document.documentElement.dataset.theme==="light"; var tc=light?"#cfcfcf":"#bbb";
  S.chart.setOption({backgroundColor:"transparent",textStyle:{color:tc},tooltip:{trigger:"axis",valueFormatter:function(v){return money(v)}},legend:{data:["Target","Achieved"],textStyle:{color:tc}},grid:{left:8,right:8,top:36,bottom:top.length>8?70:30,containLabel:true},
    xAxis:{type:"category",data:top.map(function(r){return r.outlet}),axisLabel:{color:tc,rotate:top.length>6?40:0,interval:0,fontSize:10}},yAxis:{type:"value",axisLabel:{color:tc,formatter:function(v){return short(v)}},splitLine:{lineStyle:{color:"#222"}}},
    series:[{name:"Target",type:"bar",data:top.map(function(r){return r.target}),itemStyle:{color:"#3b3b46"}},{name:"Achieved",type:"bar",data:top.map(function(r){return r.achievement}),itemStyle:{color:"#ff2b8a"}}]},true);
  S.chart.resize();
}
function loadSku(){
  var p=new URLSearchParams({outlet:$("outlet").value||"__all__",period:$("period").value||""});
  $("skuT").textContent="SKU sales & stock — "+($("outlet").value&&$("outlet").value!=="__all__"?$("outlet").value:"all outlets");
  get("/api/sales/outlet?"+p).then(function(d){if(!d.ok){msg(d.error);return}S.sku=d;drawSku()})}
var LBL={out:"Out of stock",low:"Low cover",over:"Overstock",ok:"Healthy",nil:"No stock",no_stock_data:"No stock data"};
function drawSku(){
  var d=S.sku; if(!d)return; var q=$("sq").value.trim().toLowerCase(), f=$("sf").value;
  var rows=d.rows.filter(function(r){return (!q||(r.product+" "+r.ean).toLowerCase().indexOf(q)>-1)&&(!f||(f==="sold"?r.sales_qty>0:r.status===f))});
  var t=d.totals; kp($("skuK"),[["Sales",money(t.sales_value),n(t.sales_qty)+" units"],["Stock on hand",n(t.stock)+" units",""],["Out of stock",String(t.out),"selling SKUs with zero stock","#ff8c99"],["Low cover",String(t.low),"under 15 days","#ffc857"]]);
  $("stbl").tBodies[0].innerHTML=rows.slice(0,600).map(function(r){return '<tr><td>'+esc(r.product||"—")+'</td><td>'+esc(r.ean)+'</td><td class="n">'+n(r.sales_qty)+'</td><td class="n">'+money(r.sales_value)+'</td><td class="n">'+n(r.share,1)+'%</td><td class="n">'+(r.stock==null?"—":n(r.stock))+'</td><td class="n">'+(r.cover_days==null?"—":n(r.cover_days))+'</td><td><span class="st '+r.status+'">'+LBL[r.status]+'</span></td></tr>'}).join("")||'<tr><td colspan="8" class="empty2">No SKUs match.</td></tr>';
}
$("period").onchange=function(){load()}; $("refresh").onclick=function(){load(true)};
$("outlet").onchange=function(){draw();loadSku()}; $("sq").oninput=drawSku; $("sf").onchange=drawSku;
window.addEventListener("resize",function(){if(S.chart)S.chart.resize()});
new MutationObserver(function(){if(S.data)draw()}).observe(document.documentElement,{attributes:true,attributeFilter:["data-theme"]});
load();
})();
