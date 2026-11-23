// Nashoba Power Wash dashboard: local backend.
// Zero dependencies: Node's built-in http, sqlite, and fetch.
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createLeads } from './leads.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try { process.loadEnvFile(path.join(ROOT, '.env')); } catch { /* .env optional */ }

const PORT = Number(process.env.PORT) || 3000;
const HOST = '127.0.0.1'; // only reachable from this computer
const BASE_URL = `http://${HOST}:${PORT}`;
const REDIRECT_URI = `${BASE_URL}/auth/google/callback`;
const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_ADS_DEVELOPER_TOKEN } = process.env;
const GOOGLE_ADS_API_VERSION = process.env.GOOGLE_ADS_API_VERSION || 'v26';
// Read-only marketing access; added on top of Calendar + Gmail.
const MKT_SCOPES = {
  ads: 'https://www.googleapis.com/auth/adwords',
  ga4: 'https://www.googleapis.com/auth/analytics.readonly',
  gbp: 'https://www.googleapis.com/auth/business.manage',
};
const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/gmail.send',
  ...Object.values(MKT_SCOPES),
].join(' ');

/* ---------- database ---------- */
const DATA_DIR = path.join(ROOT, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'nashoba.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, data TEXT NOT NULL, event_id TEXT, updated TEXT);
  CREATE TABLE IF NOT EXISTS expenses (id TEXT PRIMARY KEY, data TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS campaigns (id TEXT PRIMARY KEY, data TEXT NOT NULL);
`);
const SETTING_KEYS = ['todos', 'links', 'notes', 'goal', 'day', 'mkt', 'leads', 'hangers'];

const kvGet = (k) => { const r = db.prepare('SELECT value FROM kv WHERE key=?').get(k); return r ? JSON.parse(r.value) : undefined; };
const kvSet = (k, v) => db.prepare('INSERT INTO kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, JSON.stringify(v));
const kvDel = (k) => db.prepare('DELETE FROM kv WHERE key=?').run(k);

const getJob = (id) => { const r = db.prepare('SELECT data,event_id FROM jobs WHERE id=?').get(id); return r ? { ...JSON.parse(r.data), id, eventId: r.event_id || null } : null; };
const allJobs = () => db.prepare('SELECT id,data,event_id FROM jobs').all().map(r => ({ ...JSON.parse(r.data), id: r.id, eventId: r.event_id || null }));
const allExpenses = () => db.prepare('SELECT id,data FROM expenses').all().map(r => ({ ...JSON.parse(r.data), id: r.id }));
const getCampaign = (id) => { const r = db.prepare('SELECT data FROM campaigns WHERE id=?').get(id); return r ? { ...JSON.parse(r.data), id } : null; };
const allCampaigns = () => db.prepare('SELECT id,data FROM campaigns').all().map(r => ({ ...JSON.parse(r.data), id: r.id }));
const saveCampaign = (id, data) => { const { id: _, ...d } = data; db.prepare('INSERT OR REPLACE INTO campaigns(id,data) VALUES(?,?)').run(id, JSON.stringify(d)); };
const settings = () => Object.fromEntries(SETTING_KEYS.map(k => [k, kvGet('s:' + k)]).filter(([, v]) => v !== undefined));

function upsertJob(id, data) {
  const { eventId, ...clean } = data; // never trust client for event id
  clean.id = id;
  db.prepare(`INSERT INTO jobs(id,data,updated) VALUES(?,?,?)
    ON CONFLICT(id) DO UPDATE SET data=excluded.data, updated=excluded.updated`).run(id, JSON.stringify(clean), new Date().toISOString());
}

/* ---------- Google ---------- */
const googleConfigured = () => Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET);
const googleConnected = () => Boolean(kvGet('google')?.refresh_token);
const oauthStates = new Set();

async function tokenRequest(params) {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET, ...params }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error_description || j.error || `Token request failed (${r.status})`); e.code = j.error; throw e; }
  return j;
}

async function accessToken() {
  const t = kvGet('google');
  if (!t?.refresh_token) throw new Error('Google is not connected');
  if (t.access_token && t.expires_at > Date.now() + 60_000) return t.access_token;
  try {
    const j = await tokenRequest({ refresh_token: t.refresh_token, grant_type: 'refresh_token' });
    kvSet('google', { ...t, access_token: j.access_token, expires_at: Date.now() + j.expires_in * 1000 });
    return j.access_token;
  } catch (e) {
    if (e.code === 'invalid_grant') { kvDel('google'); throw new Error('Google connection expired. Click "Connect Google" again.'); }
    throw e;
  }
}

async function gapi(url, opts = {}) {
  const tok = await accessToken();
  const r = await fetch(url, { ...opts, headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json', ...opts.headers } });
  if (r.status === 204) return null;
  const j = await r.json().catch(() => null);
  if (!r.ok) {
    const detail = j?.error?.details?.find(d => d.errors)?.errors?.[0]?.message; // Google Ads puts the useful message here
    const e = new Error(detail || j?.error?.message || `Google API error ${r.status}`); e.status = r.status; throw e;
  }
  return j;
}

const CAL = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
const addDays = (iso, n) => { const [y, m, d] = iso.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
const jobDays = (svc) => (svc || '').startsWith('Patio Restoration') ? 3 : 1; // patio needs drying time

async function deleteEvent(eventId) {
  try { await gapi(`${CAL}/${encodeURIComponent(eventId)}`, { method: 'DELETE' }); }
  catch (e) { if (e.status !== 404 && e.status !== 410) throw e; }
}

// Keeps one Google Calendar all-day event per Booked/Completed job with a date.
async function syncCalendar(id) {
  if (!googleConnected()) return { skipped: true };
  const job = getJob(id);
  if (!job) return { skipped: true };
  const wanted = ['Booked', 'Completed'].includes(job.status) && /^\d{4}-\d{2}-\d{2}$/.test(job.date || '');
  if (!wanted) {
    if (job.eventId) { await deleteEvent(job.eventId); db.prepare('UPDATE jobs SET event_id=NULL WHERE id=?').run(id); return { removed: true }; }
    return { skipped: true };
  }
  const body = {
    summary: `${job.status === 'Completed' ? '✅ ' : '💧 '}${job.service} – ${job.name}`,
    location: job.town ? `${job.town}, MA` : undefined,
    description: [
      job.phone && `Phone: ${job.phone}`, job.email && `Email: ${job.email}`,
      job.quote && `Quote: $${job.quote}`, job.hours && `Est. hours: ${job.hours}`,
      job.scope && `\nAgreed scope:\n${job.scope}`, job.notes && `\nNotes:\n${job.notes}`,
      '\n(Synced from Nashoba Power Wash dashboard)',
    ].filter(Boolean).join('\n'),
    start: { date: job.date }, end: { date: addDays(job.date, jobDays(job.service)) },
    status: 'confirmed',
  };
  let ev = null;
  if (job.eventId) {
    try { ev = await gapi(`${CAL}/${encodeURIComponent(job.eventId)}`, { method: 'PUT', body: JSON.stringify(body) }); }
    catch (e) { if (e.status !== 404 && e.status !== 410) throw e; }
  }
  if (!ev) ev = await gapi(CAL, { method: 'POST', body: JSON.stringify(body) });
  db.prepare('UPDATE jobs SET event_id=? WHERE id=?').run(ev.id, id);
  return { link: ev.htmlLink };
}

const headerSafe = (s) => String(s).replace(/[\r\n]+/g, ' ').trim();
const encodeHeader = (s) => /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s).toString('base64')}?=`;
async function sendEmail({ to, subject, body }) {
  to = headerSafe(to || '');
  if (!/^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/.test(to)) throw new Error('This customer has no valid email address.');
  const raw = [
    `To: ${to}`, `Subject: ${encodeHeader(headerSafe(subject || 'Nashoba Power Wash'))}`,
    'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '',
    Buffer.from(String(body || '')).toString('base64'),
  ].join('\r\n');
  await gapi('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', { method: 'POST', body: JSON.stringify({ raw: Buffer.from(raw).toString('base64url') }) });
}

/* ---------- Marketing: Google Ads, Analytics (GA4), Business Profile, email campaigns ---------- */
const mkt = () => kvGet('s:mkt') || {};
const hasScope = (s) => (kvGet('google')?.scope || '').split(' ').includes(s);
const isoDaysAgo = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
const digits = (s) => String(s || '').replace(/\D/g, '');
const EMAIL_RE = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Why a source can't be queried yet (null = ready).
function gate(kind) {
  if (!googleConfigured() || !googleConnected()) return { state: 'disconnected' };
  if (!hasScope(MKT_SCOPES[kind])) return { state: 'scope' };
  const c = mkt();
  if (kind === 'ads' && !GOOGLE_ADS_DEVELOPER_TOKEN) return { setup: 'Add GOOGLE_ADS_DEVELOPER_TOKEN to the .env file (see README), then restart.' };
  if (kind === 'ads' && !digits(c.adsCustomerId)) return { setup: 'Choose your Google Ads account in Google setup.' };
  if (kind === 'ga4' && !digits(c.ga4Property)) return { setup: 'Choose your Google Analytics property in Google setup.' };
  if (kind === 'gbp' && !/^locations\/\d+$/.test(c.gbpLocation || '')) return { setup: 'Choose your Business Profile location in Google setup.' };
  return null;
}

/* Google Ads */
const ADS = `https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}`;
function adsReq(pathPart, opts = {}, loginId = digits(mkt().adsLoginCustomerId)) {
  const headers = { 'developer-token': GOOGLE_ADS_DEVELOPER_TOKEN };
  if (loginId) headers['login-customer-id'] = loginId;
  return gapi(ADS + pathPart, { ...opts, headers });
}
async function adsQuery(query, cid = digits(mkt().adsCustomerId), loginId) {
  const rows = []; let pageToken;
  do {
    const j = await adsReq(`/customers/${cid}/googleAds:search`, { method: 'POST', body: JSON.stringify({ query, pageToken }) }, loginId);
    rows.push(...(j.results || [])); pageToken = j.nextPageToken;
  } while (pageToken);
  return rows;
}
async function adsStats(days) {
  const g = gate('ads'); if (g) return g;
  const rows = await adsQuery(`SELECT campaign.id, campaign.name, campaign.status, metrics.cost_micros, metrics.clicks,
    metrics.impressions, metrics.conversions FROM campaign
    WHERE segments.date BETWEEN '${isoDaysAgo(days)}' AND '${isoDaysAgo(0)}' AND campaign.status != 'REMOVED'`);
  const campaigns = rows.map(r => ({
    id: String(r.campaign.id), name: r.campaign.name, status: r.campaign.status,
    cost: Number(r.metrics?.costMicros || 0) / 1e6, clicks: Number(r.metrics?.clicks || 0),
    impressions: Number(r.metrics?.impressions || 0), conversions: Number(r.metrics?.conversions || 0),
  }));
  const sum = (k) => campaigns.reduce((a, c) => a + c[k], 0);
  return { totals: { cost: sum('cost'), clicks: sum('clicks'), impressions: sum('impressions'), conversions: sum('conversions') }, campaigns };
}
async function adsCampaignCost(adsCampaignId, start, end) {
  const g = gate('ads'); if (g) throw new Error(g.setup || 'Connect Google with Ads access first.');
  const rows = await adsQuery(`SELECT metrics.cost_micros FROM campaign
    WHERE campaign.id = ${digits(adsCampaignId)} AND segments.date BETWEEN '${start}' AND '${end}'`);
  return rows.reduce((a, r) => a + Number(r.metrics?.costMicros || 0), 0) / 1e6;
}

/* Google Analytics 4 */
async function ga4Stats(days) {
  const g = gate('ga4'); if (g) return g;
  const url = `https://analyticsdata.googleapis.com/v1beta/properties/${digits(mkt().ga4Property)}:runReport`;
  const dateRanges = [{ startDate: `${days}daysAgo`, endDate: 'today' }];
  const run = (body) => gapi(url, { method: 'POST', body: JSON.stringify({ dateRanges, ...body }) });
  const [tot, ch] = await Promise.all([
    run({ metrics: ['activeUsers', 'sessions', 'screenPageViews', 'keyEvents'].map(name => ({ name })) }),
    run({ dimensions: [{ name: 'sessionDefaultChannelGroup' }], metrics: [{ name: 'sessions' }], orderBys: [{ metric: { metricName: 'sessions' }, desc: true }], limit: 8 }),
  ]);
  const v = tot.rows?.[0]?.metricValues?.map(m => Number(m.value)) || [0, 0, 0, 0];
  return {
    totals: { users: v[0], sessions: v[1], pageViews: v[2], keyEvents: v[3] },
    channels: (ch.rows || []).map(r => ({ name: r.dimensionValues[0].value, sessions: Number(r.metricValues[0].value) })),
  };
}

/* Google Business Profile */
const GBP_METRICS = ['BUSINESS_IMPRESSIONS_DESKTOP_SEARCH', 'BUSINESS_IMPRESSIONS_MOBILE_SEARCH', 'BUSINESS_IMPRESSIONS_DESKTOP_MAPS',
  'BUSINESS_IMPRESSIONS_MOBILE_MAPS', 'CALL_CLICKS', 'WEBSITE_CLICKS', 'BUSINESS_DIRECTION_REQUESTS', 'BUSINESS_CONVERSATIONS'];
async function gbpStats(days) {
  const g = gate('gbp'); if (g) return g;
  const q = new URLSearchParams();
  GBP_METRICS.forEach(m => q.append('dailyMetrics', m));
  const [s, e] = [new Date(Date.now() - days * 864e5), new Date()];
  for (const [k, d] of [['startDate', s], ['endDate', e]]) {
    q.set(`dailyRange.${k}.year`, d.getUTCFullYear()); q.set(`dailyRange.${k}.month`, d.getUTCMonth() + 1); q.set(`dailyRange.${k}.day`, d.getUTCDate());
  }
  const j = await gapi(`https://businessprofileperformance.googleapis.com/v1/${mkt().gbpLocation}:fetchMultiDailyMetricsTimeSeries?${q}`);
  const t = {};
  for (const grp of j.multiDailyMetricTimeSeries || []) for (const s2 of grp.dailyMetricTimeSeries || [])
    t[s2.dailyMetric] = (s2.timeSeries?.datedValues || []).reduce((a, x) => a + Number(x.value || 0), 0);
  const n = (k) => t[k] || 0;
  return { totals: {
    searchViews: n('BUSINESS_IMPRESSIONS_DESKTOP_SEARCH') + n('BUSINESS_IMPRESSIONS_MOBILE_SEARCH'),
    mapsViews: n('BUSINESS_IMPRESSIONS_DESKTOP_MAPS') + n('BUSINESS_IMPRESSIONS_MOBILE_MAPS'),
    calls: n('CALL_CLICKS'), websiteClicks: n('WEBSITE_CLICKS'), directions: n('BUSINESS_DIRECTION_REQUESTS'), messages: n('BUSINESS_CONVERSATIONS'),
  } };
}

const safe = (p) => p.catch(e => ({ error: e.message }));
const statsCache = new Map(); // avoid re-querying Google every time the tab is opened
async function marketingStats(days, refresh) {
  const key = JSON.stringify([days, mkt(), kvGet('google')?.scope]);
  const hit = statsCache.get(key);
  if (!refresh && hit && hit.at > Date.now() - 10 * 60_000) return hit.data;
  const [ads, ga4, gbp] = await Promise.all([safe(adsStats(days)), safe(ga4Stats(days)), safe(gbpStats(days))]);
  const data = { ads, ga4, gbp, fetchedAt: new Date().toISOString() };
  statsCache.clear(); statsCache.set(key, { at: Date.now(), data });
  return data;
}

// Lists the accounts this Google login can see, so the setup screen can offer them.
async function discover() {
  const out = { ads: [], ga4: [], gbp: [], errors: {} };
  await Promise.all([
    (async () => {
      const g = gate('ga4'); if (g?.state) return;
      const j = await gapi('https://analyticsadmin.googleapis.com/v1beta/accountSummaries?pageSize=200');
      for (const a of j.accountSummaries || []) for (const p of a.propertySummaries || [])
        out.ga4.push({ id: digits(p.property), name: `${p.displayName} (${a.displayName})` });
    })().catch(e => { out.errors.ga4 = e.message; }),
    (async () => {
      const g = gate('gbp'); if (g?.state) return;
      const j = await gapi('https://mybusinessaccountmanagement.googleapis.com/v1/accounts');
      for (const a of j.accounts || []) {
        const l = await gapi(`https://mybusinessbusinessinformation.googleapis.com/v1/${a.name}/locations?readMask=name,title&pageSize=100`);
        for (const loc of l.locations || []) out.gbp.push({ id: loc.name, name: loc.title });
      }
    })().catch(e => { out.errors.gbp = e.message; }),
    (async () => {
      const g = gate('ads'); if (g?.state) return;
      if (!GOOGLE_ADS_DEVELOPER_TOKEN) { out.errors.ads = 'GOOGLE_ADS_DEVELOPER_TOKEN is not set in .env'; return; }
      const j = await adsReq('/customers:listAccessibleCustomers', {}, '');
      for (const rn of j.resourceNames || []) {
        const id = digits(rn); let name = id;
        try {
          const c = (await adsQuery('SELECT customer.descriptive_name, customer.manager FROM customer LIMIT 1', id, id))[0]?.customer;
          if (c) name = `${c.descriptiveName || 'Unnamed'}${c.manager ? ' (manager)' : ''}`;
        } catch { /* the name is only a nicety */ }
        out.ads.push({ id, name });
      }
    })().catch(e => { out.errors.ads = e.message; }),
  ]);
  return out;
}

/* Email campaigns (sent from your Gmail, one message per person) */
function audience({ statuses = [], services = [] } = {}) {
  const st = new Set(statuses), sv = new Set(services), jobs = allJobs();
  const optedOut = new Set(jobs.filter(j => j.noMarketing).map(j => (j.email || '').trim().toLowerCase()).filter(Boolean));
  const seen = new Set(), recipients = [];
  for (const j of jobs) {
    if (st.size && !st.has(j.status)) continue;
    if (sv.size && !sv.has(j.service)) continue;
    const email = (j.email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email) || optedOut.has(email) || seen.has(email)) continue;
    seen.add(email); recipients.push({ name: j.name, email, town: j.town || '', service: j.service || '' });
  }
  return { recipients, optedOut: optedOut.size };
}
const firstName = (n) => String(n || '').trim().split(/\s+/)[0] || 'there';
function personalize(text, r) {
  return String(text || '').replace(/\{(first|name|town|service)\}/g, (_, k) => k === 'first' ? firstName(r.name) : (r[k] || ''));
}
function emailFooter() {
  return `\n\n--\nNashoba Power Wash\n${mkt().mailingAddress.trim()}\nDon't want these emails? Just reply "unsubscribe" and I'll take you off the list.`;
}

async function sendCampaign(id, testTo) {
  const c = getCampaign(id);
  if (!c) throw Object.assign(new Error('Save the campaign first.'), { status: 404 });
  const em = c.email || {};
  if (!String(em.subject || '').trim() || !String(em.body || '').trim()) throw new Error('Add a subject and message first.');
  if (!String(mkt().mailingAddress || '').trim()) throw new Error('Add your mailing address in Google setup first. The law (CAN-SPAM) requires it on marketing emails.');
  if (!googleConnected()) throw new Error('Connect Google first.');
  if (testTo) {
    const sample = audience(em).recipients[0] || { name: 'Doug', town: 'Westford', service: 'House Wash' };
    await sendEmail({ to: testTo, subject: '[TEST] ' + personalize(em.subject, sample), body: personalize(em.body, sample) + emailFooter() });
    return { test: true, to: testTo };
  }
  const already = new Set((c.sent || []).filter(s => s.ok).map(s => s.email));
  const todo = audience(em).recipients.filter(r => !already.has(r.email));
  const result = { sent: 0, failed: 0, skipped: already.size };
  for (const r of todo) {
    const entry = { email: r.email, name: r.name, at: new Date().toISOString() };
    try { await sendEmail({ to: r.email, subject: personalize(em.subject, r), body: personalize(em.body, r) + emailFooter() }); entry.ok = true; result.sent++; }
    catch (e) { entry.ok = false; entry.error = e.message; result.failed++; }
    const cur = getCampaign(id); // save after each email so a crash never causes double-sends
    cur.sent = [...(cur.sent || []).filter(s => s.email !== r.email), entry];
    if (!cur.sentAt) cur.sentAt = entry.at;
    saveCampaign(id, cur);
    await sleep(300);
  }
  return result;
}

/* ---------- Lead engine (see leads.js) ---------- */
const leads = createLeads({ db, ROOT, kvGet, allJobs, getJob, upsertJob, sendEmail, googleConnected, mkt, EMAIL_RE });

/* ---------- HTTP helpers ---------- */
const send = (res, status, data, headers = {}) => {
  const body = typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data);
  res.writeHead(status, { 'content-type': typeof data === 'object' && !Buffer.isBuffer(data) ? 'application/json' : 'text/html; charset=utf-8', ...headers });
  res.end(body);
};
const readBody = (req) => new Promise((resolve, reject) => {
  let size = 0; const chunks = [];
  req.on('data', c => { size += c.length; if (size > 10 * 1024 * 1024) { reject(new Error('Request too large')); req.destroy(); } else chunks.push(c); });
  req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}); } catch { reject(new Error('Invalid JSON')); } });
  req.on('error', reject);
});
const validId = (id) => /^[A-Za-z0-9_-]{1,64}$/.test(id);
const page = (title, msg) => `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:system-ui;padding:40px;max-width:560px;margin:auto"><h2>${title}</h2><p>${msg}</p><p><a href="/">← Back to dashboard</a></p>`;
const escHtml = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const STATIC = {
  '/': [path.join(ROOT, 'dashboard', 'index.html'), 'text/html; charset=utf-8'],
  '/index.html': [path.join(ROOT, 'dashboard', 'index.html'), 'text/html; charset=utf-8'],
  '/logo.png': [path.join(ROOT, 'Nashoba Power Wash Logo.png'), 'image/png'],
  '/favicon.ico': [path.join(ROOT, 'dashboard', 'nashoba.ico'), 'image/x-icon'],
};

