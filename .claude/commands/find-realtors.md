---
description: Research this week's batch of local real estate agents for the Nashoba Power Wash Lead Engine
argument-hint: "[optional: number of agents, default 20, or town names to focus on]"
---

You are filling the Nashoba Power Wash **Lead Engine** with this week's batch of real estate agents to pitch pre-listing exterior cleaning. Read `BUSINESS_PROFILE_md.md` first for context on the business.

Arguments from Doug (may be empty): $ARGUMENTS

## Steps

1. Run `node scripts/leads-known.mjs`. It lists agents already in the system (skip every email in `realtorEmails`) and `suggestedTowns`, which are the closest, least-covered towns. Work through those towns unless Doug named others.
2. Find **20 agents** (or the number Doug gave) who actively list homes in those towns, all within about 20 miles of Westford, MA 01886. Prefer agents with a **current single-family listing**, because their sellers need photo-ready exteriors. Good sources are brokerage agent-directory pages (e.g. Coldwell Banker, Keller Williams, RE/MAX, Compass, Century 21, local independents) and agents' own websites.
3. For each agent, collect:
   - `name`, `email`, `phone` (if listed), `brokerage`, `town` (the town they mostly list in)
   - `listing`: one current listing, e.g. `"14 Oak Ridge Rd, Acton: 4BR colonial, $849k"`
   - `profileUrl`: the page where you found their email
   - `hook`: **one or two sentences** opening the email, specific to them. Examples: noticing their new listing on Oak Ridge Rd, or that they sell a lot in Groton. It must be warm, plain and short, with no flattery, no exclamation points, and no em dashes. It must sound like a 19-year-old local business owner wrote it, not a marketer.
4. Write the batch to `data/inbox/realtors-YYYY-MM-DD.json` (today's date) in exactly this shape:
   ```json
   { "realtors": [ { "name": "", "email": "", "phone": "", "brokerage": "", "town": "", "listing": "", "profileUrl": "", "hook": "" } ] }
   ```
5. Tell Doug how many agents you added and in which towns. Then tell him to open the dashboard's **Lead Engine** tab, where each agent now has an intro email waiting for approval.

## Rules (important)

- **Only use email addresses that are publicly listed** on the agent's own page or their brokerage's page. Never guess or construct an address (e.g. firstname@brokerage.com). If no email is shown, skip that agent.
- Don't scrape sites that clearly forbid it, and don't use paid or login-only directories.
- Only business information: no home addresses, family details, or personal social media.
- Nothing gets sent by you. Doug approves every email in the dashboard.
