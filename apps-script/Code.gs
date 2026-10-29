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
const PICTURE_LIMIT = 20000;    // pictures larger than this are saved as image files (Drive folder "Hub pictures") and shown from there
const CHUNK = 90000;            // CacheService stores at most 100 KB per key

function doGet(e) {
  if (e && e.parameter && e.parameter.page === 'admin') {
    return HtmlService.createHtmlOutputFromFile('Admin')
      .setTitle('Larkin South Miami PM&R Hub · Editor')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1');
  }
  if (e && e.parameter && e.parameter.auth) return json_(authRequest_(e.parameter));
  const fresh = e && e.parameter && e.parameter.refresh;
  const cache = CacheService.getScriptCache();
  if (e && e.parameter && e.parameter.calendar === 'me') {
    const who = String(e.parameter.name || '').trim();
    const key = 'me_' + Utilities.base64EncodeWebSafe(who).slice(0, 200);
    let ics = fresh ? null : cache.get(key);
    if (!ics) { ics = buildMyCalendar_(who); try { cache.put(key, ics, CACHE_SECONDS); } catch (err) { /* uncached */ } }
    return ContentService.createTextOutput(ics).setMimeType(ContentService.MimeType.ICAL);
  }
  if (e && e.parameter && e.parameter.calendar) {
    let ics = fresh ? null : cache.get('hub_ics');
    if (!ics) {
      ics = buildCalendar_();
      try { cache.put('hub_ics', ics, CACHE_SECONDS); } catch (err) { /* large calendar: serve uncached */ }
    }
    return ContentService.createTextOutput(ics).setMimeType(ContentService.MimeType.ICAL);
  }
  // Email sign-in: when it is on, schedules, contacts and the Handbook go only to verified devices.
  if (signInOn_()) { const who = checkToken_(e && e.parameter && e.parameter.token); if (!who.ok) return json_({ ok: false, auth: 'required', reason: who.reason }); }
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
  try { syncHowToTab_(); } catch (err) { /* the tab is only instructions */ }
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
    if (panel) panel.getSheets().forEach(sh => {
      if (PRIVATE_TABS.indexOf(sh.getName()) >= 0) return;
      let v = values_(sh);
      if (sh.getName() === 'Settings') v = v.filter(r => !/^(lecture reminder|site passcode)/i.test(String(r[0] || '').trim()) || (/^site passcode/i.test(String(r[0] || '').trim()) && !signInOn_()));   // private rows; the passcode only while email sign-in is off
      out.panel[sh.getName()] = v;
    });
  } catch (err) { out.errors.push('Control Panel: ' + err.message); }

  const settings = {};
  (out.panel['Settings'] || []).forEach(r => { if (r[0]) settings[String(r[0]).trim()] = String(r[1] || '').trim(); });
  const idOf = key => idFromLink_(settings[key]) || FALLBACK[key];

  try { out.didactics = dropEmailColumns_(readSheet_(idOf('Didactic Schedule Sheet'), settings['Didactic Schedule tab'])); } catch (err) { out.errors.push('Didactic Schedule: ' + err.message); }
  try { out.residents = readSheet_(idOf('Resident Schedule Sheet'), settings['Resident Schedule tab']); } catch (err) { out.errors.push('Resident Schedule: ' + err.message); }
  return out;
}

/** Keeps email addresses off the public website if someone adds an Email column to a schedule sheet. */
function dropEmailColumns_(rows) {
  const hi = rows.findIndex(r => r.some(c => /topic/i.test(c)));
  if (hi < 0) return rows;
  const drop = rows[hi].map((c, i) => /e-?mail/i.test(c) ? i : -1).filter(i => i >= 0);
  return drop.length ? rows.map(r => r.filter((c, i) => drop.indexOf(i) < 0)) : rows;
}

function panelSettings_() {
  const settings = {};
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const st = ss && ss.getSheetByName('Settings');
  if (st) values_(st).forEach(r => { if (r[0]) settings[String(r[0]).trim()] = String(r[1] || '').trim(); });
  // Row labels are matched without caring about capitals or extra spaces ("Lecture Reminder Test Email" works too)
  const key = k => String(k).toLowerCase().replace(/\s+/g, ' ').trim();
  const byKey = {}; Object.keys(settings).forEach(k => { byKey[key(k)] = settings[k]; });
  return new Proxy(settings, { get: (t, k) => typeof k !== 'string' ? t[k] : (k in t ? t[k] : byKey[key(k)]) });
}

function buildHandbook_() {
  const out = { ok: true, updated: new Date().toISOString(), errors: [] };
  const settings = panelSettings_();
  const idOf = key => idFromLink_(settings[key]) || FALLBACK[key];
  const folderId = folderIdFromLink_(settings['Handbooks Folder']);
  if (folderId) {
    // One Google Doc per rotation / policy, in the Handbooks folder (see setupHandbooksFolder)
    try {
      const docs = handbookDocs_(folderId);
      const html = exportDocs_(docs.map(d => d.id));
      out.guides = docs.map((d, i) => ({ name: d.name, folder: d.folder, updated: d.updated, html: html[i].html || '' }));
      html.forEach((h, i) => { if (h.error) out.errors.push(docs[i].name + ': ' + h.error); });
    } catch (err) { out.errors.push('Handbooks Folder: ' + err.message); }
  } else {
    try { out.handbookHtml = exportDoc_(idOf('Handbook Doc')); } catch (err) { out.errors.push('Handbook Doc: ' + err.message); }
  }
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
    // keep bold, italic and red text (the Handbook's warnings); drop every other style
    const k = b.match(/(font-weight:\s*(700|bold)|font-style:\s*italic|(^|;)\s*color:\s*#(f00\b|ff0000|e06666|cc0000|c00000|e00\b|ea4335|d93025))/gi);
    if (k) keep.push('.' + c + '{' + k.map(x => x.replace(/^;/, '')).join(';') + '}');
    return m;
  });
  const body = (html.match(/<body[^>]*>([\s\S]*)<\/body>/i) || [])[1] || html;
  const slim = body
    .replace(/\sstyle="[^"]*"/g, '')
    .replace(/\sid="[^"]*"/g, '')
    .replace(/<img[^>]*src="(data:[^"]+)"[^>]*>/g, (m, src) => '<img src="' + (src.length < PICTURE_LIMIT ? src : pictureUrl_(src)) + '">')
    .replace(/<span>([^<]*)<\/span>/g, '$1')
    .replace(/<p class="[^"]*"><\/p>/g, '');
  return '<html><head><style>' + keep.join('') + '</style></head><body>' + slim + '</body></html>';
}

/** Saves a big picture from the Handbook once (as a view-only image in the "Hub pictures" Drive folder)
 *  and returns a web address for it, so the site shows every picture without a huge download.
 *  The same picture is never saved twice. If anything fails, the picture is kept inline instead. */
const PIC_STATS = { saved: 0, reused: 0, inline: 0, failed: [] };
function pictureUrl_(dataUri) {
  try {
    const m = dataUri.match(/^data:([^;]+);base64,(.*)$/);
    if (!m) return dataUri;
    const hash = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, m[2]).map(b => ('0' + (b & 255).toString(16)).slice(-2)).join('');
    const props = PropertiesService.getScriptProperties();
    let id = props.getProperty('pic_' + hash);
    if (id) { try { DriveApp.getFileById(id); PIC_STATS.reused++; } catch (e) { id = null; } }
    if (!id) {
      const folders = DriveApp.getFoldersByName('Hub pictures');
      const folder = folders.hasNext() ? folders.next() : DriveApp.createFolder('Hub pictures');
      const ext = (m[1].split('/')[1] || 'png').replace('jpeg', 'jpg');
      const file = folder.createFile(Utilities.newBlob(Utilities.base64Decode(m[2]), m[1], 'handbook-' + hash.slice(0, 10) + '.' + ext));
      file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
      id = file.getId();
      props.setProperty('pic_' + hash, id);
      PIC_STATS.saved++;
    }
    return 'https://drive.google.com/thumbnail?id=' + id + '&sz=w2000';
  } catch (err) {
    PIC_STATS.failed.push(String(err && err.message || err));
    return dataUri;   // still shown on the site, just a bigger download
  }
}

/** Run from the editor after changing the Handbook or this code: rebuilds the Handbook data right away
 *  (the website picks it up on its next load) and reports what happened to the pictures. */
