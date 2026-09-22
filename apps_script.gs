/*
 Google Apps Script backend for field-stock submissions.
 Create a Google Sheet, add a tab named "Submissions", paste this code into
 Extensions -> Apps Script, set SECRET below, then Deploy -> New deployment
 -> Web app -> Execute as Me -> Who has access: Anyone.
 Copy the /exec URL into Render as SUBMISSION_API_URL.
*/
const SECRET = 'EKA2026Stock123';
const SHEET_NAME = 'Submissions';
const HEADERS = ['submitted_at','email','store_name','ean_code','product_name','stock','tester','total'];
// Inward Validation (PO receiving check) - saved to its own tab, only when the request has kind:'inward'.
const INWARD_SHEET_NAME = 'Inward_Validation';
const INWARD_HEADERS = ['submitted_at','email','document_no','shop_name','transfer_to_code','ean','description','quantity','received_qty','variance_qty','variance_pct','status','line_data_json'];

function json_(obj){return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);}
function check_(secret){return !SECRET || secret===SECRET;}
function ensurePublicView_(ss){
  // Make the spreadsheet itself accessible to anyone who has the link.
  // This is required because the Flask dashboard downloads the Google Sheet
  // through the public XLSX export endpoint.
  try {
    DriveApp.getFileById(ss.getId()).setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  } catch (err) {
    // Keep submissions working if the Workspace administrator blocks public link sharing.
    console.warn('Could not set Anyone-with-link sharing: ' + err);
  }
  return 'https://docs.google.com/spreadsheets/d/' + ss.getId() + '/edit';
}
function sheet_(){const ss=SpreadsheetApp.getActiveSpreadsheet();ensurePublicView_(ss);let sh=ss.getSheetByName(SHEET_NAME);if(!sh)sh=ss.insertSheet(SHEET_NAME);if(sh.getLastRow()===0)sh.appendRow(HEADERS);return sh;}
function doGet(e){if(!check_((e.parameter||{}).secret))return json_({ok:false,error:'Unauthorized'});const ss=SpreadsheetApp.getActiveSpreadsheet();const fileUrl=ensurePublicView_(ss);if((e.parameter||{}).action==='sheet'){return json_({ok:true,url:fileUrl,spreadsheetId:ss.getId()});}const sh=sheet_();const values=sh.getDataRange().getValues();if(values.length<2)return json_({ok:true,records:[]});const headers=values.shift();const records=values.map(r=>Object.fromEntries(headers.map((h,i)=>[h,r[i]])));return json_({ok:true,records:records});}
function doPost(e){try{const body=JSON.parse(e.postData.contents||'{}');if(!check_(body.secret))return json_({ok:false,error:'Unauthorized'});if(body.kind==='inward')return saveInward_(body);const sh=sheet_();const now=new Date().toISOString();const email=body.email||'';const store=body.store_name||'';const rows=body.rows||[];if(!email||!store||!rows.length)return json_({ok:false,error:'Missing submission data'});const out=rows.map(r=>[now,email,store,r['EAN Code']||'',r['Product Name']||'',Number(r.Stock||0),Number(r.Tester||0),Number(r.Total||0)]);sh.getRange(sh.getLastRow()+1,1,out.length,HEADERS.length).setValues(out);return json_({ok:true,saved_rows:out.length});}catch(err){return json_({ok:false,error:String(err)});}}
function saveInward_(body){
  const email=body.email||'',po=body.po_number||'',rows=body.rows||[];
  if(!email||!po||!rows.length)return json_({ok:false,error:'Missing inward data'});
  const ss=SpreadsheetApp.getActiveSpreadsheet();
  ensurePublicView_(ss);
  let sh=ss.getSheetByName(INWARD_SHEET_NAME);
  if(!sh)sh=ss.insertSheet(INWARD_SHEET_NAME);if(sh.getLastRow()===0)sh.appendRow(INWARD_HEADERS);
  const now=new Date().toISOString();
  const out=rows.map(r=>[now,email,r['Document No.']||po,r['Shop Name']||'',r['Transfer-to Code']||'',r['EAN']||'',r['Description']||'',Number(r['Quantity']||0),Number(r['Received Qty']||0),Number(r['Variance Qty']||0),r['Variance %']===null?'':Number(r['Variance %']),r['Status']||'',JSON.stringify(r)]);
  sh.getRange(sh.getLastRow()+1,1,out.length,INWARD_HEADERS.length).setValues(out);
  return json_({ok:true,saved_rows:out.length});
}
