/**
 * Larkin PM&R Hub — Google data bridge
 * ------------------------------------
 * Lives in the shared chief Google account (Extensions ▸ Apps Script inside the "Hub Control Panel" sheet).
 * The website calls this script's web-app URL; the script reads the Handbook Doc and the schedule Sheets
 * and hands them back as JSON. Nothing here needs editing year to year: paste new links into the
 * Control Panel's "Settings" tab instead.
 */

// The Control Panel spreadsheet this script is attached to is found automatically.
// Fallbacks are used only if a Settings row is blank.
const FALLBACK = {
  'Handbook Doc': '1IcF0PLXIjIXV_KN7vJPspwflj3I0gsxHNbpJl-VZwjE',
  'Didactic Schedule Sheet': '1ZqfLer-e7NkITKgY7U7KVwneeSf1xr4p0BBc6bhcVqU',
  'Resident Schedule Sheet': '1dtRS8swJQ45q0BYnhONouegR7poWeeg5h9EamHjC1Qk',
};
const CACHE_SECONDS = 300;      // schedules/contacts: edits show on the site within ~5 minutes
const HANDBOOK_CACHE = 1800;    // the Handbook changes quarterly: rebuilt at most every 30 minutes
const PICTURE_LIMIT = 60000;    // pictures larger than this become a link to the Handbook
const CHUNK = 90000;            // CacheService stores at most 100 KB per key

function doGet(e) {
  if (e && e.parameter && e.parameter.page === 'admin') {
    return HtmlService.createHtmlOutputFromFile('Admin')
      .setTitle('Larkin South Miami PM&R Hub · Editor')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1');
  }
  const fresh = e && e.parameter && e.parameter.refresh;
  const cache = CacheService.getScriptCache();
  if (e && e.parameter && e.parameter.calendar) {
    let ics = fresh ? null : cache.get('hub_ics');
    if (!ics) {
      ics = buildCalendar_();
      try { cache.put('hub_ics', ics, CACHE_SECONDS); } catch (err) { /* large calendar: serve uncached */ }
    }
    return ContentService.createTextOutput(ics).setMimeType(ContentService.MimeType.ICAL);
  }
  // Two parts so the website can show schedules immediately: ?part=handbook is the (large) Handbook, anything else is the rest.
  const part = e && e.parameter && e.parameter.part === 'handbook' ? 'handbook' : 'core';
  const prefix = part === 'handbook' ? 'hb_' : 'core_';
  let payload = fresh ? null : readCache_(cache, prefix);
  if (!payload) {
    payload = JSON.stringify(part === 'handbook' ? buildHandbook_() : build_());
    writeCache_(cache, prefix, payload, part === 'handbook' ? HANDBOOK_CACHE : CACHE_SECONDS);
  }
  return ContentService.createTextOutput(payload).setMimeType(ContentService.MimeType.JSON);
}

/* ------------------------------------------------------------------ keep data warm
 * Run installAutoRefresh ONCE from the editor. Google then rebuilds the data every 5 minutes in the
 * background, so visitors never wait for a cold start and edits appear within ~5 minutes. */
function installAutoRefresh() {
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'autoRefresh').forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('autoRefresh').timeBased().everyMinutes(5).create();
  autoRefresh();
  Logger.log('Auto-refresh is on: data is rebuilt every 5 minutes.');
}

function autoRefresh() {
  const cache = CacheService.getScriptCache();
  writeCache_(cache, 'core_', JSON.stringify(build_()), 900);
  const hbAge = Date.now() - Number(cache.get('hb_at') || 0);
  if (hbAge > 25 * 60 * 1000 || !cache.get('hb_n')) {
    writeCache_(cache, 'hb_', JSON.stringify(buildHandbook_()), 3600);
    cache.put('hb_at', String(Date.now()), 3600);
  }
  try { cache.put('hub_ics', buildCalendar_(), 900); } catch (err) { /* served uncached */ }
}

/** Run from the editor to preview the calendar feed in the log. */
function testCalendar() {
  const ics = buildCalendar_();
  Logger.log(ics.split('BEGIN:VEVENT').length - 1 + ' calendar events');
  Logger.log(ics.slice(0, 1500));
}

