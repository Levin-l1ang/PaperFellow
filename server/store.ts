import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { companionKeys, noteCategories, settingsSchema } from '../shared/model.ts';
import type { Highlight, HighlightInput, Message, Note, NoteInput, Paper, PaperStructure, PaperSummary, Position, Preparation, Settings, Status } from '../shared/model.ts';
import type { StoredQuiz } from '../shared/quiz.ts';

interface PaperRow {
  id: string; file_name: string; structure: string; position: string;
  position_stamp: number; last_read: number; codex_thread: string | null;
}
const defaultPrompt = readFileSync(new URL('./reading-prompt.md', import.meta.url), 'utf8').trim();
const defaults: Settings = { provider: 'codex', codexModel: '', openaiModel: '', detail: 'concise', style: '', systemPrompt: defaultPrompt, theme: 'light', autoGenerate: true, importGeneration: 'paper' };

export class Store {
  private readonly db: DatabaseSync;

  constructor(data: string) {
    this.db = new DatabaseSync(join(data, 'papers.sqlite'));
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA foreign_keys=ON;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS papers (
        id TEXT PRIMARY KEY, file_name TEXT NOT NULL, structure TEXT NOT NULL,
        position TEXT NOT NULL, position_stamp INTEGER NOT NULL DEFAULT 0,
        last_read INTEGER NOT NULL, codex_thread TEXT
      );
      CREATE TABLE IF NOT EXISTS sections_read (
        paper TEXT REFERENCES papers(id) ON DELETE CASCADE, section TEXT,
        PRIMARY KEY(paper,section)
      );
      CREATE TABLE IF NOT EXISTS analysis (
        paper TEXT REFERENCES papers(id) ON DELETE CASCADE, section TEXT, block TEXT, markdown TEXT NOT NULL,
        PRIMARY KEY(paper,section,block)
      );
      CREATE TABLE IF NOT EXISTS jobs (
        paper TEXT REFERENCES papers(id) ON DELETE CASCADE, section TEXT, status TEXT NOT NULL,
        PRIMARY KEY(paper,section)
      );
      CREATE TABLE IF NOT EXISTS messages (
        paper TEXT REFERENCES papers(id) ON DELETE CASCADE, id TEXT, value TEXT NOT NULL,
        PRIMARY KEY(paper,id)
      );
      CREATE TABLE IF NOT EXISTS notes (
        paper TEXT REFERENCES papers(id) ON DELETE CASCADE, id TEXT, value TEXT NOT NULL,
        PRIMARY KEY(paper,id)
      );
      CREATE TABLE IF NOT EXISTS highlights (
        paper TEXT REFERENCES papers(id) ON DELETE CASCADE, id TEXT, value TEXT NOT NULL,
        PRIMARY KEY(paper,id)
      );
      CREATE TABLE IF NOT EXISTS preferences (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS preparations (
        paper TEXT PRIMARY KEY REFERENCES papers(id) ON DELETE CASCADE, value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS quizzes (
        paper TEXT REFERENCES papers(id) ON DELETE CASCADE, section TEXT, value TEXT NOT NULL,
        PRIMARY KEY(paper,section)
      );
      PRAGMA user_version=1;
    `);
    this.markInterrupted();
  }

  close() { this.db.close(); }

  private markInterrupted() {
    this.db.exec(`UPDATE jobs SET status=json_set(status,'$.phase','interrupted','$.error','上次运行已结束，可继续生成。') WHERE json_extract(status,'$.phase')='running'`);
    this.db.exec(`UPDATE preparations SET value=json_set(value,'$.phase','interrupted','$.current',null) WHERE json_extract(value,'$.phase') IN ('queued','running')`);
    this.db.exec(`UPDATE messages SET value=json_set(value,'$.phase','interrupted') WHERE json_extract(value,'$.phase')='running'`);
  }

  settings() {
    const row = this.db.prepare(`SELECT value FROM preferences WHERE key='settings'`).get() as { value: string } | undefined;
    return settingsSchema.parse({ ...defaults, ...(row && JSON.parse(row.value)) });
  }

  saveSettings(settings: Settings) {
    this.db.prepare(`INSERT INTO preferences VALUES ('settings',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(JSON.stringify(settings));
    return settings;
  }

  private paperRow(id: string) { return this.db.prepare('SELECT * FROM papers WHERE id=?').get(id) as PaperRow | undefined; }
  exists(id: string) { return Boolean(this.db.prepare('SELECT 1 FROM papers WHERE id=?').get(id)); }

  private summary(row: PaperRow, structure: PaperStructure, position: Position, completeCount: number): PaperSummary {
    return { id: row.id, title: structure.title, authors: structure.authors, year: structure.year, doi: structure.doi,
      pages: structure.pages, sectionCount: structure.sections.length, completeCount, lastRead: row.last_read,
      fileName: row.file_name, currentTitle: structure.sections.find((section) => section.id === position.section)?.title ?? '',
      preparation: this.preparation(row.id) };
  }

  library() {
    const rows = this.db.prepare(`SELECT p.*, (SELECT count(*) FROM sections_read r WHERE r.paper=p.id) AS completed FROM papers p ORDER BY last_read DESC`).all() as unknown as (PaperRow & { completed: number })[];
    return rows.map((row) => this.summary(row, JSON.parse(row.structure), JSON.parse(row.position), row.completed));
  }

  paper(id: string): Paper | undefined {
    const row = this.paperRow(id);
    if (!row) return;
    const structure = JSON.parse(row.structure) as PaperStructure;
    const position = JSON.parse(row.position) as Position;
    const read = this.db.prepare('SELECT section FROM sections_read WHERE paper=?').all(id).map((record) => String(record.section));
    const analyses: Paper['analyses'] = {};
    for (const record of this.db.prepare('SELECT section,block,markdown FROM analysis WHERE paper=?').all(id)) {
      (analyses[String(record.section)] ??= {})[String(record.block)] = String(record.markdown);
    }
    const statuses = Object.fromEntries(this.db.prepare('SELECT section,status FROM jobs WHERE paper=?').all(id)
      .map((record) => [String(record.section), JSON.parse(String(record.status))])) as Paper['statuses'];
    return { ...this.summary(row, structure, position, read.length), structure, position, read, analyses,
      codexThread: row.codex_thread, statuses, messages: this.values<Message>('messages', id), highlights: this.values<Highlight>('highlights', id) };
  }

  addPaper(id: string, fileName: string, structure: PaperStructure) {
    const first = structure.sections.find((section) => /^abstract$/i.test(section.title)) ?? structure.sections[0];
    const position: Position = { section: first.id, block: first.blocks[0]?.id ?? null, sourceScroll: 0, aiScroll: 0, mode: 'sync', stamp: 0 };
    this.db.prepare('INSERT INTO papers(id,file_name,structure,position,last_read) VALUES(?,?,?,?,?)')
      .run(id, fileName, JSON.stringify(structure), JSON.stringify(position), Date.now());
  }

  position(id: string, position: Position) {
    this.db.prepare('UPDATE papers SET position=?, position_stamp=?, last_read=? WHERE id=? AND position_stamp<=?')
      .run(JSON.stringify(position), position.stamp, Date.now(), id, position.stamp);
  }

  touch(id: string) { this.db.prepare('UPDATE papers SET last_read=? WHERE id=?').run(Date.now(), id); }

  markRead(id: string, section: string, read: boolean) {
    if (read) this.db.prepare('INSERT OR IGNORE INTO sections_read VALUES(?,?)').run(id, section);
    else this.db.prepare('DELETE FROM sections_read WHERE paper=? AND section=?').run(id, section);
    this.touch(id);
  }

  saveThread(id: string, thread: string) { this.db.prepare('UPDATE papers SET codex_thread=? WHERE id=?').run(thread, id); }

  preparation(id: string): Preparation | undefined {
    const row = this.db.prepare('SELECT value FROM preparations WHERE paper=?').get(id);
    return row && JSON.parse(String(row.value)) as Preparation;
  }

  queuedPaper() {
    const row = this.db.prepare(`SELECT paper FROM preparations WHERE json_extract(value,'$.phase')='queued' ORDER BY rowid LIMIT 1`).get();
    return row ? String(row.paper) : undefined;
  }

  savePreparation(id: string, value: Preparation) {
    this.db.prepare('INSERT INTO preparations VALUES(?,?) ON CONFLICT(paper) DO UPDATE SET value=excluded.value').run(id, JSON.stringify(value));
  }

  quiz(id: string, section: string): StoredQuiz | undefined {
    const row = this.db.prepare('SELECT value FROM quizzes WHERE paper=? AND section=?').get(id, section);
    return row && JSON.parse(String(row.value)) as StoredQuiz;
  }

  saveQuiz(id: string, section: string, quiz: StoredQuiz) {
    this.db.prepare('INSERT INTO quizzes VALUES(?,?,?) ON CONFLICT(paper,section) DO UPDATE SET value=excluded.value').run(id, section, JSON.stringify(quiz));
  }

  saveAnalysis(id: string, section: string, block: string, text: string) {
    this.db.prepare('INSERT INTO analysis VALUES(?,?,?,?) ON CONFLICT(paper,section,block) DO UPDATE SET markdown=excluded.markdown').run(id, section, block, text);
  }

  saveAnalysisProgress(id: string, section: string, block: string, text: string, status: Status) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.saveAnalysis(id, section, block, text);
      this.setStatus(id, section, status);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  setStatus(id: string, section: string, status: Status) {
    this.db.prepare('INSERT INTO jobs VALUES(?,?,?) ON CONFLICT(paper,section) DO UPDATE SET status=excluded.status').run(id, section, JSON.stringify(status));
  }

  private values<T>(table: 'messages' | 'notes' | 'highlights', id: string): T[] {
    return this.db.prepare(`SELECT value FROM ${table} WHERE paper=? ORDER BY rowid`).all(id).map((row) => JSON.parse(String(row.value)) as T);
  }

  saveMessage(id: string, message: Message) {
    this.db.prepare('INSERT INTO messages VALUES(?,?,?) ON CONFLICT(paper,id) DO UPDATE SET value=excluded.value').run(id, message.id, JSON.stringify(message));
  }

  addNote(id: string, input: NoteInput) {
    const note: Note = { ...input, id: randomUUID(), created: Date.now() };
    this.db.prepare('INSERT INTO notes VALUES(?,?,?)').run(id, note.id, JSON.stringify(note));
    return note;
  }

  updateNote(id: string, noteId: string, input: NoteInput) {
    const row = this.db.prepare('SELECT value FROM notes WHERE paper=? AND id=?').get(id, noteId);
    if (!row) return;
    const note: Note = { ...(JSON.parse(String(row.value)) as Note), ...input };
    this.db.prepare('UPDATE notes SET value=? WHERE paper=? AND id=?').run(JSON.stringify(note), id, noteId);
    return note;
  }

  notes(paper: Paper) {
    const notes = this.values<Note>('notes', paper.id);
    for (const [section, blocks] of Object.entries(paper.analyses)) {
      if (blocks.critical) notes.push({ id: `critical-${section}`, source: 'ai', category: 'Critical Comments', section,
        block: null, text: blocks.critical, created: paper.lastRead, automatic: true });
    }
    const review = paper.analyses.review?.full;
    if (review) notes.unshift({ id: 'full-review', source: 'ai', category: 'Critical Comments', section: null,
      block: null, text: review, created: paper.lastRead, automatic: true });
    return notes;
  }

  addHighlight(id: string, input: HighlightInput) {
    const value = { ...input, id: randomUUID() };
    this.db.prepare('INSERT INTO highlights VALUES(?,?,?)').run(id, value.id, JSON.stringify(value));
    return value;
  }

  delete(id: string, table: 'notes' | 'highlights', record: string) {
    this.db.prepare(`DELETE FROM ${table} WHERE paper=? AND id=?`).run(id, record);
  }

  export(paper: Paper) {
    const notes = this.notes(paper);
    const lines = [`# ${paper.title}`, [paper.authors.join(', '), paper.year, paper.doi].filter(Boolean).join(' · '), '## Research Notes'];
    for (const category of noteCategories) {
      const group = notes.filter((note) => note.category === category);
      if (!group.length) continue;
      lines.push(`### ${category}`);
      for (const note of group) {
        const section = paper.structure.sections.find((item) => item.id === note.section);
        lines.push(`**${note.source === 'ai' ? 'AI' : '读者'}**${section ? ` · ${section.title}` : ''}`, note.text);
      }
    }
    if (paper.highlights.length) {
      lines.push('## 批注与高亮');
      for (const highlight of paper.highlights) {
        const block = paper.structure.sections.flatMap((section) => section.blocks).find((item) => item.id === highlight.block);
        lines.push(`**PDF p. ${block?.page ?? '?'} · ${highlight.block}**`, highlight.quote.split('\n').map((line) => `> ${line}`).join('\n'), highlight.note);
      }
    }
    lines.push('## 逐节伴读与数学推导（AI）');
    for (const section of paper.structure.sections) {
      const analysis = paper.analyses[section.id] ?? {};
      if (!Object.keys(analysis).length) continue;
      lines.push(`### ${section.title}`);
      for (const key of companionKeys(section)) {
        if (!analysis[key]) continue;
        const block = section.blocks.find((item) => item.id === key);
        lines.push(key === 'critical' ? '#### Critical Analysis' : `#### PDF p. ${block?.page} · ${key}`, analysis[key]);
      }
    }
    return `${lines.filter(Boolean).join('\n\n')}\n`;
  }
}
