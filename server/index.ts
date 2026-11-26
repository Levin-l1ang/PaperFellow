import { mkdirSync, createReadStream, statSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { z } from 'zod';
import { highlightSchema, noteSchema, positionSchema, questionSchema, settingsSchema } from '../shared/model.ts';
import type { Paper, Section, StreamEvent } from '../shared/model.ts';
import { Companion } from './companion.ts';
import { importPdf, paperDirectory, PdfError } from './pdf.ts';
import { ImportPreparation } from './preparation.ts';
import { errorMessage, openAIStatus } from './providers.ts';
import { Store } from './store.ts';
import { answerSchema, visibleQuiz } from '../shared/quiz.ts';

const maxPdf = 80 * 1024 * 1024;
const mimes: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.wasm': 'application/wasm', '.pdf': 'application/pdf', '.bcmap': 'application/octet-stream', '.pfb': 'application/octet-stream' };
const contentPolicy = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data: blob:; worker-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'";

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

function json(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }).end(JSON.stringify(value));
}

async function raw(request: IncomingMessage, max: number, mime: string) {
  if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== mime) throw new HttpError(415, '请求类型不受支持。');
  if (Number(request.headers['content-length']) > max) { request.resume(); throw new HttpError(413, '文件或请求过大。'); }
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for await (const chunk of request.iterator({ destroyOnReturn: false })) {
      bytes += chunk.length;
      if (bytes > max) { request.resume(); throw new HttpError(413, '文件或请求过大。'); }
      chunks.push(chunk as Buffer);
    }
  } catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(400, '上传已中断。'); }
  return Buffer.concat(chunks, bytes);
}

async function body<T>(request: IncomingMessage, schema: z.ZodType<T>) {
  const bytes = await raw(request, 256 * 1024, 'application/json');
  let value: unknown;
  try { value = JSON.parse(bytes.toString()); } catch { throw new HttpError(400, 'JSON 请求无效。'); }
  const result = schema.safeParse(value);
  if (!result.success) throw new HttpError(400, result.error.issues.map((issue) => `${issue.path.join('.') || '字段'} ${issue.message}`).join(' · ').slice(0, 500));
  return result.data;
}

function selected(paper: Paper, id: string, block?: string | null) {
  const section = paper.structure.sections.find((item) => item.id === id);
  if (!section || (block && !section.blocks.some((item) => item.id === block))) throw new HttpError(404, '章节或段落不存在。');
  return section;
}

function file(request: IncomingMessage, response: ServerResponse, path: string, isPrivate: boolean) {
  if (!existsSync(path) || !statSync(path).isFile()) throw new HttpError(404, '文件不存在。');
  const size = statSync(path).size;
  const mime = mimes[extname(path)] ?? 'application/octet-stream';
  const headers: Record<string, number | string> = { 'Content-Type': mime, 'Accept-Ranges': 'bytes',
    'Cache-Control': isPrivate ? 'private, no-store' : mime.startsWith('text/html') ? 'no-cache' : 'public, max-age=31536000, immutable' };
  if (!isPrivate && !mime.startsWith('text/html')) headers['Access-Control-Allow-Origin'] = '*';
  const range = request.headers.range;
  let start = 0;
  let end = size - 1;
  if (range) {
    const parsed = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (parsed && (parsed[1] || parsed[2])) {
      start = parsed[1] ? Number(parsed[1]) : Math.max(0, size - Number(parsed[2]));
      if (parsed[1] && parsed[2]) end = Math.min(end, Number(parsed[2]));
    }
    if (!parsed || end < start || !Number.isSafeInteger(start) || start >= size) {
      response.writeHead(416, { 'Content-Range': `bytes */${size}` }).end(); return;
    }
    headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  }
  headers['Content-Length'] = Math.max(0, end - start + 1);
  response.writeHead(range ? 206 : 200, headers);
  if (request.method === 'HEAD' || size === 0) { response.end(); return; }
  const stream = createReadStream(path, { start, end });
  stream.on('error', () => response.destroy());
  response.on('close', () => stream.destroy());
  stream.pipe(response);
}

