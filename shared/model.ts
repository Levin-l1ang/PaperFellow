import { z } from 'zod';

export type BlockKind = 'text' | 'formula' | 'figure' | 'table' | 'page';
export interface Block {
  id: string; kind: BlockKind; text: string; page: number;
  box: [number, number, number, number]; asset?: string; cells?: (string | null)[][];
}
export interface Section {
  id: string; title: string; level: number; page: number; blocks: Block[];
}
export interface PaperStructure {
  title: string; authors: string[]; year: string | null; doi: string | null;
  pages: number; sections: Section[]; uncertainPages: number[];
  columnPages: number[]; warnings: string[];
}
export const positionSchema = z.object({
  section: z.string().max(48), block: z.string().max(48).nullable(),
  sourceScroll: z.number().finite().min(0).max(10_000_000), aiScroll: z.number().finite().min(0).max(10_000_000),
  mode: z.enum(['sync', 'independent']), stamp: z.number().int().nonnegative(),
  chatOpen: z.boolean().optional(), split: z.number().finite().min(31).max(69).optional(),
  companionHidden: z.boolean().optional(),
}).strict();
export type Position = z.infer<typeof positionSchema>;
export type Phase = 'idle' | 'running' | 'complete' | 'interrupted' | 'error';
export interface Status { phase: Phase; error?: string; remaining?: string[]; }
export type PreparationScope = 'paper' | 'abstract' | 'off';
export interface Preparation {
  phase: 'queued' | 'running' | 'ready' | 'paused' | 'interrupted' | 'error';
  targets: string[]; completed: number; current: string | null; error?: string;
}
export const preparationActive = (value?: Preparation | null) => value?.phase === 'queued' || value?.phase === 'running';
export interface PaperSummary {
  id: string; title: string; authors: string[]; year: string | null; doi: string | null;
  pages: number; sectionCount: number; completeCount: number; lastRead: number; fileName: string;
  currentTitle: string;
  preparation?: Preparation;
}
export interface Paper extends PaperSummary {
  structure: PaperStructure; position: Position; read: string[]; codexThread: string | null;
  analyses: Record<string, Record<string, string>>; statuses: Record<string, Status>;
  messages: Message[]; highlights: Highlight[];
}
export interface Message {
  id: string; role: 'user' | 'assistant'; text: string; section: string;
  block: string | null; created: number; phase: Phase; quote?: string; page?: number;
}
export const noteCategories = ['Key Contributions', 'Mathematical Insights', 'Critical Comments', 'Open Research Questions', 'My Own Ideas', 'Potential Research Directions'] as const;
export const noteSchema = z.object({ category: z.enum(noteCategories), text: z.string().trim().min(1).max(40_000),
  source: z.enum(['user', 'ai']), section: z.string().max(48).nullable(), block: z.string().max(48).nullable(),
}).strict();
export type NoteInput = z.infer<typeof noteSchema>;
export interface Note extends NoteInput { id: string; created: number; automatic?: boolean; }
export const highlightSchema = z.object({
  block: z.string().max(48), start: z.number().int().nonnegative(), end: z.number().int().positive(),
  quote: z.string().min(1).max(10_000), note: z.string().max(5000),
}).strict().refine(({ start, end }) => start < end);
export type HighlightInput = z.infer<typeof highlightSchema>;
export interface Highlight extends HighlightInput { id: string; }
export const settingsSchema = z.object({
  provider: z.enum(['codex', 'openai']), codexModel: z.string().trim().max(120),
  openaiModel: z.string().trim().max(120), style: z.string().trim().max(1000),
  detail: z.enum(['concise', 'balanced', 'detailed']), systemPrompt: z.string().trim().min(1).max(20_000),
  theme: z.enum(['light', 'dark']), autoGenerate: z.boolean(), importGeneration: z.enum(['paper', 'abstract', 'off']).default('paper'),
}).strict().refine((s) => s.provider !== 'openai' || !!s.openaiModel, { message: '请输入 API 模型名称。' });
export type Settings = z.infer<typeof settingsSchema>;
export type ProviderStatus = { ready: boolean; message: string; models: { id: string; name: string }[]; defaultModel?: string };
export const questionSchema = z.object({
  question: z.string().trim().min(1).max(6000), section: z.string().max(48),
  block: z.string().max(48).nullable(), quote: z.string().max(5000).optional(),
  page: z.number().int().positive().optional(), saveQuestion: z.boolean().optional(),
}).strict();
export type Question = z.infer<typeof questionSchema>;
export const streamSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('delta'), key: z.string(), text: z.string() }),
  z.object({ type: z.literal('saved'), key: z.string(), text: z.string() }),
  z.object({ type: z.literal('message'), message: z.custom<Message>() }),
  z.object({ type: z.literal('status'), phase: z.enum(['idle', 'running', 'complete', 'interrupted', 'error']), error: z.string().optional() }),
]);
export type StreamEvent = z.infer<typeof streamSchema>;

export function companionKeys(section: Section) {
  const keys = section.blocks.filter((block) => block.kind !== 'page' && !!block.text.trim()).map((block) => block.id);
  if (keys.length) keys.push('critical');
  return keys;
}
