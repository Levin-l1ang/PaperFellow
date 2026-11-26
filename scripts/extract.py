"""Index the visible PDF text and save exact page crops for non-prose material."""
import json
import contextlib
import re
import statistics
import sys
from pathlib import Path

import pymupdf as fitz

NAMED = re.compile(r"^(abstract|summary|introduction|background|preliminaries|related work|literature review|materials and methods|methods?|methodology|model architecture|approach|experiments?(?: and results)?|experimental (?:setup|results)|evaluations?|results?(?: and discussion)?|discussion|limitations?|conclusions?(?: and future work)?|future work|acknowledg(?:e)?ments?|references|bibliography|appendix(?: [a-z0-9])?(?:[:.].*)?|supplementary material)$", re.I)
NUMBERED = re.compile(r"^(?:\d{1,2}(?:\.\d{1,2})*\.?|[A-G](?:\.\d+)*\.?)\s+[^\W\d_]", re.UNICODE)
CAPTION = re.compile(r"^(?:fig(?:ure)?\.?|table)\s+[A-Z]?\d+[a-z]?(?:[.:\s]|$)", re.I)
DOI = re.compile(r"10\.\d{4,9}/[-._;()/:A-Z0-9]+", re.I)


def text_lines(page):
    result = []
    flags = fitz.TEXTFLAGS_DICT & ~fitz.TEXT_PRESERVE_IMAGES
    for block in page.get_text('dict', flags=flags)['blocks']:
        lines = []
        for line in block['lines']:
            if abs(line['dir'][1]) > .17:
                continue
            spans = [s for s in line['spans'] if s['text'].strip()]
            if not spans:
                continue
            text = ''.join(s['text'] for s in line['spans']).strip()
            weight = sum(len(s['text']) for s in spans)
            lines.append(dict(text=text, box=fitz.Rect(line['bbox']),
                              size=max(s['size'] for s in spans),
                              bold=sum(len(s['text']) for s in spans if s['flags'] & 16) * 2 >= weight,
                              math=any(re.search(r'cm(?:mi|sy|ex)|math|symbol|msam|msbm', s['font'], re.I) for s in spans)))
        if lines:
            result.append(lines)
    return result


def heading(line, body):
    text = line['text'].strip()
    if len(text) > 120 or CAPTION.match(text):
        return False
    if not re.search(r'[A-Za-z]', text):
        return False
    named = re.sub(r'^\d+(?:\.\d+)*\.?\s+', '', text).rstrip(':')
    if NAMED.fullmatch(named) and (line['bold'] or (named[:1].isupper() and not named.lower().startswith('appendix'))):
        return True
    if text.endswith(('.', ',', ';', '?')):
        return False
    return bool(NUMBERED.match(text) and (line['bold'] or line['size'] >= body * 1.08)) or (
        line['bold'] and line['size'] >= body * 1.17 and len(text) < 90)


def union(rects):
    region = fitz.Rect()
    for rect in rects:
        region |= rect
    return region


def collect_blocks(page, groups, body):
    rows = []
    numbered = re.compile(r'^(?:\d{1,2}(?:\.\d{1,2})*\.?|[A-G](?:\.\d+)*\.?)$')
    headings = [l for g in groups for l in g if l['bold'] or l['size'] > body * 1.13]
    combined = {}
    remove = set()
    for label in headings:
        if not numbered.fullmatch(label['text']):
            continue
        options = [l for l in headings if abs(l['box'].y0 - label['box'].y0) < 2.5 and
                   -1 < l['box'].x0 - label['box'].x1 < 32 and re.match(r'[A-Z]', l['text']) and len(l['text']) < 100]
        if options:
            target = min(options, key=lambda l: l['box'].x0)
            combined[id(target)] = dict(target, text=f"{label['text']} {target['text']}", box=label['box'] | target['box'], bold=True)
            remove.add(id(label))
    for lines in groups:
        pending = []

        def flush():
            if not pending:
                return
            text = '\n'.join(line['text'] for line in pending)
            box = union(line['box'] for line in pending)
            formula = (len(text) < 240 and len(pending) <= 4 and
                       (bool(re.search(r'\s{2,}\(\d+[a-z]?\)\s*$', text)) or
                        (any(line['math'] for line in pending) and len(re.findall(r'[A-Za-z]{4,}', text)) <= 4
                         and bool(re.search(r'[=∑∏∫√≤≥∝]|\(\d+\)\s*$', text)))))
            rows.append(dict(text=text, box=box, kind='formula' if formula else 'text', size=pending[0]['size']))
            pending.clear()

        for original in lines:
            if id(original) in remove:
                continue
            line = combined.get(id(original), original)
            text = line['text']
            if re.fullmatch(r'\d{1,4}', text) and (line['box'].y0 < 38 or line['box'].y1 > page.rect.height - 43):
                continue
            inline = re.match(r'^(Abstract)(?:\s*[—–:]\s*|\s{2,})(.+)$', text, re.I)
            if inline:
                flush()
                rows.append(dict(text=inline[1], box=line['box'], kind='heading', size=line['size'], bold=True))
                pending.append(dict(line, text=inline[2]))
            elif heading(line, body):
                flush()
                rows.append(dict(line, kind='heading'))
            else:
                if pending:
                    last = pending[-1]
                    gap = line['box'].y0 - last['box'].y1
                    indent = line['box'].x0 - last['box'].x0
                    if gap > body * .7 or (gap > -body * .38 and indent > 13 and len(last['text']) > 22 and re.search(r'[.!?][)\]]?$', last['text'])):
                        flush()
                pending.append(line)
        flush()
    return rows


