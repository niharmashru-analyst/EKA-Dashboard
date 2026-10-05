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

// Optional: your own Drive folder ID. Blank = auto-create "CORMATE_Uploads".
const DRIVE_FOLDER_ID = '';

const MAX_FILE_BYTES = 15 * 1024 * 1024; // 15 MB decoded
const ALLOWED_FILE_TYPES = ['PDF', 'CSV', 'XLSX', 'XLSM', 'XLS'];

const HEADERS = [
  'entry_no', 'submitted_at', 'email', 'store_name', 'ean_code',
  'product_name', 'stock', 'tester', 'total', 'submitted_by',
  'submission_mode', 'file_name', 'file_type', 'drive_file_id', 'drive_file_url'
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

    const values = sh.getDataRange().getValues();
    if (values.length < 2) return json_({ ok: true, records: [] });

    const records = values.slice(1).map(function (r) {
      const o = {};
      HEADERS.forEach(function (h, i) { o[h] = (r[i] === undefined || r[i] === null) ? '' : r[i]; });
      return o;
    });
    return json_({ ok: true, records: records });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}


/* ---------- POST ---------- */

function doPost(e) {
  let savedFile = null; // for cleanup if the sheet write fails

  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (!check_(body.secret)) return json_({ ok: false, error: 'Unauthorized' });

    const email = String(body.email || '').trim();
    const store = String(body.store_name || '').trim();
    const submittedBy = String(body.submitted_by || email || '').trim();
    const mode = String(body.submission_mode || 'field_entry').trim();

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

    const prepared = prepareFile_(body.file, entryNo); // decode + check, NOT saved yet
    const isPDF = !!prepared && prepared.type === 'PDF';

    if (!rows.length && !isPDF) return json_({ ok: false, error: 'Missing submission data' });

    // ----- 2. WRITE under lock -----
    return withLock_(function () {
      const sh = sheet_();

      // Safe retry: same entry_no already saved -> don't duplicate
      if (body.entry_no && entryExists_(sh, entryNo)) {
        // The Flask app checks saved_rows === rows sent, so report the same count.
        return json_({ ok: true, duplicate: true, saved_rows: rows.length, entry_no: entryNo, submission_mode: mode });
      }

      const now = new Date().toISOString();
      const saved = saveFile_(prepared);
      savedFile = saved.file;
      const f = saved.info;

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
      savedFile = null; // success: keep the file

      return json_({
        ok: true,
        saved_rows: rows.length,
        entry_no: entryNo,
        submission_mode: mode,
        file_name: f.file_name,
        file_type: f.file_type,
        drive_file_id: f.drive_file_id,
        drive_file_url: f.drive_file_url
      });
    });

  } catch (err) {
    // Sheet write failed after the file was saved -> remove the orphan
    if (savedFile) { try { savedFile.setTrashed(true); } catch (ignore) {} }
    return json_({ ok: false, error: String(err) });
  }
}


/* ---------- ONE-TIME SETUP ---------- */

// Run once from the editor to grant Drive/Sheets permissions,
// then create a NEW deployment version.
function authorizeOnce() {
  getRootFolder_();
  sheet_();
  pdfSheet_();
  Logger.log('Authorized. Now: Deploy > Manage deployments > Edit > New version.');
}