function refreshHandbookNow() {
  const hb = buildHandbook_();
  const payload = JSON.stringify(hb);
  writeCache_(CacheService.getScriptCache(), 'hb_', payload, 3600);
  CacheService.getScriptCache().put('hb_at', String(Date.now()), 3600);
  const html = hb.handbookHtml || (hb.guides || []).map(g => g.html).join('');
  Logger.log('Errors: ' + JSON.stringify(hb.errors));
  if (hb.guides) Logger.log('Handbooks folder: ' + hb.guides.length + ' docs · ' + hb.guides.map(g => (g.folder ? g.folder + ' ▸ ' : '') + g.name).join(' | '));
  Logger.log('Pictures in the Handbook export: ' + (html.match(/<img/g) || []).length +
    ' · saved to "Hub pictures" now: ' + PIC_STATS.saved + ' · already saved: ' + PIC_STATS.reused +
    ' · kept inline: ' + (html.match(/<img src="data:/g) || []).length);
  if (PIC_STATS.failed.length) Logger.log('Picture problem: ' + PIC_STATS.failed[0]);
  Logger.log('Handbook download size: ' + Math.round(payload.length / 1024) + ' KB. "Program Handbook" notes left: ' + (html.match(/see the <a/g) || []).length);
}

/* ------------------------------------------------------------------ Handbooks folder
 * Handbooks/                         ← link in Settings ▸ "Handbooks Folder"
 *   Note shown on every rotation     (Google Doc: shown at the top of every rotation guide)
 *   How to edit these Handbooks      (Google Doc: instructions only, not shown on the site)
 *   Policies/                        (one Google Doc per policy → Resources)
 *   Inpatient Rehab/, Consult Service/, Outpatient/, EMG/EDX/, Neurorehab/, Elective/, …
 *                                    (one Google Doc per rotation; the folder name is its category on the site)
 * The doc's name is the page title. A doc named like a row in the Control Panel "Rotations" tab gets that row's
 * schedule codes and details; a new doc simply appears as a new guide. */
function folderIdFromLink_(s) {
  if (!s) return '';
  const m = String(s).match(/folders\/([a-zA-Z0-9_-]{20,})/) || String(s).match(/[?&]id=([a-zA-Z0-9_-]{20,})/);
  if (m) return m[1];
  return /^[a-zA-Z0-9_-]{20,}$/.test(String(s).trim()) ? String(s).trim() : '';
}
function handbookDocs_(folderId) {
  const root = DriveApp.getFolderById(folderId), out = [];
  const add = (folder, name) => {
    const it = folder.getFilesByType(MimeType.GOOGLE_DOCS);
    while (it.hasNext()) { const f = it.next(); if (!f.isTrashed()) out.push({ id: f.getId(), name: f.getName(), folder: name, updated: f.getLastUpdated().toISOString() }); }
  };
  add(root, '');
  const subs = root.getFolders();
  while (subs.hasNext()) { const sf = subs.next(); if (!sf.isTrashed()) add(sf, sf.getName()); }
  // root docs: only the "every rotation" note is shown on the site
  return out.filter(d => d.folder || /every rotation|notice|note for all/i.test(d.name));
}
/** Exports several Docs at once (in parallel) and slims each one like exportDoc_. */
function exportDocs_(ids) {
  const token = ScriptApp.getOAuthToken(), out = [];
  for (let i = 0; i < ids.length; i += 10) {
    const batch = ids.slice(i, i + 10);
    let res;
    try { res = UrlFetchApp.fetchAll(batch.map(id => ({ url: 'https://docs.google.com/document/d/' + id + '/export?format=html', headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true }))); }
    catch (e) { res = batch.map(id => { try { return UrlFetchApp.fetch('https://docs.google.com/document/d/' + id + '/export?format=html', { headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true }); } catch (err) { return null; } }); }
    res.forEach((r, j) => {
      if (!r) out.push({ error: 'could not export' });
      else if (r.getResponseCode() !== 200) out.push({ error: 'could not export (HTTP ' + r.getResponseCode() + ')' });
      else out.push({ html: slimDocHtml_(r.getContentText(), batch[j]) });
    });
  }
  return out;
}

/* Which master-Handbook section goes to which doc (name, folder). Matched against the section's Heading 1 text. */
const HB_SPLIT = [
  [/departure/, 'Coverage & Departure Protocol', 'Policies'],
  [/didactic/, 'Didactics Attendance Policy', 'Policies'],
  [/\bpto\b/, 'PTO Policy', 'Policies'],
  [/family and medical|fmla/, 'FMLA & Leave Policies', 'Policies'],
  [/grievance/, 'Grievances & Due Process', 'Policies'],
  [/disciplinary/, 'Disciplinary Actions for Academic Reasons', 'Policies'],
  [/larkin south|waterford/, 'Larkin South Consults / Waterford SNF', 'Consult Service'],
  [/west palm beach/, 'West Palm Beach VA', 'Consult Service'],
  [/west gables/, 'West Gables Rehabilitation Hospital', 'Inpatient Rehab'],
  [/catherine/, "St. Catherine's West Rehabilitation Hospital", 'Inpatient Rehab'],
  [/encompass/, 'Encompass Health Rehabilitation Hospital - Sunrise', 'Inpatient Rehab'],
  [/anthony/, "St. Anthony's Rehabilitation Hospital", 'Inpatient Rehab'],
  [/pediatrics (1|i)\b/, 'Pediatric PM&R/ PED I', 'Inpatient Rehab'],
  [/pediatrics ii/, 'PED II / Prosthetics & Orthotics', 'Outpatient'],
  [/general outpatient|integrative spine/, 'ISS / Integrative Spine & Sports (Outpatient)', 'Outpatient'],
  [/electrodiagnos/, 'Electrodiagnostics (EDX) - EMG Rotation', 'EMG/EDX'],
  [/neurorehab/, 'Neurorehab / Design Neuroscience Center', 'Neurorehab'],
  [/mouhanna/, 'Interventional Pain — Dr. Joseph Mouhanna', 'Outpatient'],
  [/hatgis/, 'Interventional Pain — Dr. Jesse Hatgis', 'Outpatient'],
  [/davis|\broa\b/, 'Interventional Pain — Drs. Davis & Roa', 'Elective'],
  [/^electives$/, 'Electives', 'Elective'],
  [/rheumatology/, 'Rheumatology — Dr. Barry Waters', 'Elective'],
  [/broward|gruskin/, 'Outpatient PM&R — Dr. Alan Gruskin', 'Elective'],
  [/wound care/, 'Wound Care — Dr. Perez-Clavijo', 'Elective'],
  [/hospice/, 'Hospice & Palliative Medicine — Dr. Rejtman', 'Elective'],
  [/orthopedic surgery/, 'Orthopedic Surgery (Sports Medicine) — Dr. Schapiro', 'Elective'],
];
const HB_HOWTO = [
  'How to edit these Handbooks',
  'Each Google Doc in this folder is one page on the hub website (larkinpmr.github.io). Edits show up on the site within about 30 minutes, or right away if a chief runs refreshHandbookNow in Apps Script.',
  '• The document\'s NAME is the page title on the site. Rename the doc to rename the page.',
  '• The FOLDER is the group it appears under on the Rotation Guides page (Inpatient Rehab, Elective, …). Move a doc to another folder to move it on the site.',
  '• Policies go in the Policies folder; they appear under Resources.',
  '• To add a rotation: make a new Google Doc in the right folder (File ▸ Make a copy of an existing guide keeps the look) and write the guide. It appears on the site automatically. To give it a schedule code (so it shows in the resident schedule and personal calendars), a chief adds a row with the SAME name in the Control Panel "Rotations" tab.',
  '• To remove a rotation: move its doc to the trash.',
  '• "Note shown on every rotation" appears at the top of every rotation guide.',
  '• Red text stays red on the site; use it for warnings and "⚠ Confirm" notes. Pictures, tables and links all carry over.',
  '• Never put patient information here. Use Suggesting mode for big changes so the chiefs can review them.',
];

/** Run ONCE from the editor: copies each rotation and policy out of the current Handbook Doc into its own Google Doc
 *  (formatting, pictures and tables kept) inside a new "Handbooks" folder, and points the site at that folder.
 *  The original Handbook is not changed. Safe to run again: docs that already exist are skipped. */
function setupHandbooksFolder() {
  const started = Date.now();
  const settings = panelSettings_();
  const masterId = idFromLink_(settings['Handbook Doc']) || FALLBACK['Handbook Doc'];
  const master = DocumentApp.openById(masterId), body = master.getBody(), n = body.getNumChildren();
  // folders
  let root = null;
  const existingId = folderIdFromLink_(settings['Handbooks Folder']);
  if (existingId) root = DriveApp.getFolderById(existingId);
  if (!root) { const it = DriveApp.getRootFolder().getFoldersByName('Handbooks'); root = it.hasNext() ? it.next() : DriveApp.getRootFolder().createFolder('Handbooks'); }
  const sub = name => { const it = root.getFoldersByName(name); return it.hasNext() ? it.next() : root.createFolder(name); };
  const exists = (folder, name) => folder.getFilesByName(name).hasNext();
  // sections = Heading 1 paragraphs
  const heads = [];
  for (let i = 0; i < n; i++) {
    const el = body.getChild(i);
    if (el.getType() === DocumentApp.ElementType.PARAGRAPH && el.asParagraph().getHeading() === DocumentApp.ParagraphHeading.HEADING1) {
      const t = el.asParagraph().getText().replace(/\s+/g, ' ').trim();
      if (t) heads.push({ i: i, title: t });
    }
  }
  if (!heads.length) throw new Error('No Heading 1 titles found in the Handbook. Each rotation title must use the Heading 1 style.');
  const copyRange = (from, to, nb) => {
    for (let j = from; j < to; j++) {
      const el = body.getChild(j), T = DocumentApp.ElementType;
      try {
        if (el.getType() === T.PARAGRAPH) nb.appendParagraph(el.copy().asParagraph());
        else if (el.getType() === T.LIST_ITEM) nb.appendListItem(el.copy().asListItem());
        else if (el.getType() === T.TABLE) nb.appendTable(el.copy().asTable());
      } catch (e) { /* skip anything Docs can't copy (e.g. a table of contents) */ }
    }
    // tidy: drop the blank first line of a new doc and blank lines at the end
    const isBlank = el => el.getType() === DocumentApp.ElementType.PARAGRAPH && !el.asParagraph().getText().trim() && el.asParagraph().getNumChildren() <= 1 && !/INLINE_IMAGE|HORIZONTAL_RULE/.test(String(el.asParagraph().getNumChildren() ? el.asParagraph().getChild(0).getType() : ''));
    // Google won't remove some paragraphs (e.g. the one after a table, or the last one): those are simply left in place
    const tryRemove = el => { try { el.removeFromParent(); return true; } catch (e) { return false; } };
    if (nb.getNumChildren() > 1 && isBlank(nb.getChild(0))) tryRemove(nb.getChild(0));
    while (nb.getNumChildren() > 2 && isBlank(nb.getChild(nb.getNumChildren() - 2)) && isBlank(nb.getChild(nb.getNumChildren() - 1))) {
      if (!tryRemove(nb.getChild(nb.getNumChildren() - 1))) break;
    }
  };
  const makeDoc = (name, folder, fill) => {
    if (exists(folder, name)) return 'skipped';
    const d = DocumentApp.create(name), nb = d.getBody();
    nb.setMarginTop(body.getMarginTop()).setMarginBottom(body.getMarginBottom()).setMarginLeft(body.getMarginLeft()).setMarginRight(body.getMarginRight());
    let note = 'made';
    try {
      fill(nb);
      const c0 = nb.getChild(0);
      if (nb.getNumChildren() > 1 && c0.getType() === DocumentApp.ElementType.PARAGRAPH && !c0.asParagraph().getText().trim() && !c0.asParagraph().getNumChildren()) { try { c0.removeFromParent(); } catch (e) { } }
    } catch (e) { note = 'made, but check it: ' + e.message; }
    d.saveAndClose();
    DriveApp.getFileById(d.getId()).moveTo(folder);   // always file it in the folder, even if something above went wrong
    return note;
  };
  const log = [];
  // how-to and every-rotation note
  log.push(HB_HOWTO[0] + ': ' + makeDoc(HB_HOWTO[0], root, nb => { nb.appendParagraph(HB_HOWTO[0]).setHeading(DocumentApp.ParagraphHeading.HEADING1); HB_HOWTO.slice(1).forEach(t => nb.appendParagraph(t)); }));
  log.push('Note shown on every rotation: ' + makeDoc('Note shown on every rotation', root, nb => {
    for (let j = 0; j < heads[0].i; j++) { const el = body.getChild(j); if (el.getType() === DocumentApp.ElementType.PARAGRAPH && /please note/i.test(el.asParagraph().getText())) nb.appendParagraph(el.copy().asParagraph()); }
    if (nb.getNumChildren() > 1 && !nb.getChild(0).asParagraph().getText().trim()) nb.getChild(0).removeFromParent();
  }));
  // one doc per section
  for (let k = 0; k < heads.length; k++) {
    if (Date.now() - started > 5 * 60 * 1000) { log.push('Stopped to stay under Google\'s time limit: run setupHandbooksFolder again to finish (finished docs are skipped).'); break; }
    const h = heads[k], key = h.title.toLowerCase();
    const hit = HB_SPLIT.find(r => r[0].test(key));
    const name = hit ? hit[1] : h.title.replace(/\b([A-Z])([A-Z']+)\b/g, (m, a, b) => a + b.toLowerCase());
    const folder = sub(hit ? hit[2] : 'Other');
    log.push(name + ' → ' + (hit ? hit[2] : 'Other') + ': ' + makeDoc(name, folder, nb => copyRange(h.i, k + 1 < heads.length ? heads[k + 1].i : n, nb)));
  }
  // point the site at the folder
  const ss = SpreadsheetApp.getActiveSpreadsheet(), st = ss.getSheetByName('Settings');
  const rows = st.getDataRange().getValues();
  let r = rows.findIndex(x => String(x[0]).trim().toLowerCase() === 'handbooks folder');
  if (r < 0) { st.appendRow(['Handbooks Folder', root.getUrl()]); } else st.getRange(r + 1, 2).setValue(root.getUrl());
  CacheService.getScriptCache().remove('hb_n');
  Logger.log(log.join('\n'));
  Logger.log('Handbooks folder: ' + root.getUrl() + '\nThe Control Panel Settings tab now points the site at this folder. Next: run refreshHandbookNow.');
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
    const link = off ? '' : meetLink_(talks, settings);
    if (link) ev.push(fold_('LOCATION:' + esc_(link)), fold_('URL:' + link));
    else if (talks[0].location && !off) ev.push(fold_('LOCATION:' + esc_(talks[0].location)));
    const desc = (link ? (/zoom\.us/i.test(link) ? 'Join Zoom: ' : 'Join meeting: ') + link + '\n\n' : '') + talks.map(x => '• ' + x.topic + (x.speaker ? ' — ' + x.speaker : '')).join('\n') + (talks[0].block ? '\n\n' + talks[0].block : '');
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
  const cLink = col(/meeting|zoom|join|^link$|^url$/), cConf = col(/confirm/);
  const out = []; let cur = { date: '', location: '', time: '', link: '' }, block = '';
  rows.slice(hi + 1).forEach(r => {
    const g = i => (i >= 0 ? (r[i] || '') : '');
    const vals = r.filter(Boolean).filter((v, i, a) => a.indexOf(v) === i);
    if (vals.length === 1 && /block\s*\d/i.test(vals[0])) { block = vals[0]; return; }
    if (!g(cTopic) && vals.some(v => /block\s*\d/i.test(v))) { block = vals.find(v => /block\s*\d/i.test(v)); return; }
    const iso = isoDate_(g(cDate));
    if (iso && iso !== cur.date) cur = { date: iso, location: g(cLoc), time: g(cTime), link: '' };
    if (g(cLoc)) cur.location = g(cLoc);
    if (/^https?:\/\//i.test(g(cLink))) cur.link = g(cLink);   // a meeting link carries down to the rest of that day
    const topic = g(cTopic);
    if (!topic || !cur.date) return;
    out.push({ date: cur.date, time: cur.time, rowTime: g(cTime), location: cur.location, topic: topic, speaker: g(cSpk), block: block, link: cur.link,
      // Confirmed column: "yes"/"confirmed" → reminder · blank → invitation · anything else (rescheduled…) → nothing
      confKnown: cConf >= 0, confState: cConf < 0 ? '' : !g(cConf) ? 'blank' : /^(y|yes|confirmed)\b/i.test(g(cConf)) ? 'yes' : 'other' });
    out[out.length - 1].confirmed = out[out.length - 1].confState === 'yes';
  });
  return out;
}

/** A session's meeting link: one typed in the didactic sheet, else Settings "Virtual lecture link" when the location says Virtual. */
function meetLink_(talks, settings) {
  talks = [].concat(talks);
  const own = talks.map(t => t.link).filter(Boolean)[0];
  if (own) return own;
  const def = String(settings['Virtual lecture link'] || '').trim();
  return /^https?:\/\//i.test(def) && talks.some(t => /virtual/i.test(t.location || '')) ? def : '';
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
function esc_(s) { return String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n'); }
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


/* ------------------------------------------------------------------ personal calendar (.ics)
 * ?calendar=me&name=Full Name → that resident's rotation blocks, onboarding reminders and the lectures they present.
 * Onboarding reminders: inpatient rehab rotations and the WPB VA at 7 and 6 weeks before the start;
 * everything else at 3 and 2 weeks. Override per rotation with a Rotations-tab column
 * "Onboarding reminders (weeks before)", e.g. "8, 6". */
const MONTH_NAMES = ['July', 'August', 'September', 'October', 'November', 'December', 'January', 'February', 'March', 'April', 'May', 'June'];

function normCode_(s) { return String(s || '').toUpperCase().replace(/\s*\/\s*/g, ' / ').replace(/\s+/g, ' ').trim(); }

function rotationTable_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss && ss.getSheetByName('Rotations');
  if (!sh) return [];
  const v = values_(sh); if (v.length < 2) return [];
  const h = v[0].map(x => String(x).trim().toLowerCase());
  const col = name => h.indexOf(name);
  return v.slice(1).filter(r => r[col('rotation')]).map(r => ({
    name: String(r[col('rotation')]).trim(),
    short: String(col('short name') >= 0 ? r[col('short name')] : '').trim(),
    category: String(col('category') >= 0 ? r[col('category')] : ''),
    codes: String(col('schedule codes') >= 0 ? r[col('schedule codes')] : '').split(';').map(normCode_).filter(Boolean),
    lead: String(col('onboarding reminders (weeks before)') >= 0 ? r[col('onboarding reminders (weeks before)')] : '').split(/[,;\s]+/).map(Number).filter(n => n > 0)
  }));
}

function leadWeeks_(rot) {
  if (rot && rot.lead.length) return rot.lead.slice().sort((a, b) => b - a);
  const inpatient = rot && (/inpatient/i.test(rot.category) || rot.codes.indexOf('WPB') >= 0);
  return inpatient ? [7, 6] : [3, 2];
}

/** Same rules as the website: find "Resident | July … June" header rows, PGY labels above them. */
function parseResidents_(rows) {
  const isMonth = c => /^(jul|aug|sep|oct|nov|dec|jan|feb|mar|apr|may|jun)[a-z]*\.?(\s+\d{2,4})?$/i.test(c);
  const out = []; let pgy = '', map = null;
  rows.map(r => r.map(c => String(c == null ? '' : c).trim())).forEach(r => {
    const pg = r.join(' ').match(/PGY\s*-?\s*([2-5])/i);   // "PGY-2", "PGY 2", "PGY - 2"
    if (r.filter(isMonth).length >= 6) {
      const first = r.findIndex(isMonth);
      let ni = r.findIndex(c => /resident/i.test(c)); if (ni < 0 || ni > first) ni = Math.max(0, first - 1);
      // a month can span two columns (first half / second half of the month, split on the 16th)
      // a month header covering two columns (merged, repeated, or a blank header right after it) = first half / second half
      const own = []; let last = -1;
      r.forEach((c, k) => { if (isMonth(c)) { own[k] = c; last = k; } else if (!c && last >= 0 && k === last + 1 && own[last] && String(own[k - 2] || '').charAt(0) !== '+') { own[k] = '+' + own[last]; } else last = -1; });
      const monthOf = k => String(own[k] || '').replace(/^\+/, '').slice(0, 3).toLowerCase();
      map = { name: ni, months: MONTH_NAMES.map(m => own.map((c, k) => c && monthOf(k) === m.slice(0, 3).toLowerCase() ? k : -1).filter(k => k >= 0).slice(0, 2)) };
      if (pg) pgy = 'PGY-' + pg[1];
      return;
    }
    if (!map) { if (pg) pgy = 'PGY-' + pg[1]; return; }
    const name = r[map.name] || '';
    const cell = k => (r[k] || '').split(',')[0].trim();
    const months = map.months.map(ks => ks.length ? cell(ks[0]) : '');
    const months2 = map.months.map((ks, i) => { const b = ks.length > 1 ? cell(ks[ks.length - 1]) : ''; return b && normCode_(b) !== normCode_(months[i]) ? b : ''; });
    const filled = months.filter(Boolean).length;
    if (pg && (filled < 6 || /pgy/i.test(name))) { pgy = 'PGY-' + pg[1]; return; }
    if (name && filled >= 6 && !/key|resident/i.test(name)) out.push({ name: name, pgy: pgy, months: months, months2: months2 });
  });
  return out;
}

function buildMyCalendar_(who) {
  const settings = panelSettings_();
  const idOf = key => idFromLink_(settings[key]) || FALLBACK[key];
  const site = settings['Website address'] || '';
  const yearMatch = String(settings['Academic Year'] || '').match(/(20\d\d)/);
  const now = new Date();
  const ay = yearMatch ? Number(yearMatch[1]) : (now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1);
  const monthStart = i => new Date(Date.UTC(ay + (i >= 6 ? 1 : 0), (i + 6) % 12, 1));
  const ymd = d => Utilities.formatDate(d, 'UTC', 'yyyyMMdd');
  const stamp = Utilities.formatDate(now, 'UTC', "yyyyMMdd'T'HHmmss'Z'");

  const people = parseResidents_(readSheet_(idOf('Resident Schedule Sheet'), settings['Resident Schedule tab']));
  const lc = who.toLowerCase();
  const me = people.find(p => p.name.toLowerCase() === lc) || people.find(p => p.name.toLowerCase().indexOf(lc) >= 0);
  const uidBase = 'me-' + who.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const out = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Larkin PM&R Hub//My calendar//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    fold_('X-WR-CALNAME:' + esc_('PM&R · ' + (me ? me.name : who))), 'X-WR-TIMEZONE:' + TZ, 'REFRESH-INTERVAL;VALUE=DURATION:PT1H', 'X-PUBLISHED-TTL:PT1H'];
  if (!me) { out.push('END:VCALENDAR'); return out.join('\r\n') + '\r\n'; }

  const rots = rotationTable_();
  const rotOf = raw => { const n = normCode_(raw), first = normCode_(String(raw).split(',')[0]); return rots.find(r => r.codes.indexOf(n) >= 0 || r.codes.indexOf(first) >= 0) || null; };
  const allDay = (uid, start, endExcl, summary, desc, alarm) => {
    const ev = ['BEGIN:VEVENT', 'UID:' + uid + '@larkin-pmr-hub', 'DTSTAMP:' + stamp, 'DTSTART;VALUE=DATE:' + ymd(start), 'DTEND;VALUE=DATE:' + ymd(endExcl),
      fold_('SUMMARY:' + esc_(summary)), 'TRANSP:TRANSPARENT'];
    if (desc) ev.push(fold_('DESCRIPTION:' + esc_(desc)));
    if (alarm) ev.push('BEGIN:VALARM', 'ACTION:DISPLAY', fold_('DESCRIPTION:' + esc_(summary)), 'TRIGGER;RELATED=START:PT9H', 'END:VALARM');
    ev.push('END:VEVENT'); Array.prototype.push.apply(out, ev);
  };

  // Rotation blocks (consecutive half-months with the same assignment; a split month changes on the 16th)
  const slot = k => (k % 2 && me.months2[k >> 1]) ? me.months2[k >> 1] : me.months[k >> 1];
  const slotStart = k => k >= 24 ? monthStart(12) : (k % 2 ? new Date(monthStart(k >> 1).getTime() + 15 * 86400000) : monthStart(k >> 1));
  const fmt = d => Utilities.formatDate(d, 'UTC', 'MMM d');
  let k = 0;
  while (k < 24) {
    const raw = slot(k); if (!raw) { k++; continue; }
    const key = x => { const r = x ? rotOf(x) : null; return r ? 'r:' + r.name : normCode_(x || ''); };   // "WF/C" = "WF/Consults"
    let j = k; while (j + 1 < 24 && key(slot(j + 1)) === key(raw)) j++;
    const i = k >> 1, rot = rotOf(raw), label = rot ? (rot.short || rot.name) : raw;
    const start = slotStart(k), end = slotStart(j + 1);
    allDay(uidBase + '-rot-' + i + (k % 2 ? 'h' : ''), start, end, 'Rotation: ' + label, (rot ? rot.name + '\n' : '') + fmt(start) + ' – ' + fmt(new Date(end.getTime() - 86400000)) + (site ? '\nGuide: ' + site + '#rotations' : ''), false);
    // Onboarding reminders before each new rotation
    leadWeeks_(rot).forEach((w, k) => {
      const d = new Date(start.getTime() - w * 7 * 86400000), next = new Date(d.getTime() + 86400000);
      allDay(uidBase + '-onb-' + i + (k % 2 ? 'h' : '') + '-' + w, d, next, (k === 0 ? 'Start onboarding: ' : 'Onboarding reminder: ') + label + ' (starts ' + Utilities.formatDate(start, 'UTC', 'MMM d') + ')',
        'Your ' + (rot ? rot.name : label) + ' rotation starts ' + Utilities.formatDate(start, 'UTC', 'EEEE, MMMM d') + '. Complete credentialing, EMR and facility access, and arrange shadowing now.' + (site ? '\nGuide: ' + site + '#rotations' : ''), true);
    });
    k = j + 1;
  }

  // Lectures this resident presents
  const talks = parseDidactics_(readSheet_(idOf('Didactic Schedule Sheet'), settings['Didactic Schedule tab']));
  const toks = me.name.split(/\s+/).slice(1).filter(t => t.length >= 3);
  const presents = sp => toks.some(t => new RegExp('\\b' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i').test(sp || ''));
  const hours = Number(settings['Didactics length (hours)']) || 3;
  talks.filter(t => presents(t.speaker)).forEach((t, n) => {
    const day = t.date.replace(/-/g, ''), tm = parseTime_(t.time);
    const ev = ['BEGIN:VEVENT', 'UID:' + uidBase + '-talk-' + day + '-' + n + '@larkin-pmr-hub', 'DTSTAMP:' + stamp];
    if (tm) ev.push('DTSTART;TZID=' + TZ + ':' + day + 'T' + hhmm_(tm.start), 'DTEND;TZID=' + TZ + ':' + day + 'T' + hhmm_(Math.min(tm.end != null ? tm.end : tm.start + hours * 60, 1439)));
    else { const nd = new Date(t.date + 'T12:00:00Z'); nd.setUTCDate(nd.getUTCDate() + 1); ev.push('DTSTART;VALUE=DATE:' + day, 'DTEND;VALUE=DATE:' + ymd(nd)); }
    ev.push(fold_('SUMMARY:' + esc_('You present: ' + t.topic)));
    const link = meetLink_(talks.filter(x => x.date === t.date), settings);
    if (link) ev.push(fold_('LOCATION:' + esc_(link)), fold_('URL:' + link), fold_('DESCRIPTION:' + esc_((/zoom\.us/i.test(link) ? 'Join Zoom: ' : 'Join meeting: ') + link)));
    else if (t.location) ev.push(fold_('LOCATION:' + esc_(t.location)));
    ev.push('BEGIN:VALARM', 'ACTION:DISPLAY', fold_('DESCRIPTION:' + esc_('You present: ' + t.topic)), 'TRIGGER:-P7D', 'END:VALARM', 'END:VEVENT');
    Array.prototype.push.apply(out, ev);
  });
  out.push('END:VCALENDAR');
  return out.join('\r\n') + '\r\n';
}

/** Run from the editor: logs the personal calendar for one resident. */
function testMyCalendar() {
  const name = 'Courtney Baxter';
  const ics = buildMyCalendar_(name);
  Logger.log((ics.split('BEGIN:VEVENT').length - 1) + ' events for ' + name);
  Logger.log(ics.split('\r\n').filter(l => /^(SUMMARY|DTSTART)/.test(l)).slice(0, 40).join('\n'));
}

/* ------------------------------------------------------------------ link checker
 * Run checkHandbookLinks from the editor (e.g. at each quarterly review). It opens every link in the
 * Handbook and writes the results to a "Link Check" tab in this Control Panel: problems first. */
function checkHandbookLinks() {
  const settings = panelSettings_();
  const token = ScriptApp.getOAuthToken();
  const rawExport = id => {
    const res = UrlFetchApp.fetch('https://docs.google.com/document/d/' + id + '/export?format=html', { headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) throw new Error('Could not open a Handbook doc (HTTP ' + res.getResponseCode() + ')');
    return res.getContentText();
  };
  const text = s => s.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
  // [{ html, sectionAt(i) }]: one per doc in the Handbooks folder, or the single Handbook split by Heading 1
  const sources = [];
  const folderId = folderIdFromLink_(settings['Handbooks Folder']);
  if (folderId) handbookDocs_(folderId).forEach(d => sources.push({ html: rawExport(d.id), sectionAt: () => d.name }));
  else {
    const html = rawExport(idFromLink_(settings['Handbook Doc']) || FALLBACK['Handbook Doc']);
    const heads = []; html.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/g, (m, t, i) => { heads.push({ at: i, title: text(t.replace(/<br\s*\/?>/g, ' ')) }); return m; });
    sources.push({ html: html, sectionAt: i => { let t = 'Front pages'; heads.forEach(h => { if (h.at < i) t = h.title; }); return t; } });
  }
  const links = {};
  sources.forEach(src => src.html.replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g, (m, href, inner, i) => {
    let url = href.replace(/&amp;/g, '&');
    const g = url.match(/^https:\/\/www\.google\.com\/url\?q=([^&]+)/); if (g) url = decodeURIComponent(g[1]);
    if (!/^https?:/i.test(url)) return m;
    if (!links[url]) links[url] = { url: url, label: text(inner) || url, section: src.sectionAt(i) };
    return m;
  }));
  const list = Object.keys(links).map(k => links[k]);
  const opts = u => ({ url: u, muteHttpExceptions: true, followRedirects: false, headers: { 'User-Agent': 'Mozilla/5.0 (Larkin PM&R Hub link check)' } });
  // fetch in parallel; if one link fails outright, split the group so the rest still run in parallel
  const fetchSafe = reqs => {
    try { return UrlFetchApp.fetchAll(reqs); }
    catch (e) {
      if (reqs.length === 1) return [{ error: String(e.message || e) }];
      const half = Math.ceil(reqs.length / 2);
      return fetchSafe(reqs.slice(0, half)).concat(fetchSafe(reqs.slice(half)));
    }
  };
  const started = Date.now(), outOfTime = () => Date.now() - started > 4.5 * 60 * 1000;   // Google stops scripts at 6 minutes
  list.forEach(l => { l.status = 'Check'; l.code = ''; l.note = 'Not checked (ran out of time); run checkHandbookLinks again'; });
  for (let i = 0; i < list.length && !outOfTime(); i += 25) {
    const batch = list.slice(i, i + 25);
    fetchSafe(batch.map(l => opts(l.url))).forEach((r, j) => {
      batch[j].note = '';
      const l = batch[j];
      if (r.error) { l.status = 'Broken'; l.code = ''; l.note = r.error; return; }
      l.code = r.getResponseCode();
      const loc = String((r.getHeaders() || {}).Location || (r.getHeaders() || {}).location || '');
      if (l.code >= 300 && l.code < 400 && /accounts\.google\.com|ServiceLogin/.test(loc)) { l.status = 'Private'; l.note = 'Opens a Google sign-in page: share it as "Anyone with the link" so every resident can open it'; }
      else if (l.code >= 300 && l.code < 400) { l.status = 'Check'; l.redirect = loc; }
      else if (l.code === 401 || l.code === 403) { l.status = 'Private'; l.note = 'Needs a login or blocks automatic checks; open it yourself to confirm'; }
      else if (l.code === 404 || l.code === 410) { l.status = 'Broken'; l.note = 'Page not found'; }
      else if (l.code >= 400) { l.status = 'Check'; l.note = 'The site answered ' + l.code + '; open it yourself to confirm'; }
      else l.status = 'OK';
    });
  }
  // follow ordinary redirects to their final page
  const redirected = list.filter(l => l.status === 'Check' && l.redirect);
  for (let i = 0; i < redirected.length && !outOfTime(); i += 25) {
    const batch = redirected.slice(i, i + 25);
    fetchSafe(batch.map(l => Object.assign(opts(l.url), { followRedirects: true }))).forEach((r, j) => {
      const l = batch[j];
      if (r.error) { l.status = 'Broken'; l.note = r.error; return; }
      l.code = r.getResponseCode();
      l.status = l.code < 400 ? 'OK' : (l.code === 404 || l.code === 410 ? 'Broken' : 'Check');
      if (l.status !== 'OK') l.note = 'The site answered ' + l.code + ' after redirecting';
    });
  }
  const order = { Broken: 0, Private: 1, Check: 2, OK: 3 };
  list.sort((a, b) => order[a.status] - order[b.status]);
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName('Link Check') || ss.insertSheet('Link Check');
  sh.clear();
  const when = Utilities.formatDate(new Date(), TZ, 'MMM d, yyyy h:mm a');
  const rows = [['Status', 'Code', 'Rotation / section', 'Link text', 'Link', 'What to do']]
    .concat(list.map(l => [l.status, l.code, l.section, l.label, l.url, l.note || '']));
  sh.getRange(1, 1, rows.length, 6).setValues(rows);
  sh.getRange(1, 1, 1, 6).setFontWeight('bold');
  sh.setFrozenRows(1);
  sh.getRange(rows.length + 2, 1).setValue('Checked ' + when + ' · ' + list.length + ' links. Fix links in the Handbook doc, then run checkHandbookLinks again.');
  const colors = { Broken: '#F8D7DA', Private: '#FFF3CD', Check: '#FFF3CD', OK: '#FFFFFF' };
  if (list.length) sh.getRange(2, 1, list.length, 6).setBackgrounds(list.map(l => Array(6).fill(colors[l.status])));
  sh.autoResizeColumns(1, 4);
  const count = s => list.filter(l => l.status === s).length;
  Logger.log(list.length + ' links checked: ' + count('OK') + ' OK · ' + count('Broken') + ' broken · ' + count('Private') + ' private · ' + count('Check') + ' to check by hand. See the "Link Check" tab.');
}

/* ------------------------------------------------------------------ guest lecturer reminder emails
 * Once a day (8 AM) the script reads the Didactic Schedule and emails each lecturer on the Control Panel's private
 * "Lecturers" tab before their lecture (7 days ahead by default). Every email is written to the private
 * "Lecture Reminders" tab, so nobody gets the same reminder twice. A moved lecture gets a new reminder saying
 * the date changed; a reminded lecture that disappears or is marked canceled triggers an alert to the chief Gmail;
 * failures are emailed to the chief Gmail; on Mondays the chiefs get a list of guest lectures with no email on file.
 *   installLectureReminders  run once: creates the tabs and turns on the daily check
 *   previewLectureReminders  lists the next 6 weeks: who gets what, when (sends nothing)
 *   sendTestReminder         sends sample reminders to the test address
 *   checkLecturerEmails      emails the chiefs the guest lectures with no email on file
 * Settings rows: Lecture reminders (test / on / off; blank = test: everything goes to the test address) ·
 * Lecture reminder test email · Lecture reminder days ("7" or "7, 1") · Didactics start time (blank = 2:00 PM) ·
 * Guest lecture length (hours) (blank = 2) · Virtual lecture link · Lecture reminder signature.
 * "Lecture reminder…" rows are kept off the public website. */
const PRIVATE_TABS = ['Lecturers', 'Lecture Reminders', 'Lecture Locations', 'Invitations', 'Approved Emails', 'Sign-ins'];
const LOCATION_HEAD = ['Location (as written in the Didactic Schedule)', 'What the email says', 'Address (optional: becomes a directions link)'];
const LECTURER_HEAD = ['Name (as written in the Didactic Schedule)', 'Email', 'Also written as (separate with ;)', 'Send reminders (yes/no)', 'Notes'];
const REMINDER_HEAD = ['Sent', 'Lecture date', 'Topic', 'Speaker', 'Email', 'Days before', 'Status'];

function installLectureReminders() {
  const lec = panelSheet_('Lecturers', LECTURER_HEAD);
  panelSheet_('Lecture Reminders', REMINDER_HEAD);
  lectureLocationsTab_();
  if (lec.getLastRow() < 2) lec.getRange(2, 1, 1, 5).setValues([['Dr. Example Lecturer', 'name@example.com', 'Dr. Lecturer; John Lecturer', 'no', 'Sample row: replace it. Reminders go only to rows with an email and "yes".']]);
  lec.setColumnWidth(1, 280); lec.setColumnWidth(2, 240); lec.setColumnWidth(3, 260); lec.setColumnWidth(5, 360);
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'sendLectureReminders').forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('sendLectureReminders').timeBased().atHour(8).everyDays(1).inTimezone(TZ).create();
  const st = panelSettings_(), mode = reminderMode_(st);
  Logger.log('The daily 8 AM check is on. Mode: ' + mode.toUpperCase() + (mode === 'test' ? ' — every reminder goes to ' + testAddress_(st) + ', not to lecturers.' : mode === 'on' ? ' — reminders go to the lecturers.' : ' — nothing is sent.') +
    '\nNext: add guest lecturers to the "Lecturers" tab, run previewLectureReminders, then sendTestReminder.\nWhen the test emails look right, set Settings "Lecture reminders" to on.');
}

/** "Lecture Locations" tab: turns sheet shorthand like "ISS" into something a guest understands. */
function lectureLocationsTab_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (ss.getSheetByName('Lecture Locations')) return;
  const sh = panelSheet_('Lecture Locations', LOCATION_HEAD);
  sh.getRange(2, 1, 2, 3).setValues([['Larkin South', 'Larkin South, G&E building, 4th floor', ''], ['ISS', '', '']]);
  sh.setColumnWidth(1, 300); sh.setColumnWidth(2, 320); sh.setColumnWidth(3, 340);
}

function lectureLocation_(loc) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Lecture Locations');
  const key = String(loc || '').trim().toLowerCase();
  const row = sh && key ? values_(sh).slice(1).find(r => String(r[0] || '').trim().toLowerCase() === key) : null;
  return { name: (row && String(row[1] || '').trim()) || String(loc || '').trim(), address: (row && String(row[2] || '').trim()) || '' };
}

function reminderDays_(settings) {
  const days = String(settings['Lecture reminder days'] || '7').split(/[,;\s]+/).map(Number).filter(n => n >= 1 && n <= 60);
  return (days.length ? days : [7]).filter((n, i, a) => a.indexOf(n) === i).sort((a, b) => b - a);
}

function normName_(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/\b(dr|doctor|prof|md|do|phd)\b\.?/g, ' ').replace(/[^a-z\s'-]/g, ' ').replace(/\s+/g, ' ').trim();
}

function readLecturers_() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Lecturers');
  if (!sh) return [];
  // the Email cell can hold several addresses ("a@x.com, b@y.org"): every reminder and invitation goes to all of them
  const emails = v => String(v || '').replace(/mailto:/gi, '').split(/[\s,;]+/).filter(e => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)).join(', ');
  return values_(sh).slice(1).map(r => ({
    name: String(r[0] || '').trim(), email: emails(r[1]),
    names: [r[0]].concat(String(r[2] || '').split(/[;\n]/)).map(normName_).filter(Boolean),
    on: !/^(no|n|off|false|0)$/i.test(String(r[3] || '').trim()),
  })).filter(l => l.name && /@/.test(l.email) && l.on && !/@example\.com$/i.test(l.email));
}

/** Which lecturers a Speaker cell refers to: "Dr. Kahn", "Stuart Kahn / Dr. Ortiz", etc. */
function matchLecturers_(speaker, lecturers) {
  const parts = String(speaker || '').split(/\s*(?:\/|&|,|\band\b|\+)\s*/i).map(normName_).filter(Boolean);
  const found = [];
  parts.forEach(p => {
    let hit = lecturers.filter(l => l.names.indexOf(p) >= 0);
    if (!hit.length && p.indexOf(' ') < 0) { // just a last name, e.g. "Dr. Ortiz": use it only if one lecturer has that last name
      const byLast = lecturers.filter(l => l.names.some(n => n.split(' ').pop() === p));
      if (byLast.length === 1) hit = byLast;
    }
    hit.forEach(l => { if (found.indexOf(l) < 0) found.push(l); });
  });
  return found;
}

function daysUntil_(iso) {
  const today = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  return Math.round((Date.parse(iso + 'T12:00:00Z') - Date.parse(today + 'T12:00:00Z')) / 86400000);
}

/** "test" (default), "on" or "off" — from the Settings row "Lecture reminders". */
function reminderMode_(settings) {
  const v = String(settings['Lecture reminders'] || '').trim().toLowerCase();
  if (/^(off|no|false|0|pause|paused|stop)$/.test(v)) return 'off';
  if (/^(on|yes|true|1|live)$/.test(v)) return 'on';
  return 'test';   // blank or "test": every reminder goes to the test address instead of the lecturer
}
function testAddress_(settings) {
  let v = String(settings['Lecture reminder test email'] || '').trim();
  if (!/@/.test(v)) { const k = Object.keys(settings).find(x => /test\s*e-?mail/i.test(x) && /@/.test(settings[x])); if (k) v = String(settings[k]).trim(); }
  const m = v.replace(/^mailto:/i, '').match(/[^\s<>"',;]+@[^\s<>"',;]+/);
  return m ? m[0] : Session.getEffectiveUser().getEmail();
}
function chiefEmail_() { return Session.getEffectiveUser().getEmail(); }
function reminderLog_() { return panelSheet_('Lecture Reminders', REMINDER_HEAD); }
function readTalks_(settings) {
  const id = idFromLink_(settings['Didactic Schedule Sheet']) || FALLBACK['Didactic Schedule Sheet'];
  return parseDidactics_(readSheet_(id, settings['Didactic Schedule tab']));
}

/** Reminders due today: each reminder day d covers the days until the next smaller reminder, so a lecture
 * added late still gets one reminder. A lecture already reminded for another date counts as moved. */
function dueReminders_(settings, horizon, talks) {
  talks = talks || readTalks_(settings);
  const lecturers = readLecturers_();
  const days = reminderDays_(settings);
  const done = reminderMode_(settings) === 'on' ? /^(sent|not confirmed)/i : /^(test sent|not confirmed)/i;
  const sent = {}, datesFor = {};
  values_(reminderLog_()).slice(1).forEach(r => {
    if (!done.test(r[6])) return;
    sent[[r[1], normName_(r[2]), String(r[4]).toLowerCase(), r[5]].join('|')] = true;
    const k = normName_(r[2]) + '|' + String(r[4]).toLowerCase();
    (datesFor[k] = datesFor[k] || []).push(r[1]);
  });
  const out = [];
  talks.forEach(t => {
    const n = daysUntil_(t.date);
    if (n < 1 || n > (horizon || days[0]) || /cancel/i.test(t.topic)) return;
    const who = matchLecturers_(t.speaker, lecturers);
    if (!who.length) { if (horizon) out.push({ talk: t, n: n, lecturer: null }); return; }
    who.forEach(l => {
      const slot = days.find((d, i) => n <= d && n > (days[i + 1] || 0));
      const key = slot && [t.date, normName_(t.topic), l.email.toLowerCase(), slot].join('|');
      const before = datesFor[normName_(t.topic) + '|' + l.email.toLowerCase()] || [];
      out.push({ talk: t, n: n, lecturer: l, slot: slot, key: key, already: !!(key && sent[key]), moved: before.length > 0 && before.indexOf(t.date) < 0 });
    });
  });
  return out;
}

/** Lecture time for the email: a lecture at the usual start (or with no time) gets the flexible 2–4 PM window. */
function lectureTimes_(t, settings) {
  const len = Math.round((Number(settings['Guest lecture length (hours)']) || 2) * 60);
  const usual = parseTime_(settings['Didactics start time'] || '2:00 PM') || { start: 14 * 60, end: null };
  const own = parseTime_(t.rowTime || t.time);
  const flexible = !own || own.start === usual.start;
  const p = flexible ? usual : own;
  const end = !flexible && p.end != null ? p.end : Math.min(p.start + len, 23 * 60 + 59);
  return { start: p.start, end: end, flexible: flexible };
}

function clock_(mins) {
  const h = Math.floor(mins / 60), m = mins % 60;
  return ((h + 11) % 12 + 1) + ':' + ('0' + m).slice(-2) + ' ' + (h < 12 ? 'AM' : 'PM');
}

function reminderEmail_(t, l, settings) {
  const when = Utilities.formatDate(new Date(t.date + 'T12:00:00Z'), 'UTC', 'EEEE, MMMM d');
  const tm = lectureTimes_(t, settings);
  const time = clock_(tm.start).replace(/ (AM|PM)$/, (s, ap) => clock_(tm.end).slice(-2) === ap ? '' : s) + ' – ' + clock_(tm.end);
  const virtual = /virtual/i.test(t.location || '');  // the sheet says "Virtual" -> virtual; anything else is in person
  const link = t.link || (virtual ? (settings['Virtual lecture link'] || '') : '');
  const where = virtual ? { name: '', address: '' } : lectureLocation_(t.location);
  const place = where.name;
  const maps = where.address ? 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(where.address) : '';
  const sign = signature_(settings);
  const bare = String(l.name).replace(/\([^)]*\)/g, '').trim();
  const greet = /^\s*dr\b/i.test(bare) ? 'Dr. ' + bare.split(/\s+/).pop() : bare;
  const flexible = tm.flexible;
  const flexNote = 'Didactics start at ' + clock_(tm.start) + '. You are welcome to give your presentation at any point between ' + clock_(tm.start) + ' and ' + clock_(tm.end) + ', and we will work around your schedule. Just reply to let us know what time works best for you.';
  const rows = [['Topic', t.topic], ['Date', when], ['Time', flexible ? time + ' (flexible)' : time], ['Format', virtual ? 'Virtual' : 'In person'], ['Location', place], ['Address', where.address], ['Join link', link]].filter(r => r[1]);
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

  // Calendar: Google / Outlook buttons plus an attached .ics file (Apple Calendar, Outlook desktop, anything else).
  const ymd = t.date.replace(/-/g, '');
  const local = m => ymd + 'T' + hhmm_(m);
  const title = 'PM&R lecture: ' + t.topic;
  const calLoc = virtual ? (link || 'Virtual') : [place, where.address].filter(Boolean).join(', ');
  const details = 'Lecture for the Larkin Community Hospital South Miami PM&R residents.\nTopic: ' + t.topic + (virtual ? '\nVirtual' + (link ? ': ' + link : '') : '\nIn person' + (place ? ' at ' + place : '')) + '\n\nQuestions: reply to the reminder email.';
  const q = o => Object.keys(o).map(k => k + '=' + encodeURIComponent(o[k])).join('&');
  const google = 'https://calendar.google.com/calendar/render?' + q({ action: 'TEMPLATE', text: title }) + '&dates=' + local(tm.start) + '/' + local(tm.end) + '&' + q({ ctz: TZ, details: details, location: calLoc });
  const isoLocal = m => t.date + 'T' + hhmm_(m).replace(/(\d\d)(\d\d)(\d\d)/, '$1:$2:$3');
  const outlook = 'https://outlook.office.com/calendar/deeplink/compose?' + q({ path: '/calendar/action/compose', rru: 'addevent', subject: title, startdt: isoLocal(tm.start), enddt: isoLocal(tm.end), body: details, location: calLoc });
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Larkin PM&R Hub//Lecture//EN', 'METHOD:PUBLISH', 'BEGIN:VTIMEZONE', 'TZID:' + TZ,
    'BEGIN:DAYLIGHT', 'TZOFFSETFROM:-0500', 'TZOFFSETTO:-0400', 'TZNAME:EDT', 'DTSTART:19700308T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU', 'END:DAYLIGHT',
    'BEGIN:STANDARD', 'TZOFFSETFROM:-0400', 'TZOFFSETTO:-0500', 'TZNAME:EST', 'DTSTART:19701101T020000', 'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU', 'END:STANDARD', 'END:VTIMEZONE',
    'BEGIN:VEVENT', 'UID:lecture-' + ymd + '-' + normName_(t.topic).replace(/[^a-z0-9]+/g, '-').slice(0, 40) + '@larkin-pmr-hub',
    'DTSTAMP:' + Utilities.formatDate(new Date(), 'UTC', "yyyyMMdd'T'HHmmss'Z'"),
    'DTSTART;TZID=' + TZ + ':' + local(tm.start), 'DTEND;TZID=' + TZ + ':' + local(tm.end),
    fold_('SUMMARY:' + esc_(title)), fold_('LOCATION:' + esc_(calLoc)), fold_('DESCRIPTION:' + esc_(details))]
    .concat(link ? [fold_('URL:' + link)] : [])
    .concat(['BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:' + esc_(title), 'TRIGGER:-PT1H', 'END:VALARM', 'END:VEVENT', 'END:VCALENDAR']).join('\r\n') + '\r\n';
  const attachment = Utilities.newBlob(ics, 'text/calendar', 'PM&R lecture ' + t.date + '.ics');

  const btn = (href, label) => '<a href="' + esc(href) + '" style="display:inline-block;margin:0 8px 8px 0;padding:9px 14px;border-radius:8px;background:#0F766E;color:#ffffff;text-decoration:none;font-weight:bold">' + label + '</a>';
  const subject = 'Reminder: your ' + (virtual ? 'virtual' : 'in-person') + ' PM&R lecture on ' + when;
  const plain = 'Dear ' + greet + ',\n\nThank you again for teaching our PM&R residents. This is a friendly reminder about your upcoming ' + (virtual ? 'virtual' : 'in-person') + ' lecture:\n\n' +
    rows.map(r => r[0] + ': ' + r[1]).join('\n') +
    (flexible ? '\n\n' + flexNote : '') +
    '\n\nAdd it to your calendar:\nGoogle Calendar: ' + google + '\nOutlook: ' + outlook + '\nApple Calendar or other apps: open the attached .ics file.' +
    '\n\nIf anything has changed, or you would like to share slides or materials ahead of time, just reply to this email.\n\nThank you,\n' + sign;
  const html = '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#1f2937">' +
    '<p>Dear ' + esc(greet) + ',</p><p>Thank you again for teaching our PM&amp;R residents. This is a friendly reminder about your upcoming ' + (virtual ? 'virtual' : 'in-person') + ' lecture:</p>' +
    '<table style="border-collapse:collapse;margin:8px 0 14px">' + rows.map(r => '<tr><td style="padding:3px 16px 3px 0;color:#6b7280">' + r[0] + '</td><td style="padding:3px 0;font-weight:bold">' +
      (r[0] === 'Join link' ? '<a href="' + esc(r[1]) + '">' + esc(r[1]) + '</a>' : r[0] === 'Address' ? '<a href="' + esc(maps) + '">' + esc(r[1]) + '</a>' : esc(r[1])) + '</td></tr>').join('') + '</table>' +
    (flexible ? '<p style="margin:0 0 16px;padding:10px 14px;border-left:4px solid #0F766E;background:#F0FDFA">' + esc(flexNote) + '</p>' : '') +
    '<p style="margin:0 0 6px">Add it to your calendar:</p><div>' + btn(google, 'Google Calendar') + btn(outlook, 'Outlook') + '</div>' +
    '<p style="margin:0 0 14px;color:#6b7280;font-size:13px">Apple Calendar or another app: open the attached .ics file.' + (link ? ' The join link is saved in the event.' : '') + '</p>' +
    '<p>If anything has changed, or you would like to share slides or materials ahead of time, just reply to this email.</p>' +
    '<p>Thank you,<br>' + signHtml_(sign) + '</p></div>';
  const moved = t.moved ? 'Please note: the date of this lecture has changed since our last email. The details above are current.' : '';
  return { subject: (t.moved ? 'Updated date: ' : '') + subject, plain: moved ? plain.replace('\n\n', '\n\n' + moved + '\n\n') : plain,
    html: moved ? html.replace('</p><p>Thank you again', '</p><p style="padding:10px 14px;border-left:4px solid #B45309;background:#FFFBEB"><b>' + esc(moved) + '</b></p><p>Thank you again') : html, attachments: [attachment] };
}

/** Runs every morning (installLectureReminders sets it up): sends what's due, flags cancellations, and on
 * Mondays emails the chiefs a list of upcoming guest lectures with no email on file. */
function sendLectureReminders() {
  lectureLocationsTab_();
  const settings = panelSettings_();
  const mode = reminderMode_(settings);
  if (mode === 'off') {
    if (Utilities.formatDate(new Date(), TZ, 'u') === '1') draftUpcomingInvitations();
    return;
  }
  const log = reminderLog_();
  const stamp = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm');
  const talks = readTalks_(settings);
  const failed = [];
  const due = dueReminders_(settings, 0, talks).filter(r => r.lecturer && r.slot && !r.already && r.talk.confState !== 'other');
  const held = due.filter(r => r.talk.confState === 'blank');
  held.forEach(r => log.appendRow([stamp, r.talk.date, r.talk.topic, r.talk.speaker, r.lecturer.email, r.slot, 'Not confirmed: no reminder sent, chiefs alerted']));
  if (held.length) MailApp.sendEmail({ to: chiefEmail_(), subject: 'Hub: ' + held.length + ' guest lecture(s) coming up but not confirmed', name: 'PM&R Hub',
    body: 'These guest lectures are coming up soon, but their "Confirmed" cell in the Didactic Schedule is blank, so no reminder went out:\n\n' +
      held.map(r => r.talk.date + ' · ' + r.talk.topic + ' — ' + r.talk.speaker + ' <' + r.lecturer.email + '>').join('\n') +
      '\n\nIf they confirmed, type yes (or confirmed) under Confirmed and they will get their reminder at the next 8 AM check. If not, please reach out to them, or type something like "rescheduled" to stop these alerts.' });
  due.filter(r => held.indexOf(r) < 0).forEach(r => {
    const to = mode === 'on' ? r.lecturer.email : testAddress_(settings);
    let status = mode === 'on' ? 'Sent' : 'Test sent to ' + to;
    try { mailReminder_(r, settings, mode, to); }
    catch (err) { status = 'Failed: ' + err.message; failed.push(r.talk.date + ' · ' + r.talk.topic + ' → ' + r.lecturer.email + ': ' + err.message); }
    log.appendRow([stamp, r.talk.date, r.talk.topic, r.talk.speaker, r.lecturer.email, r.slot, status]);
  });
  if (failed.length) MailApp.sendEmail({ to: chiefEmail_(), subject: 'Hub: ' + failed.length + ' lecture reminder(s) could not be sent', name: 'PM&R Hub',
    body: 'These reminders failed (details on the Lecture Reminders tab). Please contact the lecturers directly:\n\n' + failed.join('\n') });
  checkCancellations_(settings, talks, mode);
  if (Utilities.formatDate(new Date(), TZ, 'u') === '1') {   // Mondays
    checkLecturerEmails(talks);
    try { draftUpcomingInvitations(talks); } catch (err) { /* reported in its own email */ }
  }
}

function mailReminder_(r, settings, mode, to) {
  const t = Object.assign({}, r.talk, { moved: r.moved });
  const m = reminderEmail_(t, r.lecturer, settings);
  const head = mode === 'on' ? '' : 'TEST MODE: this reminder would have gone to ' + r.lecturer.name + ' <' + r.lecturer.email + '>. To send to lecturers for real, set Settings "Lecture reminders" to on.';
  MailApp.sendEmail({ to: to, subject: (head ? '[TEST for ' + r.lecturer.email + '] ' : '') + m.subject, name: 'Larkin PM&R Chief Residents', attachments: m.attachments,
    body: (head ? head + '\n\n' : '') + m.plain,
    htmlBody: (head ? '<p style="font-family:Arial,sans-serif;font-size:13px;padding:10px 14px;background:#FEF3C7;border-radius:8px">' + head.replace(/</g, '&lt;') + '</p>' : '') + m.html });
}

/** A lecture that was reminded but is no longer in the sheet on that date (or is marked canceled) → alert the chiefs once. */
function checkCancellations_(settings, talks, mode) {
  const log = reminderLog_(), rows = values_(log).slice(1);
  const done = mode === 'on' ? /^sent/i : /^test sent/i;
  const alerted = {}; rows.forEach(r => { if (/^cancel alert/i.test(r[6])) alerted[[r[1], normName_(r[2]), String(r[4]).toLowerCase()].join('|')] = true; });
  const today = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd'), stamp = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm');
  const seen = {};
  rows.filter(r => done.test(r[6]) && String(r[1]) >= today).forEach(r => {
    const k = [r[1], normName_(r[2]), String(r[4]).toLowerCase()].join('|');
    if (seen[k] || alerted[k]) return; seen[k] = true;
    const still = talks.find(t => t.date === String(r[1]) && normName_(t.topic) === normName_(r[2]));
    if (still && !/cancel/i.test(still.topic)) return;
    const body = 'A guest lecturer was already sent a reminder, but the lecture ' + (still ? 'is now marked canceled' : 'is no longer in the Didactic Schedule on that date') + ':\n\n' +
      r[2] + '\n' + r[3] + ' <' + r[4] + '>\nScheduled for ' + r[1] + '\n\n' +
      'Please contact the lecturer personally. (If the lecture moved to a new date, they will automatically get a new reminder that says the date changed.)';
    try { MailApp.sendEmail({ to: chiefEmail_(), subject: (mode === 'on' ? '' : '[TEST] ') + 'Hub: lecture with a reminder may be canceled — ' + r[2], body: body, name: 'PM&R Hub' }); } catch (err) { /* logged below */ }
    log.appendRow([stamp, r[1], r[2], r[3], r[4], '', 'Cancel alert sent to chiefs']);
  });
}

/** Emails the chiefs a list of guest lectures in the next 3 weeks with no email on the Lecturers tab.
 * Runs automatically on Mondays; run it from the editor any time. Residents and groups are skipped. */
function checkLecturerEmails(talks) {
  const settings = panelSettings_();
  talks = Array.isArray(talks) ? talks : readTalks_(settings);
  const missing = missingLecturerEmails_(settings, talks, 21);
  if (!Array.isArray(arguments[0])) Logger.log(missing.length ? 'Guest lectures with no email:\n' + missing.join('\n') : 'Every guest lecture in the next 3 weeks has an email on file.');
  if (!missing.length) return;
  MailApp.sendEmail({ to: chiefEmail_(), subject: 'Hub: ' + missing.length + ' upcoming guest lecture(s) with no email on file', name: 'PM&R Hub',
    body: 'These guest lectures in the next 3 weeks will not get a reminder, because the speaker is not on the Control Panel\'s "Lecturers" tab (or the name is spelled differently there):\n\n' +
      missing.join('\n') + '\n\nAdd the lecturer (name as written in the Didactic Schedule, plus their email) to the Lecturers tab. If one of these is actually a resident, fix the spelling of their name in the Didactic Schedule.' });
}

function missingLecturerEmails_(settings, talks, horizon) {
  const lecturers = readLecturers_(), tokens = residentTokens_(settings);
  const out = [];
  talks.forEach(t => {
    const n = daysUntil_(t.date);
    if (n < 0 || n > horizon || !t.speaker || t.confState === 'other' || /cancel|no didactics|holiday/i.test(t.topic)) return;
    guestParts_(t.speaker, tokens).forEach(part => { if (!matchLecturers_(part, lecturers).length) out.push(t.date + ' · ' + t.topic + ' — ' + part); });
  });
  return out.filter((x, i, a) => a.indexOf(x) === i);
}

/** Lists the next 6 weeks of lectures and what would be sent. Sends nothing. */
function previewLectureReminders() {
  lectureLocationsTab_();
  const settings = panelSettings_();
  const days = reminderDays_(settings), mode = reminderMode_(settings);
  const talks = readTalks_(settings);
  const list = dueReminders_(settings, 42, talks).filter(r => r.lecturer);
  const lines = ['Mode: ' + mode.toUpperCase() + (mode === 'test' ? ' (every reminder goes to ' + testAddress_(settings) + ')' : mode === 'off' ? ' (nothing is sent)' : ' (reminders go to the lecturers)'),
    'Reminders go out ' + days.join(' and ') + ' day(s) before. Guest lectures in the next 6 weeks:'];
  list.forEach(r => {
    const t = r.talk, head = t.date + ' · ' + t.topic + ' — ' + t.speaker;
    if (t.confState === 'other') { lines.push('  ' + head + '  →  nothing (Confirmed column says something other than yes)'); return; }
    if (t.confState === 'blank') { lines.push('  ' + head + '  →  no reminder until Confirmed says yes (gets an invitation draft instead)'); return; }
    lines.push('  ' + head + '  →  ' + r.lecturer.email + (r.moved ? '  (date changed)' : '') + (r.already ? '  (already sent)' : r.slot && r.n <= days[0] ? '  (sends at the next 8 AM check)' : '  (will send ' + days.map(d => Utilities.formatDate(new Date(Date.parse(t.date + 'T12:00:00Z') - d * 86400000), 'UTC', 'MMM d')).join(' and ') + ')'));
  });
  if (!list.length) lines.push('  (none: add guest lecturers to the "Lecturers" tab)');
  const missing = missingLecturerEmails_(settings, talks, 42);
  if (missing.length) lines.push('', 'Guest speakers with no email on the Lecturers tab (no reminder will go out):');
  missing.forEach(x => lines.push('  ' + x));
  if (!ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === 'sendLectureReminders')) lines.push('', 'NOTE: the daily check is not on yet. Run installLectureReminders.');
  Logger.log(lines.join('\n'));
}

/** Sends sample reminders (one virtual, one in person) to the test address so you can see exactly what lecturers get. */
function sendTestReminder() {
  const settings = panelSettings_();
  const to = testAddress_(settings);
  const soon = Utilities.formatDate(new Date(Date.now() + 7 * 86400000), TZ, 'yyyy-MM-dd');
  [{ location: 'Virtual', topic: 'Sample lecture (virtual)' }, { location: 'Larkin South', topic: 'Sample lecture (in person)' }].forEach(x => {
    const m = reminderEmail_({ date: soon, time: '2:00 PM', rowTime: '2:00 PM', location: x.location, topic: x.topic, speaker: 'Dr. Example' }, { name: 'Dr. Example Lecturer' }, settings);
    MailApp.sendEmail({ to: to, subject: '[TEST] ' + m.subject, body: m.plain, htmlBody: m.html, attachments: m.attachments, name: 'Larkin PM&R Chief Residents' });
  });
  Logger.log('Two sample reminders (virtual and in person) sent to ' + to + '. Check that inbox.');
}

/* ------------------------------------------------------------------ lecture invitation drafts
 * Private "Invitations" tab: one row per person you'd like to ask to lecture. Typing "yes" under "Create draft?"
 * makes a ready-to-edit invitation in the chief Gmail's Drafts folder (nothing is sent). If "Proposed dates" is
 * blank, the draft suggests upcoming Monday didactics that don't have a guest speaker yet.
 *   installInvitations       run once: creates the tab and makes "yes" create the draft right away
 *   createInvitationDrafts   makes drafts for every row marked "yes" that has no status yet */
const INVITE_HEAD = ['Name', 'Email', 'Topic (optional)', 'Proposed dates (optional; blank = suggest open Mondays)', 'Format (virtual / in person / either)', 'Create draft? (yes)', 'Status', 'Notes for chiefs (not in the email)'];

function installInvitations() {
  const sh = panelSheet_('Invitations', INVITE_HEAD);
  if (sh.getLastColumn() < INVITE_HEAD.length) sh.getRange(1, 1, 1, INVITE_HEAD.length).setValues([INVITE_HEAD]).setFontWeight('bold');
  [180, 230, 220, 300, 200, 130, 260, 360].forEach((w, i) => sh.setColumnWidth(i + 1, w));
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'onInvitationsEdit').forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('onInvitationsEdit').forSpreadsheet(SpreadsheetApp.getActiveSpreadsheet()).onEdit().create();
  Logger.log('The "Invitations" tab is ready. Fill in a row and type yes under "Create draft?": the invitation appears in the chief Gmail\'s Drafts folder within a few seconds.');
}

/** Installable edit trigger: a "yes" typed on the Invitations tab creates that row's draft right away. */
function onInvitationsEdit(e) {
  try { if (e && e.range && e.range.getSheet().getName() === 'Invitations') createInvitationDrafts(); } catch (err) { /* the row's Status shows any problem */ }
}

function createInvitationDrafts() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Invitations');
  if (!sh) { Logger.log('No "Invitations" tab yet. Run installInvitations first.'); return; }
  const settings = panelSettings_();
  const rows = values_(sh);
  let talks = null, made = 0;
  rows.slice(1).forEach((r, i) => {
    const name = String(r[0] || '').trim(), email = String(r[1] || '').trim().replace(/^mailto:/i, '');
    if (!/^y(es)?$/i.test(String(r[5] || '').trim()) || String(r[6] || '').trim()) return;
    const cell = sh.getRange(i + 2, 7);
    if (!name || !/@/.test(email)) { cell.setValue('Needs a name and an email'); return; }
    try {
      talks = talks || readTalks_(settings);
      const m = invitationEmail_({ name: name, topic: String(r[2] || '').trim(), dates: String(r[3] || '').trim(), format: String(r[4] || '').trim() }, settings, talks);
      GmailApp.createDraft(email, m.subject, m.plain, { htmlBody: m.html, name: 'Larkin PM&R Chief Residents' });
      cell.setValue('Draft created ' + Utilities.formatDate(new Date(), TZ, 'MMM d, yyyy') + ' (Gmail ▸ Drafts)'); made++;
    } catch (err) { cell.setValue('Problem: ' + err.message); }
  });
  Logger.log(made ? made + ' invitation draft(s) created in the chief Gmail Drafts folder.' : 'No new rows marked "yes".');
}

/** Upcoming Monday didactics, 2–10 weeks out, with no guest speaker yet. */
function openMondays_(settings, talks, count) {
  const tokens = residentTokens_(settings);
  const byDate = {};
  talks.forEach(t => { (byDate[t.date] = byDate[t.date] || []).push(t); });
  return Object.keys(byDate).sort().filter(d => {
    const n = daysUntil_(d), dow = new Date(d + 'T12:00:00Z').getUTCDay();
    if (dow !== 1 || n < 14 || n > 70) return false;
    const day = byDate[d];
    if (day.some(t => /no didactics|holiday|cancel/i.test(t.topic))) return false;
    return !day.some(t => guestParts_(t.speaker, tokens).length);
  }).slice(0, count || 4);
}

function residentTokens_(settings) {
  const tokens = {};
  try {
    parseResidents_(readSheet_(idFromLink_(settings['Resident Schedule Sheet']) || FALLBACK['Resident Schedule Sheet'], settings['Resident Schedule tab']))
      .forEach(p => normName_(p.name).split(' ').filter(w => w.length >= 3).forEach(w => { tokens[w] = true; }));
  } catch (err) { /* no residents list: only groups are recognized */ }
  return tokens;
}

/** The parts of a Speaker cell that look like guests (not residents, not groups like "All Residents"). */
function guestParts_(speaker, tokens) {
  const group = /resident|subcommittee|pgy|chief|station|panel|faculty|attending|\btbd\b|\btba\b|everyone|\ball\b|students?\b|team/i;
  return String(speaker || '').split(/\s*(?:\/|&|,|\band\b|\+)\s*/i).map(s => s.trim())
    .filter(part => { const nm = normName_(part); return nm && !group.test(part) && !nm.split(' ').some(w => tokens[w]); });
}

/** "12/14/2026", "Dec 14", "1/11" → the next such date on or after today (a date without a year is never in the past). */
function futureDate_(s) {
  s = String(s || '').trim();
  if (/\b20\d\d\b/.test(s) || /^\d{1,2}\/\d{1,2}\/\d{2}$/.test(s)) return isoDate_(s);
  const today = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd'), y = Number(today.slice(0, 4));
  let m = s.match(/^(\d{1,2})\/(\d{1,2})$/), mo, d;
  if (m) { mo = Number(m[1]); d = Number(m[2]); }
  else {
    m = s.match(/([A-Za-z]{3,})\.?\s+(\d{1,2})/);
    if (!m) return '';
    mo = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'].indexOf(m[1].slice(0, 3).toLowerCase()) + 1; d = Number(m[2]);
    if (!mo) return '';
  }
  const iso = yr => yr + '-' + ('0' + mo).slice(-2) + '-' + ('0' + d).slice(-2);
  return iso(y) >= today ? iso(y) : iso(y + 1);
}

function invitationEmail_(x, settings, talks) {
  const sign = signature_(settings);
  const bare = x.name.replace(/\([^)]*\)/g, '').trim();
  const greet = /^\s*dr\b/i.test(bare) ? 'Dr. ' + bare.split(/\s+/).pop() : bare;
  const fmtDay = d => Utilities.formatDate(new Date(d + 'T12:00:00Z'), 'UTC', 'EEEE, MMMM d');
  const own = x.dates ? x.dates.split(/\s*[;\n]\s*|\s*,\s*(?=[A-Za-z]{3,}\b|\d{1,2}\/)/).filter(Boolean) : [];
  const dates = own.length ? own.map(d => { const iso = futureDate_(d); return iso ? fmtDay(iso) : d; }) : openMondays_(settings, talks).map(fmtDay);
  const tm = lectureTimes_({ time: '' }, settings);

  const f = x.format.toLowerCase();
  const format = /virtual|zoom/.test(f) ? 'The talk would be virtual, over Zoom.' : /person/.test(f) ? 'The talk would be in person.' : 'It can be virtual (Zoom) or in person, whichever is easier for you.';
  const topic = x.topic ? 'on ' + x.topic : 'on a topic of your choice';
  const p1 = 'On behalf of the PM&R residents at Larkin Community Hospital South Miami, we would be honored to have you give a lecture ' + topic + ' as part of our resident didactics.';
  const p2 = 'Didactics start at ' + clock_(tm.start) + ', and we can fit your talk in anytime between ' + clock_(tm.start) + ' and ' + clock_(tm.end) + ', whatever suits your schedule. ' + format;
  const p3 = dates.length ? (own.length ? 'Here are some dates that would work well for us:' : 'Here are some upcoming dates that are open for us:') : '';
  const p4 = 'If none of these work, we are happy to find another date that fits your schedule. Please reply to let us know if you are interested and which date works best.';
  const subject = 'Invitation to lecture for the Larkin PM&R residents';
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const plain = 'Dear ' + greet + ',\n\n' + p1 + '\n\n' + p2 + (p3 ? '\n\n' + p3 + '\n' + dates.map(d => '• ' + d).join('\n') : '') + '\n\n' + p4 + '\n\nThank you for considering it,\n' + sign;
  const html = '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#1f2937"><p>Dear ' + esc(greet) + ',</p><p>' + esc(p1) + '</p><p>' + esc(p2) + '</p>' +
    (p3 ? '<p style="margin-bottom:4px">' + esc(p3) + '</p><ul style="margin-top:0">' + dates.map(d => '<li>' + esc(d) + '</li>').join('') + '</ul>' : '') +
    '<p>' + esc(p4) + '</p><p>Thank you for considering it,<br>' + signHtml_(sign) + '</p></div>';
  return { subject: subject, plain: plain, html: html };
}