/** Run this once from the editor (▶ Run) to grant access and check that every source is readable. */
function testHub() {
  const out = build_();
  const t0 = Date.now(); const hb = buildHandbook_();
  Logger.log('Errors: ' + JSON.stringify(out.errors.concat(hb.errors)));
  Logger.log('Schedules/contacts download size: ' + Math.round(JSON.stringify(out).length / 1024) + ' KB');
  Logger.log('Handbook download size: ' + Math.round(JSON.stringify(hb).length / 1024) + ' KB (built in ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s)');
  Logger.log('Didactic rows: ' + (out.didactics || []).length + ' · Resident rows: ' + (out.residents || []).length);
  Logger.log('Control panel tabs: ' + Object.keys(out.panel).join(', '));
  const talks = parseDidactics_(out.didactics || []);
  const today = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  const next = talks.filter(t => t.date >= today).slice(0, 8);
  Logger.log('Sessions the website reads: ' + talks.length + ' (' + talks.filter(t => t.date >= today).length + ' upcoming). Next ones:');
  next.forEach(t => Logger.log(t.date + (t.time ? ' ' + t.time : '') + ' · ' + t.topic + (t.speaker ? ' — ' + t.speaker : '') + (t.location ? ' @ ' + t.location : '')));
}

function build_() {
  const out = { ok: true, updated: new Date().toISOString(), errors: [], panel: {} };
  try {
    const panel = SpreadsheetApp.getActiveSpreadsheet();
    if (panel) panel.getSheets().forEach(sh => { out.panel[sh.getName()] = values_(sh); });
  } catch (err) { out.errors.push('Control Panel: ' + err.message); }

  const settings = {};
  (out.panel['Settings'] || []).forEach(r => { if (r[0]) settings[String(r[0]).trim()] = String(r[1] || '').trim(); });
  const idOf = key => idFromLink_(settings[key]) || FALLBACK[key];

  try { out.didactics = readSheet_(idOf('Didactic Schedule Sheet'), settings['Didactic Schedule tab']); } catch (err) { out.errors.push('Didactic Schedule: ' + err.message); }
  try { out.residents = readSheet_(idOf('Resident Schedule Sheet'), settings['Resident Schedule tab']); } catch (err) { out.errors.push('Resident Schedule: ' + err.message); }
  return out;
}

function panelSettings_() {
  const settings = {};
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const st = ss && ss.getSheetByName('Settings');
  if (st) values_(st).forEach(r => { if (r[0]) settings[String(r[0]).trim()] = String(r[1] || '').trim(); });
  return settings;
}

function buildHandbook_() {
  const out = { ok: true, updated: new Date().toISOString(), errors: [] };
  const settings = panelSettings_();
  const idOf = key => idFromLink_(settings[key]) || FALLBACK[key];
  try { out.handbookHtml = exportDoc_(idOf('Handbook Doc')); } catch (err) { out.errors.push('Handbook Doc: ' + err.message); }
  if (settings['Templates Doc']) {
    try { out.templatesHtml = exportDoc_(idOf('Templates Doc')); } catch (err) { out.errors.push('Templates Doc: ' + err.message); }
  }
  return out;
}

