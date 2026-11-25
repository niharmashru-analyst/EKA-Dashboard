/* =========================================================
   CORMATE / RENÉE - Submission Backend v6 (merged v4 + v5)
   ---------------------------------------------------------
   - Field submissions + manual Excel/CSV/PDF uploads
   - Original files saved to Google Drive (link stored in sheet)
   - Audit fields: submitted_by, submission_mode
   - Safe schema migration for older sheets (v4 / v5 / earlier)
   - v6 fixes:
       * validate BEFORE saving to Drive (no orphan files)
       * LockService (no overlapping writes)
       * duplicate entry_no protection (safe retries)
       * secret read from Script Properties (fallback to constant)
       * text columns stored as plain text (no formula injection,
         EAN leading zeros preserved)
       * file type allow-list, size limit, sanitized file names
   ---------------------------------------------------------
   AFTER PASTING: run authorizeOnce() once, then
   Deploy > Manage deployments > Edit > New version.
   ========================================================= */

/* ---------- CONFIG ---------- */

// Preferred: Project Settings > Script Properties > add SECRET.
// This constant is only a fallback.
const SECRET_FALLBACK = 'EKA2026Stock123';

const SHEET_NAME   = 'Submissions';
const PDF_LOG_SHEET = 'PDF Uploads';
const AUDIT_LOG_SHEET = 'Upload Audit';

// Optional: your own Drive folder ID. Blank = auto-create "CORMATE_Uploads".
const DRIVE_FOLDER_ID = '';

const MAX_FILE_BYTES = 15 * 1024 * 1024; // 15 MB decoded
const ALLOWED_FILE_TYPES = ['PDF', 'CSV', 'XLSX', 'XLSM', 'XLS'];

const HEADERS = [
  'entry_no', 'submitted_at', 'email', 'store_name', 'ean_code',
  'product_name', 'stock', 'tester', 'total', 'submitted_by',
  'submission_mode', 'file_name', 'file_type', 'drive_file_id', 'drive_file_url'
];

const AUDIT_HEADERS = [
  'audit_id', 'event_at', 'status', 'action', 'entry_no', 'email', 'store_name',
  'submitted_by', 'issued_by', 'submission_mode', 'file_name', 'file_type',
  'file_size_bytes', 'saved_rows', 'client_ip', 'user_agent', 'drive_file_id',
  'drive_file_url', 'error', 'receipt_hash', 'ean_column', 'stock_column', 'tester_column'
];

const PDF_HEADERS = [
  'uploaded_at', 'email', 'store_name', 'file_name', 'file_type',
  'drive_file_id', 'drive_file_url', 'submitted_by', 'submission_mode'
];

// 1-based columns of HEADERS stored as plain text
const TEXT_COLS = [1, 3, 4, 5, 6, 10, 11, 12, 13];

// Old column names -> canonical names (used by migration)
const ALIAS = {
  entry_no:        ['entry_no', 'entry_number'],
  submitted_at:    ['submitted_at', 'date', 'timestamp', 'submitted_date', 'uploaded_at'],
  email:           ['email', 'email_id', 'submitted_by_email'],
  store_name:      ['store_name', 'shop_name', 'store'],
  ean_code:        ['ean_code', 'ean', 'sku', 'sku_code'],
  product_name:    ['product_name', 'product', 'description'],
  stock:           ['stock', 'stock_qty', 'physical_stock', 'quantity'],
  tester:          ['tester', 'tester_qty'],
  total:           ['total', 'total_qty'],
  submitted_by:    ['submitted_by', 'uploaded_by', 'admin_email', 'created_by'],
  submission_mode: ['submission_mode', 'mode', 'source'],
  file_name:       ['file_name', 'uploaded_file', 'original_file'],
  file_type:       ['file_type', 'upload_type'],
  drive_file_id:   ['drive_file_id', 'file_id'],
  drive_file_url:  ['drive_file_url', 'file_url', 'drive_url']
};


/* ---------- HELPERS ---------- */

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function getSecret_() {
  const prop = PropertiesService.getScriptProperties().getProperty('SECRET');
  return String(prop || SECRET_FALLBACK || '');
}

// Fails closed: if no secret is configured, nobody gets in.
function check_(secret) {
  const s = getSecret_();
  return !!s && String(secret || '') === s;
}

function norm_(v) {
  return String(v == null ? '' : v).trim().toLowerCase().replace(/[^a-z0-9]+/g, '_');
}

