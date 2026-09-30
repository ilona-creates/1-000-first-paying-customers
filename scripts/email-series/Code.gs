/**
 * Email series system: signup -> Google Sheet -> one email per day from Google Docs.
 *
 * Flow
 *  1. The landing-page form POSTs name/email/source to this script (doPost).
 *  2. Bots are filtered out; otherwise a row is added and email #1 is sent immediately.
 *  3. Time triggers (sendDailyEmails, at SEND_HOURS) send the next email to every
 *     active subscriber who hasn't received one today.
 *  4. Progress is written back to the Sheet (series/next number, status, last sent...).
 *  5. sendDailyReport emails a report (who was emailed, replies, issues) at REPORT_HOUR.
 *
 * Series content
 *  - One Google Doc per series, in DRIVE_FOLDER_ID, linked to the form's "source" value
 *    in CONFIG.SERIES (or named after the source value).
 *  - Each email is a tab (or heading) titled "Email 1", "Email 2"... Other tabs are ignored.
 *  - Optional "Subject:" line (then the subject) and "Body:" label at the top of an email.
 *  - An email that is empty or says "Coming soon" is treated as not written yet.
 *  - {{name}} in the subject or body is replaced with the subscriber's name.
 *
 * Setup: see README.md in the repo (scripts/email-series).
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
  SEND_HOURS: [9, 12, 17], // send slots in the script time zone (appsscript.json). A later slot retries
                           // subscribers whose email wasn't written yet ("Coming soon") at the earlier slot.
  REPORT_HOUR: 9,          // daily report time...
  REPORT_TIMEZONE: 'Asia/Bangkok',   // ...in ICT
  WEEKDAYS_ONLY: false,    // Doc instructions say Monday-Sunday; set true to pause Sat/Sun
  REPORT_TO: ['ilona@ilonamelnychuk.com'],   // empty = the account that owns this script
  MAX_RUNTIME_MS: 5 * 60 * 1000,
  // Bot protection
  MAX_SIGNUPS_PER_HOUR: 30,   // more than this in an hour are ignored (protects your email quota)
  MIN_FILL_MS: 2000           // forms submitted faster than this are treated as bots
};

var HDR_CURRENT = 'Name of current series and the next number to be sent';
var HDR_DONE = 'Names of whole serieses already full sent';
var HDR_REPLIED = 'If they have replied in email, what series name and subject line triggered the reply';
var HDR_DATE = 'Sign-up date and time (GMT)';   // Column A, the only date/time column
var HDR_DATE_OLD = 'Sign-up date and time';
var HDR_SENT = 'Total emails sent to date';
var HEADERS = [HDR_DATE, 'Name', 'Email', HDR_CURRENT, HDR_DONE, HDR_REPLIED, 'Source', 'ID', 'Series', 'Status',
               HDR_SENT, 'Last Error'];

var STATUS = { ACTIVE: 'Active', COMPLETED: 'Completed', ERROR: 'Error', UNSUBSCRIBED: 'Unsubscribed', BOUNCED: 'Bounced' };

/* ------------------------------ Web endpoints ------------------------------ */

