import { spawnSync } from 'node:child_process';
import { existsSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { data, lock, project } from './data.mjs';

function latest(path) {
  const info = statSync(path);
  if (!info.isDirectory()) return info.mtimeMs;
  return Math.max(info.mtimeMs, ...readdirSync(path).map((name) => latest(join(path, name))));
}

const built = join(project, 'dist', 'index.html');
const inputs = ['src', 'shared', 'index.html', 'diagram.html', 'vite.config.ts', 'package.json'];
if (!existsSync(built) || inputs.some((name) => latest(join(project, name)) > statSync(built).mtimeMs)) {
  const vite = join(project, 'node_modules', 'vite', 'bin', 'vite.js');
  if (!existsSync(vite)) { console.error('请先运行 npm install。'); process.exit(1); }
  const result = spawnSync(process.execPath, [vite, 'build'], { cwd: project, stdio: 'inherit', windowsHide: true });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
if (existsSync(join(project, '.env'))) process.loadEnvFile(join(project, '.env'));
const directory = process.env.PC_DATA_DIR ? (await import('node:path')).resolve(process.env.PC_DATA_DIR) : data;
const port = Number(process.env.PC_PORT ?? 4317);
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('PC_PORT 必须为 1 至 65535。');
const release = lock(directory);
process.on('exit', release);
try {
  const { startServer } = await import('../server/index.ts');
  const server = await startServer({ data: directory, dist: join(project, 'dist'), port });
  console.log(`Paper Companion → http://127.0.0.1:${port}  |  ${directory}`);
  let closing = false;
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
    if (closing) return;
    closing = true;
    const deadline = setTimeout(() => process.exit(0), 4500).unref();
    try { await server.close(); }
    finally { clearTimeout(deadline); process.exit(0); }
  });
} catch (error) { console.error(error.message); process.exitCode = 1; }
