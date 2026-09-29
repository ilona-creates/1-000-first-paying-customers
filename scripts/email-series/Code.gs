/**
 * Email series system — signup -> Google Sheet -> one email per day from Google Docs.
 *
 * Flow
 *  1. The landing-page form POSTs name/email/source to this script (doPost).
 *  2. A row is added to the Sheet and email #1 is sent immediately.
 *  3. A daily time trigger (sendDailyEmails) sends the next email to every
 *     active subscriber who hasn't received one today.
 *  4. Progress is written back to the Sheet (Status, Emails Sent, Last Sent...).
 *
 * Series content
 *  - One Google Doc per series, all in DRIVE_FOLDER_ID.
 *  - The Doc's NAME must match the form's "source" value (ignoring case,
 *    spaces, dashes): source "niche-for-growth" <-> Doc "Niche for Growth".
 *  - Each top-level TAB of the Doc is one email, in tab order.
 *    Tab title = subject line. Tab content = email body.
 *  - {{name}} in the subject or body is replaced with the subscriber's name.
 *
 * Setup: see README.md in this folder.
 */

var CONFIG = {
  SPREADSHEET_ID: '1xOYEW8-D_maWLiPNjeAM0sCU1wIMB7LViuGJWhGZfFk',
  SHEET_GID: 0,
  DRIVE_FOLDER_ID: '1RehcbFybM7bWqGFZPU1z_DavYSp65J41',
  SENDER_NAME: 'Ilona Melnychuk',
  REPLY_TO: 'ilona@ilonamelnychuk.com',
  SEND_HOUR: 9,            // daily send time (script time zone), used by installTrigger()
  MAX_RUNTIME_MS: 5 * 60 * 1000
};

var HEADERS = ['Timestamp', 'Name', 'Email', 'Source', 'ID', 'Series', 'Status',
               'Emails Sent', 'Total Emails', 'Last Sent', 'Last Error'];

var STATUS = { ACTIVE: 'Active', COMPLETED: 'Completed', ERROR: 'Error', UNSUBSCRIBED: 'Unsubscribed' };

/* ------------------------------ Web endpoints ------------------------------ */

function doPost(e) {
  var p = (e && e.parameter) || {};
  var name = clean_(p.firstName || p.name);
  var email = clean_(p.email).toLowerCase();
  var source = clean_(p.source);

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json_({ result: 'error', message: 'Invalid email' });
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sheet = getSheet_();
    var cols = getColumns_(sheet);
    var rows = readRows_(sheet, cols);

    for (var i = 0; i < rows.length; i++) {
      if (rows[i].email.toLowerCase() === email && norm_(rows[i].source) === norm_(source)) {
        return json_({ result: 'success', duplicate: true });
      }
    }

    var id = Utilities.getUuid();
    var series = findSeries_(source);
    var status = series ? STATUS.ACTIVE : STATUS.ERROR;
    var total = 0, err = '';
    if (series) {
      try { total = getEmails_(series).length; } catch (ex) { err = String(ex); status = STATUS.ERROR; }
    } else {
      err = 'No Google Doc named "' + source + '" found in the Drive folder';
    }

    var record = {};
    record['Timestamp'] = new Date();
    record['Name'] = sanitizeCell_(name);
    record['Email'] = sanitizeCell_(email);
    record['Source'] = sanitizeCell_(source);
    record['ID'] = id;
    record['Series'] = series ? series.getName() : '';
    record['Status'] = status;
    record['Emails Sent'] = 0;
    record['Total Emails'] = total;
    record['Last Error'] = err;
    var rowNum = appendRecord_(sheet, cols, record);

    // Send email #1 right away; the daily trigger handles the rest.
    if (status === STATUS.ACTIVE) {
      var sub = readRows_(sheet, cols).filter(function (r) { return r.rowNum === rowNum; })[0];
      sendNext_(sheet, cols, sub, series);
    }
    return json_({ result: 'success' });
  } finally {
    lock.releaseLock();
  }
}

/** Unsubscribe link target: <web app url>?unsubscribe=<ID> */
function doGet(e) {
  var id = e && e.parameter && e.parameter.unsubscribe;
  var msg = 'Invalid unsubscribe link.';
  if (id) {
    var lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try {
      var sheet = getSheet_();
      var cols = getColumns_(sheet);
      var hit = readRows_(sheet, cols).filter(function (r) { return r.id === id; })[0];
      if (hit) {
        sheet.getRange(hit.rowNum, cols['Status']).setValue(STATUS.UNSUBSCRIBED);
        msg = 'You have been unsubscribed. You will not receive any more emails.';
      }
    } finally {
      lock.releaseLock();
    }
  }
  return HtmlService.createHtmlOutput('<p style="font-family:sans-serif;font-size:18px;padding:40px">' + msg + '</p>');
}

/* ------------------------------ Daily sending ------------------------------ */

