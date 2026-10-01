/* CORMATE / RENEE - Submission backend v2
   Update the existing Apps Script with this file, then redeploy the Web App.
   It adds Entry No. support while remaining compatible with existing rows.
*/
const SECRET = 'EKA2026Stock123';
const SHEET_NAME = 'Submissions';
const HEADERS = ['entry_no','submitted_at','email','store_name','ean_code','product_name','stock','tester','total'];

function json_(obj){return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);}
function check_(secret){return !SECRET || secret===SECRET;}
function sheet_(){
  const ss=SpreadsheetApp.getActiveSpreadsheet();
  let sh=ss.getSheetByName(SHEET_NAME);
  if(!sh) sh=ss.insertSheet(SHEET_NAME);
  if(sh.getLastRow()===0){sh.appendRow(HEADERS);return sh;}
  const current=sh.getRange(1,1,1,Math.max(sh.getLastColumn(),HEADERS.length)).getValues()[0].map(String);
  // Migrate an older sheet whose first header was submitted_at.
  if(current[0] !== 'entry_no'){
    sh.insertColumnBefore(1);
    sh.getRange(1,1).setValue('entry_no');
  }
  const now=sh.getRange(1,1,1,Math.max(sh.getLastColumn(),HEADERS.length)).getValues()[0].map(String);
  HEADERS.forEach((h,i)=>{if(now[i]!==h) sh.getRange(1,i+1).setValue(h);});
  return sh;
}
function doGet(e){
  if(!check_((e.parameter||{}).secret)) return json_({ok:false,error:'Unauthorized'});
  const sh=sheet_();
  const values=sh.getDataRange().getValues();
  if(values.length<2)return json_({ok:true,records:[]});
  const headers=values.shift();
  const records=values.map(r=>Object.fromEntries(headers.map((h,i)=>[h,r[i]])));
  return json_({ok:true,records:records});
}
function doPost(e){
  try{
    const body=JSON.parse(e.postData.contents||'{}');
    if(!check_(body.secret))return json_({ok:false,error:'Unauthorized'});
    const sh=sheet_();
    const now=new Date().toISOString();
    const email=body.email||'';
    const store=body.store_name||'';
    const entryNo=body.entry_no||('STK-'+Utilities.formatDate(new Date(),Session.getScriptTimeZone(),'yyyyMMdd-HHmmss')+'-'+Utilities.getUuid().slice(0,4).toUpperCase());
    const rows=(body.rows||[]).filter(r=>Number(r.Total||0)>0);
    if(!email||!store||!rows.length)return json_({ok:false,error:'Missing submission data'});
    const out=rows.map(r=>[entryNo,now,email,store,r['EAN Code']||'',r['Product Name']||'',Number(r.Stock||0),Number(r.Tester||0),Number(r.Total||0)]);
    sh.getRange(sh.getLastRow()+1,1,out.length,HEADERS.length).setValues(out);
    return json_({ok:true,saved_rows:out.length,entry_no:entryNo});
  }catch(err){return json_({ok:false,error:String(err)});}
}