function doPost(e) {
  var p = (e && e.parameter) || {};
  var name = clean_(p.firstName || p.name);
  var email = clean_(p.email).toLowerCase();
  var source = clean_(p.source);

  // Bot checks. Bots get a normal-looking success reply so they learn nothing.
  if (p.website) return blocked_('honeypot');                                   // hidden field must stay empty
  if (!(Number(p.elapsed) >= CONFIG.MIN_FILL_MS)) return blocked_('too fast');  // real people take a few seconds
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json_({ result: 'error', message: 'Invalid email' });

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var cache = CacheService.getScriptCache();
    var hourKey = 'signups:' + Utilities.formatDate(new Date(), 'GMT', 'yyyyMMddHH');
    var count = Number(cache.get(hourKey) || 0);
    if (count >= CONFIG.MAX_SIGNUPS_PER_HOUR) return blocked_('hourly limit');
    cache.put(hourKey, String(count + 1), 3700);

    var sheet = getSheet_();
    var cols = getColumns_(sheet);
    var rows = readRows_(sheet, cols);
    var series = findSeries_(source);

    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (r.email.toLowerCase() !== email || norm_(r.source) !== norm_(source)) continue;
      // Already on this series: ignore. Unsubscribed / Error rows fall through and sign up again as a new row.
      if (r.status === STATUS.ACTIVE || r.status === STATUS.COMPLETED) return json_({ result: 'success', duplicate: true });
    }

    var id = Utilities.getUuid();
    var status = series ? STATUS.ACTIVE : STATUS.ERROR;
    var total = 0, err = '';
    if (series) {
      try { total = getEmails_(series).length; } catch (ex) { err = String(ex); status = STATUS.ERROR; }
    } else {
      err = 'No Google Doc found for source "' + source + '"';
    }

    var record = {};
    record[HDR_DATE] = gmtStamp_(new Date());   // the only date/time column, always GMT
    record['Name'] = sanitizeCell_(name);
    record['Email'] = sanitizeCell_(email);
    record['Source'] = sanitizeCell_(source);
    record['ID'] = id;
    record['Series'] = series ? seriesTitle_(source, series) : '';
    if (status === STATUS.ACTIVE && total) record[HDR_CURRENT] = record['Series'] + ' - next: 1 of ' + total;
    record['Status'] = status;
    record[HDR_SENT] = 0;
    record['Last Error'] = err;
    var rowNum = appendRecord_(sheet, cols, record);

    // Send email #1 right away. If today's email quota is used up, the signup is still saved and
    // the next send slot sends it (sendDailyEmails picks up anyone with no email sent yet).
    if (status === STATUS.ACTIVE) {
      if (MailApp.getRemainingDailyQuota() > 0) {
        var sub = readRows_(sheet, cols).filter(function (r) { return r.rowNum === rowNum; })[0];
        sendNext_(sheet, cols, sub, series);
      } else {
        writeRecord_(sheet, cols, rowNum, { 'Last Error': 'Waiting for daily email quota; Email 1 will go out at the next send slot' });
      }
    }
    return json_({ result: 'success' });
  } finally {
    lock.releaseLock();
  }
}

/** Unsubscribe link target: <web app url>?unsubscribe=<ID> */
function doGet(e) {
  var id = e && e.parameter && e.parameter.unsubscribe;
  var msg = 'This link is not valid.';
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
  return HtmlService.createHtmlOutput('<p style="font-family:sans-serif;font-size:18px;padding:40px">' + esc_(msg) + '</p>');
}