/** Mondays (and on demand): draft an invitation for every guest lecture in the next few weeks that isn't marked
 * Confirmed in the Didactic Schedule and hasn't been invited yet, then tell the chiefs the drafts are ready.
 * Settings: "Invitation lead (weeks)" (blank = 6) · "Automatic invitations" (off to stop). */
function draftUpcomingInvitations(talks) {
  const settings = panelSettings_();
  if (/^(off|no|false|0)$/i.test(String(settings['Automatic invitations'] || '').trim())) return;
  talks = Array.isArray(talks) ? talks : readTalks_(settings);
  if (!talks.some(t => t.confKnown)) { Logger.log('Add a "Confirmed" column to the Didactic Schedule first, so the script can tell confirmed guests from planned ones.'); return; }
  const weeks = Number(settings['Invitation lead (weeks)']) || 6;
  const sh = panelSheet_('Invitations', INVITE_HEAD);
  if (sh.getLastColumn() < INVITE_HEAD.length) sh.getRange(1, 1, 1, INVITE_HEAD.length).setValues([INVITE_HEAD]).setFontWeight('bold');
  // one invitation per lecture: same topic on the same date (names can be spelled differently, e.g. Joe / Joseph)
  const have = {}; values_(sh).slice(1).forEach(r => String(r[3] || '').split(/\s*;\s*/).forEach(d => { const iso = isoDate_(d) || futureDate_(d); if (iso) { have[normName_(r[2]) + '|' + iso] = true; have[normName_(r[0]) + '|' + iso] = true; } }));
  const tokens = residentTokens_(settings), lecturers = readLecturers_();
  const made = [];
  talks.forEach(t => {
    const n = daysUntil_(t.date);
    if (n < 1 || n > weeks * 7 || t.confState !== 'blank' || /cancel|no didactics|holiday/i.test(t.topic)) return;   // only blank Confirmed cells get an invitation
    guestParts_(t.speaker, tokens).forEach(guest => {
      const k = normName_(t.topic) + '|' + t.date;
      if (have[k] || have[normName_(guest) + '|' + t.date]) return; have[k] = true;
      const lec = matchLecturers_(guest, lecturers)[0];
      const email = lec ? lec.email : '';
      const virtual = /virtual/i.test(t.location || '');
      const pairs = talks.filter(x => x.date === t.date && x !== t && !guestParts_(x.speaker, tokens).length).map(x => x.topic).join('; ');
      const note = [t.block, pairs ? 'Same day: ' + pairs : ''].filter(Boolean).join(' · ');
      let status;
      try {
        const m = dateInvitationEmail_({ name: lec ? lec.name : guest, topic: t.topic, date: t.date, virtual: virtual, location: t.location }, settings);
        GmailApp.createDraft(email, m.subject, m.plain, { htmlBody: m.html, name: 'Larkin PM&R Chief Residents' });
        status = 'Draft created ' + Utilities.formatDate(new Date(), TZ, 'MMM d, yyyy') + ' (automatic)' + (email ? '' : ' · add their email in the draft');
        made.push(t.date + ' · ' + t.topic + ' — ' + guest + (email ? '' : '  (no email on file: add it in the draft)'));
      } catch (err) { status = 'Problem: ' + err.message; }
      const d = new Date(t.date + 'T12:00:00Z');
      sh.appendRow([lec ? lec.name : guest, email, t.topic, (d.getUTCMonth() + 1) + '/' + d.getUTCDate() + '/' + d.getUTCFullYear(), virtual ? 'virtual' : 'in person', 'auto', status, note]);
    });
  });
  Logger.log(made.length ? made.length + ' invitation draft(s) created:\n' + made.join('\n') : 'No new unconfirmed guest lectures in the next ' + weeks + ' weeks.');
  if (made.length) MailApp.sendEmail({ to: chiefEmail_(), subject: 'Hub: ' + made.length + ' lecture invitation draft(s) ready to send', name: 'PM&R Hub',
    body: 'These guest lectures in the next ' + weeks + ' weeks are not marked Confirmed yet, so an invitation is waiting in Gmail ▸ Drafts for each one:\n\n' + made.join('\n') +
      '\n\nOpen each draft, adjust it if you like, and press Send. When a lecturer confirms, type yes under "Confirmed" in the Didactic Schedule (and add them to the Lecturers tab if they are not there yet).' });
}

