// Ad Studio: Doug describes an ad, Claude writes it, and it runs on Facebook + Instagram through the Meta Marketing API.
// Money rule: nothing spends until Doug presses Start. Ads go to Meta paused, every ad has a fixed lifetime budget
// and end date, and the server refuses anything that would push the last 30 days of ads over his spending cap.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const ADS_DEFAULTS = {
  capUsd: 100, adAccountId: '', pageId: '', link: '',
  centerLat: 42.5793, centerLng: -71.4378, centerLabel: 'Westford, MA 01886',
};
const CTAS = ['GET_QUOTE', 'LEARN_MORE', 'CONTACT_US', 'SIGN_UP'];
const MODEL = 'claude-opus-5-5';
const META_VERSION = process.env.META_API_VERSION || 'v26.0';

const AD_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['name', 'primary_text', 'headline', 'description', 'call_to_action', 'daily_budget_usd', 'days', 'radius_miles', 'age_min', 'age_max', 'image_advice', 'notes', 'reply'],
  properties: {
    name: { type: 'string', description: 'Short internal campaign name, e.g. "Spring house wash 2027"' },
    primary_text: { type: 'string', description: 'The main ad text above the image' },
    headline: { type: 'string', description: 'Bold line under the image, under 40 characters' },
    description: { type: 'string', description: 'Small line under the headline, under 30 characters, or empty' },
    call_to_action: { type: 'string', enum: CTAS },
    daily_budget_usd: { type: 'number' },
    days: { type: 'integer' },
    radius_miles: { type: 'integer', description: 'Radius around Westford, MA' },
    age_min: { type: 'integer' },
    age_max: { type: 'integer', description: '65 means 65 and older' },
    image_advice: { type: 'string' },
    notes: { type: 'string', description: 'Anything Doug should double-check, or empty' },
    reply: { type: 'string', description: '1-3 plain sentences to Doug about what you made or changed' },
  },
};

function systemPrompt(profile) {
  return `You write Facebook and Instagram ads for Nashoba Power Wash, a one-person exterior cleaning business run by Doug Caggiano in Westford, MA. Doug describes the ad he wants; you write it and plan its budget and reach. He reviews and edits everything before anything runs, and he pays for the ads himself, so be careful with his money.

<business_profile>
${profile}
</business_profile>

How to write the ad:
- Sound like Doug: a local owner who does every job himself. Plain, warm, confident. No hype words ("revolutionary", "unleash", "elevate", "game-changer"), no stock phrases like "transform your home", nothing that reads as AI-written. At most one emoji, or none.
- primary_text: one to three short paragraphs, under about 300 characters in total. Facebook hides everything after roughly the first 125 characters behind "See more", so the first sentence has to work on its own.
- headline: under 40 characters. description: under 30 characters, or an empty string.
- The goal of every ad is a free quote request on Doug's website. Pick the call_to_action that fits (usually GET_QUOTE).

Facts: use only what the business profile says or what Doug tells you in his request.
- Never state prices or price ranges; Doug quotes in person. No discounts, coupons or special offers unless Doug asks for one in this request.
- Never claim he is insured, licensed, bonded, certified, an LLC, or has a number of years of experience. He started in the summer of 2025.
- No customer names, testimonials, quotes, star ratings, review counts or invented statistics.
- Don't promise results he can't guarantee, such as "removes every stain".

Meta ad policies:
- Don't assert or imply personal attributes of the person reading (their finances, health, age, and so on). Talk about the house, patio, deck or fence, not the person.
- No all-caps shouting, no clickbait, no fake urgency.

Budget and reach:
- Doug's ad money is limited. Suggest a daily budget (at least $1) and a number of days whose total fits inside the remaining budget given in the request. $3-$10 a day for 7-21 days is typical for him. If the remaining budget is too small to run a useful ad, say so in reply and plan the smallest sensible ad.
- radius_miles: between 5 and 50. His service area is about 20 miles around Westford.
- Ages: aim at likely homeowners. age_min 25 or higher unless he asks otherwise; age_max 65 means 65 and older.
- His busy season runs mid-May through August; from March to mid-May the goal is booking summer jobs early. Use the date in the request.

Other fields:
- image_advice: one or two sentences on which photo would work best. He has some before/after job photos but no gear photos yet. If an image is attached, say whether it suits the ad, and write the copy to match it.
- notes: anything Doug should double-check, such as a fact you weren't sure about. Keep it short. Empty string if there's nothing.
- reply: one to three plain sentences to Doug about what you made or changed. Don't repeat the ad text back to him.

If Doug asks for something that breaks these rules, write the closest version that follows them and say why in reply.`;
}