/** Silently drop a suspected bot and count it for the daily report. */
function blocked_(reason) {
  try {
    var props = PropertiesService.getScriptProperties();
    var key = 'blocked:' + dayKey_(new Date());
    props.setProperty(key, String((Number(props.getProperty(key)) || 0) + 1));
    console.warn('Signup blocked: ' + reason);
  } catch (ignored) {}
  return json_({ result: 'success' });
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

    // Mark bounced addresses first so they are not emailed again.
    try { checkBounces_(sheet, cols, readRows_(sheet, cols)); } catch (ex) { console.error('Bounce check failed: ' + ex); }

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

/** Run once from the editor to schedule the send slots and the daily report. */
function installTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    var fn = t.getHandlerFunction();
    if (fn === 'sendDailyEmails' || fn === 'sendDailyReport') ScriptApp.deleteTrigger(t);
  });
  CONFIG.SEND_HOURS.forEach(function (h) {
    ScriptApp.newTrigger('sendDailyEmails').timeBased().everyDays(1).atHour(h).create();
  });
  ScriptApp.newTrigger('sendDailyReport').timeBased().everyDays(1).atHour(CONFIG.REPORT_HOUR)
    .inTimezone(CONFIG.REPORT_TIMEZONE).create();
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
      writeRecord_(sheet, cols, sub.rowNum, { 'Last Error': 'Email ' + (idx + 1) + ' is not written yet' });
      return;
    }
    var vars = { name: sub.name || 'there' };
    var subject = fill_(mail.subject || (seriesTitle_(sub.source, series) + ', part ' + (idx + 1)), vars, false);
    var htmlBody = fill_(mail.html, vars, true) + unsubscribeFooter_(sub.id);
    var text = htmlToText_(htmlBody);
    var fontCss = mail.fontCss ? '<style>' + mail.fontCss + '</style>' : '';   // web font, where the mail app supports it

    MailApp.sendEmail({
      to: sub.email,
      subject: subject,
      body: text,
      htmlBody: fontCss + '<div style="max-width:468pt">' + htmlBody + '</div>',
      name: CONFIG.SENDER_NAME,
      replyTo: CONFIG.REPLY_TO
    });

    var sent = idx + 1;
    var updates = {
      'Last Error': '',
      'Status': sent >= emails.length ? STATUS.COMPLETED : STATUS.ACTIVE
    };
    updates[HDR_SENT] = sent;
    setProp_('ls:' + sub.id, Date.now());   // when we last emailed them (kept out of the Sheet: one date column only)
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

/** Trigger target: detect replies, then email the report (covers the last 24 hours). */
function sendDailyReport() {
  var lock = LockService.getScriptLock();
  lock.waitLock(60000);
  try {
    var sheet = getSheet_(), cols = getColumns_(sheet);
    var rows = readRows_(sheet, cols);
    var replies = [];
    try { replies = checkReplies_(sheet, cols, rows); } catch (ex) { console.error('Reply check failed: ' + ex); }
    try { checkBounces_(sheet, cols, rows); } catch (ex) { console.error('Bounce check failed: ' + ex); }
    rows = readRows_(sheet, cols);   // re-read: bounce checks may have changed Status
    var dayAgo = Date.now() - 24 * 3600 * 1000;
    var bounced = rows.filter(function (r) { return r.status === STATUS.BOUNCED && r.bouncedAt && r.bouncedAt.getTime() >= dayAgo; });
    var totals = {};
    rows.forEach(function (r) {
      if (!(r.source in totals)) {
        try { var f = findSeries_(r.source); totals[r.source] = f ? getEmails_(f).length : 0; } catch (ex) { totals[r.source] = 0; }
      }
      r.total = totals[r.source];
    });
    var since = Date.now() - 24 * 3600 * 1000;
    var recent = rows.filter(function (r) { return r.lastSent && r.lastSent.getTime() >= since; });
    var props = PropertiesService.getScriptProperties();
    var blocked = (Number(props.getProperty('blocked:' + dayKey_(new Date()))) || 0) +
                  (Number(props.getProperty('blocked:' + dayKey_(new Date(Date.now() - 24 * 3600 * 1000)))) || 0);
    var notes = ['Suspected bot signups blocked (last 2 days): ' + blocked];
    var report = buildReport_(Utilities.formatDate(new Date(), CONFIG.REPORT_TIMEZONE, 'yyyy-MM-dd'), recent, collectIssues_(rows).concat(bounced.map(function (r) {
      return who_(r) + ': email bounced, so the address may be mistyped. Sending to them has stopped.';
    })), replies, notes);
    var to = CONFIG.REPORT_TO.length ? CONFIG.REPORT_TO.join(',') : Session.getEffectiveUser().getEmail();
    MailApp.sendEmail({ to: to, subject: report.subject, body: report.text, htmlBody: report.html, name: CONFIG.SENDER_NAME });
  } finally {
    lock.releaseLock();
  }
}

/**
 * Finds subscriber replies in Gmail (thread subject = the email they replied to) and records
 * "Series - subject" in the reply column. Returns the newly found replies.
 */