function exportDoc_(docId) {
  DriveApp.getFileById(docId); // confirms access (and asks for Drive permission the first time)
  const url = 'https://docs.google.com/document/d/' + docId + '/export?format=html';
  const res = UrlFetchApp.fetch(url, { headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw new Error('could not export (HTTP ' + res.getResponseCode() + ')');
  return slimDocHtml_(res.getContentText(), docId);
}

/** Google's export is huge: inline styles on every line plus pictures embedded as text.
 *  Keep only what the site uses (bold/italic classes, structure) and keep pictures under ~200 KB. */
function slimDocHtml_(html, docId) {
  const css = (html.match(/<style[^>]*>([\s\S]*?)<\/style>/i) || [])[1] || '';
  const keep = [];
  css.replace(/\.([\w-]+)\{([^}]*)\}/g, (m, c, b) => {
    if (/font-weight:\s*(700|bold)|font-style:\s*italic/.test(b)) keep.push('.' + c + '{' + b.match(/(font-weight:\s*(700|bold)|font-style:\s*italic)/g).join(';') + '}');
    return m;
  });
  const body = (html.match(/<body[^>]*>([\s\S]*)<\/body>/i) || [])[1] || html;
  const link = 'https://docs.google.com/document/d/' + docId + '/edit';
  const slim = body
    .replace(/\sstyle="[^"]*"/g, '')
    .replace(/\sid="[^"]*"/g, '')
    .replace(/<img[^>]*src="(data:[^"]+)"[^>]*>/g, (m, src) => src.length < PICTURE_LIMIT ? '<img src="' + src + '">' : '<em>[Picture: see the <a href="' + link + '">Program Handbook</a>]</em>')
    .replace(/<span>([^<]*)<\/span>/g, '$1')
    .replace(/<p class="[^"]*"><\/p>/g, '');
  return '<html><head><style>' + keep.join('') + '</style></head><body>' + slim + '</body></html>';
}

function readSheet_(sheetId, tabName) {
  const ss = SpreadsheetApp.openById(sheetId);
  const sh = (tabName && ss.getSheetByName(tabName)) || ss.getSheets()[0];
  return values_(sh);
}

/** Display values exactly as shown in the sheet, with merged cells filled in. */
function values_(sh) {
  const range = sh.getDataRange();
  const vals = range.getDisplayValues();
  const r0 = range.getRow(), c0 = range.getColumn();
  range.getMergedRanges().forEach(m => {
    const top = m.getRow() - r0, left = m.getColumn() - c0;
    const v = vals[top][left];
    for (let i = 0; i < m.getNumRows(); i++) for (let j = 0; j < m.getNumColumns(); j++) {
      if (vals[top + i] && left + j < vals[top + i].length) vals[top + i][left + j] = v;
    }
  });
  while (vals.length && vals[vals.length - 1].every(c => c === '')) vals.pop();
  return vals;
}

function idFromLink_(s) {
  if (!s) return '';
  const m = String(s).match(/\/d\/([a-zA-Z0-9_-]{20,})/);
  if (m) return m[1];
  return /^[a-zA-Z0-9_-]{20,}$/.test(s) ? s : '';
}

function readCache_(cache, prefix) {
  const n = Number(cache.get(prefix + 'n') || 0);
  if (!n) return null;
  const keys = []; for (let i = 0; i < n; i++) keys.push(prefix + i);
  const parts = cache.getAll(keys);
  if (Object.keys(parts).length !== n) return null;
  return keys.map(k => parts[k]).join('');
}

function writeCache_(cache, prefix, payload, seconds) {
  try {
    const obj = {}; let n = 0;
    for (let i = 0; i < payload.length; i += CHUNK) obj[prefix + (n++)] = payload.slice(i, i + CHUNK);
    obj[prefix + 'n'] = String(n);
    cache.putAll(obj, seconds);
  } catch (err) { /* too large to cache: serve uncached */ }
}

/* ------------------------------------------------------------------ didactics calendar (.ics) */
const TZ = 'America/New_York';