function num_(v) {
  const n = Number(v);
  return isFinite(n) ? n : 0;
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try { return fn(); } finally { lock.releaseLock(); }
}

function getSpreadsheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('No active Google Spreadsheet is connected to this Apps Script.');
  return ss;
}


/* ---------- DRIVE ---------- */

function getRootFolder_() {
  if (DRIVE_FOLDER_ID) {
    try { return DriveApp.getFolderById(DRIVE_FOLDER_ID); }
    catch (err) { throw new Error('Invalid DRIVE_FOLDER_ID. Please check the Google Drive folder ID.'); }
  }
  const it = DriveApp.getFoldersByName('CORMATE_Uploads');
  return it.hasNext() ? it.next() : DriveApp.createFolder('CORMATE_Uploads');
}

function getOrCreateFolder_(parent, name) {
  const it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

function getUploadFolder_(fileType) {
  const root = getRootFolder_();
  return getOrCreateFolder_(root, fileType === 'PDF' ? 'PDF_Uploads' : 'Excel_CSV_Uploads');
}


/* ---------- FILE HANDLING ---------- */

function detectFileType_(fileName, mimeType) {
  const name = String(fileName || '').toLowerCase();
  const mime = String(mimeType || '').toLowerCase();
  if (name.endsWith('.pdf') || mime.indexOf('pdf') !== -1) return 'PDF';
  if (name.endsWith('.csv') || mime.indexOf('csv') !== -1) return 'CSV';
  if (name.endsWith('.xlsm')) return 'XLSM';
  if (name.endsWith('.xlsx') || mime.indexOf('spreadsheetml') !== -1) return 'XLSX';
  if (name.endsWith('.xls') || mime.indexOf('ms-excel') !== -1) return 'XLS';
  return 'FILE';
}

function safeFileName_(name) {
  return String(name || 'Uploaded_File').replace(/[\\\/:*?"<>|\r\n]+/g, '_').trim().slice(0, 120) || 'Uploaded_File';
}

/**
 * Decode + validate the uploaded file WITHOUT saving it.
 * Returns null when no file was sent.
 */
function prepareFile_(fileData, entryNo) {
  if (!fileData) return null;

  const rawName = String(fileData.file_name || fileData.name || 'Uploaded_File');
  const mimeType = String(fileData.mime_type || fileData.type || 'application/octet-stream').trim();
  const fileType = detectFileType_(rawName, mimeType);

  if (ALLOWED_FILE_TYPES.indexOf(fileType) === -1) {
    throw new Error('Unsupported file type. Allowed: ' + ALLOWED_FILE_TYPES.join(', '));
  }

  let base64 = String(fileData.base64 || fileData.data || '');
  if (!base64) throw new Error('Uploaded file data is empty.');
  const comma = base64.indexOf(',');
  if (comma !== -1) base64 = base64.substring(comma + 1); // strip data: prefix

  // Quick size check before decoding (base64 is ~4/3 of the raw size)
  if (base64.length * 0.75 > MAX_FILE_BYTES) {
    throw new Error('File too large. Maximum is ' + Math.round(MAX_FILE_BYTES / 1048576) + ' MB.');
  }

  const bytes = Utilities.base64Decode(base64);
  if (bytes.length > MAX_FILE_BYTES) {
    throw new Error('File too large. Maximum is ' + Math.round(MAX_FILE_BYTES / 1048576) + ' MB.');
  }

  const finalName = entryNo + '_' + safeFileName_(rawName);
  return { blob: Utilities.newBlob(bytes, mimeType, finalName), type: fileType, name: finalName };
}

function saveFile_(prepared) {
  if (!prepared) return { file: null, info: { file_name: '', file_type: '', drive_file_id: '', drive_file_url: '' } };
  const file = getUploadFolder_(prepared.type).createFile(prepared.blob);
  return {
    file: file,
    info: {
      file_name: file.getName(),
      file_type: prepared.type,
      drive_file_id: file.getId(),
      drive_file_url: file.getUrl()
    }
  };
}


/* ---------- SHEETS + MIGRATION ---------- */

function sheet_() {
  const ss = getSpreadsheet_();
  const sh = ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME);
  migrate_(sh, HEADERS);
  return sh;
}

function auditSheet_() {
  const ss = getSpreadsheet_();
  const sh = ss.getSheetByName(AUDIT_LOG_SHEET) || ss.insertSheet(AUDIT_LOG_SHEET);
  migrate_(sh, AUDIT_HEADERS);
  return sh;
}

function pdfSheet_() {
  const ss = getSpreadsheet_();
  const sh = ss.getSheetByName(PDF_LOG_SHEET) || ss.insertSheet(PDF_LOG_SHEET);
  migrate_(sh, PDF_HEADERS);
  return sh;
}

function needsMigration_(sh, headers) {
  if (sh.getLastRow() === 0) return true;
  const current = sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), 1)).getDisplayValues()[0].map(norm_);
  const canonical = headers.map(norm_);
  return !(current.length >= canonical.length && canonical.every((h, i) => current[i] === h));
}