def ordered(rows, width):
    middle = width / 2
    left = [r for r in rows if r['box'].x1 <= middle + 7 and r['box'].width > width * .22]
    right = [r for r in rows if r['box'].x0 >= middle - 7 and r['box'].width > width * .22]
    double = bool(left and right and min(r['box'].y0 for r in left) < max(r['box'].y1 for r in right)
                  and min(r['box'].y0 for r in right) < max(r['box'].y1 for r in left))
    yx = lambda r: (round(r['box'].y0 / 2), r['box'].x0)
    if not double:
        return sorted(rows, key=yx), False
    barriers = sorted([r for r in rows if r['box'].x0 < middle - 24 and r['box'].x1 > middle + 24], key=yx)
    remainder = [r for r in rows if r not in barriers]
    output = []

    def columns(items):
        return sorted((r for r in items if r['box'].x0 < middle - 9), key=yx) + sorted(
            (r for r in items if r['box'].x0 >= middle - 9), key=yx)

    for barrier in barriers:
        before = [r for r in remainder if r['box'].y0 < barrier['box'].y0 - 4]
        output.extend(columns(before))
        output.append(barrier)
        remainder = [r for r in remainder if r not in before]
    output.extend(columns(remainder))
    return output, True


def save_crop(page, region, assets, name):
    region = (region + (-3, -3, 3, 3)) & page.rect
    if region.is_empty:
        return None
    page.get_pixmap(matrix=fitz.Matrix(1.8, 1.8), clip=region, alpha=False, annots=False).save(assets / name)
    return name


def associate_assets(page, rows, assets, page_no):
    captions = [r for r in rows if CAPTION.match(r['text'])]
    figures = [fitz.Rect(i['bbox']) for i in page.get_image_info() if fitz.Rect(i['bbox']).get_area() > 1000]
    if any(not c['text'].lower().startswith('table') for c in captions):
        try:
            figures += [r for r in page.cluster_drawings() if r.width > 50 and r.height > 42]
        except (RuntimeError, ValueError):
            pass
    tables = []
    if any(c['text'].lower().startswith('table') for c in captions):
        try:
            for table in page.find_tables().tables:
                tables.append((fitz.Rect(table.bbox), table.extract()))
        except (RuntimeError, ValueError, TypeError):
            pass

    def distance(region, box):
        overlap = max(0, min(region.x1, box.x1) - max(region.x0, box.x0))
        if overlap < min(box.width, region.width) * .38:
            return 10000
        return max(0, box.y0 - region.y1, region.y0 - box.y1) + (0 if region.y1 < box.y0 else 11)

    extras = []
    used_tables = set()
    for idx, caption in enumerate(captions):
        box = caption['box']
        is_table = caption['text'].lower().startswith('table')
        caption['kind'] = 'table' if is_table else 'figure'
        if is_table:
            candidates = sorted(enumerate(tables), key=lambda t: distance(t[1][0], box))
            if not candidates or distance(candidates[0][1][0], box) > 95:
                continue
            table_index, (region, cells) = candidates[0]
            used_tables.add(table_index)
            caption['cells'] = cells
        else:
            candidates = sorted(figures, key=lambda r: distance(r, box))
            if not candidates or distance(candidates[0], box) > 95:
                continue
            region = candidates[0]
            neighboring = [region]
            for panel in candidates[1:]:
                vertical_overlap = min(panel.y1, region.y1) - max(panel.y0, region.y0)
                inside_caption = min(panel.x1, box.x1) - max(panel.x0, box.x0) >= panel.width * .75
                if vertical_overlap >= min(panel.height, region.height) * .5 and inside_caption and distance(panel, box) <= 100:
                    neighboring.append(panel)
            figures = [item for item in figures if item not in neighboring]
            region = union(neighboring)
        caption['asset'] = save_crop(page, region, assets, f'{page_no}-caption-{idx}.png')

    for idx, region in enumerate(figures):
        if region.get_area() > page.rect.get_area() * .7:
            continue
        extras.append(dict(kind='figure', box=region, text='', size=0,
                           asset=save_crop(page, region, assets, f'{page_no}-figure-{idx}.png')))
    for idx, (region, cells) in enumerate(tables):
        if idx not in used_tables:
            extras.append(dict(kind='table', box=region, text='', cells=cells, size=0,
                               asset=save_crop(page, region, assets, f'{page_no}-table-{idx}.png')))
    for idx, row in enumerate(rows):
        if row['kind'] == 'formula':
            row['asset'] = save_crop(page, row['box'], assets, f'{page_no}-formula-{idx}.png')
    return rows + extras