function buildCalendar_() {
  const panel = SpreadsheetApp.getActiveSpreadsheet();
  const settings = {};
  if (panel) {
    const st = panel.getSheetByName('Settings');
    if (st) values_(st).forEach(r => { if (r[0]) settings[String(r[0]).trim()] = String(r[1] || '').trim(); });
  }
  const id = idFromLink_(settings['Didactic Schedule Sheet']) || FALLBACK['Didactic Schedule Sheet'];
  const hours = Number(settings['Didactics length (hours)']) || 3;
  const rows = parseDidactics_(readSheet_(id, settings['Didactic Schedule tab']));

  const byDate = {};
  rows.forEach(r => { (byDate[r.date] = byDate[r.date] || []).push(r); });
  const stamp = Utilities.formatDate(new Date(), 'UTC', "yyyyMMdd'T'HHmmss'Z'");
  const out = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Larkin PM&R Hub//Didactics//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'X-WR-CALNAME:Larkin PM&R Didactics', 'X-WR-TIMEZONE:' + TZ, 'REFRESH-INTERVAL;VALUE=DURATION:PT1H', 'X-PUBLISHED-TTL:PT1H'];

  Object.keys(byDate).sort().forEach(date => {
    const talks = byDate[date];
    const off = talks.every(t => /no didactics|holiday break/i.test(t.topic));
    const ymd = date.replace(/-/g, '');
    const t = parseTime_(talks[0].time);
    const ev = ['BEGIN:VEVENT', 'UID:didactics-' + ymd + '@larkin-pmr-hub', 'DTSTAMP:' + stamp];
    if (off || !t) {
      const next = new Date(date + 'T12:00:00Z'); next.setUTCDate(next.getUTCDate() + 1);
      ev.push('DTSTART;VALUE=DATE:' + ymd, 'DTEND;VALUE=DATE:' + Utilities.formatDate(next, 'UTC', 'yyyyMMdd'));
    } else {
      const end = t.end != null ? t.end : t.start + hours * 60;
      ev.push('DTSTART;TZID=' + TZ + ':' + ymd + 'T' + hhmm_(t.start), 'DTEND;TZID=' + TZ + ':' + ymd + 'T' + hhmm_(Math.min(end, 23 * 60 + 59)));
    }
    const jc = talks.some(x => /journal club/i.test(x.topic));
    const summary = off ? talks[0].topic : 'PM&R Didactics' + (jc ? ' · Journal Club' : '');
    ev.push(fold_('SUMMARY:' + esc_(summary)));
    if (talks[0].location && !off) ev.push(fold_('LOCATION:' + esc_(talks[0].location)));
    const desc = talks.map(x => '• ' + x.topic + (x.speaker ? ' — ' + x.speaker : '')).join('\n') + (talks[0].block ? '\n\n' + talks[0].block : '');
    ev.push(fold_('DESCRIPTION:' + esc_(desc)), 'TRANSP:' + (off ? 'TRANSPARENT' : 'OPAQUE'), 'END:VEVENT');
    Array.prototype.push.apply(out, ev);
  });
  out.push('END:VCALENDAR');
  return out.join('\r\n') + '\r\n';
}

/** Same rules the website uses: find the header row, carry dates down, skip "Block" banner rows. */
function parseDidactics_(rows) {
  rows = rows.map(r => r.map(c => String(c == null ? '' : c).trim()));
  const hi = rows.findIndex(r => r.some(c => /topic/i.test(c)) && r.some(c => /^date$/i.test(c)));
  if (hi < 0) return [];
  const H = rows[hi].map(c => c.toLowerCase());
  const col = re => H.findIndex(h => re.test(h));
  const cDate = col(/^date$/), cLoc = col(/location/), cTime = col(/^time/), cTopic = col(/topic/), cSpk = col(/speaker|presenter|resident\/|attending/);
  const out = []; let cur = { date: '', location: '', time: '' }, block = '';
  rows.slice(hi + 1).forEach(r => {
    const g = i => (i >= 0 ? (r[i] || '') : '');
    const vals = r.filter(Boolean).filter((v, i, a) => a.indexOf(v) === i);
    if (vals.length === 1 && /block\s*\d/i.test(vals[0])) { block = vals[0]; return; }
    if (!g(cTopic) && vals.some(v => /block\s*\d/i.test(v))) { block = vals.find(v => /block\s*\d/i.test(v)); return; }
    const iso = isoDate_(g(cDate));
    if (iso && iso !== cur.date) cur = { date: iso, location: g(cLoc), time: g(cTime) };
    if (g(cLoc)) cur.location = g(cLoc);
    const topic = g(cTopic);
    if (!topic || !cur.date) return;
    out.push({ date: cur.date, time: cur.time, location: cur.location, topic: topic, speaker: g(cSpk), block: block });
  });
  return out;
}