export function createAds({ db, ROOT, kvGet, getCampaign, saveCampaign, EMAIL_RE }) {
  db.exec('CREATE TABLE IF NOT EXISTS ads (id TEXT PRIMARY KEY, data TEXT NOT NULL)');
  const IMG_DIR = path.join(ROOT, 'data', 'ad-images');
  fs.mkdirSync(IMG_DIR, { recursive: true });

  const getAd = (id) => { const r = db.prepare('SELECT data FROM ads WHERE id=?').get(id); return r ? { ...JSON.parse(r.data), id } : null; };
  const allAds = () => db.prepare('SELECT id,data FROM ads').all().map(r => ({ ...JSON.parse(r.data), id: r.id }));
  const putAd = (a) => { const { id, stage, totalUsd: _t, ...d } = a; d.updated = new Date().toISOString(); db.prepare('INSERT OR REPLACE INTO ads(id,data) VALUES(?,?)').run(id, JSON.stringify(d)); };
  const newId = () => crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  const now = () => new Date().toISOString();
  const clean = (s, max = 2000) => String(s ?? '').trim().slice(0, max);
  const digits = (s) => String(s || '').replace(/\D/g, '');
  const num = (v, lo, hi, dflt) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt; };
  const round2 = (n) => Math.round(n * 100) / 100;
  const fail = (msg, status = 400) => Object.assign(new Error(msg), { status });

  const cfg = () => ({ ...ADS_DEFAULTS, ...(kvGet('s:ads') || {}) });
  const accountId = () => digits(cfg().adAccountId || process.env.META_AD_ACCOUNT_ID);
  const pageId = () => digits(cfg().pageId || process.env.META_PAGE_ID);
  const defaultLink = () => clean(cfg().link || kvGet('s:leads')?.website || '', 500);

  /* ---------- the ad's shape ---------- */
  const blankAd = (id) => ({
    id, title: 'New ad', brief: '', created: now(), history: [],
    copy: { primaryText: '', headline: '', description: '', cta: 'GET_QUOTE', link: defaultLink() },
    plan: { dailyBudget: 5, days: 14, radiusMiles: 20, ageMin: 30, ageMax: 65 },
    advice: '', notes: '', image: null, meta: {}, stats: null,
  });
  function sanitizeCopy(c = {}, old = {}) {
    return {
      primaryText: clean(c.primaryText ?? old.primaryText, 2000), headline: clean(c.headline ?? old.headline, 120),
      description: clean(c.description ?? old.description, 120),
      cta: CTAS.includes(c.cta) ? c.cta : (old.cta || 'GET_QUOTE'), link: clean(c.link ?? old.link, 500),
    };
  }
  function sanitizePlan(p = {}, old = {}) {
    const ageMin = Math.round(num(p.ageMin ?? old.ageMin, 18, 65, 30));
    return {
      dailyBudget: round2(num(p.dailyBudget ?? old.dailyBudget, 1, 500, 5)), days: Math.round(num(p.days ?? old.days, 1, 90, 14)),
      radiusMiles: Math.round(num(p.radiusMiles ?? old.radiusMiles, 1, 50, 20)), ageMin,
      ageMax: Math.max(ageMin, Math.round(num(p.ageMax ?? old.ageMax, 18, 65, 65))),
    };
  }
  const totalUsd = (a) => round2(a.plan.dailyBudget * a.plan.days);
  const endedAt = (a) => a.meta?.endedAt || (a.meta?.launchedAt && a.meta?.endTime && Date.parse(a.meta.endTime) < Date.now() ? a.meta.endTime : null);
  function stage(a) {
    const m = a.meta || {};
    if (!m.adId) return 'draft';
    if (endedAt(a)) return 'ended';
    if (!m.launchedAt) return 'ready';
    return m.campaignStatus === 'PAUSED' ? 'paused' : 'running';
  }
  const withStage = (a) => a && { ...a, stage: stage(a), totalUsd: totalUsd(a) };

  // Spending cap over a rolling 30 days. Ads that are live or waiting to start reserve their full budget;
  // ads that ended in the last 30 days count what they actually spent.
  function committedUsd(exceptId) {
    const cutoff = Date.now() - 30 * 864e5;
    let sum = 0;
    for (const a of allAds()) {
      if (a.id === exceptId || !a.meta?.adId) continue; // nothing can spend until the ad itself exists
      const end = endedAt(a);
      if (!end) sum += a.meta.lifetimeUsd ?? totalUsd(a);
      else if (Date.parse(end) >= cutoff) sum += a.meta.launchedAt ? (a.stats?.spend ?? a.meta.lifetimeUsd ?? totalUsd(a)) : 0;
    }
    return round2(sum);
  }
  function checkCap(a) {
    const cap = Number(cfg().capUsd) || 0, used = committedUsd(a.id), total = totalUsd(a);
    if (used + total > cap + 0.001) {
      throw fail(`This ad's budget ($${total.toFixed(2)}) would put you over your $${cap} ad spending cap for the last 30 days ($${used.toFixed(2)} is already committed). Lower the budget, end another ad, or raise the cap in Meta setup.`);
    }
  }

  /* ---------- Claude ---------- */
  let client = null;
  async function claude() {
    if (client) return client;
    let mod;
    try { mod = await import('@anthropic-ai/sdk'); }
    catch { throw fail('The Claude library isn\'t installed. Open a terminal in the dashboard folder, run "npm install", then restart the dashboard.'); }
    try { client = new mod.default(); }
    catch { throw fail('Add your Claude API key to the .env file as ANTHROPIC_API_KEY (see README), then restart the dashboard.'); }
    return client;
  }
  function readProfile() {
    try { return fs.readFileSync(path.join(ROOT, 'BUSINESS_PROFILE_md.md'), 'utf8'); }
    catch { return '(No business profile file found.)'; }
  }

  async function write(ad, { brief, instruction }) {
    const c = await claude();
    const cap = Number(cfg().capUsd) || 0, used = committedUsd(ad.id), left = Math.max(0, round2(cap - used));
    const revising = Boolean(ad.copy.primaryText && instruction);
    const content = [];
    const img = ad.image && imagePath(ad);
    if (img && fs.existsSync(img) && fs.statSync(img).size < 3.7 * 1024 * 1024) { // Claude's image limit is 5 MB after encoding
      content.push({ type: 'image', source: { type: 'base64', media_type: ad.image.mime, data: fs.readFileSync(img).toString('base64') } });
    }
    const today = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    const lines = [
      `Today is ${today}.`,
      `Remaining ad budget: $${left.toFixed(2)} (his cap is $${cap} per 30 days; $${used.toFixed(2)} is already committed to other ads).`,
      `The ad links to: ${ad.copy.link || '(his quote page, not set yet)'}`,
      img ? 'The photo Doug picked for this ad is attached.' : 'Doug hasn\'t picked a photo yet.',
      '',
    ];
    if (revising) {
      lines.push('Current draft (Doug may have edited it by hand; keep his edits unless he asks to change them):',
        JSON.stringify({ name: ad.title, ...ad.copy, ...ad.plan }, null, 2), '',
        `Doug's original description: ${ad.brief || '(none)'}`, '', `What Doug wants changed: ${instruction}`);
    } else {
      lines.push('Doug\'s description of the ad he wants:', brief || ad.brief);
    }
    content.push({ type: 'text', text: lines.join('\n') });

    let res;
    try {
      res = await c.beta.messages.create({
        model: MODEL, max_tokens: 16000,
        betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default', // a rare safety decline gets retried on another model
        output_config: { effort: 'medium', format: { type: 'json_schema', schema: AD_SCHEMA } },
        system: [{ type: 'text', text: systemPrompt(readProfile()), cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content }],
      });
    } catch (e) {
      const st = e?.status;
      if (st === 401) throw fail('Claude rejected the API key. Check ANTHROPIC_API_KEY in the .env file, then restart.');
      if (st === 429) throw fail('Claude is busy (rate limit). Wait a minute and try again.');
      if (st === 400 && /credit|billing/i.test(e.message)) throw fail('Your Claude account is out of credit. Add credit at console.anthropic.com → Billing.');
      if (!st && /api.?key|auth/i.test(e?.message || '')) throw fail('Add your Claude API key to the .env file as ANTHROPIC_API_KEY (see README), then restart the dashboard.');
      throw fail(`Claude couldn't write the ad: ${e?.message || e}`, 502);
    }
    if (res.stop_reason === 'refusal') throw fail('Claude declined to write this one. Try describing the ad a different way.');
    if (res.stop_reason === 'max_tokens') throw fail('Claude\'s answer got cut off. Try again.', 502);
    let out;
    try { out = JSON.parse(res.content.filter(b => b.type === 'text').map(b => b.text).join('')); }
    catch { throw fail('Claude sent back something unreadable. Try again.', 502); }

    ad.title = clean(out.name, 80) || ad.title;
    ad.copy = sanitizeCopy({ primaryText: out.primary_text, headline: out.headline, description: out.description, cta: out.call_to_action }, ad.copy);
    ad.plan = sanitizePlan({ dailyBudget: out.daily_budget_usd, days: out.days, radiusMiles: out.radius_miles, ageMin: out.age_min, ageMax: out.age_max }, ad.plan);
    if (left >= 1 && totalUsd(ad) > left) ad.plan.days = Math.max(1, Math.floor(left / ad.plan.dailyBudget)); // keep inside the cap
    ad.advice = clean(out.image_advice, 600); ad.notes = clean(out.notes, 600);
    ad.history = [...ad.history, { who: 'doug', text: revising ? instruction : (brief || ad.brief), at: now() }, { who: 'claude', text: clean(out.reply, 800), at: now() }].slice(-40);
    return ad;
  }

  /* ---------- images ---------- */
  const imagePath = (a) => a.image?.file && path.join(IMG_DIR, path.basename(a.image.file));
  function removeImage(a) { const p = imagePath(a); if (p) fs.rmSync(p, { force: true }); a.image = null; }
  function setImage(a, buf, mime) {
    if (!['image/jpeg', 'image/png'].includes(mime)) throw fail('Use a JPG or PNG photo.');
    if (buf.length > 7.5 * 1024 * 1024) throw fail('That photo is too big. Use one under 7 MB.');
    removeImage(a);
    const file = `${a.id}-${Date.now()}.${mime === 'image/png' ? 'png' : 'jpg'}`;
    fs.writeFileSync(path.join(IMG_DIR, file), buf);
    a.image = { file, mime, hash: null };
  }

  /* ---------- Meta Marketing API ---------- */
  const metaConfigured = () => Boolean(process.env.META_ACCESS_TOKEN);
  async function meta(pathPart, { method = 'GET', params = {} } = {}) {
    const token = process.env.META_ACCESS_TOKEN;
    if (!token) throw fail('Meta isn\'t connected yet. Add META_ACCESS_TOKEN to the .env file (see README), then restart.');
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') q.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
    q.set('access_token', token);
    if (process.env.META_APP_SECRET) q.set('appsecret_proof', crypto.createHmac('sha256', process.env.META_APP_SECRET).update(token).digest('hex'));
    const url = `${process.env.META_GRAPH_URL || 'https://graph.facebook.com'}/${META_VERSION}/${pathPart}`; // override only for testing
    const r = method === 'GET' ? await fetch(`${url}?${q}`) : await fetch(url, { method, body: q });
    const j = await r.json().catch(() => null);
    if (!r.ok || j?.error) {
      const e = j?.error || {};
      if (e.code === 190) throw fail('Your Meta access token expired or was revoked. Make a new one (README, "Connect Meta") and put it in .env.');
      throw fail(`Meta: ${e.error_user_msg || e.message || `error ${r.status}`}`, r.status >= 500 ? 502 : 400);
    }
    return j;
  }
  const act = () => { const id = accountId(); if (!id) throw fail('Pick your ad account in Ad Studio → ⚙ Meta setup first.'); return `act_${id}`; };

  async function accountInfo() {
    const a = await meta(act(), { params: { fields: 'name,currency,account_status,timezone_name' } });
    return { name: a.name, currency: a.currency, active: a.account_status === 1, status: a.account_status, timezone: a.timezone_name };
  }
  async function discover() {
    const out = { accounts: [], pages: [], errors: {} };
    await Promise.all([
      meta('me/adaccounts', { params: { fields: 'name,account_id,currency', limit: 50 } })
        .then(j => { out.accounts = (j.data || []).map(x => ({ id: x.account_id, name: `${x.name || 'Ad account'} (${x.currency})` })); })
        .catch(e => { out.errors.accounts = e.message; }),
      meta('me/accounts', { params: { fields: 'name,id', limit: 50 } })
        .then(j => { out.pages = (j.data || []).map(x => ({ id: x.id, name: x.name })); })
        .catch(e => { out.errors.pages = e.message; }),
    ]);
    return out;
  }

  function validateForMeta(a) {
    const c = a.copy;
    if (!c.primaryText || !c.headline) throw fail('The ad needs its main text and a headline first.');
    if (!/^https:\/\/[^\s]+\.[^\s]+$/.test(c.link)) throw fail('Add the web page the ad should open (your quote page, starting with https://).');
    if (!a.image) throw fail('Add a photo first. Facebook ads need an image.');
    if (!pageId()) throw fail('Pick your Facebook Page in Ad Studio → ⚙ Meta setup first.');
    if (a.plan.dailyBudget < 1) throw fail('Meta needs a budget of at least $1 a day.');
  }

  // Creates campaign → ad set → creative → ad, all paused at the campaign level. Saves each ID as it goes,
  // so if something fails halfway, pressing the button again carries on instead of making duplicates.
  async function publish(a) {
    if (stage(a) !== 'draft') throw fail('This ad is already on Meta.');
    if (!a.copy.link) a.copy.link = defaultLink();
    validateForMeta(a); checkCap(a);
    const info = await accountInfo();
    if (info.currency !== 'USD') throw fail(`Your ad account is billed in ${info.currency}. Ad Studio's budgets assume US dollars, so use a USD ad account.`);
    if (!info.active) throw fail('Meta says your ad account isn\'t active (often a missing payment method). Fix it in Ads Manager → Billing, then try again.');
    const m = a.meta = a.meta || {};
    const save = () => putAd(a);
    const label = `${a.title} · Ad Studio`;
    const lifetimeCents = Math.round(totalUsd(a) * 100);

    if (!m.campaignId) {
      const r = await meta(`${act()}/campaigns`, { method: 'POST', params: {
        name: label, objective: 'OUTCOME_TRAFFIC', status: 'PAUSED', special_ad_categories: [],
        is_adset_budget_sharing_enabled: false, // the budget lives on the ad set
      } });
      m.campaignId = r.id; m.campaignStatus = 'PAUSED'; m.accountId = accountId(); save();
    }
    if (!m.adsetId) {
      const start = new Date(), end = new Date(start.getTime() + a.plan.days * 864e5);
      const r = await meta(`${act()}/adsets`, { method: 'POST', params: {
        name: label, campaign_id: m.campaignId, status: 'ACTIVE',
        lifetime_budget: lifetimeCents, start_time: start.toISOString(), end_time: end.toISOString(),
        billing_event: 'IMPRESSIONS', optimization_goal: 'LINK_CLICKS', bid_strategy: 'LOWEST_COST_WITHOUT_CAP', destination_type: 'WEBSITE',
        targeting: {
          geo_locations: { custom_locations: [{ latitude: cfg().centerLat, longitude: cfg().centerLng, radius: a.plan.radiusMiles, distance_unit: 'mile' }] },
          age_min: a.plan.ageMin, age_max: a.plan.ageMax,
          targeting_automation: { advantage_audience: 0 }, // stick to the radius and ages Doug picked
        },
      } });
      m.adsetId = r.id; m.lifetimeUsd = totalUsd(a); m.endTime = end.toISOString(); save();
    }
    if (!a.image.hash) {
      const r = await meta(`${act()}/adimages`, { method: 'POST', params: { bytes: fs.readFileSync(imagePath(a)).toString('base64') } });
      a.image.hash = Object.values(r.images || {})[0]?.hash;
      if (!a.image.hash) throw fail('Meta didn\'t accept the photo. Try a different JPG.', 502);
      save();
    }
    if (!m.creativeId) {
      const c = a.copy;
      const slug = a.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'ad';
      const r = await meta(`${act()}/adcreatives`, { method: 'POST', params: {
        name: label,
        object_story_spec: { page_id: pageId(), link_data: {
          link: c.link, message: c.primaryText, name: c.headline, description: c.description || undefined,
          image_hash: a.image.hash, call_to_action: { type: c.cta, value: { link: c.link } },
        } },
        url_tags: `utm_source=facebook&utm_medium=paid_social&utm_campaign=${slug}`, // so website stats show where visits came from
      } });
      m.creativeId = r.id; save();
    }
    if (!m.adId) {
      const r = await meta(`${act()}/ads`, { method: 'POST', params: { name: label, adset_id: m.adsetId, creative: { creative_id: m.creativeId }, status: 'ACTIVE' } });
      m.adId = r.id; m.publishedAt = now(); save();
    }
    // Track it next to the other campaigns in the Marketing tab (cost per lead, return).
    if (!m.dashCampaignId || !getCampaign(m.dashCampaignId)) {
      m.dashCampaignId = newId();
      saveCampaign(m.dashCampaignId, {
        name: a.title, channel: 'Facebook / Instagram ads', status: 'Planned', start: '', end: '',
        budget: m.lifetimeUsd, spend: 0, notes: `Made in Ad Studio. Meta campaign ${m.campaignId}. Spend updates automatically.`,
        metaCampaignId: m.campaignId, studioAdId: a.id,
      });
      save();
    }
    return a;
  }
  function updateDashCampaign(a, patch) {
    const id = a.meta?.dashCampaignId, c = id && getCampaign(id);
    if (c) saveCampaign(id, { ...c, ...patch });
  }

  // A send that failed halfway left a paused campaign (and maybe an ad set) on Meta. If Doug edits the draft,
  // drop the pieces built from the old version; the next send rebuilds them. Nothing in them can spend.
  function resetPartial(a) {
    const m = a.meta || {};
    if (m.adsetId) meta(m.adsetId, { method: 'DELETE' }).catch(() => {});
    for (const k of ['adsetId', 'creativeId', 'lifetimeUsd', 'endTime']) delete m[k];
  }

  async function launch(a) {
    const st = stage(a);
    if (st !== 'ready' && st !== 'paused') throw fail(st === 'running' ? 'This ad is already running.' : 'Send this ad to Meta first.');
    const m = a.meta;
    if (st === 'ready') {
      checkCap(a);
      const ad = await meta(m.adId, { params: { fields: 'effective_status,ad_review_feedback' } });
      m.effectiveStatus = ad.effective_status;
      if (ad.effective_status === 'DISAPPROVED') { putAd(a); throw fail(`Meta rejected this ad: ${reviewText(ad.ad_review_feedback) || 'no reason given'}. Make a copy, fix it, and send the copy.`); }
      const end = new Date(Date.now() + a.plan.days * 864e5); // the clock starts now, not when it was sent
      await meta(m.adsetId, { method: 'POST', params: { end_time: end.toISOString() } });
      m.endTime = end.toISOString();
    } else if (Date.parse(m.endTime) < Date.now()) throw fail('This ad\'s run is over.');
    await meta(m.campaignId, { method: 'POST', params: { status: 'ACTIVE' } });
    m.campaignStatus = 'ACTIVE';
    if (!m.launchedAt) { m.launchedAt = now(); updateDashCampaign(a, { status: 'Active', start: now().slice(0, 10), end: m.endTime.slice(0, 10) }); }
    putAd(a); return a;
  }
  async function pause(a, end) {
    const st = stage(a);
    if (st === 'draft' || st === 'ended') throw fail('This ad isn\'t live.');
    await meta(a.meta.campaignId, { method: 'POST', params: { status: 'PAUSED' } });
    a.meta.campaignStatus = 'PAUSED';
    if (end) { a.meta.endedAt = now(); updateDashCampaign(a, { status: 'Done', ...(a.meta.launchedAt ? { end: now().slice(0, 10) } : {}) }); }
    putAd(a); return a;
  }

  const reviewText = (fb) => fb ? Object.values(fb.global || fb).filter(v => typeof v === 'string').join(' ') : '';
  async function refresh(a) {
    const m = a.meta;
    if (!m?.adId) return a;
    const [ad, camp, ins] = await Promise.all([
      meta(m.adId, { params: { fields: 'effective_status,ad_review_feedback' } }),
      meta(m.campaignId, { params: { fields: 'status' } }),
      meta(`${m.campaignId}/insights`, { params: { fields: 'spend,impressions,reach,inline_link_clicks,cpc,ctr', date_preset: 'maximum' } }),
    ]);
    m.effectiveStatus = ad.effective_status; m.review = reviewText(ad.ad_review_feedback); m.campaignStatus = camp.status;
    const s = ins.data?.[0] || {};
    a.stats = {
      spend: round2(Number(s.spend || 0)), impressions: Number(s.impressions || 0), reach: Number(s.reach || 0),
      clicks: Number(s.inline_link_clicks || 0), fetchedAt: now(),
    };
    updateDashCampaign(a, { spend: a.stats.spend, spendSyncedAt: a.stats.fetchedAt });
    putAd(a); return a;
  }
  async function previewUrl(a) {
    if (!a.meta?.creativeId) throw fail('Send the ad to Meta first.');
    const j = await meta(`${a.meta.creativeId}/previews`, { params: { ad_format: 'MOBILE_FEED_STANDARD' } });
    const src = /src="([^"]+)"/.exec(j.data?.[0]?.body || '')?.[1];
    if (!src) throw fail('Meta didn\'t return a preview.', 502);
    return src.replace(/&amp;/g, '&');
  }

  function status() {
    return {
      claude: Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN),
      meta: metaConfigured(), accountId: accountId(), pageId: pageId(), defaultLink: defaultLink(),
      cap: Number(cfg().capUsd) || 0, committed: committedUsd(), version: META_VERSION,
    };
  }
  const list = () => allAds().map(withStage).sort((x, y) => (y.created || '').localeCompare(x.created || ''));

  /* ---------- routes ---------- */
  return {
    exportData: () => ({ ads: allAds() }),
    importBackup(d) { for (const a of Array.isArray(d.ads) ? d.ads : []) if (/^[\w-]{1,64}$/.test(a.id)) putAd(a); },
    async route(m, p, url, req, res, { send, readBody }) {
      const reply = async (fn) => {
        try { const out = await fn(); send(res, 200, out); }
        catch (e) { send(res, e.status || 500, { error: e.message }); }
        return true;
      };
      let r;
      if (m === 'GET' && (r = p.match(/^\/ad-image\/([\w-]{1,64})$/))) {
        const a = getAd(r[1]), file = a && imagePath(a);
        if (!file || !fs.existsSync(file)) { send(res, 404, 'Not found'); return true; }
        send(res, 200, fs.readFileSync(file), { 'content-type': a.image.mime, 'cache-control': 'no-store' }); return true;
      }
      if (m === 'GET' && p === '/api/ads') return reply(() => ({ ads: list(), status: status() }));
      if (m === 'GET' && p === '/api/ads/discover') return reply(discover);
      if (m === 'GET' && p === '/api/ads/check') return reply(async () => {
        const out = { account: await accountInfo() };
        if (pageId()) out.page = await meta(pageId(), { params: { fields: 'name' } });
        return out;
      });

      if (!(r = p.match(/^\/api\/ads\/([\w-]{1,64})(\/[a-z-]+)?$/))) return false;
      const [, id, action = ''] = r;
      const cur = getAd(id);
      const need = () => { if (!cur) throw fail('Ad not found.', 404); return cur; };
      const draftOnly = (a) => {
        if (stage(a) !== 'draft') throw fail('This ad is already on Meta, so it can\'t be changed. Use "Make a copy" to start a new version.');
        resetPartial(a); return a;
      };
      const done = (a) => ({ ad: withStage(a), status: status() });

      if (m === 'PUT' && !action) return reply(async () => {
        const a = cur ? draftOnly(cur) : blankAd(id), b = await readBody(req);
        if (b.title !== undefined) a.title = clean(b.title, 80) || a.title;
        if (b.brief !== undefined) a.brief = clean(b.brief);
        if (b.copy) a.copy = sanitizeCopy(b.copy, a.copy);
        if (b.plan) a.plan = sanitizePlan(b.plan, a.plan);
        putAd(a); return done(a);
      });
      if (m === 'DELETE' && !action) return reply(async () => {
        const a = need();
        if (a.meta?.adId) throw fail('This ad has been on Meta, so it stays in your history. End it instead.');
        if (a.meta?.campaignId) meta(a.meta.campaignId, { method: 'DELETE' }).catch(() => {}); // half-sent: tidy up Meta
        removeImage(a); db.prepare('DELETE FROM ads WHERE id=?').run(id); return { ok: true, status: status() };
      });
      if (m !== 'POST' && action !== '/preview') return false;

      switch (action) {
        case '/write': return reply(async () => {
          const b = await readBody(req);
          const a = cur ? draftOnly(cur) : blankAd(id);
          if (b.copy) a.copy = sanitizeCopy(b.copy, a.copy);
          if (b.plan) a.plan = sanitizePlan(b.plan, a.plan);
          const brief = clean(b.brief), instruction = clean(b.instruction);
          if (!a.copy.primaryText) { if (!brief && !a.brief) throw fail('Describe the ad you want first.'); if (brief) a.brief = brief; }
          else if (!instruction) throw fail('Type what you\'d like changed.');
          putAd(a); // keep Doug's typing even if Claude fails
          await write(a, { brief: a.brief, instruction: a.copy.primaryText ? instruction : '' });
          putAd(a); return done(a);
        });
        case '/image': return reply(async () => {
          const a = draftOnly(need()), b = await readBody(req);
          if (b.remove) removeImage(a);
          else if (b.useLogo) setImage(a, fs.readFileSync(path.join(ROOT, 'Nashoba Power Wash Logo.png')), 'image/png');
          else {
            const mt = /^data:(image\/(?:jpeg|png));base64,([A-Za-z0-9+/=]+)$/.exec(String(b.dataUrl || ''));
            if (!mt) throw fail('Use a JPG or PNG photo.');
            setImage(a, Buffer.from(mt[2], 'base64'), mt[1]);
          }
          putAd(a); return done(a);
        });
        case '/publish': return reply(async () => done(await publish(need())));
        case '/launch': return reply(async () => done(await launch(need())));
        case '/pause': return reply(async () => done(await pause(need(), false)));
        case '/end': return reply(async () => done(await pause(need(), true)));
        case '/refresh': return reply(async () => done(await refresh(need())));
        case '/preview': return reply(async () => ({ url: await previewUrl(need()) }));
        case '/duplicate': return reply(async () => {
          const src = need(), a = blankAd(newId());
          Object.assign(a, { title: `${src.title} (copy)`, brief: src.brief, copy: { ...src.copy }, plan: { ...src.plan }, advice: src.advice, history: [] });
          const file = imagePath(src);
          if (file && fs.existsSync(file)) setImage(a, fs.readFileSync(file), src.image.mime);
          putAd(a); return done(a);
        });
      }
      return false;
    },
  };
}
