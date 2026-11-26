import { companionKeys, preparationActive } from '../shared/model.ts';
import type { Paper, Preparation, PreparationScope, Section, StreamEvent } from '../shared/model.ts';
import type { Companion } from './companion.ts';
import { errorMessage } from './providers.ts';
import type { Store } from './store.ts';

type Listener = (event: StreamEvent) => void;
interface Task {
  paper: string;
  section: string;
  controller: AbortController;
  listeners: Set<Listener>;
  partial: Map<string, string>;
  promise: Promise<void>;
}

function completedSections(paper: Paper, preparation: Preparation) {
  return preparation.targets.filter((id) => {
    const section = paper.structure.sections.find((entry) => entry.id === id);
    return section && companionKeys(section).every((key) => Boolean(paper.analyses[id]?.[key]));
  });
}

export class ImportPreparation {
  private readonly store: Store;
  private readonly companion: Companion;
  private readonly foreground: () => boolean;
  private current: Task | null = null;
  private scheduled = false;
  private closing = false;

  constructor(store: Store, companion: Companion, foreground: () => boolean) {
    this.store = store;
    this.companion = companion;
    this.foreground = foreground;
  }

  enqueue(paper: Paper, scope: PreparationScope) {
    if (scope === 'off') return;
    const sections = paper.structure.sections.filter((entry) => companionKeys(entry).length > 0 &&
      !/^(?:[\d.]+\s+)?(?:references|bibliography|acknowledg(?:e)?ments?)$/i.test(entry.title.trim()));
    const first = sections.find((entry) => /^abstract$/i.test(entry.title.trim())) ?? sections[0];
    const targets = scope === 'paper' ? sections.map((entry) => entry.id) : first ? [first.id] : [];
    if (!targets.length) return;
    this.store.savePreparation(paper.id, { phase: 'queued', targets, completed: 0, current: null });
    this.kick();
  }

  resume(paper: Paper) {
    if (!paper.preparation) return;
    if (!preparationActive(paper.preparation) && paper.preparation.phase !== 'ready') {
      this.store.savePreparation(paper.id, { ...paper.preparation, phase: 'queued', current: null, error: undefined });
      this.kick();
    }
    return this.store.preparation(paper.id);
  }

  pause(paper: string) {
    const value = this.store.preparation(paper);
    if (!value || !preparationActive(value)) return value;
    const paused: Preparation = { ...value, phase: 'paused', current: null };
    this.store.savePreparation(paper, paused);
    if (this.current?.paper === paper) this.current.controller.abort();
    return paused;
  }

  async yieldToReader(paper: string) {
    const task = this.current;
    if (task?.paper !== paper) return;
    task.controller.abort();
    await task.promise;
  }

  subscribe(paper: string, section: string, listener: Listener) {
    const task = this.current;
    if (task?.paper !== paper || task.section !== section) return;
    task.listeners.add(listener);
    listener({ type: 'status', phase: 'running' });
    for (const [key, text] of task.partial) listener({ type: 'delta', key, text });
    return () => task.listeners.delete(listener);
  }

  kick() {
    if (this.closing || this.scheduled || this.current || this.foreground()) return;
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      if (this.closing || this.current || this.foreground()) return;
      const id = this.store.queuedPaper();
      const paper = id ? this.store.paper(id) : undefined;
      const value = paper?.preparation;
      if (!paper || !value) return;
      const completed = completedSections(paper, value);
      const section = paper.structure.sections.find((entry) => value.targets.includes(entry.id) && !completed.includes(entry.id));
      if (!section) {
        this.store.savePreparation(paper.id, { ...value, completed: completed.length, phase: 'ready', current: null, error: undefined });
        this.kick();
        return;
      }
      this.store.savePreparation(paper.id, { ...value, completed: completed.length, phase: 'running', current: section.id, error: undefined });
      const task: Task = { paper: paper.id, section: section.id, controller: new AbortController(),
        partial: new Map(), listeners: new Set(), promise: Promise.resolve() };
      this.current = task;
      task.promise = this.run(task, paper, section);
    });
  }

  private async run(task: Task, paper: Paper, section: Section) {
    const emit = (event: StreamEvent) => {
      if (event.type === 'delta') task.partial.set(event.key, (task.partial.get(event.key) ?? '') + event.text);
      if (event.type === 'saved') task.partial.delete(event.key);
      for (const listener of task.listeners) listener(event);
    };
    try {
      await this.companion.generate(paper, section, false, task.controller.signal, emit);
    } catch (error) {
      this.store.setStatus(task.paper, section.id, { phase: 'error', error: errorMessage(error) });
      emit({ type: 'status', phase: 'error', error: errorMessage(error) });
    } finally {
      const latest = this.store.paper(task.paper);
      const state = latest?.preparation;
      if (latest && state) {
        const completed = completedSections(latest, state).length;
        const status = latest.statuses[section.id];
        const phase = completed === state.targets.length ? 'ready' : this.closing ? 'interrupted'
          : state.phase === 'paused' ? 'paused' : status?.phase === 'error' ? 'error' : 'queued';
        this.store.savePreparation(task.paper, { ...state, phase, current: null, completed, error: phase === 'error' ? status?.error : undefined });
      }
      this.current = null;
      this.kick();
    }
  }

  close() {
    this.closing = true;
    this.current?.controller.abort();
    return this.current?.promise;
  }
}