function checkReplies_(sheet, cols, rows) {
  var found = [];
  rows.forEach(function (r) {
    if (!r.sent || !r.signup) return;
    var q = 'from:' + r.email + ' after:' + Utilities.formatDate(r.signup, 'GMT', 'yyyy/MM/dd');
    var known = r.replied, added = [];
    GmailApp.search(q, 0, 10).forEach(function (thread) {
      thread.getMessages().forEach(function (m) {
        if (m.getFrom().toLowerCase().indexOf(r.email.toLowerCase()) < 0) return;
        var subj = m.getSubject().replace(/^\s*((re|fw|fwd):\s*)+/i, '').trim();
        var label = (r.series || 'Unknown series') + ' - "' + subj + '"';
        if (known.indexOf(label) < 0 && added.indexOf(label) < 0) added.push(label);
      });
    });
    if (added.length) {
      sheet.getRange(r.rowNum, cols[HDR_REPLIED]).setValue((known ? known + '; ' : '') + added.join('; '));
      added.forEach(function (label) { found.push({ who: who_(r), label: label }); });
    }
  });
  return found;
}

/**
 * Finds delivery failures in Gmail for subscribers we emailed and marks them Bounced (sending stops).
 * Returns the newly bounced subscribers.
 */
function checkBounces_(sheet, cols, rows) {
  var bodies = [];
  GmailApp.search('from:(mailer-daemon OR postmaster) subject:(failure OR undeliverable OR returned) newer_than:2d', 0, 50)
    .forEach(function (t) {
      t.getMessages().forEach(function (m) { bodies.push(m.getPlainBody().toLowerCase()); });
    });
  var found = [];
  if (!bodies.length) return found;
  rows.forEach(function (r) {
    if ((r.status !== STATUS.ACTIVE && r.status !== STATUS.COMPLETED) || !r.sent) return;
    var addr = r.email.toLowerCase();
    if (bodies.some(function (b) { return b.indexOf(addr) >= 0; })) {
      writeRecord_(sheet, cols, r.rowNum, { 'Status': STATUS.BOUNCED, 'Last Error': 'Email bounced: address not found or cannot receive mail' });
      setProp_('bounced:' + r.id, Date.now());
      found.push(r);
    }
  });
  return found;
}

/** Report label for a subscriber: name and Sheet row, never the email address. */
function who_(r) { return (r.name || '(no name)') + ' (row ' + r.rowNum + ')'; }

function collectIssues_(rows) {
  var issues = [], stale = Date.now() - 36 * 3600 * 1000;
  rows.forEach(function (r) {
    if (r.lastError && r.status !== STATUS.BOUNCED) issues.push(who_(r) + ': ' + r.lastError);
    else if (r.status === STATUS.ACTIVE && r.sent > 0 && r.lastSent && r.lastSent.getTime() < stale) {
      issues.push(who_(r) + ': no email sent for over 36 hours (quota or time limit?)');
    }
  });
  Object.keys(CONFIG.SERIES).forEach(function (src) {
    try {
      var file = findSeries_(src), emails = getEmails_(file);
      var empty = [];
      emails.forEach(function (m, i) { if (!m.html) empty.push(i + 1); });
      if (empty.length) issues.push('Series "' + seriesTitle_(src, file) + '": ' + (empty.length > 1 ? 'Emails ' : 'Email ') + empty.join(', ') + (empty.length > 1 ? ' have' : ' has') + ' no content yet');
    } catch (ex) {
      issues.push('Series "' + src + '": ' + ex);
    }
  });
  var quota = MailApp.getRemainingDailyQuota();
  if (quota < 20) issues.push('Only ' + quota + ' emails left in today\'s sending quota');
  return issues;
}