/** The first ask for a lecture that is already on the schedule: that date, or another date that month. */
function dateInvitationEmail_(x, settings) {
  const sign = signature_(settings);
  const bare = String(x.name).replace(/\([^)]*\)/g, '').trim();
  const greet = /^\s*dr\b/i.test(bare) ? 'Dr. ' + bare.split(/\s+/).pop() : bare;
  const day = Utilities.formatDate(new Date(x.date + 'T12:00:00Z'), 'UTC', 'EEEE, MMMM d'), month = Utilities.formatDate(new Date(x.date + 'T12:00:00Z'), 'UTC', 'MMMM');
  const tm = lectureTimes_({ time: '' }, settings);
  const where = x.virtual ? 'virtual, over Zoom' : 'in person' + (lectureLocation_(x.location).name ? ' at ' + lectureLocation_(x.location).name : '');
  const p1 = 'We are the PM&R chief residents at Larkin Community Hospital South Miami, and we would love to have you give a lecture on ' + x.topic + ' for our residents.';
  const p2 = 'Would you be available on ' + day + '? Didactics start at ' + clock_(tm.start) + ', and you can present anytime between ' + clock_(tm.start) + ' and ' + clock_(tm.end) + '. The session would be ' + where + '.';
  const p3 = 'If that day does not work, could you let us know another date in ' + month + ' that would? We are happy to work around your schedule.';
  const subject = 'Lecture request: ' + x.topic + ' (' + Utilities.formatDate(new Date(x.date + 'T12:00:00Z'), 'UTC', 'MMM d') + ')';
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const plain = 'Dear ' + greet + ',\n\n' + p1 + '\n\n' + p2 + '\n\n' + p3 + '\n\nThank you,\n' + sign;
  const html = '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#1f2937"><p>Dear ' + esc(greet) + ',</p><p>' + esc(p1) + '</p><p>' + esc(p2) + '</p><p>' + esc(p3) + '</p><p>Thank you,<br>' + signHtml_(sign) + '</p></div>';
  return { subject: subject, plain: plain, html: html };
}


