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

## Lead Engine tab

Three lead channels in one place. Claude finds people and writes the messages, and **nothing is sent until you approve it** in the approval queue.

| Channel | How it works |
|---|---|
| 🏡 **Realtors** | Each Monday, open Claude Code in this folder and type `/find-realtors`. Claude researches ~20 local agents (public business emails only) and writes a personal opening line for each. Next time you open the dashboard, each agent has an intro email waiting. If they don't reply, follow-ups are drafted on **day 5** and **day 12**, then it stops. Move an agent to *Replied*, *Partner* or *Not interested* to stop their follow-ups early. |
| ⭐ **Past customers** | Type `/find-past-customers` in Claude Code to pull them from Gmail (you confirm the list), or add them with **+ Past customer**. Before spring, click **Draft spring re-booking emails**. When any job is marked *Completed*, a thank-you + review request is drafted automatically. |
| 🎁 **Referrals** | On a new lead's job, fill in **Referred by**. When that job is *Completed*, the referrer earns $50 off (set in ⚙ Settings). The dashboard shows what's owed and reminds you when you open their next job. |
| 🚪 **Door hangers** | After each completed job, click **🖨 Hanger**, save as PDF, and upload to Vistaprint (Door Hangers, 4.25″ × 11″). The hanger never shows the customer's name or address. Click **Log drop** after you walk the street. |

**Sending:** with Google connected, **✓ Approve & send** sends from your Gmail. Without it, **Open in Gmail** opens a ready-to-send email; send it there, then click **I sent it ✓** so follow-ups get scheduled.

**Before you start (whenever you're ready):** open ⚙ Settings and add your phone, your website's quote page (for the QR code), and your Google review link. Also add a mailing address in Marketing → ⚙ Google setup. A PO box is fine; the law (CAN-SPAM) requires one on realtor and re-booking emails, and the dashboard won't send them without it.

Claude's research lands in `data/inbox/` and is imported automatically (then moved to `data/inbox/imported/`).

## Ad Studio tab (Facebook + Instagram ads)

Describe the ad you want in plain words. Claude writes the text, suggests a budget, a radius around Westford and an age range, and you edit anything before it goes anywhere.

1. **✨ Write my ad**: type what the ad should do (or click an idea). Claude reads `BUSINESS_PROFILE_md.md`, so it knows your services and won't invent prices, discounts, reviews or insurance claims.
2. **Ask Claude for changes** ("shorter", "mention patios too"), or edit the fields yourself. The preview on the right updates as you type.
3. **Add a photo**: upload a before/after shot (square works best), or use your logo for now.
4. **Send to Meta (paused)**: creates the campaign on Facebook/Instagram, *paused*. Nothing runs or spends. Meta reviews the ad, usually within a day. Click **Meta's own preview** to see exactly how it will look.
5. **▶ Start ad**: it runs for the number of days you set, starting then. **⏸ Pause** and **⏹ End ad** work any time.

**Money safety:**
- Every ad has a fixed total budget and end date on Meta's side, so Meta can't spend more than the total shown.
- A **spending cap** (default $100, in ⚙ Meta setup) covers any 30 days. Ads that are running or waiting hold their full budget; ended ads count what they actually spent. The dashboard refuses to send or start an ad that would go over it.
- Once an ad is on Meta its text and budget are locked. Use **Make a copy** to change it.

Each ad also appears in the Marketing tab (channel *Facebook / Instagram ads*) with its spend updated automatically. When a customer says they saw the ad, pick that campaign on their job to get cost per lead. Ad links carry `utm_source=facebook` so Google Analytics shows the visits too.

### Connect Claude (one-time, ~5 minutes)
1. Go to https://console.anthropic.com, sign up, and add a little credit under **Billing** ($5 lasts a long time; each ad draft costs a few cents).
2. **Settings → API keys → Create key**, copy it, and put it in `.env` as `ANTHROPIC_API_KEY=...`.
3. In a terminal in this folder, run `npm install` once (it installs the Claude library), then restart the dashboard.

### Connect Meta (one-time, ~20 minutes)
You need a Facebook Page and a Meta ad account with a payment method in **US dollars** (you have these if you've run Facebook ads before).
1. Open **Meta Business Suite settings** (https://business.facebook.com/settings). Under **Accounts**, make sure your Page and your ad account are both listed in your business portfolio.
2. Go to https://developers.facebook.com → **My Apps → Create app**. Choose the **Create & manage ads with Marketing API** use case (or app type *Business*) and connect it to your business portfolio.
3. Back in business settings: **Users → System users → Add**, name it "Dashboard", role **Admin**. Then **Assign assets**: your ad account (full control / manage campaigns) and your Page (full control, or at least "Create ads").
4. On that system user, click **Generate new token**, pick your app, set expiration to **Never**, and tick `ads_management`, `ads_read`, `business_management`, `pages_show_list`, `pages_read_engagement`. Copy the token into `.env` as `META_ACCESS_TOKEN=...`.
5. Optional but recommended: in your app's **App settings → Basic**, copy the **App secret** into `.env` as `META_APP_SECRET=...`.
6. Restart the dashboard, open **Ad Studio → ⚙ Meta setup**, click **Find my ad accounts & Pages**, pick them, add your quote page link, and click **Test connection**.

If Meta says it can't use your Page, the Page wasn't assigned to the system user in step 3. The app is pinned to Marketing API **v26.0**. When Meta retires it (they'll email you, roughly a year out), set `META_API_VERSION` in `.env` to the newest version.

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