/** Pure: rows = subscribers emailed in the last 24 hours; replies = [{who, label}]. */
function buildReport_(day, rows, issues, replies, notes) {
  replies = replies || [];
  notes = notes || [];
  var subject = 'Email series report ' + day + ': ' + rows.length + ' sent, ' + issues.length + ' issue(s)';
  var lines = ['Emails sent in the last 24 hours: ' + rows.length, ''];
  var html = '<h2 style="margin:0 0 8px">Email series report, ' + esc_(day) + '</h2><p><strong>Emails sent in the last 24 hours: ' + rows.length + '</strong></p>';
  if (rows.length) {
    html += '<table cellpadding="6" style="border-collapse:collapse;border:1px solid #ccc"><tr style="background:#f2f2f2"><th align="left">Name</th><th align="left">Series</th><th align="left">Sent</th></tr>';
    rows.forEach(function (r) {
      var n = 'Email ' + r.sent + (r.total ? ' of ' + r.total : '');
      lines.push(who_(r) + ' | ' + r.series + ' | ' + n);
      html += '<tr><td>' + esc_(who_(r)) + '</td><td>' + esc_(r.series) + '</td><td>' + esc_(n) + '</td></tr>';
    });
    html += '</table>';
  } else { lines.push('(nobody was emailed)'); html += '<p>Nobody was emailed.</p>'; }
  lines.push('', 'New replies: ' + (replies.length || 'none'));
  html += '<h3>New replies</h3>';
  if (replies.length) {
    html += '<ul>' + replies.map(function (p) { return '<li>' + esc_(p.who) + ': ' + esc_(p.label) + '</li>'; }).join('') + '</ul>';
    replies.forEach(function (p) { lines.push('- ' + p.who + ': ' + p.label); });
  } else html += '<p>None.</p>';
  lines.push('', 'Issues to address: ' + (issues.length || 'none'));
  html += '<h3>Issues to address</h3>';
  if (issues.length) {
    html += '<ul>' + issues.map(function (i) { return '<li>' + esc_(i) + '</li>'; }).join('') + '</ul>';
    issues.forEach(function (i) { lines.push('- ' + i); });
  } else html += '<p>None.</p>';
  if (notes.length) {
    lines.push('', 'Also: ' + notes.join('; '));
    html += '<p style="color:#666;font-size:13px">' + notes.map(esc_).join('<br>') + '</p>';
  }
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

/**
 * Returns [{subject, html, fontCss}], one per "Email N" section of the series Doc.
 * The email HTML comes from the Doc's own HTML export so fonts, sizes, colours, spacing and blank lines
 * match the Doc exactly. Cached for the run (and briefly across runs).
 */
function getEmails_(file) {
  var memo = getEmails_.memo || (getEmails_.memo = {});
  var key = file.getId() + ':' + file.getLastUpdated().getTime();
  if (memo[key]) return memo[key];
  var cache = CacheService.getScriptCache(), ckey = 'series2:' + key;
  var hit = cache.get(ckey);
  if (hit) return (memo[key] = JSON.parse(hit));

  var emails = null;
  try { emails = getEmailsFromExport_(file); } catch (ex) { console.warn('HTML export failed, using plain conversion: ' + ex); }
  if (!emails || !emails.length) emails = getEmailsFromApi_(file);
  memo[key] = emails;
  try { cache.put(ckey, JSON.stringify(emails), 600); } catch (ignored) { /* over the 100KB cache limit: fine */ }
  return emails;
}

function getEmailsFromExport_(file) {
  var resp = UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files/' + file.getId() + '/export?mimeType=text%2Fhtml', {
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    muteHttpExceptions: true
  });
  if (resp.getResponseCode() !== 200) throw new Error('export HTTP ' + resp.getResponseCode());
  return parseExportHtml_(resp.getContentText());
}