def join_formula_fragments(rows):
    remaining = []
    for row in rows:
        if row['kind'] == 'formula':
            box = row['box']
            neighbor = next((candidate for candidate in reversed(remaining[-5:]) if candidate['kind'] == 'formula' and
                             min(candidate['box'].y1, box.y1) - max(candidate['box'].y0, box.y0) > 3 and
                             max(candidate['box'].x0, box.x0) - min(candidate['box'].x1, box.x1) < 16), None)
            if neighbor:
                neighbor['text'] += '\n' + row['text']
                neighbor['box'] |= box
                continue
        remaining.append(row)
    return remaining


def metadata(doc, first, original_name):
    meta = doc.metadata or {}
    early = sorted([l for group in first for l in group if l['box'].y0 < doc[0].rect.height * .65], key=lambda l: (l['box'].y0, l['box'].x0))
    peak = max([l['size'] for l in early if len(l['text']) > 8] or [0])
    headline = [l for l in early if l['size'] >= peak * .94 and len(l['text']) > 6 and not NAMED.fullmatch(l['text'])]
    if headline:
        headline = [l for l in headline if l['box'].y0 <= headline[0]['box'].y0 + peak * 2.7]
    meta_title = (meta.get('title') or '').strip()
    title = meta_title if len(meta_title) >= 7 and not re.search(r'\.tex$|^untitled|^microsoft word', meta_title, re.I) else ' '.join(l['text'] for l in headline)
    author_meta = (meta.get('author') or '').strip()
    authors = [a.strip() for a in re.split(r'\s*(?:;|,|\band\b)\s*', author_meta) if a.strip() and a.lower() not in ('arxiv', 'anonymous', 'unknown')]
    if not authors and headline:
        bottom = max(l['box'].y1 for l in headline)
        abstract = next((l['box'].y0 for l in early if l['text'].lower().startswith('abstract')), bottom + 210)
        for line in early:
            t = line['text'].strip('∗*†‡ ')
            if not bottom - 1 <= line['box'].y0 < min(abstract, bottom + 210):
                continue
            if not line['bold'] or re.search(r'@|university|research|brain|google|workshop|proceedings|department|arxiv|^http', t, re.I):
                continue
            authors.extend(a.strip('∗*†‡ ') for a in re.split(r'\s*(?:[,;]|\band\b|\s{2,})\s*', t) if 2 <= len(a.split()) <= 7 and len(a) <= 90)
    evidence = doc[0].get_text()[:6000] + '\n' + (doc.get_xml_metadata() or '')[:16000]
    doi_match = DOI.search(evidence)
    doi = doi_match[0].rstrip('.),;') if doi_match else None
    arxiv_match = re.search(r'arxiv\s*[:.]\s*(\d{2})\d{2}\.\d{4,5}', evidence, re.I)
    explicit_year = re.search(r'(?:©\s*|copyright\s*|proceedings[^\n]{0,100}?|published[^\n]{0,80}?)(19\d{2}|20\d{2})', evidence, re.I)
    year = explicit_year[1] if explicit_year else ('20' + arxiv_match[1] if arxiv_match else None)
    return (title or Path(original_name).stem)[:400], list(dict.fromkeys(authors))[:60], year, doi, headline


