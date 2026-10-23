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
  [/mouhanna/, 'Interventional Pain — Dr. Joseph Mouhanna', 'Elective'],
  [/hatgis/, 'Interventional Pain — Dr. Jesse Hatgis', 'Elective'],
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
    if (nb.getNumChildren() > 1 && isBlank(nb.getChild(0))) nb.getChild(0).removeFromParent();
    while (nb.getNumChildren() > 2 && isBlank(nb.getChild(nb.getNumChildren() - 2)) && isBlank(nb.getChild(nb.getNumChildren() - 1))) nb.getChild(nb.getNumChildren() - 1).removeFromParent();
  };
  const makeDoc = (name, folder, fill) => {
    if (exists(folder, name)) return 'skipped';
    const d = DocumentApp.create(name), nb = d.getBody();
    nb.setMarginTop(body.getMarginTop()).setMarginBottom(body.getMarginBottom()).setMarginLeft(body.getMarginLeft()).setMarginRight(body.getMarginRight());
    fill(nb);
    const c0 = nb.getChild(0);
    if (nb.getNumChildren() > 1 && c0.getType() === DocumentApp.ElementType.PARAGRAPH && !c0.asParagraph().getText().trim() && !c0.asParagraph().getNumChildren()) c0.removeFromParent();
    d.saveAndClose();
    DriveApp.getFileById(d.getId()).moveTo(folder);
    return 'made';
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
    const pg = r.join(' ').match(/PGY[\s-]?([2-5])/i);
    if (r.filter(isMonth).length >= 6) {
      const first = r.findIndex(isMonth);
      let ni = r.findIndex(c => /resident/i.test(c)); if (ni < 0 || ni > first) ni = Math.max(0, first - 1);
      map = { name: ni, months: MONTH_NAMES.map(m => r.findIndex(c => isMonth(c) && c.slice(0, 3).toLowerCase() === m.slice(0, 3).toLowerCase())) };
      if (pg) pgy = 'PGY-' + pg[1];
      return;
    }
    if (!map) { if (pg) pgy = 'PGY-' + pg[1]; return; }
    const name = r[map.name] || '';
    const months = map.months.map(i => i >= 0 ? (r[i] || '').split(',')[0].trim() : '');
    const filled = months.filter(Boolean).length;
    if (pg && (filled < 6 || /pgy/i.test(name))) { pgy = 'PGY-' + pg[1]; return; }
    if (name && filled >= 6 && !/key|resident/i.test(name)) out.push({ name: name, pgy: pgy, months: months });
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

  // Rotation blocks (consecutive months with the same assignment)
  let i = 0;
  while (i < 12) {
    const raw = me.months[i]; if (!raw) { i++; continue; }
    let j = i; while (j + 1 < 12 && normCode_(me.months[j + 1]) === normCode_(raw)) j++;
    const rot = rotOf(raw), label = rot ? (rot.short || rot.name) : raw;
    const start = monthStart(i), end = monthStart(j + 1 < 12 ? j + 1 : 12);
    allDay(uidBase + '-rot-' + i, start, end, 'Rotation: ' + label, (rot ? rot.name + '\n' : '') + MONTH_NAMES[i] + (j > i ? '–' + MONTH_NAMES[j] : '') + (site ? '\nGuide: ' + site + '#rotations' : ''), false);
    // Onboarding reminders before each new rotation
    leadWeeks_(rot).forEach((w, k) => {
      const d = new Date(start.getTime() - w * 7 * 86400000), next = new Date(d.getTime() + 86400000);
      allDay(uidBase + '-onb-' + i + '-' + w, d, next, (k === 0 ? 'Start onboarding: ' : 'Onboarding reminder: ') + label + ' (starts ' + Utilities.formatDate(start, 'UTC', 'MMM d') + ')',
        'Your ' + (rot ? rot.name : label) + ' rotation starts ' + Utilities.formatDate(start, 'UTC', 'EEEE, MMMM d') + '. Complete credentialing, EMR and facility access, and arrange shadowing now.' + (site ? '\nGuide: ' + site + '#rotations' : ''), true);
    });
    i = j + 1;
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
    if (t.location) ev.push(fold_('LOCATION:' + esc_(t.location)));
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
