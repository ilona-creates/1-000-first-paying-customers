# Email series system

Landing-page signup → Google Sheet → one email per day from Google Docs → status written back to the Sheet.

## Content rules (Google Docs)
- One Google Doc per series, all inside the Drive folder.
- **Doc name = the form's `source` value** (case/spaces/dashes ignored). The niche page uses
  `source="niche-for-growth"`, so name the Doc `Niche for Growth`.
- **One top-level tab per email**, in order. **Tab title = subject line.** Tab content = body.
- `{{name}}` is replaced with the subscriber's name (subject and body).
- Supported: headings, bold, italic, underline, links, bulleted/numbered lists, horizontal rules.
  Not supported: images and tables.
- Adding a new series = add a Doc and a form with a matching `source`. No code changes.

## Setup (one time, ~5 min)
1. Open the Sheet → **Extensions → Apps Script**. Delete the starter code, paste in `Code.gs`.
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
`Timestamp, Name, Email, Source` (from the form) plus columns the script adds automatically:
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
