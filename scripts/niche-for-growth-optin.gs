/**
 * Niche for Growth — free framework opt-in handler.
 *
 * Setup:
 * 1. Create a new Google Sheet (this will hold your signups).
 * 2. In the Sheet, go to Extensions > Apps Script.
 * 3. Delete any starter code and paste this whole file in.
 * 4. Click Deploy > New deployment.
 *    - Type: Web app
 *    - Execute as: Me
 *    - Who has access: Anyone
 * 5. Click Deploy, authorize it, and copy the Web app URL it gives you.
 * 6. Paste that URL into the ENDPOINT constant in unique.html
 *    (search for "TODO: paste your Google Apps Script Web App URL").
 *
 * Each submission appends a row: Timestamp, Name, Email, Source.
 * A header row is added automatically the first time it runs.
 */
function doPost(e) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();

  if (sheet.getLastRow() === 0) {
    sheet.appendRow(['Timestamp', 'Name', 'Email', 'Source']);
  }

  sheet.appendRow([
    new Date(),
    e.parameter.firstName || '',
    e.parameter.email || '',
    e.parameter.source || ''
  ]);

  return ContentService.createTextOutput(JSON.stringify({ result: 'success' }))
    .setMimeType(ContentService.MimeType.JSON);
}