def index(pdf, assets, original_name):
    assets.mkdir(exist_ok=True, parents=True)
    with fitz.open(pdf) as doc:
        if not doc.is_pdf or doc.needs_pass or not 0 < len(doc) <= 400:
            raise ValueError('PDF 必须未加密，并包含 1–400 页。')
        first = text_lines(doc[0])
        title, authors, year, doi, headline = metadata(doc, first, original_name)
        outlines = doc.get_toc(simple=False)
        sections = []
        uncertain = []
        double = []
        block_no = 0
        current = None
        headings_seen = set()
        top_exclusion = 0
        if headline:
            top_exclusion = max(line['box'].y1 for line in headline)

        def new_section(name, page_no, level):
            nonlocal current
            name = ' '.join(name.split())[:200]
            current = dict(id=f's{len(sections) + 1}', title=name, level=level, page=page_no, blocks=[])
            sections.append(current)
            headings_seen.add(re.sub(r'\W', '', name).lower())

        running_headers = {}
        for page_no, page in enumerate(doc, 1):
            groups = first if page_no == 1 else text_lines(page)
            body_lines = [l for g in groups for l in g if len(l['text']) >= 36]
            body = statistics.median([l['size'] for l in body_lines]) if body_lines else 10
            rows = collect_blocks(page, groups, body)
            text = ''.join(r['text'] for r in rows)
            bad = len(text.strip()) < 60 or text.count('\ufffd') > max(3, len(text) * .025) or text.count('\x00') > 3
            if bad:
                uncertain.append(page_no)
            if page_no == 1:
                abstract = next((r['box'].y0 for r in rows if r['kind'] == 'heading' and r['text'].lower().rstrip(':') == 'abstract'), None)
                if abstract is not None:
                    rows = [r for r in rows if r['box'].y0 >= abstract - .5]
                elif top_exclusion:
                    rows = [r for r in rows if r['box'].y0 > top_exclusion - .5]
            for level, name, on_page, link in outlines:
                if on_page != page_no or not name.strip():
                    continue
                normalized = re.sub(r'\W', '', name).lower()
                match = next((r for r in rows if r['kind'] == 'heading' and
                              (re.sub(r'\W', '', r['text']).lower() == normalized or re.sub(r'\W', '', re.sub(r'^\d[\d.]*\s*', '', r['text'])).lower() == normalized)), None)
                if match:
                    match['level'] = level
                elif normalized not in headings_seen and link.get('to') is not None and re.search(r'[A-Za-z]', name):
                    point = link['to']
                    rows.append(dict(text=name, kind='heading', box=fitz.Rect(point.x, point.y, point.x + 1, point.y + 1), size=body, level=level))
            rows = associate_assets(page, join_formula_fragments(rows), assets, page_no)
            rows, is_double = ordered(rows, page.rect.width)
            if is_double:
                double.append(page_no)
            if bad:
                rows.insert(0, dict(kind='page', text='', box=page.rect, size=0))
            for row in rows:
                text = row['text']
                box = row['box']
                if row['kind'] == 'text' and (box.y1 < 42 or box.y0 > page.rect.height - 39):
                    if text in running_headers:
                        continue
                    running_headers[text] = page_no
                if row['kind'] == 'heading':
                    number = re.match(r'^((?:\d+|[A-G])(?:\.\d+)*)\b', text)
                    level = row.get('level', len(number[1].split('.')) if number else 1)
                    if not current or current['blocks'] or current['title'] != text:
                        new_section(text, page_no, level)
                    continue
                if not text.strip() and row['kind'] == 'text':
                    continue
                if not current:
                    new_section('Document', page_no, 1)
                block_no += 1
                block = dict(id=f'p{block_no}', kind=row['kind'], text=text, page=page_no,
                             box=[round(v, 2) for v in box])
                for field in ('asset', 'cells'):
                    if row.get(field):
                        block[field] = row[field]
                current['blocks'].append(block)

        if not sections:
            new_section('Document', 1, 1)
        warnings = []
        if uncertain:
            warnings.append('部分页面的文字层不完整，可打开原始 PDF 或按页请求视觉分析。')
        if len(sections) <= 1:
            warnings.append('没有可靠的章节标题，已按 PDF 阅读顺序索引原文。')
        return dict(title=title, authors=authors, year=year, doi=doi, pages=len(doc), sections=sections,
                    uncertainPages=uncertain, columnPages=double, warnings=warnings)


def render_page(pdf, number, output):
    with fitz.open(pdf) as doc:
        page = doc[number - 1]
        scale = min(2, 1700 / max(page.rect.width, page.rect.height))
        page.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False, annots=False).save(output)


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    if sys.argv[1] == 'page':
        render_page(sys.argv[2], int(sys.argv[3]), sys.argv[4])
    else:
        with contextlib.redirect_stdout(sys.stderr):
            result = index(Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3])
        print(json.dumps(result, ensure_ascii=False))
