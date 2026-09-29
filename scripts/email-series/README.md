# Email series system

Landing-page signup → Google Sheet → one email per day from Google Docs → status written back to the Sheet.

## Content rules (Google Docs)
- One Google Doc per series, all inside the Drive folder. `CONFIG.SERIES` in `Code.gs` links a form `source`
  value to its Doc (currently `niche-for-growth` -> "Niche Started Framework"). For a new series, add an entry
  there (or just name the Doc after the `source` value).
- **One email per tab, titled `Email 1`, `Email 2`, ...** in order. Other tabs (e.g. `Instructions`) are ignored.
  If the Doc is a single tab, headings named `Email 1`, `Email 2`... split it instead.
- **Subject:** optionally start an email with a line `Subject: Your subject here`. Otherwise it defaults to
  `Niche Starter Framework, part N`.
- An email with no text yet is skipped quietly (Last Error says so) and sent once you write it.
- `{{name}}` is replaced with the subscriber's name (subject and body).
- Supported: headings, bold, italic, underline, links, lists, horizontal rules. Not images or tables.
- Schedule: 9AM GMT, every day (`appsscript.json` sets the time zone; set `WEEKDAYS_ONLY: true` in `CONFIG` to pause Sat/Sun).
  Email #1 is sent immediately at signup.
- Subject: put `Subject:` followed by the subject (same line or next line). A `Body:` label line is ignored.
- **Daily report:** after each daily run the script emails the account owner (or `CONFIG.REPORT_TO`) who was emailed today
  (name, series, email number) and any issues: errors, missed sends, unwritten emails, low quota.

## Setup (one time, ~5 min)
1. Open the Sheet → **Extensions → Apps Script**. Delete the starter code, paste in `Code.gs`. In Project Settings, tick
   "Show appsscript.json" and paste in `appsscript.json` (sets GMT).
2. Check the `CONFIG` block at the top (IDs are pre-filled; confirm `REPLY_TO` and `SENDER_NAME`).
3. Select **`installTrigger`** in the function dropdown → **Run** → approve the permissions
   (Sheets, Drive, Docs, send email). This schedules the daily send (default 9am, script time zone;
   set the time zone in Project Settings).
4. **Deploy → New deployment → Web app** — Execute as: **Me**, Who has access: **Anyone**. Copy the URL.
   (After any later code change: Deploy → Manage deployments → edit → new version.)
5. Paste the URL into `ENDPOINT` in `niche.html` and push.
6. Test: sign up with your own email. You should get email #1 immediately and a new row in the Sheet.
   To test day 2 without waiting, run `sendDailyEmails` after clearing that row's **Last Sent** cell.

## Sheet columns
`Sign-up date and time, Name, Email`, plus the two status columns already in your Sheet (the script keeps them updated:
"current series and next number" and "series already received"), plus columns it adds: `Source`,
`ID, Series, Status, Emails Sent, Total Emails, Last Sent, Last Error`.

**Status**: `Active` → `Completed` (all emails sent), `Unsubscribed`, or `Error` (signup with no matching Doc).
Temporary problems (quota hit, empty tab) show in **Last Error** and the subscriber stays `Active`,
retrying on the next daily run. Edit a row's **Emails Sent** to skip/resend an email; set Status to
`Paused` (any value other than `Active`) to stop sending.

## Limits
- Gmail free accounts send ~100 emails/day, Google Workspace ~1,500. The script stops when quota runs out
  and resumes the next day.
- Emails come from your Google account address (display name = `SENDER_NAME`).
- The form uses `no-cors`, so the page can't read the script's reply; it always shows the success message.
