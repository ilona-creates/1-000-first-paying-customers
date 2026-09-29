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
  // form "source" value -> Google Doc (by ID, so renaming the Doc is safe) + friendly title for subjects.
  // Series not listed here fall back to matching the Doc's NAME to the source value.
  SERIES: {
    'niche-for-growth': { docId: '1c-F5Kp3-vbU0ecnF0hbZX-M-tRF_D9VRJuDGdIajCls', title: 'Niche Starter Framework' }
  },
  SEND_HOUR: 9,            // daily send time in the script time zone (appsscript.json sets GMT)
  WEEKDAYS_ONLY: false,    // Doc instructions say Monday-Sunday; set true to pause Sat/Sun
  REPORT_TO: [],           // daily report recipients; empty = the account that owns this script
  MAX_RUNTIME_MS: 5 * 60 * 1000
};

var HDR_CURRENT = 'Name of current series and the next number to be sent';
var HDR_DONE = "Names of whole series' already received";
var HEADERS = ['Sign-up date and time', 'Name', 'Email', HDR_CURRENT, HDR_DONE, 'Source', 'ID', 'Series', 'Status',
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
    record['Sign-up date and time'] = new Date();
    record['Name'] = sanitizeCell_(name);
    record['Email'] = sanitizeCell_(email);
    record['Source'] = sanitizeCell_(source);
    record['ID'] = id;
    record['Series'] = series ? seriesTitle_(source, series) : '';
    if (series && total) record[HDR_CURRENT] = record['Series'] + ' - next: 1 of ' + total;
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
    if (CONFIG.WEEKDAYS_ONLY && Number(Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'u')) >= 6) return;
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
  try { sendDailyReport_(); } catch (ex) { console.error('Report failed: ' + ex); }
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
    if (!mail.html) {   // not written yet: stay Active and retry on the next run
      writeRecord_(sheet, cols, sub.rowNum, { 'Total Emails': emails.length, 'Last Error': 'Email ' + (idx + 1) + ' is not written yet' });
      return;
    }
    var vars = { name: sub.name || 'there' };
    var subject = fill_(mail.subject || (seriesTitle_(sub.source, series) + ', part ' + (idx + 1)), vars, false);
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
    var title = seriesTitle_(sub.source, series);
    updates[HDR_CURRENT] = sent >= emails.length ? 'Finished ' + title : title + ' - next: ' + (sent + 1) + ' of ' + emails.length;
    if (sent >= emails.length) updates[HDR_DONE] = title;
    writeRecord_(sheet, cols, sub.rowNum, updates);
  } catch (ex) {
    setError_(sheet, cols, sub.rowNum, String(ex));
  }
}

function setError_(sheet, cols, rowNum, message) {
  // Keep the subscriber Active so a fixed Doc / restored quota resumes automatically.
  writeRecord_(sheet, cols, rowNum, { 'Last Error': message });
}

/* --------------------------------- Report --------------------------------- */

function sendDailyReport_() {
  var sheet = getSheet_(), cols = getColumns_(sheet);
  var rows = readRows_(sheet, cols), today = dayKey_(new Date());
  var sentToday = rows.filter(function (r) { return r.lastSent && dayKey_(r.lastSent) === today; });
  var report = buildReport_(today, sentToday, collectIssues_(rows, today));
  var to = CONFIG.REPORT_TO.length ? CONFIG.REPORT_TO.join(',') : Session.getEffectiveUser().getEmail();
  MailApp.sendEmail({ to: to, subject: report.subject, body: report.text, htmlBody: report.html, name: CONFIG.SENDER_NAME });
}

function collectIssues_(rows, today) {
  var issues = [];
  rows.forEach(function (r) {
    if (r.lastError) issues.push(r.name + ' <' + r.email + '>: ' + r.lastError);
    else if (r.status === STATUS.ACTIVE && !(r.lastSent && dayKey_(r.lastSent) === today) && r.sent > 0) {
      issues.push(r.name + ' <' + r.email + '>: was due an email today but none was sent (quota or time limit?)');
    }
  });
  Object.keys(CONFIG.SERIES).forEach(function (src) {
    try {
      var file = findSeries_(src), emails = getEmails_(file);
      var empty = [];
      emails.forEach(function (m, i) { if (!m.html) empty.push(i + 1); });
      if (empty.length) issues.push('Series "' + seriesTitle_(src, file) + '": Email ' + empty.join(', ') + ' have no content yet');
    } catch (ex) {
      issues.push('Series "' + src + '": ' + ex);
    }
  });
  var quota = MailApp.getRemainingDailyQuota();
  if (quota < 20) issues.push('Only ' + quota + ' emails left in today\'s sending quota');
  return issues;
}

