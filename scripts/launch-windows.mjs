import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { project } from './data.mjs';

const run = promisify(execFile);
const environment = join(project, '.env');
if (existsSync(environment)) process.loadEnvFile(environment);
const lock = join(resolve(process.env.PC_DATA_DIR || join(project, 'data')), '.running');
const port = Number(process.env.PC_PORT ?? 4317);
const address = `127.0.0.1:${port}`;
const url = `http://${address}`;
const system = join(process.env.SystemRoot || 'C:\\Windows', 'System32');

function lockedProcess() {
  try {
    const pid = Number(readFileSync(lock, 'utf8'));
    if (!Number.isSafeInteger(pid) || pid < 1 || pid === process.pid) return null;
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

async function findRunningApp() {
  const pid = lockedProcess();
  if (!pid) return false;
  for (let attempt = 0; attempt < 12 && lockedProcess() === pid; attempt++) {
    try {
      const { stdout } = await run(join(system, 'netstat.exe'), ['-ano', '-p', 'TCP'], { timeout: 2000, windowsHide: true });
      const matches = stdout.split(/\r?\n/).some((line) => {
        const [protocol, local, remote, , owner] = line.trim().split(/\s+/);
        return protocol === 'TCP' && local === address && remote === '0.0.0.0:0' && Number(owner) === pid;
      });
      if (matches) {
        const response = await fetch(`${url}/api/settings`, { signal: AbortSignal.timeout(1300) });
        await response.body?.cancel();
        if (response.ok) return true;
      }
    } catch { /* The other launcher may still be starting the server. */ }
    await delay(250);
  }
  return false;
}

async function openPage() {
  if (process.argv.includes('--no-browser')) return;
  console.log(`论文库地址 ${url}。正在打开默认浏览器…`);
  try {
    await run(join(system, 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-Command', `Start-Process -FilePath '${url}/' -ErrorAction Stop`],
      { windowsHide: true, timeout: 10000 });
  } catch {
    console.error(`请在浏览器地址栏输入 ${url}`);
  }
}

async function launch() {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('PC_PORT 必须为 1 至 65535。');
  if (await findRunningApp()) {
    console.log(`PaperFellow 已在运行。${url}`);
    await openPage();
    return;
  }
  try { await import('./start.mjs'); }
  catch (error) {
    if (!await findRunningApp()) throw error;
  }
  if (!process.exitCode) await openPage();
}

try { await launch(); }
catch (error) { console.error(error.message); process.exitCode = 1; }
