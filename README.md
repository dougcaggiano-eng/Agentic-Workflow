# Nashoba Power Wash Dashboard

A business dashboard that runs on your own computer: leads and quotes, schedule, quote calculator, money, job playbook, business setup tasks, and quick links. It can also sync booked jobs to Google Calendar and email customers from Gmail.

## Start it

Double-click **Nashoba Dashboard** on the desktop. It opens in its own app window, and the server runs hidden in the background, then stops by itself about 3 minutes after you close the window.

(Developer option: `npm start` runs the server in a terminal; then open http://127.0.0.1:3000.)

- Your data lives in `data/nashoba.db`. It stays on this computer and is never committed to git.
- Use **Export backup** (bottom of the sidebar) now and then, and save the file somewhere safe, such as Google Drive.

## Connect Google Calendar + Gmail (one-time, ~10 minutes)

1. Go to https://console.cloud.google.com/ and create a project (e.g. "Nashoba Dashboard").
2. Under **APIs & Services → Library**, enable **Google Calendar API** and **Gmail API**.
3. Under **APIs & Services → OAuth consent screen**: choose **External**, fill in the app name and your email, and add yourself as a **Test user**.
4. Under **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Application type: **Desktop app**
5. Copy `.env.example` to `.env` and paste in the Client ID and Client secret.
6. Restart the server (`Ctrl+C`, then `npm start`) and click **Connect Google** in the sidebar.

> While the Google app is in "Testing" mode, Google expires the connection after 7 days, so you'll need to click **Connect Google** again. To stop that, click **Publish app** on the OAuth consent screen. Google will show an "unverified app" warning when you sign in; since it's your own app, click *Advanced → Go to app*.

### What syncs
- A job set to **Booked** or **Completed** with a date becomes an all-day event on your Google Calendar. Patio restorations block 3 days for drying time.
- Changing the date, scope, or quote updates the event. Marking a job **Lost**, clearing its date, or deleting it removes the event.
- **Message customer** (open any saved job): pick a template (quote confirmation, reminder, thank-you, follow-up), edit it, then:
  - **Send email**: sends from your Gmail.
  - **Text**: opens your texting app (Phone Link on Windows) with the message filled in.

## Marketing tab

Tracks every campaign (emails, Google Ads, flyers, yard signs, referral pushes): what it cost and what it brought in. On each lead, set **Source** and pick a **Campaign** in the job form. The Campaigns table then shows leads, booked jobs, revenue, cost per lead, and return (revenue ÷ spend).

It also pulls in numbers from Google. Each part works independently, so set up only the ones you use.

**First, for all of them:** in Cloud Console → **APIs & Services → Library**, enable the APIs listed below. Then click **Reconnect to enable Marketing** in the sidebar (the dashboard now asks Google for read-only access to Ads, Analytics, and Business Profile). Finally, open **Marketing → ⚙ Google setup → Find my Google accounts** and pick your accounts.

| Feature | Enable these APIs | Extra steps |
|---|---|---|
| **Email campaigns** (Gmail) | none (uses Gmail API) | In Google setup, enter a mailing address. US law (CAN-SPAM) requires one on marketing emails, and a PO box is fine. |
| **Website stats** (Google Analytics 4) | Google Analytics Data API, Google Analytics Admin API | GA4 must be installed on the Wix site (Wix: Marketing Integrations → Google Analytics). |
| **Business Profile** (views, calls, directions) | My Business Account Management API, My Business Business Information API, Business Profile Performance API | Google must approve API access first: fill in the [GBP API access form](https://developers.google.com/my-business/content/prereqs). Until then these APIs show 0 quota and the card shows an error. |
| **Google Ads** (spend, clicks, conversions) | Google Ads API | Needs a developer token: create a [Google Ads manager account](https://ads.google.com/home/tools/manager-accounts/), open **Tools → API Center**, apply, and put the token in `.env` as `GOOGLE_ADS_DEVELOPER_TOKEN`. A new token only works with *test* accounts until you apply for Basic access (usually a few days). If your Ads account is under that manager account, enter the manager's ID in Google setup. |

### Email campaigns
**✉️ Email campaign** → choose who gets it (e.g. all *Completed* customers), write the message (`{first}` becomes their first name), then **Send test** to yourself first.
- Each person gets their own email from your Gmail (not a group email).
- Duplicate email addresses are only emailed once.
- If someone replies "unsubscribe", open their job and tick **Don't send marketing emails**.
- If sending stops partway (internet drops, Gmail limit), click Send again. Only the people who didn't get it are emailed. Personal Gmail allows about 500 emails a day.

### Google Ads spend
On a campaign with channel **Google Ads**, pick the linked Ads campaign and click **Pull spend from Google Ads** to fill in its spend for the campaign's dates.

Google numbers are cached for 10 minutes. Click ↻ to refresh. Google Ads retires each API version after about a year. When requests start failing with a version error, set `GOOGLE_ADS_API_VERSION` in `.env` to the [current version](https://developers.google.com/google-ads/api/docs/sunset-dates).