// Shared migration: reorders/renames old columns into the canonical headers,
// keeping existing data (works for both Submissions and PDF Uploads).
function migrate_(sh, headers) {
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
    return;
  }

  const width = Math.max(sh.getLastColumn(), 1);
  const current = sh.getRange(1, 1, 1, width).getDisplayValues()[0].map(norm_);
  const canonical = headers.map(norm_);
  const already = current.length >= canonical.length && canonical.every((h, i) => current[i] === h);
  if (already) return;

  const values = sh.getDataRange().getValues();
  const oldHeaders = (values.shift() || []).map(norm_);
  const idx = {};
  oldHeaders.forEach((h, i) => { if (h && idx[h] === undefined) idx[h] = i; });

  const out = values.map(row => headers.map(h => {
    const keys = ALIAS[h] || [h];
    for (const k of keys) {
      if (idx[k] !== undefined) return row[idx[k]] == null ? '' : row[idx[k]];
    }
    return '';
  }));

  sh.clearContents();
  sh.getRange(1, 1, 1, headers.length).setValues([headers]);
  if (out.length) sh.getRange(2, 1, out.length, headers.length).setValues(out);
}

// Writes rows with text columns forced to plain text (blocks formulas, keeps EAN zeros)
function writeRows_(sh, rows, textCols) {
  const start = sh.getLastRow() + 1;
  textCols.forEach(c => sh.getRange(start, c, rows.length, 1).setNumberFormat('@'));
  sh.getRange(start, 1, rows.length, rows[0].length).setValues(rows);
}

function entryExists_(sh, entryNo) {
  const last = sh.getLastRow();
  if (last < 2) return false;
  const col = sh.getRange(2, 1, last - 1, 1).getValues();
  for (let i = 0; i < col.length; i++) {
    if (String(col[i][0]) === entryNo) return true;
  }
  return false;
}


function makeAuditId_() {
  return 'AUD-' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd-HHmmss') + '-' + Utilities.getUuid().slice(0, 8).toUpperCase();
}
function hashReceipt_(auditId, entryNo, email, store, fileName, eventAt) {
  const raw=[auditId,entryNo,email,store,fileName,eventAt,getSecret_()].join('|');
  const digest=Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,raw,Utilities.Charset.UTF_8);
  return digest.map(function(b){const n=b<0?b+256:b;return ('0'+n.toString(16)).slice(-2);}).join('');
}
function writeAudit_(a) {
  try {
    const sh=auditSheet_(), eventAt=a.event_at||new Date().toISOString(), auditId=a.audit_id||makeAuditId_();
    const receipt=a.receipt_hash||hashReceipt_(auditId,a.entry_no||'',a.email||'',a.store_name||'',a.file_name||'',eventAt);
    writeRows_(sh,[[auditId,eventAt,a.status||'SUCCESS',a.action||'SUBMISSION',a.entry_no||'',a.email||'',a.store_name||'',a.submitted_by||'',a.issued_by||'',a.submission_mode||'',a.file_name||'',a.file_type||'',num_(a.file_size_bytes),num_(a.saved_rows),a.client_ip||'',a.user_agent||'',a.drive_file_id||'',a.drive_file_url||'',a.error||'',receipt,a.ean_column||'',a.stock_column||'',a.tester_column||'']],[1,2,3,4,5,6,7,8,9,10,11,12,15,16,17,18,19,20,21,22,23]);
    SpreadsheetApp.flush(); return {audit_id:auditId,receipt_hash:receipt};
  } catch(err) { console.error('Audit write failed: '+err); return {audit_id:a.audit_id||'',receipt_hash:''}; }
}

