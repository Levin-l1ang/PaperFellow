import hashlib
import json
import re
import shutil
import sqlite3
import sys
import tempfile
import time
import zipfile
from contextlib import closing
from pathlib import Path

PAPER = re.compile(r'papers/[a-f0-9]{64}/(?:original\.pdf|assets/[a-z0-9-]+\.png)')


def database(root):
    return root / 'papers.sqlite'


def backup(root, output):
    if not database(root).is_file():
        raise ValueError('没有可备份的论文数据库。')
    with tempfile.TemporaryDirectory(dir=root.parent) as staging:
        snapshot = database(Path(staging))
        with closing(sqlite3.connect(database(root))) as db, closing(sqlite3.connect(snapshot)) as copy:
            db.backup(copy)
        with zipfile.ZipFile(output, 'x', compression=zipfile.ZIP_DEFLATED, compresslevel=4) as archive:
            archive.writestr('manifest.json', json.dumps({'product': 'Paper Companion', 'format': 1}))
            archive.write(snapshot, 'papers.sqlite')
            for file in sorted((root / 'papers').rglob('*')):
                name = file.relative_to(root).as_posix()
                if file.is_file() and PAPER.fullmatch(name):
                    archive.write(file, name)
    print(f'备份已写入 {output}')


def validate(root):
    with closing(sqlite3.connect(database(root))) as connection:
        if connection.execute('PRAGMA user_version').fetchone()[0] != 1 or connection.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
            raise ValueError('SQLite 备份损坏或版本不受支持。')
        for paper_id, structure in connection.execute('SELECT id,structure FROM papers'):
            if not re.fullmatch(r'[a-f0-9]{64}', paper_id):
                raise ValueError('备份中存在无效的论文 ID。')
            target = root / 'papers' / paper_id
            pdf = target / 'original.pdf'
            if not pdf.is_file():
                raise ValueError(f'备份缺少原始 PDF {paper_id}。')
            with pdf.open('rb') as content:
                if hashlib.file_digest(content, 'sha256').hexdigest() != paper_id:
                    raise ValueError(f'原始 PDF 校验失败 {paper_id}。')
            assets = target / 'assets'
            assets.mkdir(exist_ok=True)
            for section in json.loads(structure)['sections']:
                for block in section['blocks']:
                    name = block.get('asset')
                    if name and (not re.fullmatch(r'[a-z0-9-]+\.png', name) or not (assets / name).is_file()):
                        raise ValueError(f'备份缺少原始图文区域 {name}。')


def restore(root, source):
    with tempfile.TemporaryDirectory(dir=root.parent) as staging:
        dest = Path(staging) / 'restored'
        dest.mkdir()
        with zipfile.ZipFile(source) as archive:
            names = archive.namelist()
            if len(names) != len(set(names)) or 'manifest.json' not in names or 'papers.sqlite' not in names:
                raise ValueError('备份文件目录无效。')
            if archive.getinfo('manifest.json').file_size > 1024 or json.loads(archive.read('manifest.json')) != {'product': 'Paper Companion', 'format': 1}:
                raise ValueError('备份格式无效。')
            for entry in archive.infolist():
                name = entry.filename
                if name == 'manifest.json':
                    continue
                if name != 'papers.sqlite' and not PAPER.fullmatch(name):
                    raise ValueError(f'备份包含未识别的文件 {name}。')
                path = dest / name
                path.parent.mkdir(parents=True, exist_ok=True)
                with archive.open(entry) as incoming, path.open('xb') as output:
                    shutil.copyfileobj(incoming, output)
        validate(dest)
        shutil.copyfile(root / '.running', dest / '.running')
        previous = root.with_name(f'{root.name}.before-restore-{time.time_ns()}')
        root.rename(previous)
        try:
            dest.rename(root)
        except OSError:
            previous.rename(root)
            raise
        (previous / '.running').unlink()
        print(f'已恢复数据。恢复前的数据保留于 {previous}')


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    try:
        action, root, file = sys.argv[1:]
        (backup if action == 'backup' else restore)(Path(root), Path(file))
    except (ValueError, OSError, sqlite3.Error, zipfile.BadZipFile) as error:
        sys.exit(str(error))
