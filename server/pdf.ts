import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, renameSync, rmSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { PaperStructure } from '../shared/model.ts';
import type { Store } from './store.ts';

const execute = promisify(execFile);
const project = fileURLToPath(new URL('..', import.meta.url));
const pythonInVenv = join(project, '.venv', ...(process.platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python']));
const python = process.env.PC_PYTHON || (existsSync(pythonInVenv) ? pythonInVenv : process.platform === 'win32' ? 'python' : 'python3');
const script = join(project, 'scripts', 'extract.py');

export class PdfError extends Error {}

async function runPython(args: string[], signal?: AbortSignal) {
  try {
    return (await execute(python, ['-X', 'utf8', script, ...args], { timeout: 150_000, maxBuffer: 45 * 1024 * 1024,
      windowsHide: true, encoding: 'utf8', signal, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } })).stdout;
  } catch (cause) {
    if (signal?.aborted) throw new DOMException('PDF 操作已中断。', 'AbortError');
    const error = cause as Error & { code?: string; stderr?: string; killed?: boolean };
    if (error.code === 'ENOENT' || /No module named 'pymupdf'/.test(error.stderr ?? '')) {
      throw new PdfError('无法启动 PyMuPDF。请安装 requirements.txt 或设置 PC_PYTHON。');
    }
    if (error.killed) throw new PdfError('PDF 处理超时。');
    const detail = (error.stderr ?? '').trim().split('\n').at(-1)?.slice(0, 220);
    throw new PdfError(detail?.startsWith('ValueError:') ? detail.slice(11).trim() : '无法解析该 PDF。请检查文件是否损坏或加密。');
  }
}

export function paperDirectory(data: string, id: string) { return join(data, 'papers', id); }

export async function importPdf(store: Store, data: string, fileName: string, bytes: Buffer) {
  if (!bytes.subarray(0, 1024).includes(Buffer.from('%PDF-'))) throw new PdfError('请选择有效的 PDF 文件。');
  const id = createHash('sha256').update(bytes).digest('hex');
  if (store.exists(id)) return { id, duplicate: true };
  const safeName = basename(fileName.replaceAll('\\', '/')).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 240) || 'paper.pdf';
  const stage = join(data, 'staging', randomUUID());
  await mkdir(stage, { recursive: true });
  try {
    const pdf = join(stage, 'original.pdf');
    await writeFile(pdf, bytes, { flag: 'wx' });
    const text = await runPython([pdf, join(stage, 'assets'), safeName]);
    const structure = JSON.parse(text) as PaperStructure;
    if (store.exists(id)) return { id, duplicate: true };
    const destination = paperDirectory(data, id);
    // The commit is synchronous to prevent two concurrent imports from winning the same hash.
    // A crash before the SQL insert can leave an unindexed copy of this exact hash.
    if (existsSync(destination)) rmSync(destination, { recursive: true, force: true });
    renameSync(stage, destination);
    try { store.addPaper(id, safeName, structure); }
    catch (error) { await rename(destination, stage); throw error; }
    return { id, duplicate: false };
  } finally { await rm(stage, { recursive: true, force: true }); }
}

export async function makePageImage(data: string, id: string, page: number, signal: AbortSignal) {
  const png = join(paperDirectory(data, id), 'assets', `page-${page}.png`);
  if (existsSync(png)) return png;
  const temp = join(data, 'staging', `${randomUUID()}.png`);
  try {
    await runPython(['page', join(paperDirectory(data, id), 'original.pdf'), String(page), temp], signal);
    await rename(temp, png);
    return png;
  } finally { await rm(temp, { force: true }); }
}