/* ---------- GET ---------- */

function doGet(e) {
  try {
    if (!check_((e && e.parameter) ? e.parameter.secret : '')) {
      return json_({ ok: false, error: 'Unauthorized' });
    }

    // Reads don't take the lock, so a long Drive upload can't block the
    // dashboard's refresh. Lock only if the sheet needs creating/migrating.
    let sh = getSpreadsheet_().getSheetByName(SHEET_NAME);
    if (!sh || needsMigration_(sh, HEADERS)) {
      sh = withLock_(sheet_);
    }

    const params=(e&&e.parameter)?e.parameter:{};
    if(String(params.view||'').toLowerCase()==='audit'){
      let ash=getSpreadsheet_().getSheetByName(AUDIT_LOG_SHEET);
      if(!ash||needsMigration_(ash,AUDIT_HEADERS)) ash=withLock_(auditSheet_);
      const av=ash.getDataRange().getValues();
      const records=av.length<2?[]:av.slice(1).map(function(r){const o={};AUDIT_HEADERS.forEach(function(h,i){o[h]=(r[i]===undefined||r[i]===null)?'':r[i];});return o;});
      const limit=Math.max(1,Math.min(Number(params.limit||500),1000)); records.reverse();
      return json_({ok:true,records:records.slice(0,limit)});
    }
    if(String(params.view||'').toLowerCase()==='variance_cases'){
      const vsh=varianceCasesSheet_(); const vv=vsh.getDataRange().getValues();
      const vh=VARIANCE_CASE_HEADERS; let records=vv.length<2?[]:vv.slice(1).map(function(r){const o={};vh.forEach(function(h,i){o[h]=(r[i]===undefined||r[i]===null)?'':r[i];});return o;});
      records.reverse(); const limit=Math.max(1,Math.min(Number(params.limit||1000),2000));
      return json_({ok:true,records:records.slice(0,limit)});
    }
    const values = sh.getDataRange().getValues();
    if (values.length < 2) return json_({ ok: true, records: [] });
    const records = values.slice(1).map(function (r) {
      const o = {}; HEADERS.forEach(function (h, i) { o[h] = (r[i] === undefined || r[i] === null) ? '' : r[i]; }); return o;
    });
    return json_({ ok: true, records: records });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}


/* ---------- POST ---------- */

function doPost(e) {
  let savedFile = null;
  let auditContext = {};

  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (!check_(body.secret)) return json_({ ok: false, error: 'Unauthorized' });
    if(String(body.kind||'').toLowerCase()==='variance_case') return handleVarianceCase_(body);

    const email = String(body.email || '').trim();
    const store = String(body.store_name || '').trim();
    const submittedBy = String(body.submitted_by || email || '').trim();
    const mode = String(body.submission_mode || 'field_entry').trim();
    auditContext={audit_id:String(body.audit_id||makeAuditId_()),email:email,store_name:store,submitted_by:submittedBy,issued_by:String(body.issued_by||submittedBy||email).trim(),submission_mode:mode,client_ip:String(body.client_ip||'').trim(),user_agent:String(body.user_agent||'').trim(),ean_column:String(body.ean_column||'').trim(),stock_column:String(body.stock_column||'').trim(),tester_column:String(body.tester_column||'').trim(),action:'UPLOAD/SUBMISSION'};

    const entryNo = String(body.entry_no || (
      'STK-' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd-HHmmss') +
      '-' + Utilities.getUuid().slice(0, 4).toUpperCase()
    ));

    // ----- 1. VALIDATE everything first (nothing written yet) -----
    if (!email || !store) return json_({ ok: false, error: 'Missing submission data' });
    if (!/^[^\s@]+@[^\s@]+$/.test(email)) return json_({ ok: false, error: 'Invalid email' });

    const rows = (Array.isArray(body.rows) ? body.rows : [])
      .map(function (r) {
        const stock = num_(r.Stock);
        const tester = num_(r.Tester);
        return {
          ean: String(r['EAN Code'] || '').trim(),
          name: String(r['Product Name'] || '').trim(),
          stock: stock,
          tester: tester,
          total: stock + tester
        };
      })
      .filter(function (r) { return r.total > 0; });

    const prepared = prepareFile_(body.file, entryNo);
    auditContext.entry_no=entryNo; auditContext.file_name=body.file?String(body.file.file_name||body.file.name||''):''; auditContext.file_size_bytes=body.file?Number(body.file.size_bytes||0):0;
    const isPDF = !!prepared && prepared.type === 'PDF';

    if (!rows.length && !isPDF) return json_({ ok: false, error: 'Missing submission data' });

    // ----- 2. WRITE under lock -----
    return withLock_(function () {
      const sh = sheet_();

      // Safe retry: same entry_no already saved -> don't duplicate
      if (body.entry_no && entryExists_(sh, entryNo)) {
        const dup=writeAudit_(Object.assign({},auditContext,{status:'DUPLICATE',action:'DUPLICATE_RETRY',saved_rows:rows.length}));
        return json_({ok:true,duplicate:true,saved_rows:rows.length,entry_no:entryNo,submission_mode:mode,audit_id:dup.audit_id,receipt_hash:dup.receipt_hash});
      }

      const now = new Date().toISOString();
      const saved = saveFile_(prepared);
      savedFile = saved.file;
      const f = saved.info; auditContext.file_name=f.file_name||auditContext.file_name; auditContext.file_type=f.file_type||''; auditContext.drive_file_id=f.drive_file_id||''; auditContext.drive_file_url=f.drive_file_url||''; auditContext.saved_rows=rows.length;

      if (isPDF) {
        const pdfSh = pdfSheet_();
        writeRows_(pdfSh, [[
          now, email, store, f.file_name, f.file_type,
          f.drive_file_id, f.drive_file_url, submittedBy, mode
        ]], [2, 3, 4, 5, 8, 9]);
      }

      if (rows.length) {
        const out = rows.map(function (r) {
          return [
            entryNo, now, email, store, r.ean, r.name,
            r.stock, r.tester, r.total, submittedBy, mode,
            f.file_name, f.file_type, f.drive_file_id, f.drive_file_url
          ];
        });
        writeRows_(sh, out, TEXT_COLS);
      }

      SpreadsheetApp.flush();
      const audit=writeAudit_(Object.assign({},auditContext,{status:'SUCCESS'}));
      savedFile = null;

      return json_({
        ok: true,
        saved_rows: rows.length,
        entry_no: entryNo,
        submission_mode: mode,
        file_name: f.file_name,
        file_type: f.file_type,
        drive_file_id: f.drive_file_id,
        drive_file_url:f.drive_file_url, audit_id:audit.audit_id, receipt_hash:audit.receipt_hash
      });
    });

  } catch (err) {
    auditContext.status='FAILED'; auditContext.error=String(err); writeAudit_(auditContext);
    // Sheet write failed after the file was saved -> remove the orphan
    if (savedFile) { try { savedFile.setTrashed(true); } catch (ignore) {} }
    return json_({ ok: false, error: String(err) });
  }
}