/* App mode: started by the desktop launcher. The open dashboard window pings the
   server; once no window has pinged for a while, the server shuts itself down. */
const APP_MODE = process.argv.includes('--app');
const IDLE_LIMIT_MS = 3 * 60_000; // background windows may only ping once a minute
let lastPing = Date.now() + 60_000; // grace period while the window opens
if (APP_MODE) setInterval(() => {
  if (Date.now() - lastPing > IDLE_LIMIT_MS) { console.log('Dashboard window closed, shutting down.'); process.exit(0); }
}, 15_000).unref();

/* ---------- routes ---------- */
async function handle(req, res) {
  // Block DNS-rebinding: only accept requests addressed to this machine.
  const host = (req.headers.host || '').toLowerCase();
  if (host !== `127.0.0.1:${PORT}` && host !== `localhost:${PORT}`) return send(res, 403, { error: 'Forbidden host' });

  const url = new URL(req.url, BASE_URL);
  const p = url.pathname;
  const m = req.method;

  // Writes require a custom header, which other websites can't send cross-origin (CSRF guard).
  if (m !== 'GET' && req.headers['x-npw'] !== '1') return send(res, 403, { error: 'Missing app header' });

  if (m === 'GET' && STATIC[p]) {
    const [file, type] = STATIC[p];
    return fs.readFile(file, (err, buf) => err ? send(res, 404, 'Not found') : send(res, 200, buf, { 'content-type': type, 'cache-control': 'no-store' }));
  }

  if (p === '/api/ping') { lastPing = Math.max(lastPing, Date.now()); return send(res, 200, { ok: true }); }
  if (await leads.route(m, p, url, req, res, { send, readBody })) return;

  /* Google OAuth */
  if (m === 'GET' && p === '/auth/google') {
    if (!googleConfigured()) return send(res, 400, page('Google not set up yet', 'Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to the <code>.env</code> file (see README), then restart the server.'));
    const state = crypto.randomBytes(16).toString('hex'); oauthStates.add(state);
    const q = new URLSearchParams({ client_id: GOOGLE_CLIENT_ID, redirect_uri: REDIRECT_URI, response_type: 'code', scope: GOOGLE_SCOPES, access_type: 'offline', prompt: 'consent', state });
    res.writeHead(302, { location: `https://accounts.google.com/o/oauth2/v2/auth?${q}` }); return res.end();
  }
  if (m === 'GET' && p === '/auth/google/callback') {
    const state = url.searchParams.get('state');
    if (!state || !oauthStates.delete(state)) return send(res, 400, page('Connection failed', 'Invalid or expired sign-in attempt. Try again.'));
    if (url.searchParams.get('error')) return send(res, 400, page('Connection cancelled', escHtml(url.searchParams.get('error'))));
    try {
      const j = await tokenRequest({ code: url.searchParams.get('code'), redirect_uri: REDIRECT_URI, grant_type: 'authorization_code' });
      if (!j.refresh_token) throw new Error('Google did not return a refresh token. Remove the app at myaccount.google.com/permissions and try again.');
      kvSet('google', { refresh_token: j.refresh_token, access_token: j.access_token, expires_at: Date.now() + j.expires_in * 1000, scope: j.scope });
      res.writeHead(302, { location: '/?google=connected' }); return res.end();
    } catch (e) { return send(res, 500, page('Connection failed', escHtml(e.message))); }
  }
  if (m === 'POST' && p === '/api/google/disconnect') {
    const t = kvGet('google');
    if (t?.refresh_token) await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(t.refresh_token)}`, { method: 'POST' }).catch(() => {});
    kvDel('google'); return send(res, 200, { ok: true });
  }
  if (m === 'POST' && p === '/api/google/resync') {
    const results = { synced: 0, errors: [] };
    for (const j of allJobs()) {
      try { const r = await syncCalendar(j.id); if (r.link || r.removed) results.synced++; }
      catch (e) { results.errors.push(`${j.name}: ${e.message}`); }
    }
    return send(res, 200, results);
  }

  /* state */
  if (m === 'GET' && p === '/api/state') {
    return send(res, 200, {
      jobs: allJobs(), expenses: allExpenses(), campaigns: allCampaigns(), settings: settings(),
      google: { configured: googleConfigured(), connected: googleConnected(), marketing: Object.values(MKT_SCOPES).every(hasScope), adsToken: Boolean(GOOGLE_ADS_DEVELOPER_TOKEN) },
    });
  }
  if (m === 'GET' && p === '/api/export') {
    const data = { exported: new Date().toISOString(), jobs: allJobs().map(({ eventId, ...j }) => j), expenses: allExpenses(), campaigns: allCampaigns(), ...leads.exportData(), ...settings() };
    return send(res, 200, data, { 'content-disposition': `attachment; filename="nashoba-dashboard-backup-${new Date().toISOString().slice(0, 10)}.json"` });
  }
  if (m === 'POST' && p === '/api/import') {
    const d = await readBody(req);
    if (!Array.isArray(d.jobs) || !Array.isArray(d.expenses)) return send(res, 400, { error: 'Not a valid backup file' });
    db.exec('BEGIN');
    try {
      for (const j of d.jobs) { const id = validId(j.id) ? j.id : crypto.randomUUID(); upsertJob(id, j); }
      for (const e of d.expenses) { const id = validId(e.id) ? e.id : crypto.randomUUID(); const { id: _, ...rest } = e; db.prepare('INSERT OR REPLACE INTO expenses(id,data) VALUES(?,?)').run(id, JSON.stringify(rest)); }
      for (const c of Array.isArray(d.campaigns) ? d.campaigns : []) saveCampaign(validId(c.id) ? c.id : crypto.randomUUID(), c);
      leads.importBackup(d);
      for (const k of SETTING_KEYS) if (d[k] !== undefined) kvSet('s:' + k, d[k]);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    return send(res, 200, { ok: true, jobs: d.jobs.length, expenses: d.expenses.length });
  }

  /* settings */
  let r;
  if (m === 'PUT' && (r = p.match(/^\/api\/settings\/(\w+)$/))) {
    if (!SETTING_KEYS.includes(r[1])) return send(res, 404, { error: 'Unknown setting' });
    const { value } = await readBody(req); kvSet('s:' + r[1], value); return send(res, 200, { ok: true });
  }

  /* jobs */
  if ((r = p.match(/^\/api\/jobs\/([^/]+)$/))) {
    const id = r[1]; if (!validId(id)) return send(res, 400, { error: 'Bad id' });
    if (m === 'PUT') {
      const data = await readBody(req);
      if (!String(data.name || '').trim()) return send(res, 400, { error: 'Client name is required' });
      const before = getJob(id);
      if (before?.pastImport) { data.pastImport = true; data.year = before.year; } // server-owned flags the form doesn't carry
      upsertJob(id, data);
      try { leads.onJobSaved(before, getJob(id)); } catch (e) { console.error('Lead engine:', e.message); }
      let calendar;
      try { calendar = await syncCalendar(id); } catch (e) { calendar = { error: e.message }; }
      return send(res, 200, { job: getJob(id), calendar });
    }
    if (m === 'DELETE') {
      const job = getJob(id);
      let calendar = {};
      if (job?.eventId && googleConnected()) { try { await deleteEvent(job.eventId); } catch (e) { calendar.error = e.message; } }
      db.prepare('DELETE FROM jobs WHERE id=?').run(id);
      leads.onJobDeleted(id);
      return send(res, 200, { ok: true, calendar });
    }
  }
  if (m === 'POST' && (r = p.match(/^\/api\/jobs\/([^/]+)\/email$/))) {
    const job = getJob(r[1]); if (!job) return send(res, 404, { error: 'Job not found' });
    const { subject, body } = await readBody(req);
    await sendEmail({ to: job.email, subject, body });
    return send(res, 200, { ok: true, to: job.email });
  }

  /* marketing */
  if (m === 'GET' && p === '/api/marketing/stats') {
    const days = [7, 28, 90].includes(Number(url.searchParams.get('days'))) ? Number(url.searchParams.get('days')) : 28;
    return send(res, 200, await marketingStats(days, url.searchParams.get('refresh') === '1'));
  }
  if (m === 'GET' && p === '/api/marketing/discover') return send(res, 200, await discover());
  if (m === 'POST' && p === '/api/marketing/audience') return send(res, 200, audience(await readBody(req)));

  if ((r = p.match(/^\/api\/campaigns\/([^/]+)(\/send|\/ads-spend)?$/))) {
    const id = r[1]; if (!validId(id)) return send(res, 400, { error: 'Bad id' });
    if (m === 'PUT' && !r[2]) {
      const { sent, sentAt, ...d } = await readBody(req); // the send log is server-owned
      if (!String(d.name || '').trim()) return send(res, 400, { error: 'Campaign name is required' });
      const old = getCampaign(id);
      saveCampaign(id, { ...d, sent: old?.sent || [], sentAt: old?.sentAt || null });
      return send(res, 200, { campaign: getCampaign(id) });
    }
    if (m === 'DELETE' && !r[2]) { db.prepare('DELETE FROM campaigns WHERE id=?').run(id); return send(res, 200, { ok: true }); }
    if (m === 'POST' && r[2] === '/send') {
      const { test } = await readBody(req);
      if (test !== undefined && !EMAIL_RE.test(String(test).trim())) return send(res, 400, { error: 'Enter a valid test email address.' });
      try { return send(res, 200, { ...(await sendCampaign(id, test && String(test).trim())), campaign: getCampaign(id) }); }
      catch (e) { return send(res, e.status || 400, { error: e.message }); }
    }
    if (m === 'POST' && r[2] === '/ads-spend') {
      const c = getCampaign(id); if (!c) return send(res, 404, { error: 'Save the campaign first.' });
      if (!digits(c.adsCampaignId)) return send(res, 400, { error: 'Pick the Google Ads campaign to link first.' });
      const start = /^\d{4}-\d{2}-\d{2}$/.test(c.start || '') ? c.start : isoDaysAgo(365);
      const end = /^\d{4}-\d{2}-\d{2}$/.test(c.end || '') && c.end < isoDaysAgo(0) ? c.end : isoDaysAgo(0);
      try { c.spend = Math.round(await adsCampaignCost(c.adsCampaignId, start, end) * 100) / 100; }
      catch (e) { return send(res, 400, { error: e.message }); }
      c.spendSyncedAt = new Date().toISOString(); saveCampaign(id, c);
      return send(res, 200, { campaign: getCampaign(id), start, end });
    }
  }

  /* expenses */
  if ((r = p.match(/^\/api\/expenses\/([^/]+)$/))) {
    const id = r[1]; if (!validId(id)) return send(res, 400, { error: 'Bad id' });
    if (m === 'PUT') { const { id: _, ...d } = await readBody(req); db.prepare('INSERT OR REPLACE INTO expenses(id,data) VALUES(?,?)').run(id, JSON.stringify(d)); return send(res, 200, { ok: true }); }
    if (m === 'DELETE') { db.prepare('DELETE FROM expenses WHERE id=?').run(id); return send(res, 200, { ok: true }); }
  }

  send(res, 404, { error: 'Not found' });
}

http.createServer((req, res) => {
  handle(req, res).catch(e => { console.error(e); if (!res.headersSent) send(res, 500, { error: e.message }); });
}).listen(PORT, HOST, () => {
  console.log(`\n  Nashoba Power Wash dashboard → ${BASE_URL}\n`);
  console.log(`  Google: ${!googleConfigured() ? 'not set up (see README)' : googleConnected() ? 'connected' : 'ready to connect'}\n`);
});
