"""Rebuild the site's saved copy (data/snapshot.json) from the master Handbook .docx,
splitting it exactly the way the site splits the live Google Doc."""
import sys, re, json, os, shutil, subprocess, html, zipfile, datetime
from lxml import etree, html as LH
from PIL import Image

DOCX = sys.argv[1] if len(sys.argv) > 1 else '/home/claude/hb/out.docx'
REPO = '/home/claude/larkinpmr.github.io'
WORK = '/home/claude/hb/snap'
shutil.rmtree(WORK, ignore_errors=True); os.makedirs(WORK)

# 1. mark red runs with a character style so pandoc keeps them (docx+styles)
W = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
z = zipfile.ZipFile(DOCX)
tmp = WORK + '/marked.docx'
with zipfile.ZipFile(tmp, 'w', zipfile.ZIP_DEFLATED) as out:
    for item in z.infolist():
        data = z.read(item.filename)
        if item.filename == 'word/document.xml':
            root = etree.fromstring(data)
            for r in root.iter(W + 'r'):
                rpr = r.find(W + 'rPr'); c = rpr.find(W + 'color') if rpr is not None else None
                if c is not None and c.get(W + 'val', '').lower() in ('ff0000', 'e06666', 'cc0000', 'c00000'):
                    st = etree.Element(W + 'rStyle'); st.set(W + 'val', 'HubWarn'); rpr.insert(0, st)
            data = etree.tostring(root, xml_declaration=True, encoding='UTF-8', standalone=True)
        if item.filename == 'word/styles.xml':
            data = data.replace(b'</w:styles>', b'<w:style w:type="character" w:customStyle="1" w:styleId="HubWarn"><w:name w:val="HubWarn"/></w:style></w:styles>')
        out.writestr(item, data)

subprocess.run(['pandoc', '-f', 'docx+styles', '-t', 'html', '--extract-media=' + WORK + '/m', tmp, '-o', WORK + '/hb.html'], check=True)
doc = LH.fromstring('<div>' + open(WORK + '/hb.html', encoding='utf-8').read() + '</div>')

# 2. tidy pandoc output to match what the site produces from Google's export
for sp in doc.xpath('//span[@data-custom-style]'):
    if sp.get('data-custom-style') == 'HubWarn': sp.attrib.clear(); sp.set('class', 'warn')
    else: sp.drop_tag()
for d in doc.xpath('//div[@data-custom-style]'): d.drop_tag()
for m in doc.xpath('//mark|//u'): m.drop_tag()
for el in doc.iter():
    if not isinstance(el.tag, str): continue
    for a in list(el.attrib):
        if a not in ('href', 'src', 'alt', 'colspan', 'rowspan', 'start') and not (a == 'class' and el.get('class') == 'warn'): del el.attrib[a]
for a in doc.xpath('//a[@href]'):
    h = a.get('href')
    if h.startswith('#'): a.drop_tag(); continue
    if not h.startswith('mailto:'): a.set('target', '_blank'); a.set('rel', 'noopener')
os.makedirs(REPO + '/assets/hb', exist_ok=True)
for f in os.listdir(REPO + '/assets/hb'): os.remove(REPO + '/assets/hb/' + f)
for img in doc.xpath('//img'):
    src = img.get('src'); name = os.path.splitext(os.path.basename(src))[0] + '.jpg'
    im = Image.open(src).convert('RGB')
    if im.width > 1400: im = im.resize((1400, round(im.height * 1400 / im.width)), Image.LANCZOS)
    im.save(REPO + '/assets/hb/' + name, 'JPEG', quality=80, optimize=True)
    img.attrib.clear(); img.set('src', 'assets/hb/' + name); img.set('loading', 'lazy'); img.set('alt', '')
for t in doc.xpath('//table'):
    w = LH.Element('div'); w.set('class', 'tbl'); t.addprevious(w); w.append(t)
for p in doc.xpath('//p|//li|//h1|//h2|//h3'):
    if not p.text_content().replace('\xa0', ' ').strip() and not p.xpath('.//img'): p.drop_tree()

# 3. split by Heading 1, like splitSections()
def outer(e): return LH.tostring(e, encoding='unicode')
sections, preface, cur = [], [], None
for k in doc:
    if k.tag == 'h1':
        for br in k.xpath('.//br'): br.tail = ' ' + (br.tail or ''); 
        title = re.sub(r'\s+', ' ', k.text_content()).strip()
        cur = {'title': title, 'key': title.lower(), 'parts': []}; sections.append(cur); continue
    (cur['parts'] if cur else preface).append(k)
sections = [dict(s, html=''.join(outer(x) for x in s['parts'])) for s in sections]
sections = [s for s in sections if len(s['html']) > 40]
notice = ''.join(outer(k) for k in preface if re.search('please note', k.text_content(), re.I))

def demote(h): return re.sub(r'<(/?)h([1-6])\b', lambda m: '<%sh%d' % (m.group(1), min(6, max(2, int(m.group(2)) + 1))), h)
def title_case(s):
    if s != s.upper(): return s
    t = re.sub(r'\b([a-z])', lambda m: m.group(1).upper(), s.lower())
    t = re.sub(r'\b(Va|Pto|Fmla|Pm&r|Lch|Iss|Emg|Snf|Irf|P&o|Ii|Iii)\b', lambda m: m.group(0).upper(), t, flags=re.I)
    return re.sub(r'\b(Of|And|The|With)\b', lambda m: m.group(0).lower(), t)

snap_path = REPO + '/data/snapshot.json'
raw = open(snap_path, encoding='utf-8').read()
snap = json.loads(raw)
used = set()
def assign(items):
    for it in items:
        terms = [t.strip() for t in (it.get('handbookMatch') or '').lower().split('|') if t.strip()]
        hits = [s for s in sections if id(s) not in used and any(t in s['key'] for t in terms)]
        if not hits: print('  no Handbook section for', it['id']); continue
        for h in hits: used.add(id(h))
        hh = demote(hits[0]['html']) if len(hits) == 1 else ''.join('<h2>%s</h2>' % html.escape(title_case(h['title'])) + demote(h['html']) for h in hits)
        it['html'] = hh; it['handbookHtml'] = hh; it['source'] = 'handbook'
        print('  %-10s <- %s' % (it['id'], ' + '.join(h['title'][:40] for h in hits)))
assign(snap['policies']); assign(snap['rotations'])
slug = lambda s: re.sub(r'(^-|-$)', '', re.sub(r'[^a-z0-9]+', '-', s.lower().replace('&', 'and')))
snap['extraSections'] = [{'id': 'hb-' + slug(s['title']), 'title': title_case(s['title']), 'html': demote(s['html'])} for s in sections if id(s) not in used]
snap['masterHandbook'] = True
snap['hbNotice'] = notice
snap['builtFrom'] = 'Master Handbook (PM&R Program Handbook 2026-2027)'
snap['builtAt'] = datetime.date.today().isoformat()
json.dump(snap, open(snap_path, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
print('extra sections:', [s['title'] for s in snap['extraSections']])
print('snapshot KB:', os.path.getsize(snap_path) // 1024, '· pictures KB:', sum(os.path.getsize(REPO + '/assets/hb/' + f) for f in os.listdir(REPO + '/assets/hb')) // 1024)
