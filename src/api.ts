import { streamSchema } from '../shared/model.ts';
import type { Preparation, StreamEvent } from '../shared/model.ts';

export const paperURL = (paper: string, suffix = '') => `/api/papers/${paper}${suffix}`;

async function checked(response: Response) {
  if (response.ok) return response;
  const info = await response.json().catch(() => null);
  throw new Error(info?.error || `本地服务返回 ${response.status}。`);
}

export async function api<T>(url: string, method = 'GET', value?: unknown, keepalive = false): Promise<T> {
  const response = await checked(await fetch(url, { method, keepalive, headers: value === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: value === undefined ? undefined : JSON.stringify(value) }));
  return response.json() as Promise<T>;
}

export async function upload(file: File) {
  if (file.size > 80 * 1024 * 1024) throw new Error('PDF 超过 80 MB。');
  const response = await checked(await fetch(`/api/papers?name=${encodeURIComponent(file.name)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/pdf' }, body: file,
  }));
  return response.json() as Promise<{ id: string; duplicate: boolean; preparation?: Preparation }>;
}

export async function stream(url: string, request: unknown, signal: AbortSignal, receive: (event: StreamEvent) => void) {
  const response = await checked(await fetch(url, request === undefined ? { signal } :
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request), signal }));
  if (response.status === 204) return;
  if (!response.body) throw new Error('本地服务未返回流式响应。');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let terminal = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let i: number;
      while ((i = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, i);
        buffer = buffer.slice(i + 2);
        if (!frame.startsWith('data: ')) continue;
        const event = streamSchema.parse(JSON.parse(frame.slice(6)));
        if (event.type === 'status' && event.phase !== 'running' && event.phase !== 'idle') terminal = true;
        receive(event);
      }
    }
    if (!terminal) throw new Error('连接在生成完成前关闭。');
  } finally { await reader.cancel().catch(() => {}); }
}

export function message(error: unknown) { return error instanceof Error ? error.message : '操作失败。'; }