function backfillAuditOnce(){return withLock_(function(){const ash=auditSheet_(),existing={};const av=ash.getDataRange().getValues();if(av.length>1)av.slice(1).forEach(function(r){existing[String(r[0]||'')]=true;});const sh=sheet_(),v=sh.getDataRange().getValues(),g={};if(v.length>1)v.slice(1).forEach(function(r){const e=String(r[0]||'').trim();if(e&&!g[e])g[e]=r;});Object.keys(g).forEach(function(e){const r=g[e],id='LEGACY-'+e;if(!existing[id])writeAudit_({audit_id:id,event_at:r[1]||new Date().toISOString(),status:'SUCCESS',action:'LEGACY_BACKFILL',entry_no:e,email:r[2],store_name:r[3],submitted_by:r[9],issued_by:r[9],submission_mode:r[10]||'legacy',file_name:r[11],file_type:r[12],drive_file_id:r[13],drive_file_url:r[14]});});const ph=pdfSheet_(),pv=ph.getDataRange().getValues();if(pv.length>1)pv.slice(1).forEach(function(r,i){const id='LEGACY-PDF-'+(i+1);if(!existing[id])writeAudit_({audit_id:id,event_at:r[0]||new Date().toISOString(),status:'SUCCESS',action:'LEGACY_BACKFILL',email:r[1],store_name:r[2],submitted_by:r[7],issued_by:r[7],submission_mode:r[8]||'pdf_upload',file_name:r[3],file_type:r[4],drive_file_id:r[5],drive_file_url:r[6]});});return 'Historical audit backfill completed.';});}

/* ---------- ONE-TIME SETUP ---------- */