/** Run daily by a time trigger (see installTrigger). Safe to run manually too. */
function sendDailyEmails() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return;
  var started = Date.now();
  try {
    var sheet = getSheet_();
    var cols = getColumns_(sheet);
    var today = dayKey_(new Date());
    var cache = {};

    readRows_(sheet, cols).forEach(function (sub) {
      if (sub.status !== STATUS.ACTIVE) return;
      if (sub.lastSent && dayKey_(sub.lastSent) === today) return;
      if (Date.now() - started > CONFIG.MAX_RUNTIME_MS) return;   // resume on next run
      if (MailApp.getRemainingDailyQuota() < 1) return;           // resume tomorrow

      var series = cache[sub.source];
      if (series === undefined) series = cache[sub.source] = findSeries_(sub.source);
      if (!series) {
        setError_(sheet, cols, sub.rowNum, 'No Google Doc named "' + sub.source + '" found');
        return;
      }
      sendNext_(sheet, cols, sub, series);
    });
  } finally {
    lock.releaseLock();
  }
}

/** Run once from the editor to schedule the daily send. */
function installTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'sendDailyEmails') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('sendDailyEmails').timeBased().everyDays(1).atHour(CONFIG.SEND_HOUR).create();
}

function sendNext_(sheet, cols, sub, series) {
  try {
    var emails = getEmails_(series);
    var idx = sub.sent;                       // 0-based index of the next email
    if (idx >= emails.length) {
      sheet.getRange(sub.rowNum, cols['Status']).setValue(STATUS.COMPLETED);
      return;
    }
    var mail = emails[idx];
    var vars = { name: sub.name || 'there' };
    var subject = fill_(mail.subject, vars, false);
    var htmlBody = fill_(mail.html, vars, true) + unsubscribeFooter_(sub.id);
    var text = htmlToText_(htmlBody);

    MailApp.sendEmail({
      to: sub.email,
      subject: subject,
      body: text,
      htmlBody: '<div style="font-family:Arial,sans-serif;font-size:16px;line-height:1.5">' + htmlBody + '</div>',
      name: CONFIG.SENDER_NAME,
      replyTo: CONFIG.REPLY_TO
    });

    var sent = idx + 1;
    var updates = {
      'Emails Sent': sent,
      'Total Emails': emails.length,
      'Last Sent': new Date(),
      'Last Error': '',
      'Status': sent >= emails.length ? STATUS.COMPLETED : STATUS.ACTIVE
    };
    writeRecord_(sheet, cols, sub.rowNum, updates);
  } catch (ex) {
    setError_(sheet, cols, sub.rowNum, String(ex));
  }
}

function setError_(sheet, cols, rowNum, message) {
  // Keep the subscriber Active so a fixed Doc / restored quota resumes automatically.
  writeRecord_(sheet, cols, rowNum, { 'Last Error': message });
}

/* ------------------------------ Drive / Docs ------------------------------ */

function findSeries_(source) {
  if (!source) return null;
  var files = DriveApp.getFolderById(CONFIG.DRIVE_FOLDER_ID).getFilesByType(MimeType.GOOGLE_DOCS);
  while (files.hasNext()) {
    var f = files.next();
    if (norm_(f.getName()) === norm_(source)) return f;
  }
  return null;
}

/** Returns [{subject, html}] — one per top-level tab. Cached briefly. */
function getEmails_(file) {
  var cache = CacheService.getScriptCache();
  var key = 'series:' + file.getId() + ':' + file.getLastUpdated().getTime();
  var hit = cache.get(key);
  if (hit) return JSON.parse(hit);

  var tabs = DocumentApp.openById(file.getId()).getTabs();
  var emails = tabs.map(function (tab) {
    var html = bodyToHtml_(tab.asDocumentTab().getBody());
    if (!html.trim()) throw new Error('Tab "' + tab.getTitle() + '" in "' + file.getName() + '" is empty');
    return { subject: tab.getTitle(), html: html };
  });
  try { cache.put(key, JSON.stringify(emails), 600); } catch (ignored) { /* >100KB */ }
  return emails;
}

function bodyToHtml_(body) {
  var out = [], listTag = null;
  function closeList() { if (listTag) { out.push('</' + listTag + '>'); listTag = null; } }

  for (var i = 0; i < body.getNumChildren(); i++) {
    var el = body.getChild(i);
    var type = el.getType();

    if (type === DocumentApp.ElementType.LIST_ITEM) {
      var item = el.asListItem();
      var tag = /NUMBER|LATIN|ROMAN/.test(String(item.getGlyphType())) ? 'ol' : 'ul';
      if (listTag !== tag) { closeList(); out.push('<' + tag + '>'); listTag = tag; }
      out.push('<li>' + inlineHtml_(item.editAsText()) + '</li>');
      continue;
    }
    closeList();

    if (type === DocumentApp.ElementType.PARAGRAPH) {
      var para = el.asParagraph();
      var inner = inlineHtml_(para.editAsText());
      if (!inner.trim()) { out.push('<p>&nbsp;</p>'); continue; }
      var h = { HEADING1: 'h1', HEADING2: 'h2', HEADING3: 'h3', HEADING4: 'h4', HEADING5: 'h5', HEADING6: 'h6', TITLE: 'h1', SUBTITLE: 'h2' }[String(para.getHeading())];
      out.push(h ? '<' + h + '>' + inner + '</' + h + '>' : '<p>' + inner + '</p>');
    } else if (type === DocumentApp.ElementType.HORIZONTAL_RULE) {
      out.push('<hr>');
    }
    // Tables and images are not supported.
  }
  closeList();
  return out.join('\n');
}

