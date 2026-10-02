/* CORMATE / RENÉE - Submission backend v4
   Supports normal field submissions + admin/manual uploads.
   Adds submitted_by + submission_mode audit fields and migrates older sheets safely.
*/
const SECRET = 'EKA2026Stock123';
const SHEET_NAME = 'Submissions';
const HEADERS = ['entry_no','submitted_at','email','store_name','ean_code','product_name','stock','tester','total','submitted_by','submission_mode'];

function json_(obj){return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);}
function check_(secret){return !SECRET || String(secret || '') === SECRET;}
function norm_(v){return String(v == null ? '' : v).trim().toLowerCase().replace(/[^a-z0-9]+/g,'_');}
function first_(obj, keys){for (const k of keys){if (Object.prototype.hasOwnProperty.call(obj,k) && obj[k] !== '' && obj[k] != null)return obj[k];}return '';}

function sheet_(){
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if(!ss) throw new Error('No active Google Spreadsheet is connected to this Apps Script.');
  let sh = ss.getSheetByName(SHEET_NAME);
  if(!sh) sh = ss.insertSheet(SHEET_NAME);
  migrateSchema_(sh);
  return sh;
}

function migrateSchema_(sh){
  if(sh.getLastRow() === 0){sh.getRange(1,1,1,HEADERS.length).setValues([HEADERS]);return;}
  const width=Math.max(sh.getLastColumn(),1);
  const rawHeaders=sh.getRange(1,1,1,width).getDisplayValues()[0];
  const current=rawHeaders.map(norm_);
  const canonical=HEADERS.map(norm_);
  const already=current.length >= canonical.length && canonical.every((h,i)=>current[i]===h);
  if(already)return;

  const values=sh.getDataRange().getValues();
  const oldHeaders=values.shift().map(v=>norm_(v));
  const idx={}; oldHeaders.forEach((h,i)=>{if(h)idx[h]=i;});
  const alias={
    entry_no:['entry_no','entry_number'], submitted_at:['submitted_at','date','timestamp','submitted_date'],
    email:['email','email_id','submitted_by_email'], store_name:['store_name','shop_name','store'],
    ean_code:['ean_code','ean','sku','sku_code'], product_name:['product_name','product','description'],
    stock:['stock','stock_qty','physical_stock','quantity'], tester:['tester','tester_qty'], total:['total','total_qty'],
    submitted_by:['submitted_by','uploaded_by','admin_email','created_by'], submission_mode:['submission_mode','mode','source']
  };
  const out=values.map(row=>HEADERS.map(h=>{
    const keys=alias[h]||[h];
    for(const k of keys){if(idx[k] !== undefined)return row[idx[k]] == null ? '' : row[idx[k]];}
    return '';
  }));
  sh.clearContents();
  sh.getRange(1,1,1,HEADERS.length).setValues([HEADERS]);
  if(out.length)sh.getRange(2,1,out.length,HEADERS.length).setValues(out);
}

function doGet(e){
  try{
    if(!check_((e && e.parameter) ? e.parameter.secret : ''))return json_({ok:false,error:'Unauthorized'});
    const sh=sheet_(); const values=sh.getDataRange().getValues();
    if(values.length<2)return json_({ok:true,records:[]});
    const records=values.slice(1).map(function(r){const o={};HEADERS.forEach(function(h,i){o[h]=r[i]===undefined||r[i]===null?'':r[i];});return o;});
    return json_({ok:true,records:records});
  }catch(err){return json_({ok:false,error:String(err)});}
}

function doPost(e){
  try{
    const body=JSON.parse((e&&e.postData&&e.postData.contents)||'{}');
    if(!check_(body.secret))return json_({ok:false,error:'Unauthorized'});
    const sh=sheet_(); const now=new Date().toISOString();
    const email=String(body.email||'').trim(); const store=String(body.store_name||'').trim();
    const entryNo=String(body.entry_no||('STK-'+Utilities.formatDate(new Date(),Session.getScriptTimeZone(),'yyyyMMdd-HHmmss')+'-'+Utilities.getUuid().slice(0,4).toUpperCase()));
    const submittedBy=String(body.submitted_by||email||'').trim();
    const mode=String(body.submission_mode||'field_entry').trim();
    const rows=(body.rows||[]).filter(function(r){return Number(r.Total||0)>0;});
    if(!email||!store||!rows.length)return json_({ok:false,error:'Missing submission data'});
    const out=rows.map(function(r){const stock=Number(r.Stock||0);const tester=Number(r.Tester||0);return [entryNo,now,email,store,String(r['EAN Code']||''),String(r['Product Name']||''),stock,tester,stock+tester,submittedBy,mode];});
    sh.getRange(sh.getLastRow()+1,1,out.length,HEADERS.length).setValues(out);SpreadsheetApp.flush();
    return json_({ok:true,saved_rows:out.length,entry_no:entryNo,submission_mode:mode});
  }catch(err){return json_({ok:false,error:String(err)});}
}