/** Pure: rows = subscribers emailed today. */
function buildReport_(day, rows, issues) {
  var subject = 'Daily email report ' + day + ': ' + rows.length + ' sent, ' + issues.length + ' issue(s)';
  var lines = ['Emails sent today: ' + rows.length, ''];
  var html = '<h2 style="margin:0 0 8px">Daily email report, ' + esc_(day) + '</h2><p><strong>Emails sent today: ' + rows.length + '</strong></p>';
  if (rows.length) {
    html += '<table cellpadding="6" style="border-collapse:collapse;border:1px solid #ccc"><tr style="background:#f2f2f2"><th align="left">Name</th><th align="left">Series</th><th align="left">Sent today</th></tr>';
    rows.forEach(function (r) {
      var n = 'Email ' + r.sent + (r.total ? ' of ' + r.total : '');
      lines.push(r.name + ' | ' + r.series + ' | ' + n);
      html += '<tr><td>' + esc_(r.name) + '</td><td>' + esc_(r.series) + '</td><td>' + esc_(n) + '</td></tr>';
    });
    html += '</table>';
  } else { lines.push('(nobody was emailed today)'); html += '<p>Nobody was emailed today.</p>'; }
  lines.push('', 'Issues to address: ' + (issues.length || 'none'));
  html += '<h3>Issues to address</h3>';
  if (issues.length) {
    html += '<ul>' + issues.map(function (i) { return '<li>' + esc_(i) + '</li>'; }).join('') + '</ul>';
    issues.forEach(function (i) { lines.push('- ' + i); });
  } else html += '<p>None.</p>';
  return { subject: subject, text: lines.join('\n'), html: html };
}

/* ------------------------------ Drive / Docs ------------------------------ */

function findSeries_(source) {
  if (!source) return null;
  var keys = Object.keys(CONFIG.SERIES);
  for (var k = 0; k < keys.length; k++) {
    if (norm_(keys[k]) === norm_(source)) return DriveApp.getFileById(CONFIG.SERIES[keys[k]].docId);
  }
  var files = DriveApp.getFolderById(CONFIG.DRIVE_FOLDER_ID).getFilesByType(MimeType.GOOGLE_DOCS);
  while (files.hasNext()) {
    var f = files.next();
    if (norm_(f.getName()) === norm_(source)) return f;
  }
  return null;
}

function seriesTitle_(source, file) {
  var keys = Object.keys(CONFIG.SERIES);
  for (var k = 0; k < keys.length; k++) if (norm_(keys[k]) === norm_(source)) return CONFIG.SERIES[keys[k]].title;
  return file.getName();
}

/** Returns [{subject, html}] — one per top-level tab. Cached briefly. */
function getEmails_(file) {
  var cache = CacheService.getScriptCache();
  var key = 'series:' + file.getId() + ':' + file.getLastUpdated().getTime();
  var hit = cache.get(key);
  if (hit) return JSON.parse(hit);

  var emailRe = /^\s*email\s*\d+/i;
  var tabs = DocumentApp.openById(file.getId()).getTabs();
  var emails = [];

  // Preferred layout: one tab per email, tab titled "Email 1", "Email 2"...
  // (any other tab, e.g. "Instructions", is ignored).
  tabs.forEach(function (tab) {
    if (emailRe.test(tab.getTitle())) {
      var body = tab.asDocumentTab().getBody();
      emails.push(parseEmail_(body, 0, body.getNumChildren()));
    }
  });

  // Fallback: everything in one tab, each email starting at a heading "Email N".
  if (!emails.length) {
    tabs.forEach(function (tab) {
      var body = tab.asDocumentTab().getBody(), n = body.getNumChildren(), starts = [];
      for (var i = 0; i < n; i++) {
        var c = body.getChild(i);
        if (c.getType() === DocumentApp.ElementType.PARAGRAPH && emailRe.test(c.asParagraph().getText())) starts.push(i);
      }
      starts.forEach(function (from, j) {
        emails.push(parseEmail_(body, from + 1, j + 1 < starts.length ? starts[j + 1] : n));
      });
    });
  }
  if (!emails.length) throw new Error('No "Email N" tabs found in "' + file.getName() + '"');
  try { cache.put(key, JSON.stringify(emails), 600); } catch (ignored) { /* >100KB */ }
  return emails;
}

/**
 * Optional leading labels: "Subject: text" (or "Subject:" then the subject on the next line),
 * and a "Body:" label line. Without a subject, sendNext_ builds a default.
 */
function parseEmail_(body, from, to) {
  var subject = '', wantSubject = false;
  for (var i = from; i < to; i++) {
    var el = body.getChild(i);
    if (el.getType() !== DocumentApp.ElementType.PARAGRAPH) break;
    var t = el.asParagraph().getText().trim();
    if (!t) { from = i + 1; continue; }
    if (wantSubject) { subject = t; wantSubject = false; from = i + 1; continue; }
    var m = t.match(/^subject:\s*(.*)$/i);
    if (m) { if (m[1]) subject = m[1]; else wantSubject = true; from = i + 1; continue; }
    if (/^body:?$/i.test(t)) { from = i + 1; continue; }
    break;
  }
  return { subject: subject, html: bodyToHtml_(body, from, to) };
}

/** Returns '' when the range has no text (e.g. an email that isn't written yet). */
function bodyToHtml_(body, from, to) {
  var out = [], listTag = null, hasText = false;
  function closeList() { if (listTag) { out.push('</' + listTag + '>'); listTag = null; } }

  for (var i = from; i < to; i++) {
    var el = body.getChild(i);
    var type = el.getType();
    if (type === DocumentApp.ElementType.LIST_ITEM || type === DocumentApp.ElementType.PARAGRAPH) {
      if (el.asText().getText().trim()) hasText = true;
    }

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
  if (!hasText) return '';
  return out.join('\n').replace(/^(<p>&nbsp;<\/p>\n?)+/, '').replace(/(\n?<p>&nbsp;<\/p>)+$/, '');
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
      series: String(get(row, 'Series') || ''),
      lastError: String(get(row, 'Last Error') || ''),
      total: Number(get(row, 'Total Emails')) || 0,
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
