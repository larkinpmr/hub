"""Refresh the schedules in the site's saved copy (data/snapshot.json) from downloaded sheets.

Usage:
  python3 tools/build_schedules.py "Resident Schedule.xlsx" "Didactic Schedule.xlsx"
(Google Sheets ▸ File ▸ Download ▸ Microsoft Excel). The rows are read the way Google shows them
(merged cells filled in) and parsed with the website's own code from index.html, so the saved copy matches
what the live site shows."""
import sys, os, json, re, subprocess, datetime
import openpyxl

REPO = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
res_path, did_path = sys.argv[1], sys.argv[2]
did_tab = sys.argv[3] if len(sys.argv) > 3 else 'Master Schedule'

def shown(v):
    if v is None: return ''
    if isinstance(v, datetime.datetime):
        if v.hour or v.minute: return v.strftime('%-I:%M %p')
        return f'{v.month}/{v.day}/{v.year}'
    if isinstance(v, datetime.date): return f'{v.month}/{v.day}/{v.year}'
    if isinstance(v, datetime.time): return datetime.datetime.combine(datetime.date(2000, 1, 1), v).strftime('%-I:%M %p')
    if isinstance(v, float) and v.is_integer(): return str(int(v))
    s = str(v)
    return '' if s.startswith('=') else s

def rows(path, tab=None):
    wb = openpyxl.load_workbook(path)
    ws = wb[tab] if tab and tab in wb.sheetnames else wb.worksheets[0]
    vals = [[shown(c) for c in r] for r in ws.iter_rows(values_only=True)]
    for m in ws.merged_cells.ranges:          # Google's data shows a merged value in every cell it covers
        v = vals[m.min_row - 1][m.min_col - 1]
        for r in range(m.min_row - 1, m.max_row):
            for c in range(m.min_col - 1, m.max_col):
                vals[r][c] = v
    while vals and not any(vals[-1]): vals.pop()
    return vals

html = open(os.path.join(REPO, 'index.html'), encoding='utf-8').read()
def grab(name):
    i = html.index('function ' + name + '(')
    depth, j = 0, html.index('{', i)
    for k in range(j, len(html)):
        depth += {'{': 1, '}': -1}.get(html[k], 0)
        if depth == 0: return html[i:k + 1]
js = '\n'.join([
    'const MONTH_FULL = ["July","August","September","October","November","December","January","February","March","April","May","June"];',
    'const norm = s => String(s || "").toUpperCase().replace(/\\s*\\/\\s*/g, " / ").replace(/\\s+/g, " ").trim();',
    grab('isoOf'), grab('parseLooseDate'), grab('parseResidents'), grab('parseDidactics'),
    'const inp = JSON.parse(require("fs").readFileSync(0, "utf8"));',
    'console.log(JSON.stringify({ residents: parseResidents(inp.res), didactics: parseDidactics(inp.did) }));'])
out = subprocess.run(['node', '-e', js], input=json.dumps({'res': rows(res_path), 'did': rows(did_path, did_tab)}), capture_output=True, text=True, check=True).stdout
parsed = json.loads(out)
snap_path = os.path.join(REPO, 'data/snapshot.json')
snap = json.load(open(snap_path))
snap['residents'] = parsed['residents']; snap['didactics'] = parsed['didactics']
snap['builtAt'] = datetime.date.today().isoformat()
json.dump(snap, open(snap_path, 'w'), ensure_ascii=False)
print(len(parsed['residents']), 'residents ·', len(parsed['didactics']), 'didactic sessions ·',
      sum(1 for p in parsed['residents'] if any(p.get('months2') or [])), 'residents with split months')