/** Email signature: the chiefs from the Control Panel "Contacts" tab (role contains "Chief"), the academic year,
 * and the chief email. A "Lecture reminder signature" Settings row replaces it. Updates itself each year. */
function signature_(settings) {
  if (String(settings['Lecture reminder signature'] || '').trim()) return String(settings['Lecture reminder signature']).trim();
  const year = String(settings['Academic Year'] || '').replace(/\s*[–—-]\s*/, ' - ').trim();
  let chiefs = [], email = '';
  try {
    const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Contacts');
    const rows = sh ? values_(sh) : [];
    const head = (rows[0] || []).map(h => String(h).trim().toLowerCase());
    const col = re => head.findIndex(h => re.test(h));
    const cRole = col(/role/), cName = col(/name/), cPhone = col(/phone|cell/), cEmail = col(/e-?mail/);
    rows.slice(1).forEach(r => {
      if (cRole < 0 || cName < 0 || !/chief/i.test(r[cRole]) || !String(r[cName] || '').trim()) return;
      chiefs.push(String(r[cName]).trim() + (cPhone >= 0 && String(r[cPhone] || '').trim() ? ' || Cell: ' + String(r[cPhone]).trim() : ''));
      if (!email && cEmail >= 0 && /@/.test(r[cEmail])) email = String(r[cEmail]).trim();
    });
  } catch (err) { /* fall back to the plain signature */ }
  email = email || Session.getEffectiveUser().getEmail();
  return ['Physical Medicine & Rehabilitation Chief Residents' + (year ? ' ' + year : ''), 'Larkin Community Hospital South Miami', 'Email: ' + email].concat(chiefs).join('\n');
}

