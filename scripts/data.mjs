import { existsSync, mkdirSync, openSync, closeSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const project = fileURLToPath(new URL('..', import.meta.url));
export const data = resolve(process.env.PC_DATA_DIR || join(project, 'data'));

export function lock(directory) {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, '.running');
  if (existsSync(path)) {
    const pid = Number(readFileSync(path, 'utf8'));
    if (!Number.isInteger(pid) || pid < 1) throw new Error(`无法读取进程锁 ${path}。`);
    try { process.kill(pid, 0); throw new Error(`数据目录正在使用（进程 ${pid}）。`); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
    unlinkSync(path);
  }
  const handle = openSync(path, 'wx');
  try { writeFileSync(handle, String(process.pid)); }
  finally { closeSync(handle); }
  return () => { if (existsSync(path) && readFileSync(path, 'utf8') === String(process.pid)) unlinkSync(path); };
}
