/*
 Google Apps Script backend for field-stock submissions.
 Create a Google Sheet, add a tab named "Submissions", paste this code into
 Extensions -> Apps Script, set SECRET below, then Deploy -> New deployment
 -> Web app -> Execute as Me -> Who has access: Anyone.
 Copy the /exec URL into Render as SUBMISSION_API_URL.
*/
const SECRET = 'CHANGE_ME_TO_A_LONG_RANDOM_SECRET';
const SHEET_NAME = 'Submissions';
const HEADERS = ['submitted_at','email','store_name','ean_code','product_name','stock','tester','total'];

function json_(obj){return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);}
function check_(secret){return !SECRET || secret===SECRET;}
function sheet_(){const ss=SpreadsheetApp.getActiveSpreadsheet();let sh=ss.getSheetByName(SHEET_NAME);if(!sh)sh=ss.insertSheet(SHEET_NAME);if(sh.getLastRow()===0)sh.appendRow(HEADERS);return sh;}
function doGet(e){if(!check_((e.parameter||{}).secret))return json_({ok:false,error:'Unauthorized'});const sh=sheet_();const values=sh.getDataRange().getValues();if(values.length<2)return json_({ok:true,records:[]});const headers=values.shift();const records=values.map(r=>Object.fromEntries(headers.map((h,i)=>[h,r[i]])));return json_({ok:true,records:records});}
function doPost(e){try{const body=JSON.parse(e.postData.contents||'{}');if(!check_(body.secret))return json_({ok:false,error:'Unauthorized'});const sh=sheet_();const now=new Date().toISOString();const email=body.email||'';const store=body.store_name||'';const rows=body.rows||[];if(!email||!store||!rows.length)return json_({ok:false,error:'Missing submission data'});const out=rows.map(r=>[now,email,store,r['EAN Code']||'',r['Product Name']||'',Number(r.Stock||0),Number(r.Tester||0),Number(r.Total||0)]);sh.getRange(sh.getLastRow()+1,1,out.length,HEADERS.length).setValues(out);return json_({ok:true,saved_rows:out.length});}catch(err){return json_({ok:false,error:String(err)});}}