function signHtml_(sign) {
  return String(sign).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/([\w.+-]+@[\w-]+\.[\w.-]+)/g, '<a href="mailto:$1">$1</a>').replace(/\n/g, '<br>');
}

/* ------------------------------------------------------------------ "How to update" tab
 * The Control Panel's "How to update" tab is written from HOWTO_LINES. The 5-minute autoRefresh rewrites it by
 * itself whenever these lines change (after new code is pasted in), so whoever changes how the hub works must
 * update HOWTO_LINES too. writeHowToTab rewrites it right away. */
const HOWTO_WARNING = '⚠  DO NOT TYPE IN OR EDIT THIS TAB.  It is rewritten automatically whenever the hub\'s instructions change, and anything typed here will be erased. To change these instructions, update HOWTO_LINES in the Apps Script code (ask Claude) — not this tab.';
const HOWTO_LINES = [
  ['HOW TO KEEP THE HUB UP TO DATE'],
  ['You never edit the website. Edit the Google files below and the site follows within about 5 minutes (refresh the page). The full Chief Handoff Guide has more detail.'],
  [''],
  ['WHAT TO EDIT'],
  ['Didactic schedule → the Didactic Schedule sheet. Each session needs a Date (or sits under a dated row) and a Lecture Topic; add Time, Location and Speaker. Write "Virtual" in Location for Zoom sessions. Put "Journal Club" in the topic for Journal Club. Calendar subscribers follow the sheet automatically.'],
  ['Resident schedule → the Resident Schedule sheet, using the codes in the Rotations tab (SCW, WGRH, EMG…). To split a month in half, give that month two columns (merge the month header or leave the new header blank): the first column is the 1st–15th, the second starts on the 16th.'],
  ['Rotation guides & policies → the Handbooks folder in Drive: one Google Doc per page. The doc name is the page title, the folder is its group, and the Policies folder appears under Resources. To add a rotation, copy a doc in the right folder and rename it; add a Rotations-tab row with exactly the same name to give it a schedule code. Run refreshHandbookNow to update the site right away. Each guide\'s "First day" card (address and phone numbers) and its "Jump to" menu are built from the doc itself: put the address and main phone near the top, and write section titles as short bold lines (e.g. "Responsibilities:") so they appear in the menu.'],
  ['Contacts, announcements, quick links → the tabs in this Control Panel. Contacts rows whose role contains "Chief" also become the signature on every lecture email.'],
  ['Settings tab → Academic Year, Home headline and subtitle, Email sign-in (on/off), Virtual lecture link (the usual Zoom link), Holiday themes (off to turn off), and the Lecture reminder settings.'],
  [''],
  ['WHO CAN USE THE HUB (email sign-in)'],
  ['Settings "Email sign-in" = on → the first time someone opens the hub on a phone or computer, they enter their email and get a 6-digit code from the chief Gmail. After that, that device stays signed in. No passcode is used.'],
  ['Approved Emails tab → one row per person: their email(s) (several are fine, separated by commas), name, role, and Active (yes/no). Only these emails can get a code. To remove someone, set Active to no or delete the row: they are signed out on their next visit. This tab is never shown on the website.'],
  ['Sign-ins tab → every verified device, when it was last used, and its Status. Type revoked in Status to sign that one device out (for example a lost phone). Do not edit the Key column.'],
  ['When the Academic Year in Settings changes, every device verifies its email once more. Calendar subscription links keep working without sign-in. To turn sign-in off, set "Email sign-in" to off.'],
  [''],
  ['GUEST LECTURERS (automatic emails from the chief Gmail)'],
  ['Lecturers tab → one row per guest: name as written in the Didactic Schedule, email (several are fine, separated by commas), other spellings, and yes. This tab is never shown on the website.'],
  ['Confirmed column in the Didactic Schedule → yes or confirmed = the guest gets a reminder 7 days before. Blank = the guest gets an invitation draft. Anything else (rescheduled, declined…) = nothing.'],
  ['Every Monday → invitation drafts are created in Gmail ▸ Drafts for guest lectures in the next 6 weeks with a blank Confirmed cell, and the chief Gmail gets a note. Open each draft, adjust it, and press Send. When the guest agrees, type yes under Confirmed.'],
  ['Invitations tab → to invite someone by hand, add a row and type yes under "Create draft?". Leave the dates blank to suggest open Mondays.'],
  ['Settings "Lecture reminders" → test (everything goes to the "Lecture reminder test email"), on (to the lecturers) or off. Optional: Invitation lead (weeks), Lecture reminder days, Automatic invitations (off).'],
  ['The chief Gmail is emailed about guests with no email on file (Mondays), emails that failed, reminded lectures that disappear or are canceled, and guest lectures still blank a week out. Every email sent is logged on the Lecture Reminders tab.'],
  ['Lecture Locations tab → what in-person locations are called in emails (for example ISS → full name) and an optional address that becomes a directions link.'],
  [''],
  ['NEW ACADEMIC YEAR (each July)'],
  ['1. Make the new Didactic and Resident Schedule sheets (File ▸ Make a copy of last year\'s), paste their links into Settings, and update Academic Year (the website and the email signature show the new year).'],
  ['2. Update the Approved Emails tab: add the new class, set graduates to no. (Changing the Academic Year already makes every device verify once more. If email sign-in is off, change the Site passcode instead.)'],
  ['3. Update Contacts with the new chiefs (name and cell): the website and the email signature follow.'],
  ['4. Check the Rotations tab codes match the new Resident Schedule.'],
  ['5. Update the Lecturers tab (add new guests, remove old ones) and keep the Confirmed column in the new Didactic Schedule.'],
  ['6. Have residents review their Handbooks docs; run checkHandbookLinks.'],
  [''],
  ['IF SOMETHING LOOKS WRONG (Extensions ▸ Apps Script, pick the function, press Run, read the log)'],
  ['Site footer says "Saved copy" → run testHub; the "Errors" line names the source that failed (usually a link in Settings or a file\'s sharing).'],
  ['A Handbook change is not on the site → run refreshHandbookNow, then reload the site.'],
  ['Check the lecture emails without sending anything → run previewLectureReminders. Run sendTestReminder for two sample reminders at the test address.'],
  ['After pasting new code into Code.gs → Deploy ▸ Manage deployments: for BOTH deployments click the pencil, choose New version, and Deploy.'],
  [''],
  ['OWNERSHIP'],
  ['This sheet, its Apps Script, the Handbooks folder and the GitHub account that hosts the site all belong to the shared chief Gmail. Hand over that login (and update its recovery phone and email) each year and nothing breaks.'],
];