export async function startServer({ data, dist, port }: { data: string; dist: string; port: number }) {
  const cwd = join(data, 'codex-work');
  for (const location of [data, cwd, join(data, 'papers'), join(data, 'staging')]) mkdirSync(location, { recursive: true });
  const store = new Store(data);
  const companion = new Companion(store, data, cwd);
  const preparation = new ImportPreparation(store, companion, () => companion.active.size > 0);
  let importCount = 0;
  let closing = false;
  const activeStreams = new Set<Promise<void>>();
  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      if (response.destroyed || response.headersSent) { response.end(); return; }
      if (error instanceof PdfError) { json(response, 422, { error: error.message }); return; }
      if (error instanceof HttpError) { json(response, error.status, { error: error.message }); return; }
      console.error(errorMessage(error));
      json(response, 500, { error: '本地服务遇到错误，请检查启动终端。' });
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse) {
    const serverPort = port || (server.address() as { port: number })?.port;
    const host = request.headers.host;
    const method = request.method;
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', `${contentPolicy}; frame-ancestors ${path === '/diagram.html' ? "'self'" : "'none'"}`);
    if (host !== `127.0.0.1:${serverPort}` && host !== `localhost:${serverPort}`) throw new HttpError(403, '请使用本机地址访问。');
    if (closing) throw new HttpError(503, '服务正在关闭。');
    if (path.startsWith('/api/')) {
      if (request.headers['sec-fetch-site'] === 'cross-site' || (request.headers.origin && request.headers.origin !== `http://${host}`)) {
        throw new HttpError(403, '拒绝跨站请求。');
      }
    } else {
      if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, '方法不受支持。');
      const entry = path === '/' ? '/index.html' : path;
      const target = resolve(dist, `.${entry}`);
      if (!target.startsWith(resolve(dist) + sep)) throw new HttpError(404, '文件不存在。');
      file(request, response, target, false);
      return;
    }

    if (path === '/api/settings') {
      if (method === 'GET') return json(response, 200, store.settings());
      if (method === 'PUT') return json(response, 200, store.saveSettings(await body(request, settingsSchema)));
    }
    if (path === '/api/provider' && method === 'GET') {
      return json(response, 200, store.settings().provider === 'codex' ? await companion.codex.status() : openAIStatus());
    }
    if (path === '/api/papers') {
      if (method === 'GET') return json(response, 200, store.library());
      if (method === 'POST') {
        if (importCount >= 2) throw new HttpError(429, '正在索引其他 PDF，请稍后重试。');
        const name = (url.searchParams.get('name') || 'paper.pdf').slice(0, 240);
        importCount++;
        try {
          const imported = await importPdf(store, data, name, await raw(request, maxPdf, 'application/pdf'));
          if (!imported.duplicate) preparation.enqueue(store.paper(imported.id)!, store.settings().importGeneration);
          return json(response, 200, { ...imported, preparation: store.preparation(imported.id) });
        }
        finally { importCount--; }
      }
    }

    const match = /^\/api\/papers\/([0-9a-f]{64})(.*)$/.exec(path);
    if (!match) throw new HttpError(404, '接口不存在。');
    const [, id, action] = match;
    if (!store.exists(id)) throw new HttpError(404, '论文不存在。');
    if ((method === 'GET' || method === 'HEAD') && (action === '/pdf' || /^\/assets\/[0-9a-z-]+\.png$/.test(action))) {
      return file(request, response, join(paperDirectory(data, id), action === '/pdf' ? 'original.pdf' : action.slice(1)), true);
    }
    if (action === '/stop' && method === 'POST') {
      await body(request, z.object({}).strict());
      companion.active.get(id)?.abort();
      return json(response, 200, { ok: true });
    }
    const paper = store.paper(id)!;
    if (action === '' && method === 'GET') return json(response, 200, paper);
    if (action === '/preparation' && method === 'POST') {
      const { action } = await body(request, z.object({ action: z.enum(['pause', 'resume']) }).strict());
      return json(response, 200, (action === 'pause' ? preparation.pause(id) : preparation.resume(paper)) ?? null);
    }
    if (action === '/companion-state' && method === 'GET') {
      const section = selected(paper, url.searchParams.get('section') ?? '');
      return json(response, 200, { preparation: paper.preparation, statuses: paper.statuses, analysis: paper.analyses[section.id] ?? {} });
    }
    if (action === '/background-stream' && method === 'GET') {
      const section = selected(paper, url.searchParams.get('section') ?? '');
      const unsubscribe = preparation.subscribe(id, section.id, (event) => {
        if (!response.headersSent) sseHeaders(response);
        if (response.destroyed || response.writableEnded) return;
        writeEvent(response, event);
        if (event.type === 'status' && event.phase !== 'running') response.end();
      });
      if (unsubscribe) response.on('close', unsubscribe);
      else response.writeHead(204, { 'Cache-Control': 'no-store' }).end();
      return;
    }
    const quizRoute = /^\/quiz\/([a-zA-Z0-9-]{1,48})$/.exec(action);
    if (quizRoute) {
      const section = selected(paper, quizRoute[1]);
      const quiz = store.quiz(id, section.id);
      if (method === 'GET') return json(response, 200, quiz ? visibleQuiz(quiz) : null);
      if (method === 'POST') {
        await body(request, z.object({}).strict());
        if (!section.blocks.some((block) => block.text.trim())) throw new HttpError(422, '本章节需要可索引的原文才能生成问题。');
        return startStream(id, response, (signal, emit) => companion.buildQuiz(store.paper(id)!, section, signal, emit));
      }
      if (method === 'PUT') {
        const answer = await body(request, answerSchema);
        const current = store.quiz(id, section.id);
        if (!current) throw new HttpError(404, '尚未生成问题。');
        if (current.answers[answer.item] === undefined) {
          current.answers[answer.item] = answer.choice;
          store.saveQuiz(id, section.id, current);
        }
        return json(response, 200, visibleQuiz(current));
      }
    }
    if (action === '/position' && method === 'PUT') {
      const position = await body(request, positionSchema);
      selected(paper, position.section, position.block);
      if (position.stamp > Date.now() + 60_000) throw new HttpError(400, '阅读位置时间无效。');
      store.position(id, position);
      return json(response, 200, { ok: true });
    }
    if (action === '/read' && method === 'PUT') {
      const value = await body(request, z.object({ section: z.string().max(48), read: z.boolean() }).strict());
      selected(paper, value.section);
      store.markRead(id, value.section, value.read);
      return json(response, 200, { ok: true });
    }
    if (action === '/notes') {
      if (method === 'GET') return json(response, 200, store.notes(paper));
      if (method === 'POST') {
        const note = await body(request, noteSchema);
        if (note.section) selected(paper, note.section, note.block);
        return json(response, 201, store.addNote(id, note));
      }
    }
    if (action === '/highlights' && method === 'POST') {
      const input = await body(request, highlightSchema);
      const block = paper.structure.sections.flatMap((section) => section.blocks).find((item) => item.id === input.block);
      if (!block || block.text.slice(input.start, input.end) !== input.quote) throw new HttpError(400, '所选文字和 PDF 索引不匹配。');
      return json(response, 201, store.addHighlight(id, input));
    }
    const record = /^\/(notes|highlights)\/([0-9a-f-]{36})$/.exec(action);
    if (record && method === 'DELETE') {
      await body(request, z.object({}).strict());
      store.delete(id, record[1] as 'notes' | 'highlights', record[2]);
      return json(response, 200, { ok: true });
    }
    if (record?.[1] === 'notes' && method === 'PUT') {
      const note = await body(request, noteSchema);
      if (note.section) selected(paper, note.section, note.block);
      const updated = store.updateNote(id, record[2], note);
      if (!updated) throw new HttpError(404, '笔记不存在。');
      return json(response, 200, updated);
    }
    if (action === '/export.md' && method === 'GET') {
      response.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': 'attachment; filename="reading-notes.md"',
        'Cache-Control': 'no-store' }).end(store.export(paper));
      return;
    }
    if (action === '/generate' && method === 'POST') {
      const input = await body(request, z.object({ section: z.string().max(48), regenerate: z.boolean().optional() }).strict());
      const section = selected(paper, input.section);
      return startStream(id, response, (signal, emit) => companion.generate(store.paper(id)!, section, input.regenerate ?? false, signal, emit));
    }
    if (action === '/chat' && method === 'POST') {
      const input = await body(request, questionSchema);
      const section: Section = selected(paper, input.section, input.block);
      if (input.page && input.page > paper.pages) throw new HttpError(404, 'PDF 页不存在。');
      return startStream(id, response, (signal, emit) => companion.answer(store.paper(id)!, section, input, signal, emit));
    }
    if (action === '/review' && method === 'POST') {
      await body(request, z.object({}).strict());
      return startStream(id, response, (signal, emit) => companion.review(store.paper(id)!, signal, emit));
    }
    throw new HttpError(404, '接口不存在。');
  }

  function sseHeaders(response: ServerResponse) {
    response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'Connection': 'keep-alive' });
    response.flushHeaders();
  }

  function writeEvent(response: ServerResponse, event: StreamEvent) { response.write(`data: ${JSON.stringify(event)}\n\n`); }

  async function startStream(id: string, response: ServerResponse, run: (signal: AbortSignal, emit: (event: StreamEvent) => void) => Promise<void>) {
    if (companion.active.has(id)) throw new HttpError(409, '本论文已有生成任务，请等待或先中断。');
    const controller = new AbortController();
    companion.active.set(id, controller);
    sseHeaders(response);
    response.on('close', () => controller.abort());
    const keepalive = setInterval(() => { if (!response.destroyed) response.write(': heartbeat\n\n'); }, 12000);
    const task = (async () => {
      await preparation.yieldToReader(id);
      if (controller.signal.aborted) {
        if (!response.destroyed) writeEvent(response, { type: 'status', phase: 'interrupted' });
        return;
      }
      await run(controller.signal, (event) => {
        if (!response.destroyed && !response.writableEnded) writeEvent(response, event);
      });
    })();
    activeStreams.add(task);
    try { await task; }
    finally {
      clearInterval(keepalive);
      activeStreams.delete(task);
      companion.active.delete(id);
      preparation.kick();
      response.end();
    }
  }

  try { await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); }); }
  catch (error) { store.close(); throw error; }
  return { port: (server.address() as { port: number }).port, async close() {
    closing = true;
    const background = preparation.close();
    companion.close();
    await Promise.allSettled([...activeStreams, background]);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  } };
}
