import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { lock, project } from './data.mjs';

const [action, archive] = process.argv.slice(2);
if (!archive || !['backup', 'restore'].includes(action)) throw new Error('用法：npm run backup -- <archive.zip> 或 npm run restore -- <archive.zip>');
if (existsSync(join(project, '.env'))) process.loadEnvFile(join(project, '.env'));
const directory = resolve(process.env.PC_DATA_DIR || join(project, 'data'));
const venv = join(project, '.venv', ...(process.platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python']));
const python = process.env.PC_PYTHON || (existsSync(venv) ? venv : process.platform === 'win32' ? 'python' : 'python3');
const release = lock(directory);
try {
  const result = spawnSync(python, ['-X', 'utf8', join(project, 'scripts', 'archive.py'), action, directory, resolve(archive)], { stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally { release(); }
