"""Rebuild the site's saved copy (data/snapshot.json) so it matches Google.

Usage:
  python3 tools/build_snapshot.py Handbooks/          # a downloaded "Handbooks" Drive folder (Download ▸ unzip):
                                                      #   Handbooks/<category folder>/<guide>.docx, Policies/…, Note shown on every rotation.docx
  python3 tools/build_snapshot.py Handbook.docx       # the older single Handbook (split by Heading 1, like setupHandbooksFolder)

The saved copy stores one entry per guide in snapshot["guides"], exactly like the live data, so the site
places them the same way (doc name = page, folder = category, Policies = Resources)."""
import sys, re, json, os, shutil, subprocess, zipfile, datetime
from lxml import etree, html as LH
from PIL import Image

SRC = sys.argv[1] if len(sys.argv) > 1 else '/home/claude/hb/out.docx'
REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '..')) if os.path.basename(os.path.dirname(os.path.abspath(__file__))) == 'tools' else '/home/claude/larkinpmr.github.io'
CODE = REPO + '/apps-script/Code.gs'
WORK = '/tmp/hub-snapshot-work'
shutil.rmtree(WORK, ignore_errors=True); os.makedirs(WORK)
W = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
pics_dir = REPO + '/assets/hb'
os.makedirs(pics_dir, exist_ok=True)
for f in os.listdir(pics_dir): os.remove(os.path.join(pics_dir, f))
pic_n = [0]

def docx_to_tree(path):
    """docx → tidied lxml tree (red text marked as class="warn", pictures saved to assets/hb)."""
    tag = 'd%d' % len(os.listdir(WORK))
    tmp = os.path.join(WORK, tag + '.docx')
    z = zipfile.ZipFile(path)
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
    media = os.path.join(WORK, tag + '-m')
    html_out = os.path.join(WORK, tag + '.html')
    subprocess.run(['pandoc', '-f', 'docx+styles', '-t', 'html', '--extract-media=' + media, tmp, '-o', html_out], check=True)
    doc = LH.fromstring('<div>' + open(html_out, encoding='utf-8').read() + '</div>')
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
        if a.get('href').startswith('#'): a.drop_tag()
    for img in doc.xpath('//img'):
        src = img.get('src')
        pic_n[0] += 1; name = 'p%03d.jpg' % pic_n[0]
        im = Image.open(src).convert('RGB')
        if im.width > 1400: im = im.resize((1400, round(im.height * 1400 / im.width)), Image.LANCZOS)
        im.save(os.path.join(pics_dir, name), 'JPEG', quality=80, optimize=True)
        img.attrib.clear(); img.set('src', 'assets/hb/' + name); img.set('alt', '')
    for p in doc.xpath('//p|//li'):
        if not p.text_content().replace('\xa0', ' ').strip() and not p.xpath('.//img'): p.drop_tree()
    return doc

def outer(e): return LH.tostring(e, encoding='unicode')
guides = []
if os.path.isdir(SRC):
    for dirpath, _, files in os.walk(SRC):
        rel = os.path.relpath(dirpath, SRC)
        folder = '' if rel == '.' else rel.split(os.sep)[0]
        for f in sorted(files):
            if not f.lower().endswith('.docx'): continue
            name = f[:-5]
            if not folder and not re.search(r'every rotation|notice|note for all', name, re.I): continue   # how-to etc.
            doc = docx_to_tree(os.path.join(dirpath, f))
            guides.append({'name': name, 'folder': folder, 'html': '<html><body>' + ''.join(outer(k) for k in doc) + '</body></html>'})
    # Drive's zip download swaps characters it can't put in file names (' : / become _ or -): restore the real
    # names from the current saved copy when only those characters differ.
    key = lambda t: re.sub(r'[^a-z0-9]', '', t.lower().replace("'s", 's'))
    try: old = json.load(open(REPO + '/data/snapshot.json')).get('guides') or []
    except Exception: old = []
    oldNames = {key(g['name']): g['name'] for g in old}; oldFolders = {key(g['folder']): g['folder'] for g in old if g['folder']}
    for g in guides:
        g['name'] = oldNames.get(key(g['name']), g['name'].replace(' _ ', ' / ').replace('_s ', "'s ").replace('_ ', ': '))
        if g['folder']: g['folder'] = oldFolders.get(key(g['folder']), g['folder'])
else:
    # single Handbook: split by Heading 1 with the same table the Apps Script uses
    split = json.loads(subprocess.run(['node', '-e', "const fs=require('fs');eval(fs.readFileSync(process.argv[1],'utf8')+';console.log(JSON.stringify(HB_SPLIT.map(r=>[r[0].source,r[0].flags,r[1],r[2]])))')", CODE], capture_output=True, text=True, check=True).stdout)
    doc = docx_to_tree(SRC)
    secs, pre, cur = [], [], None
    for k in doc:
        if k.tag == 'h1':
            for br in k.xpath('.//br'): br.tail = ' ' + (br.tail or '')
            cur = {'title': re.sub(r'\s+', ' ', k.text_content()).strip(), 'parts': [k]}; secs.append(cur); continue
        (cur['parts'] if cur else pre).append(k)
    for s in secs:
        key = s['title'].lower()
        hit = next((x for x in split if re.search(x[0], key)), None)
        name = hit[2] if hit else re.sub(r"\b([A-Z])([A-Z']+)\b", lambda m: m.group(1) + m.group(2).lower(), s['title'])
        guides.append({'name': name, 'folder': hit[3] if hit else 'Other', 'html': '<html><body>' + ''.join(outer(k) for k in s['parts']) + '</body></html>'})
    note = [k for k in pre if re.search('please note', k.text_content(), re.I)]
    guides.append({'name': 'Note shown on every rotation', 'folder': '', 'html': '<html><body>' + ''.join(outer(k) for k in note) + '</body></html>'})

snap_path = REPO + '/data/snapshot.json'
snap = json.load(open(snap_path, encoding='utf-8'))
snap['guides'] = guides
for k in ('masterHandbook', 'hbNotice', 'extraSections'): snap.pop(k, None)
snap['builtFrom'] = 'Handbooks folder' if os.path.isdir(SRC) else 'Master Handbook (split into guides)'
snap['builtAt'] = datetime.date.today().isoformat()
json.dump(snap, open(snap_path, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
print(len(guides), 'guides:', ' | '.join((g['folder'] + ' ▸ ' if g['folder'] else '') + g['name'] for g in guides))
print('snapshot KB:', os.path.getsize(snap_path) // 1024, '· pictures:', pic_n[0])
