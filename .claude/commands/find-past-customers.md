---
description: Pull Nashoba Power Wash's past customers out of Gmail into the Lead Engine
argument-hint: "[optional: extra search words or names]"
---

You are building Doug's past-customer list for the Nashoba Power Wash **Lead Engine** (spring re-booking emails, review requests and referral credits). Read `BUSINESS_PROFILE_md.md` for context.

Extra hints from Doug (may be empty): $ARGUMENTS

## Steps

1. Run `node scripts/leads-known.mjs` and skip anyone already in `customerNames` / `customerEmails`.
2. Use the Gmail tools to search Doug's mail from 2025 onward for customer conversations. Try several searches, for example: `power wash`, `pressure wash`, `quote`, `patio`, `house wash`, `deck`, `fence`, `estimate`, `Nashoba`, plus any words Doug gave. Look at **who Doug was talking to** about a job: people asking for a quote, scheduling, or thanking him.
3. Keep only real customers or serious quote requests. Skip newsletters, suppliers, Wix/Facebook/Google notifications, and Doug's own addresses.
4. For each person, collect `name`, `email`, `phone` (if it appears in the thread), `town` (if mentioned), `service` (one of: `House Wash (vinyl siding)`, `Patio Restoration (re-sand)`, `Patio Clean`, `Composite Deck Cleaning`, `Fence Cleaning`, `Mold & Grime Removal`, `Other`), `year` (2025 or 2026), and a short `notes` (e.g. "quoted $650, unclear if booked").
5. **Show Doug the list as a table and ask him to confirm** which ones actually became customers, and whether to drop or fix any. Only write the people he confirms.
6. Write them to `data/inbox/customers-YYYY-MM-DD.json`:
   ```json
   { "customers": [ { "name": "", "email": "", "phone": "", "town": "", "service": "", "year": "2026", "notes": "" } ] }
   ```
7. Tell Doug they'll appear under **Lead Engine → Past customers** next time he opens the dashboard. He can add anyone who isn't in Gmail (texts, Venmo) with **+ Past customer**.

## Rules

- Read-only in Gmail: don't send, label, archive or draft anything.
- Don't copy message contents into the file beyond the fields above.