/** Pure: Doc HTML export -> [{subject, html, fontCss}]. Sections start at a title/heading "Email N". */
function parseExportHtml_(html) {
  var emailRe = /^\s*email\s*\d+/i;
  var css = (html.match(/<style[^>]*>([\s\S]*?)<\/style>/i) || [])[1] || '';
  var fontCss = (css.match(/@import url\([^)]*\);?/i) || [''])[0];
  var body = html.replace(/^[\s\S]*?<body[^>]*>/i, '').replace(/<\/body>[\s\S]*$/i, '');

  var blocks = [], re = /<(p|ol|ul|h[1-6]|table)\b[^>]*>[\s\S]*?<\/\1>|<hr\b[^>]*\/?>/gi, m;
  while ((m = re.exec(body))) {
    var tag = /^<hr/i.test(m[0]) ? 'hr' : m[1].toLowerCase();
    blocks.push({
      tag: tag,
      html: m[0],
      text: htmlText_(m[0]),
      isTitle: tag === 'p' && /class="[^"]*\btitle\b/i.test(m[0].slice(0, 200)),
      isHeading: /^h[1-6]$/.test(tag)
    });
  }

  var starts = [];
  blocks.forEach(function (b, i) { if ((b.isTitle || b.isHeading) && emailRe.test(b.text)) starts.push(i); });
  var emails = [];
  starts.forEach(function (from) {
    var to = from + 1;
    while (to < blocks.length && !(blocks[to].isTitle || (blocks[to].isHeading && emailRe.test(blocks[to].text)))) to++;
    var mail = emailFromBlocks_(blocks.slice(from + 1, to));
    mail.fontCss = fontCss;
    emails.push(mail);
  });
  return emails;
}

/** Optional "Subject:" (same line or next line) and "Body:" labels at the top; "Coming soon" or empty = not written. */
function emailFromBlocks_(blocks) {
  var subject = '', wantSubject = false, i = 0;
  while (i < blocks.length) {
    var t = blocks[i].text;
    if (!t) { i++; continue; }
    if (wantSubject) { subject = t; wantSubject = false; i++; continue; }
    var sm = t.match(/^subject:\s*(.*)$/i);
    if (sm) { if (sm[1]) subject = sm[1]; else wantSubject = true; i++; continue; }
    if (/^body:?$/i.test(t)) { i++; continue; }
    break;
  }
  var rest = blocks.slice(i);
  var isBlank = function (b) { return b.tag === 'p' && !b.text; };
  while (rest.length && isBlank(rest[0])) rest.shift();
  while (rest.length && isBlank(rest[rest.length - 1])) rest.pop();
  var plain = rest.map(function (b) { return b.text; }).join(' ').trim();
  if (!plain || /^coming soon[.!]?$/i.test(plain)) return { subject: subject, html: '' };
  return { subject: subject, html: rest.map(function (b) { return cleanBlockHtml_(b.html); }).join('') };
}

/** Keep the Doc's inline styles; drop page-layout bits, unwrap Google link redirects, keep blank lines visible. */
function cleanBlockHtml_(h) {
  return h
    .replace(/\s(?:id|class)="[^"]*"/gi, '')
    .replace(/(?:orphans|widows):\s*\d+;?|page-break-after:\s*avoid;?/gi, '')
    .replace(/href="https:\/\/www\.google\.com\/url\?q=([^"&]*)[^"]*"/gi, function (all, q) {
      try { return 'href="' + esc_(decodeURIComponent(q)) + '"'; } catch (e) { return all; }
    })
    .replace(/(<span[^>]*>)(<\/span>)/gi, '$1&nbsp;$2')                       // blank paragraphs keep their height
    .replace(/font-family:\s*&quot;([^&]+)&quot;/gi, function (all, fam) {    // fallbacks for mail apps without the web font
      var fb = /garamond|georgia|times|lora|merriweather|playfair|baskerville|cambria|serif/i.test(fam) ? 'Georgia,&quot;Times New Roman&quot;,serif'
             : /mono|courier|consolas/i.test(fam) ? '&quot;Courier New&quot;,monospace' : 'Arial,Helvetica,sans-serif';
      return 'font-family:&quot;' + fam + '&quot;,' + fb;
    });
}