function writeHowToTab() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName('How to update') || ss.insertSheet('How to update', 0);
  sh.getProtections(SpreadsheetApp.ProtectionType.SHEET).forEach(p => p.remove());
  sh.clear();
  const lines = [[HOWTO_WARNING], ['']].concat(HOWTO_LINES);
  sh.getRange(1, 1, lines.length, 1).setValues(lines).setWrap(true).setVerticalAlignment('top').setFontSize(11).setFontColor('#1f2937').setBackground(null);
  sh.setColumnWidth(1, 900);
  sh.getRange(1, 1).setFontSize(16).setFontWeight('bold').setFontColor('#B91C1C').setBackground('#FDE2E1').setVerticalAlignment('middle');
  sh.setRowHeight(1, 84);
  const isHead = t => /^[A-Z]/.test(t) && t.length < 140 && !/[a-z]/.test(t.split('(')[0]);   // ALL-CAPS lines are section headings
  HOWTO_LINES.forEach((r, i) => { if (r[0] && isHead(r[0])) sh.getRange(i + 3, 1).setFontWeight('bold').setFontSize(i ? 12 : 14); });
  sh.setFrozenRows(1);
  // A typing attempt shows Google's "this range is protected" warning; the script can still rewrite it.
  sh.protect().setDescription('Written automatically by the hub script. Do not edit.').setWarningOnly(true);
  PropertiesService.getScriptProperties().setProperty('howto_hash', howToHash_());
  Logger.log('The "How to update" tab is up to date (' + HOWTO_LINES.length + ' lines).');
}

