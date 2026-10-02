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
- An email that is empty or just says "Coming soon" is skipped quietly (Last Error says so) and sent once you write it.
- **Holding a draft:** put a line that says only `Coming soon` at the very top of an email (above `Subject:`). The whole email is
  held back, even if the draft below it has text. Delete that line when the email is ready to go out.
- `{{name}}` is replaced with the subscriber's name (subject and body).
- **Formatting:** the email uses the Doc's own formatting (font, size, colour, bold/italic, alignment, line spacing, blank lines,
  links, lists, horizontal rules), taken from the Doc's HTML export, so it looks like the Doc. Mail apps that can't load the Doc's
  font (Gmail, for example) fall back to a similar serif font. Images and tables are not supported.
- **Spacing:** paragraph spacing follows the Doc: "space before/after" overlap (the larger wins) instead of adding up, list items
  sit one line apart with no extra gap, and line height matches the Doc's. `EMAIL_SPACING_SCALE` in `CONFIG` makes the gaps
  tighter (below 1) or looser (above 1); `DOC_LINE_FACTOR` is the Docs line-height factor.
- **Signature:** the short block after the last horizontal line (up to 6 plain paragraphs, e.g. tagline and "book a call") is
  styled compactly: thin line, tight spacing, links in the brand colour, and a short first line (a name) in bold. If it starts
  with the same name as the sign-off above the line, the repeat is dropped.
- **Bot protection:** a hidden form field and a minimum fill time (bots are ignored silently), and a cap of 30 signups per hour
  (so bots can't use up your daily email quota). Blocked attempts are counted in the daily report. There is no confirmation email: email #1 goes out immediately.
- Schedule: one email per person per day, Monday-Sunday, at 09:00 GMT (`SEND_HOURS` in `Code.gs`; the time zone is set by
  `appsscript.json`). The schedule is set in the script, not read from the Doc's "Instructions" section: to change it, edit
  `SEND_HOURS` and run `installTrigger` again. Adding more times (e.g. `[9, 12, 17]`) makes later times retry anyone whose
  email was "Coming soon" earlier; with a single time they simply get it the next day.
  Email #1 is sent immediately at signup.
- Subject: put `Subject:` followed by the subject (same line or next line). A `Body:` label line is ignored.
- **Daily report** at 09:00 ICT to `REPORT_TO` (ilona@ilonamelnychuk.com): who was emailed in the last 24 hours
  (name, series, email number), new replies, bounced addresses, and issues (errors, missed sends, unwritten emails, low quota).
  The report shows names and Sheet row numbers only, never subscribers' email addresses. Bounced addresses are marked `Bounced` and no longer emailed.

## Setup (one time, ~5 min)
1. Open the Sheet → **Extensions → Apps Script**. Delete the starter code, paste in `Code.gs`. In Project Settings, tick
   "Show appsscript.json" and paste in `appsscript.json` (sets GMT).
2. Check the `CONFIG` block at the top (IDs are pre-filled; confirm `REPLY_TO` and `SENDER_NAME`).
3. Select **`installTrigger`** in the function dropdown → **Run** → approve the permissions
   (Sheets, Drive, Docs, Gmail, send email). This schedules the 09:00/12:00/17:00 sends and the 09:00 ICT report.
4. **Deploy → New deployment → Web app** — Execute as: **Me**, Who has access: **Anyone**. Copy the URL.
   (After any later code change: Deploy → Manage deployments → edit → new version.)
5. Paste the URL into `ENDPOINT` in `niche.html` and push.
6. Test: sign up with your own email. You should get email #1 immediately and a new row in the Sheet.
   To test day 2 without waiting, run `sendDailyEmails` after clearing that row's **Last Sent** cell.
   To test the report, run `sendDailyReport`.

## Sheet columns
`Sign-up date and time (GMT)` (Column A, always GMT, like `30-September-2026 05:34 GMT`, the only date/time column), `Name`, `Email`, the three status columns
("current series and next number", "series already full sent", "replied to"), and the columns the script adds:
`Source, ID, Series, Status, Total emails sent to date, Last Error`.

Older Sheets are tidied automatically on the next run: `Emails Sent` is renamed `Total emails sent to date`, and the
`Total Emails` and `Last Sent` columns are removed (the script keeps each person's last-sent time itself).

**Status**: `Active` → `Completed` (all emails sent), `Unsubscribed`, `Bounced` (the email bounced; sending stops), or
`Error` (signup with no matching Doc). Bounces are checked before every send slot and in the daily report.
Temporary problems (quota hit, empty tab) show in **Last Error** and the subscriber stays `Active`,
retrying on the next send slot. Edit a row's **Total emails sent to date** to skip/resend an email; set Status to
anything other than `Active` (for example `Paused`) to stop sending.

## Limits
- Gmail free accounts send ~100 emails/day, Google Workspace ~1,500. The script stops when quota runs out
  and resumes the next day.
- Emails come from your Google account address (display name = `SENDER_NAME`).
- The form uses `no-cors`, so the page can't read the script's reply; it always shows the success message.
