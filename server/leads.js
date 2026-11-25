// Lead engine: realtor outreach, past-customer re-booking + referrals, review requests, door hangers.
// Nothing is ever sent automatically. Every message is a draft until Doug approves it.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const REALTOR_STAGES = ['Queued', 'Sent', 'Follow-up 1', 'Follow-up 2', 'Replied', 'Partner', 'Not interested'];
const STOPPED = new Set(['Replied', 'Partner', 'Not interested']);
export const LEAD_DEFAULTS = {
  phone: '', website: '', reviewLink: '', photosLink: '',
  weeklyTarget: 20, fu1Days: 5, fu2Days: 12, referralCredit: 50,
};

export function createLeads({ db, ROOT, kvGet, allJobs, getJob, upsertJob, sendEmail, googleConnected, mkt, EMAIL_RE }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS realtors (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS drafts (id TEXT PRIMARY KEY, data TEXT NOT NULL);
  `);
  const INBOX = path.join(ROOT, 'data', 'inbox');
  fs.mkdirSync(path.join(INBOX, 'imported'), { recursive: true });

  const rows = (t) => db.prepare(`SELECT id,data FROM ${t}`).all().map(r => ({ ...JSON.parse(r.data), id: r.id }));
  const getRow = (t, id) => { const r = db.prepare(`SELECT data FROM ${t} WHERE id=?`).get(id); return r ? { ...JSON.parse(r.data), id } : null; };
  const putRow = (t, id, d) => { const { id: _, ...rest } = d; db.prepare(`INSERT OR REPLACE INTO ${t}(id,data) VALUES(?,?)`).run(id, JSON.stringify(rest)); };
  const delRow = (t, id) => db.prepare(`DELETE FROM ${t} WHERE id=?`).run(id);
  const allRealtors = () => rows('realtors');
  const allDrafts = () => rows('drafts');
  const newId = () => crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  const now = () => new Date().toISOString();
  const cfg = () => ({ ...LEAD_DEFAULTS, ...(kvGet('s:leads') || {}) });
  const first = (n) => String(n || '').trim().split(/\s+/)[0] || 'there';
  const clean = (s, max = 400) => String(s ?? '').trim().slice(0, max);
  const lc = (s) => String(s || '').trim().toLowerCase();

  /* ---------- message templates ---------- */
  function signature() {
    const c = cfg();
    return ['Doug Caggiano', 'Nashoba Power Wash', c.phone, c.website].filter(Boolean).join('\n');
  }
  // CAN-SPAM: commercial email needs a physical address and a way to opt out.
  function footer() {
    const addr = String(mkt().mailingAddress || '').trim() || '[ADD YOUR MAILING ADDRESS IN MARKETING > GOOGLE SETUP]';
    return `\n\n--\nNashoba Power Wash · ${addr}\nIf you'd rather not hear from me, just reply "no thanks" and I won't email again.`;
  }
  const svcShort = (s) => String(s || 'project').replace(/\s*\(.*\)/, '').toLowerCase();

  const TEMPLATES = {
    intro: (r) => {
      const c = cfg();
      return {
        subject: `Photo-ready exteriors for your ${r.town || 'upcoming'} listings`,
        body: `Hi ${first(r.name)},

${r.hook ? r.hook + '\n\n' : ''}I'm Doug, owner of Nashoba Power Wash in Westford. I help homes in ${r.town || 'the area'} and the surrounding towns look their best before listing photos and showings: house washes, paver patio restoration, composite decks, and fences.

What you can count on:
- Fast turnaround. I aim to be on site within a few days of your call (weather permitting).
- I do every job myself, so the person you talk to is the person who shows up.
- A clear written scope before I start, so there are no surprises for you or your seller.

Paver patio restoration (cleaning the mold out of the joints and re-sanding) is something most local washers don't offer, and it makes a big difference in photos.${c.photosLink ? `\n\nSome before/after photos: ${c.photosLink}` : ''}

If you have a listing coming up, I'd be glad to take a look and give a free quote. Just reply here${c.phone ? ` or call/text ${c.phone}` : ''}.

Thanks,
${signature()}`,
      };
    },
    fu1: (r) => ({
      subject: `Re: Photo-ready exteriors for your ${r.town || 'upcoming'} listings`,
      body: `Hi ${first(r.name)},

Just bumping this up in case it got buried. If you have a listing coming up this spring, I can usually get out within a few days to wash the house or clean up the patio before photos.

Happy to give a free quote any time.

${signature()}`,
    }),
    fu2: (r) => ({
      subject: `Re: Photo-ready exteriors for your ${r.town || 'upcoming'} listings`,
      body: `Hi ${first(r.name)},

Last note from me, I promise. If a seller ever needs a quick house wash or patio cleanup before listing, I'd love to be your go-to. Feel free to keep my number${cfg().phone ? ` (${cfg().phone})` : ''} handy.

Thanks for your time,
${signature()}`,
    }),
    rebook: (j) => {
      const c = cfg();
      return {
        subject: 'Book your spring power wash (past customers first)',
        body: `Hi ${first(j.name)},

Thanks again for having me out for your ${svcShort(j.service)}. I'm filling the Nashoba Power Wash schedule for spring and summer now, and past customers get first pick of dates.

If your siding, patio, deck, or fence could use a refresh after the winter, just reply and I'll put together a quote.

Know someone who could use a wash? For every friend you send my way who books, you get $${c.referralCredit} off your next job.

${signature()}`,
      };
    },
    review: (j) => {
      const c = cfg();
      return {
        subject: 'Thank you from Nashoba Power Wash',
        body: `Hi ${first(j.name)},

Thanks again for choosing Nashoba Power Wash! I really enjoyed working on your ${svcShort(j.service)}.

If you're happy with how it came out, a quick Google review would mean a lot to a small local business${c.reviewLink ? `:\n${c.reviewLink}` : '.'}

And if a friend or neighbor could use a wash, send them my way. You'll get $${c.referralCredit} off your next job when they book.

${signature()}`,
      };
    },
  };
  const COMMERCIAL = new Set(['intro', 'fu1', 'fu2', 'rebook']); // these get the CAN-SPAM footer

  function makeDraft({ kind, step, refId, name, to, phone, extra = {} }, src) {
    const { subject, body } = TEMPLATES[step](src);
    const d = { kind, step, refId, name, to: clean(to, 200), phone: clean(phone, 40), subject, body, status: 'pending', created: now(), ...extra };
    const id = newId(); putRow('drafts', id, d); return id;
  }
  const draftsFor = (refId, step) => allDrafts().filter(d => d.refId === refId && (!step || d.step === step));

  /* ---------- importing (from Claude commands via data/inbox, or pasted in the dashboard) ---------- */
  function importBatch(batch, label = 'dashboard') {
    const out = { realtors: 0, customers: 0, skipped: 0 };
    const knownR = new Set(allRealtors().map(r => lc(r.email)));
    for (const raw of Array.isArray(batch.realtors) ? batch.realtors : []) {
      const email = lc(raw.email);
      if (!String(raw.name || '').trim() || !EMAIL_RE.test(email) || knownR.has(email)) { out.skipped++; continue; }
      knownR.add(email);
      const r = {
        name: clean(raw.name, 120), email, phone: clean(raw.phone, 40), brokerage: clean(raw.brokerage, 120), town: clean(raw.town, 60),
        listing: clean(raw.listing, 200), hook: clean(raw.hook, 400), profileUrl: clean(raw.profileUrl || raw.source, 300),
        stage: 'Queued', added: now(), batch: label, log: [],
      };
      const id = newId(); putRow('realtors', id, r);
      makeDraft({ kind: 'realtor', step: 'intro', refId: id, name: r.name, to: r.email, phone: r.phone }, r);
      out.realtors++;
    }
    const jobs = allJobs();
    const knownC = new Set(jobs.flatMap(j => [lc(j.email), lc(j.name)]).filter(Boolean));
    for (const raw of Array.isArray(batch.customers) ? batch.customers : []) {
      const name = clean(raw.name, 120), email = lc(raw.email);
      if (!name || knownC.has(lc(name)) || (email && knownC.has(email))) { out.skipped++; continue; }
      knownC.add(lc(name)); if (email) knownC.add(email);
      upsertJob(newId(), {
        name, email: EMAIL_RE.test(email) ? email : '', phone: clean(raw.phone, 40), town: clean(raw.town, 60),
        service: clean(raw.service, 80) || 'Other', status: 'Completed', source: 'Repeat customer', pastImport: true,
        year: clean(raw.year, 4), paid: raw.paid ? String(raw.paid) : '', created: now().slice(0, 10),
        notes: `Past customer${raw.year ? ` (${clean(raw.year, 4)})` : ''}, added via ${label}.${raw.notes ? ' ' + clean(raw.notes) : ''}`,
      });
      out.customers++;
    }
    return out;
  }
  function ingestInbox() {
    const total = { realtors: 0, customers: 0, skipped: 0, files: [] };
    for (const f of fs.readdirSync(INBOX).filter(f => f.toLowerCase().endsWith('.json'))) {
      const full = path.join(INBOX, f);
      try {
        const r = importBatch(JSON.parse(fs.readFileSync(full, 'utf8')), f);
        for (const k of ['realtors', 'customers', 'skipped']) total[k] += r[k];
        total.files.push(f);
        fs.renameSync(full, path.join(INBOX, 'imported', `${Date.now()}-${f}`));
      } catch (e) { console.error(`Couldn't import ${f}: ${e.message}`); }
    }
    return total;
  }

  /* ---------- the sequence: create follow-up drafts when they come due ---------- */
  function tick() {
    const c = cfg(), t = Date.now(), drafts = allDrafts();
    for (const r of allRealtors()) {
      const mine = drafts.filter(d => d.refId === r.id);
      if (STOPPED.has(r.stage)) { // stop the sequence: drop anything still waiting
        for (const d of mine.filter(d => d.status === 'pending')) delRow('drafts', d.id);
        continue;
      }
      const introSent = mine.find(d => d.step === 'intro' && d.status === 'sent')?.sentAt;
      if (!introSent) continue;
      const days = (t - Date.parse(introSent)) / 864e5;
      const has = (s) => mine.some(d => d.step === s);
      if (r.stage === 'Sent' && days >= c.fu1Days && !has('fu1')) makeDraft({ kind: 'realtor', step: 'fu1', refId: r.id, name: r.name, to: r.email, phone: r.phone }, r);
      if (r.stage === 'Follow-up 1' && days >= c.fu2Days && !has('fu2')) makeDraft({ kind: 'realtor', step: 'fu2', refId: r.id, name: r.name, to: r.email, phone: r.phone }, r);
    }
  }

  // Called by server.js after a job is saved: thank-you + review request when a job becomes Completed.
  function onJobSaved(before, after) {
    if (after.status !== 'Completed' || before?.status === 'Completed' || after.pastImport) return;
    if (!after.email && !after.phone) return;
    if (draftsFor(after.id, 'review').length) return;
    makeDraft({ kind: 'customer', step: 'review', refId: after.id, name: after.name, to: after.email, phone: after.phone }, after);
  }
  function onJobDeleted(id) { for (const d of draftsFor(id)) if (d.status === 'pending') delRow('drafts', d.id); }

  function draftRebooking() {
    const season = String(new Date().getMonth() >= 8 ? new Date().getFullYear() + 1 : new Date().getFullYear());
    const jobs = allJobs();
    const optedOut = new Set(jobs.filter(j => j.noMarketing).flatMap(j => [lc(j.email), lc(j.name)]).filter(Boolean));
    const already = new Set(allDrafts().filter(d => d.step === 'rebook' && d.season === season).map(d => lc(d.to) || lc(d.name)));
    const seen = new Set(); let made = 0, noContact = 0;
    for (const j of jobs.filter(j => j.status === 'Completed')) {
      const key = lc(j.email) || lc(j.name);
      if (seen.has(key) || optedOut.has(lc(j.email)) || optedOut.has(lc(j.name)) || already.has(key)) continue;
      seen.add(key);
      if (!j.email && !j.phone) { noContact++; continue; }
      makeDraft({ kind: 'customer', step: 'rebook', refId: j.id, name: j.name, to: j.email, phone: j.phone, extra: { season } }, j);
      made++;
    }
    return { made, noContact, season };
  }

  /* ---------- after a draft is sent ---------- */
  function markSent(d, via) {
    d.status = 'sent'; d.sentAt = now(); d.via = via; putRow('drafts', d.id, d);
    if (d.kind === 'realtor') {
      const r = getRow('realtors', d.refId);
      if (r) {
        const next = { intro: 'Sent', fu1: 'Follow-up 1', fu2: 'Follow-up 2' }[d.step];
        if (next && !STOPPED.has(r.stage)) r.stage = next;
        r.log = [...(r.log || []), { at: d.sentAt, what: `${{ intro: 'Intro', fu1: 'Follow-up 1', fu2: 'Follow-up 2' }[d.step]} sent (${via})` }];
        putRow('realtors', r.id, r);
      }
    }
  }
  const fullBody = (d) => d.body + (COMMERCIAL.has(d.step) ? footer() : '');
  const needsAddress = (d) => COMMERCIAL.has(d.step) && !String(mkt().mailingAddress || '').trim();

  /* ---------- door hanger (print to PDF, upload to Vistaprint) ---------- */
  const HANGER_VERB = [
    [/patio restoration/i, 'restored a patio'], [/patio/i, 'cleaned a patio'], [/house/i, 'washed a house'],
    [/deck/i, 'cleaned a deck'], [/fence/i, 'cleaned a fence'],
  ];
  function hangerHtml(job) {
    const c = cfg();
    const verb = (HANGER_VERB.find(([re]) => re.test(job?.service || '')) || [null, 'cleaned a home'])[1];
    const esc = (s) => String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
    const qr = c.website ? `https://api.qrserver.com/v1/create-qr-code/?size=600x600&margin=0&data=${encodeURIComponent(c.website)}` : '';
    return `<!doctype html><html><head><meta charset="utf-8"><title>Door hanger · Nashoba Power Wash</title>
<link href="https://fonts.googleapis.com/css2?family=Anton&family=Inter:wght@400;600;700&display=swap" rel="stylesheet">
<style>
  @page{size:4.5in 11.25in;margin:0}
  *{box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  body{margin:0;background:#cfd8e3;font-family:Inter,system-ui,sans-serif}
  .tip{max-width:640px;margin:18px auto;background:#fff;border-radius:10px;padding:14px 18px;font-size:14px;line-height:1.5}
  .tip b{color:#0B2A6F}
  .sheet{width:4.5in;height:11.25in;margin:0 auto 30px;background:#fff;position:relative;overflow:hidden}
  .top{height:3.6in;background:linear-gradient(180deg,#BFE6FF 0%,#3FA9F5 40%,#1E5BC6 75%,#0B2A6F 100%);position:relative}
  .hole{position:absolute;left:50%;top:.75in;width:1.5in;height:1.5in;margin-left:-.75in;border:1.5px dashed rgba(255,255,255,.7);border-radius:50%}
  .logo{position:absolute;left:.4in;right:.4in;bottom:-.55in;background:#fff;border-radius:14px;padding:.12in;box-shadow:0 4px 14px rgba(0,0,0,.18)}
  .logo img{width:100%;display:block}
  .body{padding:.85in .45in 0;text-align:center;color:#13213A}
  .kicker{font-size:11pt;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#1E5BC6}
  h1{font-family:Anton,Impact,sans-serif;font-weight:400;font-size:27pt;line-height:1.05;margin:.08in 0 .14in;color:#0B2A6F;text-transform:uppercase}
  p{font-size:10.5pt;line-height:1.45;margin:0 0 .12in}
  ul{list-style:none;padding:0;margin:.12in 0 .18in;font-size:10.5pt;text-align:left;display:inline-block}
  li{margin:.04in 0} li::before{content:"✓ ";color:#1F9D55;font-weight:700}
  .cta{background:#0B2A6F;color:#fff;border-radius:12px;padding:.16in;display:flex;gap:.16in;align-items:center;text-align:left;margin-top:.1in}
  .cta img{width:1.15in;height:1.15in;background:#fff;padding:.05in;border-radius:6px}
  .cta .big{font-family:Anton,Impact,sans-serif;font-size:17pt;color:#BFE6FF;line-height:1.05}
  .cta small{display:block;font-size:9.5pt;color:#D4E1F5;margin-top:.05in}
  .foot{position:absolute;bottom:.35in;left:0;right:0;text-align:center;font-size:8.5pt;color:#5B6B82}
  .warn{color:#C8372D}
  @media print{body{background:#fff}.tip{display:none}.sheet{margin:0}.hole{display:none}}
</style></head><body>
<div class="tip"><b>How to order:</b> press <b>Ctrl+P</b> → Destination <b>Save as PDF</b> → More settings: <b>Margins: None</b>, tick <b>Background graphics</b> → Save.
Then on Vistaprint choose <b>Door Hangers → 4.25″ × 11″</b> and <b>upload your full design</b> (this file includes the ⅛″ bleed). The dashed circle shows roughly where the hanger hole is cut. It isn't printed.
${!c.website ? '<br><span class="warn">⚠ Add your website (quote page) in Leads → Settings so the QR code appears.</span>' : ''}${!c.phone ? '<br><span class="warn">⚠ Add your phone number in Leads → Settings.</span>' : ''}</div>
<div class="sheet">
  <div class="top"><div class="hole"></div><div class="logo"><img src="/logo.png" alt="Nashoba Power Wash"></div></div>
  <div class="body">
    <div class="kicker">Hi neighbor!</div>
    <h1>We just ${esc(verb)} on your street</h1>
    <p>If your home could use the same fresh start, I'd love to give you a free, no-pressure quote.</p>
    <ul><li>House washes (vinyl siding)</li><li>Paver patio restoration &amp; re-sanding</li><li>Composite decks &amp; fences</li><li>Mold &amp; grime removal</li></ul>
    <div class="cta">${qr ? `<img src="${esc(qr)}" alt="QR code">` : ''}
      <div><div class="big">FREE QUOTE</div><small>${qr ? 'Scan to request a quote' : 'Request a quote'}${c.phone ? `<br>or call/text <b style="color:#fff">${esc(c.phone)}</b>` : ''}</small></div></div>
  </div>
  <div class="foot">Locally owned &amp; operated · Westford, MA<br>Personal service. Every job done by the owner.</div>
</div></body></html>`;
  }

  /* ---------- routes ---------- */
  return {
    tick, ingestInbox, onJobSaved, onJobDeleted, allRealtors, allDrafts, importBatch,
    exportData: () => ({ realtors: allRealtors(), drafts: allDrafts() }),
    importBackup(d) {
      for (const r of Array.isArray(d.realtors) ? d.realtors : []) putRow('realtors', /^[\w-]{1,64}$/.test(r.id) ? r.id : newId(), r);
      for (const x of Array.isArray(d.drafts) ? d.drafts : []) putRow('drafts', /^[\w-]{1,64}$/.test(x.id) ? x.id : newId(), x);
    },
    // Returns true if it handled the request.
    async route(m, p, url, req, res, { send, readBody }) {
      let r;
      if (m === 'GET' && p === '/hanger') {
        const job = url.searchParams.get('job') ? getJob(url.searchParams.get('job')) : null;
        send(res, 200, hangerHtml(job)); return true;
      }
      if (m === 'GET' && p === '/api/leads') {
        const inbox = ingestInbox(); tick();
        send(res, 200, { realtors: allRealtors(), drafts: allDrafts(), inbox, config: cfg(), stages: REALTOR_STAGES }); return true;
      }
      if (m === 'POST' && p === '/api/leads/import') {
        const out = importBatch(await readBody(req), 'dashboard'); tick();
        send(res, 200, out); return true;
      }
      if (m === 'POST' && p === '/api/leads/rebook') { send(res, 200, draftRebooking()); return true; }
      // Send several approved drafts in one go (the "Send all" button). Still one email per person.
      if (m === 'POST' && p === '/api/drafts-bulk/send') {
        const { ids } = await readBody(req);
        if (!googleConnected()) { send(res, 400, { error: 'Connect Google first (bottom of the sidebar). Without it, use "Open in Gmail" one at a time.' }); return true; }
        const want = new Set(Array.isArray(ids) ? ids : []);
        const todo = allDrafts().filter(d => want.has(d.id) && d.status === 'pending' && EMAIL_RE.test(lc(d.to)));
        if (todo.some(needsAddress)) { send(res, 400, { error: 'Add your mailing address in Marketing → ⚙ Google setup first. The law (CAN-SPAM) requires it on marketing emails.' }); return true; }
        const out = { sent: 0, failed: [], skipped: want.size - todo.length };
        let streak = 0;
        for (const d of todo) {
          try { await sendEmail({ to: d.to, subject: d.subject, body: fullBody(d) }); markSent(d, 'Gmail'); out.sent++; streak = 0; }
          catch (e) {
            out.failed.push({ name: d.name, error: e.message });
            if (++streak >= 3 || /expired|not connected/i.test(e.message)) { out.stopped = true; break; } // Gmail/login problem: stop, the rest stay queued
          }
          await new Promise(r => setTimeout(r, 400)); // gentle pace for Gmail
        }
        tick();
        send(res, 200, { ...out, drafts: allDrafts(), realtors: allRealtors() }); return true;
      }
      if (m === 'POST' && p === '/api/leads/refresh') { // re-fill drafts you haven't edited, e.g. after adding your phone number
        let n = 0;
        for (const d of allDrafts().filter(d => d.status === 'pending' && !d.edited)) {
          const src = d.kind === 'realtor' ? getRow('realtors', d.refId) : getJob(d.refId);
          if (!src) continue;
          Object.assign(d, TEMPLATES[d.step](src)); putRow('drafts', d.id, d); n++;
        }
        send(res, 200, { refreshed: n, drafts: allDrafts() }); return true;
      }

      if ((r = p.match(/^\/api\/realtors\/([\w-]{1,64})$/))) {
        const cur = getRow('realtors', r[1]); if (!cur) { send(res, 404, { error: 'Realtor not found' }); return true; }
        if (m === 'PUT') {
          const d = await readBody(req);
          for (const k of ['name', 'phone', 'brokerage', 'town', 'listing', 'hook', 'notes']) if (d[k] !== undefined) cur[k] = clean(d[k], 1000);
          if (d.stage && REALTOR_STAGES.includes(d.stage) && d.stage !== cur.stage) {
            cur.log = [...(cur.log || []), { at: now(), what: `Moved to ${d.stage}` }]; cur.stage = d.stage;
          }
          putRow('realtors', cur.id, cur); tick();
          send(res, 200, { realtor: getRow('realtors', cur.id), drafts: allDrafts() }); return true;
        }
        if (m === 'DELETE') {
          for (const d of draftsFor(cur.id)) if (d.status === 'pending') delRow('drafts', d.id);
          delRow('realtors', cur.id); send(res, 200, { ok: true }); return true;
        }
      }

      if ((r = p.match(/^\/api\/drafts\/([\w-]{1,64})(\/send|\/mark|\/full)?$/))) {
        const d = getRow('drafts', r[1]); if (!d) { send(res, 404, { error: 'Draft not found' }); return true; }
        if (m === 'PUT' && !r[2]) {
          const b = await readBody(req);
          if (b.subject !== undefined && b.subject !== d.subject) { d.subject = clean(b.subject, 300); d.edited = true; }
          if (b.body !== undefined && b.body !== d.body) { d.body = String(b.body).slice(0, 20000); d.edited = true; }
          if (b.to !== undefined) d.to = clean(b.to, 200);
          putRow('drafts', d.id, d); send(res, 200, { draft: d }); return true;
        }
        if (m === 'GET' && r[2] === '/full') { // full text incl. footer, for "Open in Gmail" / copy / text
          if (needsAddress(d)) { send(res, 400, { error: 'Add your mailing address in Marketing → ⚙ Google setup first. The law (CAN-SPAM) requires it on marketing emails.' }); return true; }
          send(res, 200, { to: d.to, subject: d.subject, body: fullBody(d) }); return true;
        }
        if (m === 'POST' && r[2] === '/send') {
          if (d.status === 'sent') { send(res, 400, { error: 'Already sent.' }); return true; }
          if (needsAddress(d)) { send(res, 400, { error: 'Add your mailing address in Marketing → ⚙ Google setup first. The law (CAN-SPAM) requires it on marketing emails.' }); return true; }
          if (!googleConnected()) { send(res, 400, { error: 'Connect Google first, or use "Open in Gmail".' }); return true; }
          try { await sendEmail({ to: d.to, subject: d.subject, body: fullBody(d) }); }
          catch (e) { send(res, 400, { error: e.message }); return true; }
          markSent(d, 'Gmail'); tick(); send(res, 200, { draft: getRow('drafts', d.id), drafts: allDrafts(), realtors: allRealtors() }); return true;
        }
        if (m === 'POST' && r[2] === '/mark') {
          const { status, via } = await readBody(req);
          if (status === 'sent') markSent(d, clean(via, 30) || 'manually');
          else if (status === 'skipped' || status === 'pending') { d.status = status; putRow('drafts', d.id, d); }
          else { send(res, 400, { error: 'Bad status' }); return true; }
          tick(); send(res, 200, { drafts: allDrafts(), realtors: allRealtors() }); return true;
        }
        if (m === 'DELETE' && !r[2]) { delRow('drafts', d.id); send(res, 200, { ok: true }); return true; }
      }
      return false;
    },
  };
}