function isoDate_(s) {
  s = String(s || '').trim(); if (!s) return '';
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) { const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]); return y + '-' + ('0' + m[1]).slice(-2) + '-' + ('0' + m[2]).slice(-2); }
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/); if (m) return m[0];
  const t = Date.parse(s); if (!isNaN(t)) return Utilities.formatDate(new Date(t), TZ, 'yyyy-MM-dd');
  return '';
}

/** "2:00 PM", "8am-12pm", "2:00 PM - 5:00 PM" -> minutes after midnight. */
function parseTime_(s) {
  const parts = String(s || '').toLowerCase().split(/\s*(?:-|–|to)\s*(?=\d)/);
  const one = (p, fallbackAmPm) => {
    const m = String(p || '').match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm|a|p)?/);
    if (!m) return null;
    let h = Number(m[1]); const min = Number(m[2] || 0); const ap = (m[3] || fallbackAmPm || '').charAt(0);
    if (ap === 'p' && h < 12) h += 12; if (ap === 'a' && h === 12) h = 0;
    if (!ap && h >= 1 && h <= 6) h += 12; // a bare "2:00" means afternoon
    return h * 60 + min;
  };
  const start = one(parts[0], (String(parts[1] || '').match(/(am|pm)/) || [])[1]);
  if (start == null) return null;
  const end = parts[1] ? one(parts[1]) : null;
  return { start: start, end: end != null && end > start ? end : null };
}

function utf8Len_(s) { return unescape(encodeURIComponent(s)).length; }
function hhmm_(mins) { return ('0' + Math.floor(mins / 60)).slice(-2) + ('0' + (mins % 60)).slice(-2) + '00'; }
function esc_(s) { return String(s).replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n'); }
function fold_(line) {
  const out = []; let cur = '';
  for (const ch of line) {
    if (utf8Len_(cur + ch) > 74) { out.push(cur); cur = ' ' + ch; } else cur += ch;
  }
  out.push(cur);
  return out.join('\r\n');
}


/* ------------------------------------------------------------------ chief editor (Admin.html) */
const EDITABLE_TABS = ['Contacts', 'Quick Links', 'Announcements', 'Rotations', 'Settings'];
const EDIT_HEAD = ['Page ID', 'Type', 'Title', 'Hidden', 'Updated', 'Content 1', 'Content 2', 'Content 3', 'Content 4', 'Content 5', 'Content 6'];
const CELL = 45000; // Google Sheets allows 50,000 characters per cell

/** Only the account that owns this script (the chief Gmail) may edit. */
function guard_() {
  const me = (Session.getActiveUser().getEmail() || '').toLowerCase();
  const owner = (Session.getEffectiveUser().getEmail() || '').toLowerCase();
  if (!me || me !== owner) throw new Error('Editing is limited to ' + (owner || 'the chief account') + '. Sign in with that Google account and reopen the editor.');
  return me;
}

function clearCache_() {
  const keys = ['core_n', 'hb_n', 'hb_at', 'hub_ics']; for (let i = 0; i < 100; i++) keys.push('core_' + i, 'hb_' + i);
  CacheService.getScriptCache().removeAll(keys);
}

function panelSheet_(name, head) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(name);
  if (!sh && head) { sh = ss.insertSheet(name); sh.getRange(1, 1, 1, head.length).setValues([head]).setFontWeight('bold'); sh.setFrozenRows(1); }
  return sh;
}