/** Plain text of an HTML fragment (entities decoded). */
function htmlText_(h) {
  return decodeEntities_(h.replace(/<[^>]+>/g, '')).replace(/\u00a0/g, ' ').trim();
}

/** Fallback: rebuild each email from the Doc's text and basic styling (bold, italic, links, lists). */
function getEmailsFromApi_(file) {
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
  var out = [], listTag = null, hasText = false, plain = '';
  function closeList() { if (listTag) { out.push('</' + listTag + '>'); listTag = null; } }

  for (var i = from; i < to; i++) {
    var el = body.getChild(i);
    var type = el.getType();
    if (type === DocumentApp.ElementType.LIST_ITEM || type === DocumentApp.ElementType.PARAGRAPH) {
      var tx = el.asText().getText().trim();
      if (tx) { hasText = true; plain += tx + ' '; }
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
  if (!hasText || /^\s*coming soon[.!]?\s*$/i.test(plain)) return '';   // placeholder = not written yet
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

/**
 * One-time tidy-up of older Sheets: rename "Emails Sent", and remove the "Last Sent" and "Total Emails" columns
 * (Column A is the only date/time column; last-sent times are kept by the script, totals come from the Doc).
 */
function migrateSheet_(sheet) {
  var lastCol = sheet.getLastColumn();
  if (!lastCol) return;
  var hdr = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h).trim(); });
  var iSent = hdr.indexOf('Emails Sent');
  if (iSent >= 0 && hdr.indexOf(HDR_SENT) < 0) sheet.getRange(1, iSent + 1).setValue(HDR_SENT);

  var iLast = hdr.indexOf('Last Sent'), iTotal = hdr.indexOf('Total Emails'), iId = hdr.indexOf('ID');
  var lastRow = sheet.getLastRow();

  // Column A: the header is "Sign-up date and time (GMT)". Rename the older header, or merge a stray duplicate column into it.
  var iDate = hdr.indexOf(HDR_DATE), iOld = hdr.indexOf(HDR_DATE_OLD);
  if (iDate < 0 && iOld >= 0) { sheet.getRange(1, iOld + 1).setValue(HDR_DATE); iDate = iOld; iOld = -1; }
  if (iDate >= 0 && iOld >= 0 && lastRow >= 2) {
    var main = sheet.getRange(2, iDate + 1, lastRow - 1, 1).getValues();
    var stray = sheet.getRange(2, iOld + 1, lastRow - 1, 1).getValues();
    for (var r = 0; r < main.length; r++) {
      if (main[r][0] === '' && stray[r][0] !== '') sheet.getRange(r + 2, iDate + 1).setValue(stray[r][0]);
    }
  }
  // Turn real date cells into the text format (30-September-2026 05:34 GMT).
  if (iDate >= 0 && lastRow >= 2) {
    var dates = sheet.getRange(2, iDate + 1, lastRow - 1, 1).getValues();
    for (var d = 0; d < dates.length; d++) {
      if (dates[d][0] instanceof Date) sheet.getRange(d + 2, iDate + 1).setValue(gmtStamp_(dates[d][0]));
    }
  }

  if (iLast >= 0 && iId >= 0 && lastRow >= 2) {
    var ids = sheet.getRange(2, iId + 1, lastRow - 1, 1).getValues();
    var vals = sheet.getRange(2, iLast + 1, lastRow - 1, 1).getValues();
    var props = {};
    for (var i = 0; i < ids.length; i++) {
      if (ids[i][0] && vals[i][0] instanceof Date) props['ls:' + ids[i][0]] = String(vals[i][0].getTime());
    }
    if (Object.keys(props).length) PropertiesService.getScriptProperties().setProperties(props);
  }
  [iLast, iTotal, iOld].filter(function (i) { return i >= 0; }).sort(function (a, b) { return b - a; })
    .forEach(function (i) { sheet.deleteColumn(i + 1); });
}

