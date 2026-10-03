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

    // Same public manual-upload link can also receive a previously generated PDF.
    // The PDF is stored in Drive and indexed in a separate sheet for audit/recovery.
    if(String(body.type||'').trim()==='pdf_upload'){
      const email=String(body.email||'').trim().toLowerCase();
      const store=String(body.store_name||'').trim();
      const entryNo=String(body.entry_no||('PDF-'+Utilities.formatDate(new Date(),Session.getScriptTimeZone(),'yyyyMMdd-HHmmss')+'-'+Utilities.getUuid().slice(0,4).toUpperCase()));
      const fileName=String(body.file_name||('Stock_Verification_'+entryNo+'.pdf')).replace(/[^a-zA-Z0-9._ -]/g,'_');
      const b64=String(body.pdf_base64||'');
      if(!email||!store||!b64)return json_({ok:false,error:'Missing PDF upload data'});
      const bytes=Utilities.base64Decode(b64);
      if(bytes.length>10*1024*1024)return json_({ok:false,error:'PDF is too large. Maximum allowed size is 10 MB.'});
      const blob=Utilities.newBlob(bytes,'application/pdf',fileName);
      const folderName='CORMATE Stock Verification PDFs';
      const folders=DriveApp.getFoldersByName(folderName);
      const folder=folders.hasNext()?folders.next():DriveApp.createFolder(folderName);
      const file=folder.createFile(blob);
      const logSh=SpreadsheetApp.getActiveSpreadsheet().getSheetByName('PDF Uploads') || SpreadsheetApp.getActiveSpreadsheet().insertSheet('PDF Uploads');
      if(logSh.getLastRow()===0)logSh.appendRow(['entry_no','uploaded_at','email','store_name','file_name','file_url','submission_mode']);
      logSh.appendRow([entryNo,new Date().toISOString(),email,store,fileName,file.getUrl(),'manual_pdf']);
      SpreadsheetApp.flush();
      return json_({ok:true,entry_no:entryNo,file_name:fileName,file_url:file.getUrl()});
    }

    const sh=sheet_(); const now=new Date().toISOString();
    const email=String(body.email||'').trim(); const store=String(body.store_name||'').trim();
    const entryNo=String(body.entry_no||('STK-'+Utilities.formatDate(new Date(),Session.getScriptTimeZone(),'yyyyMMdd-HHmmss')+'-'+Utilities.getUuid().slice(0,4).toUpperCase()));
    const submittedBy=String(body.submitted_by||email||'').trim();
    const mode=String(body.submission_mode||'field_entry').trim();
    const rows=(body.rows||[]).filter(function(r){return Number(r.Total||0)>0;});
    if(!email||!store||!rows.length)return json_({ok:false,error:'Missing submission data'});

    // Idempotency: a mobile device may retry after a timeout even though the
    // first request already reached Google Sheets. Never append the same entry twice.
    const lastRow=sh.getLastRow();
    if(lastRow>1){
      const existing=sh.getRange(2,1,lastRow-1,1).getDisplayValues().flat().map(String);
      if(existing.indexOf(entryNo)!==-1){
        const matched=existing.filter(function(x){return x===entryNo;}).length;
        return json_({ok:true,saved_rows:matched||rows.length,entry_no:entryNo,duplicate:true,submission_mode:mode});
      }
    }
    const out=rows.map(function(r){const stock=Number(r.Stock||0);const tester=Number(r.Tester||0);return [entryNo,now,email,store,String(r['EAN Code']||''),String(r['Product Name']||''),stock,tester,stock+tester,submittedBy,mode];});
    sh.getRange(sh.getLastRow()+1,1,out.length,HEADERS.length).setValues(out);SpreadsheetApp.flush();
    return json_({ok:true,saved_rows:out.length,entry_no:entryNo,submission_mode:mode});
  }catch(err){return json_({ok:false,error:String(err)});}
}
