// Prints what the Lead Engine already knows, so /find-realtors and /find-past-customers skip duplicates.
// Read-only. Usage: node scripts/leads-known.mjs
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOWNS = ['Westford', 'Chelmsford', 'Littleton', 'Groton', 'Acton', 'Carlisle', 'Concord', 'Tyngsborough', 'Dunstable',
  'Ayer', 'Boxborough', 'Harvard', 'Lowell', 'Billerica', 'Tewksbury', 'Dracut', 'Pepperell', 'Shirley', 'Stow', 'Maynard',
  'Bedford', 'Burlington', 'Townsend', 'Sudbury', 'Lexington', 'Wilmington'];

const out = { realtorEmails: [], realtorsPerTown: {}, customerNames: [], customerEmails: [], pendingInboxFiles: [], suggestedTowns: [] };
const dbFile = path.join(ROOT, 'data', 'nashoba.db');
if (fs.existsSync(dbFile)) {
  const db = new DatabaseSync(dbFile, { readOnly: true });
  const has = (t) => db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
  if (has('realtors')) for (const r of db.prepare('SELECT data FROM realtors').all().map(x => JSON.parse(x.data))) {
    out.realtorEmails.push(String(r.email || '').toLowerCase());
    out.realtorsPerTown[r.town || '?'] = (out.realtorsPerTown[r.town || '?'] || 0) + 1;
  }
  for (const j of db.prepare('SELECT data FROM jobs').all().map(x => JSON.parse(x.data))) {
    if (j.name) out.customerNames.push(j.name);
    if (j.email) out.customerEmails.push(String(j.email).toLowerCase());
  }
}
// Files waiting in the inbox count too (the dashboard imports them next time it opens).
const inbox = path.join(ROOT, 'data', 'inbox');
if (fs.existsSync(inbox)) for (const f of fs.readdirSync(inbox).filter(f => f.endsWith('.json'))) {
  out.pendingInboxFiles.push(f);
  try {
    const d = JSON.parse(fs.readFileSync(path.join(inbox, f), 'utf8'));
    for (const r of d.realtors || []) { out.realtorEmails.push(String(r.email || '').toLowerCase()); out.realtorsPerTown[r.town || '?'] = (out.realtorsPerTown[r.town || '?'] || 0) + 1; }
    for (const c of d.customers || []) { out.customerNames.push(c.name); if (c.email) out.customerEmails.push(String(c.email).toLowerCase()); }
  } catch { /* ignore a bad file */ }
}
// Closest towns first, least-covered first.
out.suggestedTowns = TOWNS.map((t, i) => [t, i, out.realtorsPerTown[t] || 0]).sort((a, b) => a[2] - b[2] || a[1] - b[1]).slice(0, 6).map(x => x[0]);
console.log(JSON.stringify(out, null, 2));
