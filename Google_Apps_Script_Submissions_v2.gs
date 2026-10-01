/* CORMATE / RENEE - Submission backend v3
   Robust submission history + Entry No. support.
*/
const SECRET = 'EKA2026Stock123';
const SHEET_NAME = 'Submissions';
const HEADERS = ['entry_no','submitted_at','email','store_name','ean_code','product_name','stock','tester','total'];

function json_(obj){
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
function check_(secret){ return !SECRET || String(secret || '') === SECRET; }
function sheet_(){
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if(!ss) throw new Error('No active Google Spreadsheet is connected to this Apps Script.');
  let sh = ss.getSheetByName(SHEET_NAME);
  if(!sh) sh = ss.insertSheet(SHEET_NAME);
  if(sh.getLastRow() === 0){ sh.getRange(1,1,1,HEADERS.length).setValues([HEADERS]); return sh; }

  const width = Math.max(sh.getLastColumn(), HEADERS.length);
  let current = sh.getRange(1,1,1,width).getDisplayValues()[0].map(v => String(v).trim());
  if(current[0] !== 'entry_no'){
    sh.insertColumnBefore(1);
    current = sh.getRange(1,1,1,Math.max(sh.getLastColumn(), HEADERS.length)).getDisplayValues()[0].map(v => String(v).trim());
  }
  HEADERS.forEach((h,i) => sh.getRange(1,i+1).setValue(h));
  return sh;
}
function doGet(e){
  try{
    if(!check_((e && e.parameter) ? e.parameter.secret : '')) return json_({ok:false,error:'Unauthorized'});
    const sh = sheet_();
    const values = sh.getDataRange().getValues();
    if(values.length < 2) return json_({ok:true,records:[]});
    const headers = HEADERS;
    const records = values.slice(1).map(function(r){
      const o={};
      headers.forEach(function(h,i){ o[h] = r[i] === undefined || r[i] === null ? '' : r[i]; });
      return o;
    });
    return json_({ok:true,records:records});
  }catch(err){
    return json_({ok:false,error:String(err)});
  }
}
function doPost(e){
  try{
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if(!check_(body.secret)) return json_({ok:false,error:'Unauthorized'});
    const sh = sheet_();
    const now = new Date().toISOString();
    const email = String(body.email || '').trim();
    const store = String(body.store_name || '').trim();
    const entryNo = String(body.entry_no || ('STK-' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd-HHmmss') + '-' + Utilities.getUuid().slice(0,4).toUpperCase()));
    const rows = (body.rows || []).filter(function(r){ return Number(r.Total || 0) > 0; });
    if(!email || !store || !rows.length) return json_({ok:false,error:'Missing submission data'});
    const out = rows.map(function(r){
      const stock = Number(r.Stock || 0);
      const tester = Number(r.Tester || 0);
      return [entryNo,now,email,store,String(r['EAN Code'] || ''),String(r['Product Name'] || ''),stock,tester,stock+tester];
    });
    sh.getRange(sh.getLastRow()+1,1,out.length,HEADERS.length).setValues(out);
    SpreadsheetApp.flush();
    return json_({ok:true,saved_rows:out.length,entry_no:entryNo});
  }catch(err){ return json_({ok:false,error:String(err)}); }
}
