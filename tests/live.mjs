import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { project } from '../scripts/data.mjs';
import { sseData } from '../server/providers.ts';

const [firstFile, secondFile] = process.argv.slice(2);
if (!firstFile || !secondFile) throw new Error('用法：npm run test:live -- <first.pdf> <second.pdf>');
const scratch = await mkdtemp(join(process.env.PC_TEST_ROOT || tmpdir(), 'paper-companion-live-'));
const data = join(scratch, 'data');
const port = Number(process.env.PC_TEST_PORT || '4537');
const base = `http://127.0.0.1:${port}`;
const firstPath = resolve(firstFile);
const secondPath = resolve(secondFile);
const environment = { ...process.env, PC_DATA_DIR: data, PC_PORT: String(port) };
delete environment.OPENAI_API_KEY;
let child;

async function start() {
  child = spawn(process.execPath, ['scripts/start.mjs'], { cwd: project, env: environment, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let output = '';
  child.stdout.on('data', (buffer) => { output += buffer; });
  child.stderr.on('data', (buffer) => { output += buffer; });
  for (let count = 0; count < 600; count++) {
    if (output.includes(`Paper Companion → ${base}`)) return;
    if (child.exitCode !== null) throw new Error(output);
    await delay(250);
  }
  throw new Error(`服务器启动超时\n${output}`);
}

async function shutdown() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const stopped = once(child, 'exit');
  child.kill('SIGKILL');
  await stopped;
}

async function req(path, method = 'GET', value, type = 'application/json') {
  const response = await fetch(base + path, { method, headers: value === undefined ? {} : { 'Content-Type': type },
    body: value === undefined ? undefined : type === 'application/json' ? JSON.stringify(value) : value,
    signal: AbortSignal.timeout(300_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${await response.text()}`);
  return response;
}
const json = async (...args) => (await req(...args)).json();
const pathFor = (id, suffix = '') => `/api/papers/${id}${suffix}`;
const importFile = async (file) => json(`/api/papers?name=${encodeURIComponent(basename(file))}`, 'POST', await readFile(file), 'application/pdf');
const get = (id) => json(pathFor(id));
async function operation(id, kind, values, onEvent) {
  const response = await req(pathFor(id, `/${kind}`), 'POST', values);
  const events = [];
  for await (const frame of sseData(response.body)) {
    const event = JSON.parse(frame);
    events.push(event);
    if (onEvent && await onEvent(event)) break;
  }
  return events;
}
function assertStream(events, key) {
  const terminal = events.filter((item) => item.type === 'status').at(-1);
  assert.equal(terminal?.phase, 'complete', terminal?.error);
  const deltas = events.filter((event) => event.type === 'delta' && (!key || event.key === key));
  assert.ok(deltas.length > 5, `expected incremental deltas, got ${deltas.length}`);
  assert.match(deltas.map((event) => event.text).join(''), /[\u3400-\u9fff]/);
}

try {
  await start();
  assert.deepEqual(await json('/api/papers'), []);
  const settings = await json('/api/settings');
  assert.equal(settings.provider, 'codex');
  await json('/api/settings', 'PUT', { ...settings, importGeneration: 'off' });
  const auth = await json('/api/provider');
  assert.equal(auth.ready, true, auth.message);
  console.log(`Codex ChatGPT login and model catalog verified (${auth.models.length} models).`);

  const first = await importFile(firstPath);
  assert.equal(first.duplicate, false);
  const paper = await get(first.id);
  const abstract = paper.structure.sections.find((section) => /^abstract$/i.test(section.title));
  const next = paper.structure.sections.find((section) => /introduction/i.test(section.title));
  assert.ok(abstract?.blocks.length && next?.blocks.length, 'Expected Abstract and Introduction');
  assert.equal(paper.position.section, abstract.id);
  assert.equal((await importFile(firstPath)).duplicate, true);
  console.log(`Imported ${paper.title}: ${paper.structure.sections.length} sections, ${paper.pages} pages.`);

  const trace = await operation(first.id, 'generate', { section: abstract.id });
  assertStream(trace, abstract.blocks[0].id);
  const afterGeneration = await get(first.id);
  assert.match(afterGeneration.analyses[abstract.id][abstract.blocks[0].id], /[\u3400-\u9fff]/);
  assert.ok(afterGeneration.analyses[abstract.id].critical);
  assert.ok(afterGeneration.codexThread);
  const cache = await operation(first.id, 'generate', { section: abstract.id });
  assert.equal(cache.some((event) => event.type === 'delta'), false);
  console.log('Abstract streamed as Chinese paragraphs and Critical Analysis, then loaded from cache.');

  await json(pathFor(first.id, '/read'), 'PUT', { section: abstract.id, read: true });
  const question = '根据当前 Abstract 的原文，作者明确声称取消了哪些网络组件？请保留原文术语并注明段落编号。';
  const chat = await operation(first.id, 'chat', { question, section: abstract.id, block: abstract.blocks[0].id, saveQuestion: true });
  assertStream(chat);
  const answered = await get(first.id);
  assert.equal(answered.messages.length, 2);
  assert.equal(answered.messages[0].text, question);
  assert.match(answered.messages[1].text, /recurrent|recurrence|convolution|循环|卷积/i);
  assert.match(answered.messages[1].text, /p\d+/i);
  const follow = await operation(first.id, 'chat', { question: '把上一条回答改写为一句话，保留刚刚提到的两类组件。', section: abstract.id, block: abstract.blocks[0].id });
  assertStream(follow);
  const beforeExit = await get(first.id);
  assert.match(beforeExit.messages.at(-1).text, /recurrent|recurrence|convolution|循环|卷积/i);
  console.log('Paper-grounded Q&A and a follow-up used actual streaming and persisted the conversation.');

  const position = { section: next.id, block: next.blocks[1]?.id ?? next.blocks[0].id, sourceScroll: 133, aiScroll: 88, mode: 'independent', stamp: Date.now(), split: 47, chatOpen: true };
  await json(pathFor(first.id, '/position'), 'PUT', position);
  const running = await req(pathFor(first.id, '/generate'), 'POST', { section: next.id });
  // Crash after one completed row, leaving the remaining rows in-flight.
  for await (const frame of sseData(running.body)) {
    const event = JSON.parse(frame);
    if (event.type === 'saved') { await shutdown(); break; }
    if (event.type === 'status' && event.phase === 'error') throw new Error(event.error);
  }
  await start();
  const restored = await get(first.id);
  assert.deepEqual(restored.position, position);
  assert.equal(restored.messages.length, 4);
  assert.deepEqual(restored.analyses[abstract.id], afterGeneration.analyses[abstract.id]);
  assert.equal(restored.codexThread, afterGeneration.codexThread);
  assert.equal(restored.statuses[next.id].phase, 'interrupted');
  assert.ok(Object.keys(restored.analyses[next.id]).length >= 1);
  assert.ok(restored.read.includes(abstract.id));
  console.log('Hard-stopped and restarted the backend. Position, cache, read state and history were restored; interrupted work was recoverable.');

  const other = await importFile(secondPath);
  assert.notEqual(other.id, first.id);
  const otherPaper = await get(other.id);
  const otherAbstract = otherPaper.structure.sections.find((section) => /^abstract$/i.test(section.title));
  assert.ok(otherAbstract?.blocks.length);
  assert.equal(otherPaper.messages.length, 0);
  assert.equal(otherPaper.codexThread, null);
  assert.ok(otherPaper.structure.columnPages.length > 0, 'Use a two-column second PDF for this acceptance test.');
  assertStream(await operation(other.id, 'generate', { section: otherAbstract.id }));
  assert.notEqual((await get(other.id)).codexThread, restored.codexThread);
  const back = await get(first.id);
  assert.deepEqual(back.position, restored.position);
  assert.deepEqual(back.messages, restored.messages);
  assert.equal((await json('/api/papers')).length, 2);
  const notes = await json(pathFor(first.id, '/notes'));
  assert.ok(notes.some((note) => note.source === 'user' && note.text === question));
  assert.ok(notes.some((note) => note.source === 'ai' && note.category === 'Critical Comments'));
  assert.match(await (await req(pathFor(first.id, '/export.md'))).text(), /Critical Analysis/);
  console.log(`Second, two-column paper verified (${otherPaper.title}). Its thread is separate, and returning to the first paper preserved state.`);

  const durableRows = Object.keys(restored.analyses[next.id]);
  const continued = await operation(first.id, 'generate', { section: next.id });
  assertStream(continued);
  assert.ok(!continued.some((event) => event.type === 'delta' && durableRows.includes(event.key)));
  assert.equal((await get(first.id)).codexThread, restored.codexThread);
  console.log('Resumed the existing Codex thread after restart and generated only missing paragraphs.');

  const visual = await operation(other.id, 'chat', { section: otherAbstract.id, block: otherAbstract.blocks[0].id, page: 1,
    question: '根据给出的原始 PDF 第 1 页图像，用一句中文指出 Abstract 和 Introduction 的相对版面位置。' });
  assertStream(visual);
  assert.equal((await get(other.id)).messages.at(-1).page, 1);
  console.log('Streamed visual analysis of the original BERT PDF page.');

  await shutdown();
  const zip = join(scratch, 'backup.zip');
  for (const mode of ['backup', 'restore']) {
    const archive = spawn(process.execPath, ['scripts/backup.mjs', mode, zip], { cwd: project, env: environment, stdio: 'inherit', windowsHide: true });
    assert.equal((await once(archive, 'exit'))[0], 0);
  }
  await start();
  assert.deepEqual((await get(first.id)).messages, restored.messages);
  const restoredPdf = await req(pathFor(other.id, '/pdf'));
  assert.equal(restoredPdf.headers.get('content-type'), 'application/pdf');
  assert.deepEqual(Buffer.from(await restoredPdf.arrayBuffer()), await readFile(secondPath));
  console.log('Backup and restore verified against the original PDF and conversation records.');
} finally {
  await shutdown();
  if (process.env.PC_KEEP_TEST_DATA === '1') console.log(`Test data: ${data}`);
  else await rm(scratch, { recursive: true, force: true });
}
