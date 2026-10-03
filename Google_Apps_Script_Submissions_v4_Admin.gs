/* CORMATE / RENÉE - Submission backend v5
   Field submissions + manual Excel/CSV + PDF uploads.
   Original uploaded files are stored in Google Drive.
*/
const SECRET='EKA2026Stock123';
const SHEET_NAME='Submissions';
const PDF_LOG_SHEET='PDF Uploads';
// Leave blank to auto-create/find CORMATE_Uploads in My Drive.
const DRIVE_FOLDER_ID='';
const HEADERS=['entry_no','submitted_at','email','store_name','ean_code','product_name','stock','tester','total','submitted_by','submission_mode','file_name','file_type','drive_file_id','drive_file_url'];
const PDF_HEADERS=['uploaded_at','email','store_name','file_name','file_type','drive_file_id','drive_file_url','submitted_by','submission_mode'];

function json_(obj){return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);}
function check_(secret){return !SECRET||String(secret||'')===SECRET;}
function norm_(v){return String(v==null?'':v).trim().toLowerCase().replace(/[^a-z0-9]+/g,'_');}

function rootFolder_(){
  if(DRIVE_FOLDER_ID){try{return DriveApp.getFolderById(DRIVE_FOLDER_ID);}catch(e){throw new Error('Invalid DRIVE_FOLDER_ID.');}}
  const f=DriveApp.getFoldersByName('CORMATE_Uploads');
  return f.hasNext()?f.next():DriveApp.createFolder('CORMATE_Uploads');
}
function uploadFolder_(type){
  const root=rootFolder_();
  const name=String(type||'').toUpperCase()==='PDF'?'PDF_Uploads':'Excel_CSV_Uploads';
  const f=root.getFoldersByName(name);
  return f.hasNext()?f.next():root.createFolder(name);
}
function fileType_(name,mime){
  const n=String(name||'').toLowerCase(),m=String(mime||'').toLowerCase();
  if(n.endsWith('.pdf')||m.indexOf('pdf')>=0)return 'PDF';
  if(n.endsWith('.csv')||m.indexOf('csv')>=0)return 'CSV';
  if(n.endsWith('.xlsm'))return 'XLSM';
  if(n.endsWith('.xlsx')||m.indexOf('spreadsheetml')>=0||m.indexOf('excel')>=0)return 'XLSX';
  if(n.endsWith('.xls')||m.indexOf('ms-excel')>=0)return 'XLS';
  return 'FILE';
}
function saveFile_(f){
  if(!f)return {file_name:'',file_type:'',drive_file_id:'',drive_file_url:''};
  const name=String(f.file_name||f.name||'Uploaded_File').trim();
  const mime=String(f.mime_type||f.type||'application/octet-stream').trim();
  const type=fileType_(name,mime);
  let b64=String(f.base64||f.data||'');
  if(!b64)throw new Error('Uploaded file data is empty.');
  const comma=b64.indexOf(','); if(comma>=0)b64=b64.slice(comma+1);
  const blob=Utilities.newBlob(Utilities.base64Decode(b64),mime,name);
  const file=uploadFolder_(type).createFile(blob);
  return {file_name:file.getName(),file_type:type,drive_file_id:file.getId(),drive_file_url:file.getUrl()};
}
function sheet_(){const ss=SpreadsheetApp.getActiveSpreadsheet();if(!ss)throw new Error('No active Google Spreadsheet is connected.');let sh=ss.getSheetByName(SHEET_NAME);if(!sh)sh=ss.insertSheet(SHEET_NAME);migrate_(sh,HEADERS);return sh;}
function pdfSheet_(){const ss=SpreadsheetApp.getActiveSpreadsheet();if(!ss)throw new Error('No active Google Spreadsheet is connected.');let sh=ss.getSheetByName(PDF_LOG_SHEET);if(!sh)sh=ss.insertSheet(PDF_LOG_SHEET);migrate_(sh,PDF_HEADERS);return sh;}
function migrate_(sh,headers){
  if(sh.getLastRow()===0){sh.getRange(1,1,1,headers.length).setValues([headers]);return;}
  const raw=sh.getRange(1,1,1,Math.max(sh.getLastColumn(),1)).getDisplayValues()[0].map(norm_);
  const canon=headers.map(norm_); if(raw.length>=canon.length&&canon.every((h,i)=>raw[i]===h))return;
  const vals=sh.getDataRange().getValues(); const old=(vals.shift()||[]).map(norm_); const idx={};old.forEach((h,i)=>{if(h)idx[h]=i;});
  const aliases={entry_no:['entry_no','entry_number'],submitted_at:['submitted_at','date','timestamp','uploaded_at'],email:['email','email_id','submitted_by_email'],store_name:['store_name','shop_name','store'],ean_code:['ean_code','ean','sku','sku_code'],product_name:['product_name','product','description'],stock:['stock','stock_qty','physical_stock','quantity'],tester:['tester','tester_qty'],total:['total','total_qty'],submitted_by:['submitted_by','uploaded_by','admin_email','created_by'],submission_mode:['submission_mode','mode','source'],file_name:['file_name','uploaded_file','original_file'],file_type:['file_type','upload_type'],drive_file_id:['drive_file_id','file_id'],drive_file_url:['drive_file_url','file_url','drive_url']};
  const out=vals.map(row=>headers.map(h=>{for(const k of (aliases[h]||[h]))if(idx[k]!==undefined)return row[idx[k]]==null?'':row[idx[k]];return '';}));
  sh.clearContents();sh.getRange(1,1,1,headers.length).setValues([headers]);if(out.length)sh.getRange(2,1,out.length,headers.length).setValues(out);
}
function doGet(e){try{if(!check_(e&&e.parameter?e.parameter.secret:''))return json_({ok:false,error:'Unauthorized'});const sh=sheet_(),v=sh.getDataRange().getValues();if(v.length<2)return json_({ok:true,records:[]});return json_({ok:true,records:v.slice(1).map(r=>{const o={};HEADERS.forEach((h,i)=>o[h]=r[i]==null?'':r[i]);return o;})});}catch(err){return json_({ok:false,error:String(err)});}}
function doPost(e){
  try{
    const body=JSON.parse((e&&e.postData&&e.postData.contents)||'{}');if(!check_(body.secret))return json_({ok:false,error:'Unauthorized'});
    const now=new Date().toISOString(),email=String(body.email||'').trim(),store=String(body.store_name||'').trim();
    const entryNo=String(body.entry_no||('STK-'+Utilities.formatDate(new Date(),Session.getScriptTimeZone(),'yyyyMMdd-HHmmss')+'-'+Utilities.getUuid().slice(0,4).toUpperCase()));
    const submittedBy=String(body.submitted_by||email||'').trim(),mode=String(body.submission_mode||'field_entry').trim();
    if(!email||!store)return json_({ok:false,error:'Missing email or store.'});
    let file={file_name:'',file_type:'',drive_file_id:'',drive_file_url:''}; if(body.file)file=saveFile_(body.file);
    const rows=(body.rows||[]).filter(r=>Number(r.Total||0)>0);
    if(!rows.length&&!file.file_name)return json_({ok:false,error:'Missing submission data.'});
    if(file.file_type==='PDF'){
      const p=pdfSheet_();p.getRange(p.getLastRow()+1,1,1,PDF_HEADERS.length).setValues([[now,email,store,file.file_name,file.file_type,file.drive_file_id,file.drive_file_url,submittedBy,mode]]);SpreadsheetApp.flush();
    }
    if(rows.length){
      const sh=sheet_();const out=rows.map(r=>{const stock=Number(r.Stock||0),tester=Number(r.Tester||0);return [entryNo,now,email,store,String(r['EAN Code']||''),String(r['Product Name']||''),stock,tester,stock+tester,submittedBy,mode,file.file_name,file.file_type,file.drive_file_id,file.drive_file_url];});
      sh.getRange(sh.getLastRow()+1,1,out.length,HEADERS.length).setValues(out);SpreadsheetApp.flush();
    }
    return json_({ok:true,saved_rows:rows.length,entry_no:entryNo,submission_mode:mode,file_name:file.file_name,file_type:file.file_type,drive_file_id:file.drive_file_id,drive_file_url:file.drive_file_url});
  }catch(err){return json_({ok:false,error:String(err)});}
}