function howToHash_() {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, JSON.stringify([HOWTO_WARNING, HOWTO_LINES]))
    .map(b => ('0' + (b & 255).toString(16)).slice(-2)).join('');
}

/** Called by autoRefresh: rewrites the tab only when the instructions in the code have changed (or the tab is gone). */
function syncHowToTab_() {
  const props = PropertiesService.getScriptProperties();
  const tab = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('How to update');
  if (tab && props.getProperty('howto_hash') === howToHash_()) return;
  writeHowToTab();
}


/* ------------------------------------------------------------------ email sign-in
 * Settings "Email sign-in" = on: a device must verify an email on the private "Approved Emails" tab (a 6-digit code
 * is emailed from the chief Gmail) before Google sends it schedules, contacts or the Handbook. A verified device stays
 * signed in until its person is removed from Approved Emails (or set to "no"), its row on the "Sign-ins" tab is set to
 * "revoked", or the Academic Year in Settings changes (everyone verifies once each July). Calendar feeds stay open.
 *   installSignIn   run once: creates the Approved Emails and Sign-ins tabs */
const APPROVED_HEAD = ['Email(s) (several are fine, separated by commas)', 'Name', 'Role (resident / faculty / staff)', 'Active (yes/no)', 'Notes'];
const SIGNIN_HEAD = ['Signed in', 'Email', 'Name', 'Device', 'Academic year', 'Last seen', 'Status (type revoked to sign this device out)', 'Key (do not edit)'];

function installSignIn() {
  const a = panelSheet_('Approved Emails', APPROVED_HEAD); [340, 200, 200, 120, 300].forEach((w, i) => a.setColumnWidth(i + 1, w));
  const b = panelSheet_('Sign-ins', SIGNIN_HEAD); [150, 240, 180, 160, 120, 150, 260, 120].forEach((w, i) => b.setColumnWidth(i + 1, w));
  Logger.log('Approved Emails and Sign-ins tabs are ready. Fill in Approved Emails, then set Settings "Email sign-in" to on.');
}

function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function sha_(s) { return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(s)).map(b => ('0' + (b & 255).toString(16)).slice(-2)).join(''); }
function normEmail_(s) { return String(s || '').trim().toLowerCase().replace(/^mailto:/, ''); }

function signInOn_() {
  const cache = CacheService.getScriptCache();
  let v = cache.get('signin_on');
  if (v === null) { v = /^(on|yes|true|1)$/i.test(String(panelSettings_()['Email sign-in'] || '').trim()) ? '1' : '0'; cache.put('signin_on', v, 60); }
  return v === '1';
}
function academicYear_() {
  const cache = CacheService.getScriptCache();
  let y = cache.get('acad_year');
  if (y === null) { y = String(panelSettings_()['Academic Year'] || '').replace(/\s+/g, ' ').trim(); cache.put('acad_year', y, 60); }
  return y;
}

/** email → {name, role} for every active row of Approved Emails (cached a minute, so removals apply quickly). */
function approvedMap_() {
  const cache = CacheService.getScriptCache(), hit = cache.get('approved_map');
  if (hit) return JSON.parse(hit);
  const map = {}, sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Approved Emails');
  if (sh) values_(sh).slice(1).forEach(r => {
    if (/^(no|n|off|false|0|inactive|removed)$/i.test(String(r[3] || '').trim())) return;
    String(r[0] || '').split(/[\s,;]+/).map(normEmail_).filter(e => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)).forEach(e => { map[e] = { name: String(r[1] || '').trim(), role: String(r[2] || '').trim() }; });
  });
  try { cache.put('approved_map', JSON.stringify(map), 60); } catch (err) { /* uncached */ }
  return map;
}

/** key hash → {email, year, status, row} from the Sign-ins tab (cached a minute). */
function tokenMap_() {
  const cache = CacheService.getScriptCache(), hit = cache.get('token_map');
  if (hit) return JSON.parse(hit);
  const map = {}, sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Sign-ins');
  if (sh) values_(sh).slice(1).forEach((r, i) => { if (r[7]) map[String(r[7])] = { email: normEmail_(r[1]), year: String(r[4] || '').trim(), status: String(r[6] || '').trim(), row: i + 2 }; });
  try { cache.put('token_map', JSON.stringify(map), 60); } catch (err) { /* uncached */ }
  return map;
}

function checkToken_(token) {
  if (!token) return { ok: false, reason: 'none' };
  const h = sha_(token), rec = tokenMap_()[h];
  if (!rec) return { ok: false, reason: 'unknown' };
  if (/revok|signed out|remove/i.test(rec.status)) return { ok: false, reason: 'revoked' };
  if (rec.year !== academicYear_()) return { ok: false, reason: 'year' };
  const who = approvedMap_()[rec.email];
  if (!who) return { ok: false, reason: 'removed' };
  const cache = CacheService.getScriptCache();
  if (!cache.get('seen_' + h)) {   // "Last seen", at most every 6 hours per device
    try { SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Sign-ins').getRange(rec.row, 6).setValue(Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm')); } catch (err) { /* not essential */ }
    cache.put('seen_' + h, '1', 6 * 3600);
  }
  return { ok: true, email: rec.email, name: who.name };
}

/** ?auth=start&email=… sends a code (only to approved emails; the answer is the same either way).
 *  ?auth=verify&email=…&code=…&device=… returns a device key. */
function authRequest_(p) {
  const cache = CacheService.getScriptCache();
  const email = normEmail_(p.email);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { ok: false, error: 'email' };
  const ek = sha_(email).slice(0, 40);
  if (p.auth === 'start') {
    const n = Number(cache.get('otpn_' + ek) || 0);
    if (n >= 5) return { ok: true };                       // at most 5 codes an hour per email
    cache.put('otpn_' + ek, String(n + 1), 3600);
    const who = approvedMap_()[email];
    if (!who) return { ok: true };                         // not on the list: nothing is sent, nothing is revealed
    const code = String(Math.floor(100000 + Math.random() * 900000));
    cache.put('otp_' + ek, JSON.stringify({ code: code, tries: 0 }), 15 * 60);
    const hi = who.name ? 'Hi ' + who.name.split(/\s+/)[0] + ',' : 'Hi,';
    MailApp.sendEmail({ to: email, name: 'Larkin PM&R Hub', subject: 'Your PM&R Hub code: ' + code,
      body: hi + '\n\nYour sign-in code for the Larkin PM&R Hub is ' + code + '.\nIt works for 15 minutes. If you did not ask for it, you can ignore this email.\n\n' + signature_(panelSettings_()),
      htmlBody: '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#1f2937"><p>' + hi + '</p><p>Your sign-in code for the Larkin PM&amp;R Hub is</p><p style="font-size:30px;font-weight:bold;letter-spacing:6px;margin:6px 0 14px">' + code + '</p><p>It works for 15 minutes. If you did not ask for it, you can ignore this email.</p><p>' + signHtml_(signature_(panelSettings_())) + '</p></div>' });
    return { ok: true };
  }
  if (p.auth === 'verify') {
    const raw = cache.get('otp_' + ek);
    if (!raw) return { ok: false, error: 'expired' };
    const otp = JSON.parse(raw);
    if (String(p.code || '').replace(/\D/g, '') !== otp.code) {
      otp.tries++;
      if (otp.tries >= 5) { cache.remove('otp_' + ek); return { ok: false, error: 'locked' }; }
      cache.put('otp_' + ek, JSON.stringify(otp), 15 * 60);
      return { ok: false, error: 'wrong' };
    }
    cache.remove('otp_' + ek);
    const who = approvedMap_()[email];
    if (!who) return { ok: false, error: 'expired' };
    const token = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
    const lock = LockService.getScriptLock(); lock.waitLock(10000);
    try {
      const sh = panelSheet_('Sign-ins', SIGNIN_HEAD);
      const now = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm');
      sh.appendRow([now, email, who.name, String(p.device || '').slice(0, 60), academicYear_(), now, 'active', sha_(token)]);
    } finally { lock.releaseLock(); }
    cache.remove('token_map');
    return { ok: true, token: token, name: who.name, email: email };
  }
  return { ok: false, error: 'request' };
}