function adminLoad() {
  const me = guard_();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const tabs = {};
  EDITABLE_TABS.forEach(n => { const sh = ss.getSheetByName(n); tabs[n] = sh ? values_(sh) : []; });
  const settings = {}; (tabs.Settings || []).forEach(r => { if (r[0]) settings[String(r[0]).trim()] = String(r[1] || '').trim(); });
  const siteUrl = settings['Website address'] || '';
  let snapshot = null, siteError = '';
  if (siteUrl) {
    try {
      const res = UrlFetchApp.fetch(siteUrl.replace(/\/?$/, '/') + 'data/snapshot.json', { muteHttpExceptions: true });
      if (res.getResponseCode() === 200) snapshot = JSON.parse(res.getContentText()); else siteError = 'Website returned HTTP ' + res.getResponseCode();
    } catch (err) { siteError = err.message; }
  } else siteError = 'Add the website address to the Settings tab to edit pages.';
  const pages = [];
  if (snapshot) {
    pages.push({ id: 'readiness', type: 'Notice', title: 'Inpatient rotation readiness banner', html: snapshot.readinessHtml || '' });
    (snapshot.rotations || []).forEach(r => pages.push({ id: 'rot-' + r.id, type: 'Rotation guide', title: r.title, html: r.html }));
    (snapshot.subpages || []).forEach(r => pages.push({ id: r.id, type: 'Extra guide', title: r.title, html: r.html }));
    (snapshot.policies || []).forEach(r => pages.push({ id: 'pol-' + r.id, type: 'Policy', title: r.title, html: r.html }));
    (snapshot.templates || []).forEach(r => pages.push({ id: 'tpl-' + r.id, type: 'Template', title: r.title, html: r.html }));
  }
  return { me: me, tabs: tabs, pages: pages, edits: readEdits_(), siteUrl: siteUrl, siteError: siteError,
           handbookUrl: settings['Handbook Doc'] || '', panelUrl: ss.getUrl() };
}

function readEdits_() {
  const sh = panelSheet_('Page Edits');
  if (!sh) return [];
  const v = sh.getDataRange().getValues();
  return v.slice(1).filter(r => r[0]).map(r => ({ id: String(r[0]), type: String(r[1]), title: String(r[2]), hidden: /^(y|yes|true)$/i.test(String(r[3])),
    updated: r[4] ? Utilities.formatDate(new Date(r[4]), Session.getScriptTimeZone(), 'MMM d, yyyy h:mm a') : '', html: r.slice(5).join('') }));
}

function adminSaveTab(name, rows) {
  guard_();
  if (EDITABLE_TABS.indexOf(name) < 0) throw new Error('That tab cannot be edited here.');
  const sh = panelSheet_(name, rows[0]);
  const width = Math.max.apply(null, rows.map(r => r.length));
  const data = rows.map(r => { const x = r.map(c => String(c == null ? '' : c)); while (x.length < width) x.push(''); return x; });
  sh.clearContents();
  sh.getRange(1, 1, data.length, width).setValues(data);
  sh.getRange(1, 1, 1, width).setFontWeight('bold');
  clearCache_();
  return 'Saved ' + name + '. The website shows the change on its next refresh.';
}

function adminSavePage(page) {
  guard_();
  if (!page || !/^(readiness|rot-|sub-|pol-|tpl-)/.test(page.id)) throw new Error('Unknown page.');
  const sh = panelSheet_('Page Edits', EDIT_HEAD);
  const html = String(page.html || '');
  if (html.length > CELL * 6) throw new Error('This page is too long to save here (' + html.length + ' characters). Shorten it or edit the Handbook doc instead.');
  const chunks = []; for (let i = 0; i < 6; i++) chunks.push(html.slice(i * CELL, (i + 1) * CELL));
  const row = [page.id, page.type || '', page.title || '', page.hidden ? 'Yes' : '', new Date()].concat(chunks);
  const ids = sh.getRange(1, 1, Math.max(1, sh.getLastRow()), 1).getValues().map(r => String(r[0]));
  const at = ids.indexOf(page.id);
  if (at > 0) sh.getRange(at + 1, 1, 1, row.length).setValues([row]); else sh.appendRow(row);
  clearCache_();
  return page.hidden ? 'Page hidden from the website.' : 'Page saved. The website shows the change on its next refresh.';
}

function adminRevertPage(id) {
  guard_();
  const sh = panelSheet_('Page Edits');
  if (!sh) return 'Nothing to undo.';
  const ids = sh.getRange(1, 1, Math.max(1, sh.getLastRow()), 1).getValues().map(r => String(r[0]));
  const at = ids.indexOf(id);
  if (at > 0) sh.deleteRow(at + 1);
  clearCache_();
  return 'Restored the original version.';
}