function inlineHtml_(text) {
  var s = text.getText();
  if (!s) return '';
  var starts = text.getTextAttributeIndices();
  var html = '';
  for (var i = 0; i < starts.length; i++) {
    var from = starts[i], to = i + 1 < starts.length ? starts[i + 1] : s.length;
    var piece = esc_(s.substring(from, to)).replace(/[\r\v]/g, '<br>');
    if (!piece) continue;
    if (text.isBold(from)) piece = '<strong>' + piece + '</strong>';
    if (text.isItalic(from)) piece = '<em>' + piece + '</em>';
    if (text.isUnderline(from) && !text.getLinkUrl(from)) piece = '<u>' + piece + '</u>';
    var url = text.getLinkUrl(from);
    if (url) piece = '<a href="' + esc_(url) + '">' + piece + '</a>';
    html += piece;
  }
  return html;
}

/* ------------------------------ Sheet helpers ------------------------------ */

function getSheet_() {
  var ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  var sheets = ss.getSheets();
  for (var i = 0; i < sheets.length; i++) if (sheets[i].getSheetId() === CONFIG.SHEET_GID) return sheets[i];
  return sheets[0];
}

/** Map header name -> 1-based column, adding any missing headers at the end. */
function getColumns_(sheet) {
  var lastCol = Math.max(sheet.getLastColumn(), 1);
  var existing = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var cols = {};
  existing.forEach(function (h, i) { if (h !== '') cols[String(h).trim()] = i + 1; });
  var next = existing.some(function (h) { return h !== ''; }) ? lastCol + 1 : 1;
  HEADERS.forEach(function (h) {
    if (!cols[h]) { sheet.getRange(1, next).setValue(h); cols[h] = next; next++; }
  });
  sheet.setFrozenRows(1);
  return cols;
}

function readRows_(sheet, cols) {
  var last = sheet.getLastRow();
  if (last < 2) return [];
  var width = sheet.getLastColumn();
  var data = sheet.getRange(2, 1, last - 1, width).getValues();
  var get = function (row, h) { return row[cols[h] - 1]; };
  var rows = [];
  data.forEach(function (row, i) {
    var email = String(get(row, 'Email') || '').trim();
    if (!email) return;
    var lastSent = get(row, 'Last Sent');
    rows.push({
      rowNum: i + 2,
      name: String(get(row, 'Name') || '').trim(),
      email: email,
      source: String(get(row, 'Source') || '').trim(),
      id: String(get(row, 'ID') || ''),
      status: String(get(row, 'Status') || '').trim(),
      sent: Number(get(row, 'Emails Sent')) || 0,
      lastSent: lastSent instanceof Date ? lastSent : null
    });
  });
  return rows;
}

function appendRecord_(sheet, cols, record) {
  var rowNum = sheet.getLastRow() + 1;
  writeRecord_(sheet, cols, rowNum, record);
  return rowNum;
}

function writeRecord_(sheet, cols, rowNum, record) {
  Object.keys(record).forEach(function (h) {
    sheet.getRange(rowNum, cols[h]).setValue(record[h]);
  });
}

/* --------------------------------- Utilities --------------------------------- */

function unsubscribeFooter_(id) {
  var url = ScriptApp.getService().getUrl();
  if (!url) return '';
  return '<hr><p style="font-size:12px;color:#777">Don\'t want these emails? ' +
         '<a href="' + url + '?unsubscribe=' + encodeURIComponent(id) + '">Unsubscribe</a></p>';
}

function fill_(str, vars, isHtml) {
  return str.replace(/\{\{\s*name\s*\}\}/gi, isHtml ? esc_(vars.name) : vars.name);
}

function htmlToText_(html) {
  return html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|h\d|li)>/gi, '\n')
    .replace(/<a href="([^"]*)">([^<]*)<\/a>/gi, '$2 ($1)')
    .replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

function esc_(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function norm_(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }
function clean_(s) { return String(s || '').trim().substring(0, 200); }
function sanitizeCell_(s) { return /^[=+\-@]/.test(s) ? "'" + s : s; }   // block formula injection
function dayKey_(d) { return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd'); }
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