/** Map header name -> 1-based column, adding any missing headers at the end. */
function getColumns_(sheet) {
  migrateSheet_(sheet);
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
  var props = PropertiesService.getScriptProperties().getProperties();
  var rows = [];
  data.forEach(function (row, i) {
    var email = String(get(row, 'Email') || '').trim();
    if (!email) return;
    var id = String(get(row, 'ID') || '');
    rows.push({
      rowNum: i + 2,
      name: String(get(row, 'Name') || '').trim(),
      email: email,
      source: String(get(row, 'Source') || '').trim(),
      signup: parseStamp_(get(row, HDR_DATE)),
      replied: String(get(row, HDR_REPLIED) || ''),
      id: id,
      series: String(get(row, 'Series') || ''),
      lastError: String(get(row, 'Last Error') || ''),
      status: String(get(row, 'Status') || '').trim(),
      sent: Number(get(row, HDR_SENT)) || 0,
      lastSent: props['ls:' + id] ? new Date(Number(props['ls:' + id])) : null,
      bouncedAt: props['bounced:' + id] ? new Date(Number(props['bounced:' + id])) : null
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
  return decodeEntities_(html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|h\d|li)>/gi, '\n')
    .replace(/<a href="([^"]*)">([^<]*)<\/a>/gi, '$2 ($1)')
    .replace(/<[^>]+>/g, ''));
}

var NAMED_ENTITIES = { nbsp: ' ', quot: '"', apos: "'", lt: '<', gt: '>', pound: '£', euro: '€', yen: '¥', cent: '¢', copy: '©', reg: '®',
  trade: '™', deg: '°', middot: '·', bull: '•', hellip: '…', ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  laquo: '«', raquo: '»', eacute: 'é', egrave: 'è', agrave: 'à', aacute: 'á', uuml: 'ü', ouml: 'ö', auml: 'ä', ntilde: 'ñ', ccedil: 'ç' };
/** Decodes named and numeric HTML entities (&pound; &#39; &#x2019; ...). &amp; is decoded last. */
function decodeEntities_(t) {
  return String(t)
    .replace(/&#x([0-9a-f]+);/gi, function (a, n) { return String.fromCharCode(parseInt(n, 16)); })
    .replace(/&#(\d+);/g, function (a, n) { return String.fromCharCode(+n); })
    .replace(/&([a-z]+);/gi, function (a, n) { return NAMED_ENTITIES.hasOwnProperty(n.toLowerCase()) && n !== 'amp' ? NAMED_ENTITIES[n.toLowerCase()] : a; })
    .replace(/&amp;/g, '&');
}

function esc_(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function norm_(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }
function clean_(s) { return String(s || '').trim().substring(0, 200); }
function sanitizeCell_(s) { return /^[=+\-@]/.test(s) ? "'" + s : s; }   // block formula injection
function setProp_(key, value) { PropertiesService.getScriptProperties().setProperty(key, String(value)); }
var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** Column A format: "30-September-2026 05:34 GMT". */
function gmtStamp_(d) {
  var p = function (n) { return (n < 10 ? '0' : '') + n; };
  return p(d.getUTCDate()) + '-' + MONTHS[d.getUTCMonth()] + '-' + d.getUTCFullYear() + ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ' GMT';
}
/** Reads a Sheet date cell: a real date, "30-September-2026 05:34 GMT", or the older "2026-09-30 05:34 GMT". */
function parseStamp_(v) {
  if (v instanceof Date) return v;
  var t = String(v || '').trim(), m = t.match(/^(\d{1,2})-([A-Za-z]+)-(\d{4})(?: (\d{2}):(\d{2}))?(?: GMT)?$/);
  if (m) {
    var mi = MONTHS.map(function (n) { return n.toLowerCase(); }).indexOf(m[2].toLowerCase());
    if (mi >= 0) return new Date(Date.UTC(+m[3], mi, +m[1], +(m[4] || 0), +(m[5] || 0)));
  }
  m = t.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}) GMT$/);
  return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5])) : null;
}
function dayKey_(d) { return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd'); }
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