// Run once from the editor to grant Drive/Sheets permissions,
// then create a NEW deployment version.
function authorizeOnce() {
  getRootFolder_();
  sheet_();
  pdfSheet_(); auditSheet_();
  Logger.log('Authorized. Now: Deploy > Manage deployments > Edit > New version.');
}


/* ---------- VARIANCE WORKFLOW ---------- */
const VARIANCE_CASE_HEADERS = ['case_id','created_at','updated_at','email','store_name','ean_code','product_name','stage','system_stock','derived_stock','physical_stock','updated_stock','remarks','status','actor','timeline_json'];
function varianceCasesSheet_(){
  const ss=getSpreadsheet_(); let sh=ss.getSheetByName('Variance Cases');
  if(!sh){sh=ss.insertSheet('Variance Cases');sh.getRange(1,1,1,VARIANCE_CASE_HEADERS.length).setValues([VARIANCE_CASE_HEADERS]);}
  const current=sh.getRange(1,1,1,Math.max(sh.getLastColumn(),VARIANCE_CASE_HEADERS.length)).getDisplayValues()[0].map(String);
  if(current[0]!=='case_id'){sh.insertRowBefore(1);sh.getRange(1,1,1,VARIANCE_CASE_HEADERS.length).setValues([VARIANCE_CASE_HEADERS]);}
  else VARIANCE_CASE_HEADERS.forEach(function(h,i){if(current[i]!==h)sh.getRange(1,i+1).setValue(h);});
  return sh;
}
function handleVarianceCase_(body){
  return withLock_(function(){
    const sh=varianceCasesSheet_(), now=new Date().toISOString(), action=String(body.action||'create').toLowerCase();
    const values=sh.getDataRange().getValues(), headers=VARIANCE_CASE_HEADERS;
    if(action==='create'){
      const id=String(body.case_id||('VAR-'+Utilities.getUuid().slice(0,10).toUpperCase()));
      if(values.slice(1).some(function(r){return String(r[0])===id;})) return json_({ok:true,duplicate:true,case_id:id});
      const timeline=[{at:now,actor:String(body.actor||body.email||''),action:'SUBMITTED',remarks:String(body.remarks||'')}];
      const row=[id,now,now,String(body.email||''),String(body.store_name||''),String(body.ean_code||''),String(body.product_name||''),String(body.stage||'stage2'),num_(body.system_stock),num_(body.derived_stock),num_(body.physical_stock),num_(body.updated_stock),String(body.remarks||''),'Pending HOD',String(body.actor||body.email||''),JSON.stringify(timeline)];
      sh.appendRow(row); return json_({ok:true,message:'Variance submitted for HOD approval.',case_id:id,case:caseRow_(row)});
    }
    const id=String(body.case_id||''); let rowIndex=-1,row=null;
    for(let i=1;i<values.length;i++){if(String(values[i][0])===id){rowIndex=i+1;row=values[i];break;}}
    if(!row)return json_({ok:false,error:'Variance case not found.'});
    if(String(row[13])!=='Pending HOD')return json_({ok:false,error:'This case has already been actioned.'});
    if(action!=='approve'&&action!=='reject')return json_({ok:false,error:'Unknown variance action.'});
    const timeline=(()=>{try{return JSON.parse(String(row[15]||'[]'));}catch(e){return [];}})();
    const remarks=String(body.remarks||'').trim();
    timeline.push({at:now,actor:String(body.actor||''),action:action==='approve'?'APPROVED':'REJECTED',remarks:remarks});
    sh.getRange(rowIndex,3).setValue(now); sh.getRange(rowIndex,14).setValue(action==='approve'?'Approved':'Rejected'); sh.getRange(rowIndex,15).setValue(String(body.actor||'')); sh.getRange(rowIndex,16).setValue(JSON.stringify(timeline));
    if(remarks)sh.getRange(rowIndex,13).setValue(String(row[12]||'')+'\nHOD: '+remarks);
    row=sh.getRange(rowIndex,1,1,VARIANCE_CASE_HEADERS.length).getValues()[0];
    return json_({ok:true,message:'Variance '+(action==='approve'?'approved.':'rejected.'),case_id:id,case:caseRow_(row)});
  });
}
function caseRow_(r){const o={};VARIANCE_CASE_HEADERS.forEach(function(h,i){o[h]=r[i]===undefined?'':r[i];});return o;}
