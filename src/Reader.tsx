import { Fragment, lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, FormEvent, PointerEvent } from 'react';
import { ArrowDownRight, ArrowLeft, ArrowRight, ArrowUpRight, BookOpen, BookmarkPlus, Check, ChevronDown, ChevronUp, CircleAlert,
  ExternalLink, FileText, Highlighter, Link2, List, ListChecks, LoaderCircle, MessageCircle, PanelLeftClose, PanelRightClose, PanelRightOpen,
  Pause, Play, RefreshCw, Send, Sparkles, Square, Unlink2, X } from 'lucide-react';
import { companionKeys, preparationActive } from '../shared/model.ts';
import type { Block, Highlight, HighlightInput, Message, NoteInput, Paper, Position, Preparation, Question, Settings, Status } from '../shared/model.ts';
import { api, message, paperURL, stream } from './api';
import { Markdown } from './Content';
import { Modal } from './Dialogs';
import { PreparationStatus } from './PreparationStatus';
import { QuizPanel } from './QuizPanel';

const PdfPane = lazy(() => import('./PdfPane').then((module) => ({ default: module.PdfPane })));
type Selection = HighlightInput;
type Job = { id: string; section: string; kind: 'generate' | 'chat'; controller: AbortController; promise: Promise<void> };

function replaceMessage(messages: Message[], value: Message) {
  return messages.some((item) => item.id === value.id) ? messages.map((item) => item.id === value.id ? value : item) : [...messages, value];
}

function SourceText({ block, marks }: { block: Block; marks: Highlight[] }) {
  const cuts = [...new Set([0, block.text.length, ...marks.flatMap((mark) => [mark.start, mark.end])])].sort((a, b) => a - b);
  return <p className="original-copy" lang="en" data-selectable={block.id}>{cuts.slice(0, -1).map((start, index) => {
    const end = cuts[index + 1];
    const active = marks.filter((mark) => start >= mark.start && end <= mark.end);
    const text = block.text.slice(start, end);
    return active.length ? <mark key={start} title={active.map((mark) => mark.note).filter(Boolean).join('\n') || '高亮'}>{text}</mark> : <Fragment key={start}>{text}</Fragment>;
  })}</p>;
}

function SourceBlock({ block, paper, active, focus, openPage, marks, select, remove }: {
  block: Block; paper: string; active: boolean; focus(): void; openPage(): void; marks: Highlight[]; select(selection: Selection): void; remove(id: string): void;
}) {
  function capture() {
    const selected = window.getSelection();
    if (!selected || selected.isCollapsed || !selected.rangeCount) return;
    const range = selected.getRangeAt(0);
    const anchor = range.startContainer.parentElement?.closest<HTMLElement>('[data-selectable]');
    if (!anchor || anchor.dataset.selectable !== block.id || !anchor.contains(range.endContainer)) return;
    const prefix = range.cloneRange();
    prefix.selectNodeContents(anchor);
    prefix.setEnd(range.startContainer, range.startOffset);
    const start = prefix.toString().length;
    const end = start + range.toString().length;
    if (end > start && end - start <= 5000) select({ block: block.id, start, end, note: '', quote: block.text.slice(start, end) });
  }

  return <article data-block={block.id} className={`reader-cell source-cell ${active ? 'focused' : ''}`} onClick={focus} onMouseUp={capture} onKeyUp={capture}>
    <div className="cell-body">
    <header className="cell-meta"><span><i className="paragraph-dot" />{block.id.toUpperCase()}{block.kind !== 'text' && ` · ${{ formula: '公式', figure: '插图', table: '表格', page: '原始页面' }[block.kind]}`}</span>
      <button className="text-button page-link" onClick={(event) => { event.stopPropagation(); openPage(); }}>PDF p. {block.page}<ArrowUpRight size={13} /></button></header>
    {block.kind === 'page' && <div className="source-warning"><CircleAlert size={17} /><div>此页文字层不完整。<button className="text-button" onClick={openPage}>查看原始 PDF</button></div></div>}
    {block.asset && <figure className="paper-figure"><button aria-label={`打开 PDF 第 ${block.page} 页`} onClick={openPage}>
      <img src={paperURL(paper, `/assets/${block.asset}`)} alt={block.kind === 'formula' ? `PDF 第 ${block.page} 页公式` : `PDF 第 ${block.page} 页裁图`} loading="lazy" /></button></figure>}
    {block.text && (block.kind === 'formula' && block.asset ? <details className="formula-text"><summary>PDF 文字层</summary><SourceText block={block} marks={marks} /></details> : <SourceText block={block} marks={marks} />)}
    {!!block.cells?.length && <details className="formula-text" open={!block.asset}><summary>表格文字层</summary>
      <div className="table-scroll"><table><tbody>{block.cells.map((row, i) => <tr key={i}>{row.map((cell, j) => i === 0 ? <th key={j}>{cell}</th> : <td key={j}>{cell}</td>)}</tr>)}</tbody></table></div>
    </details>}
    {marks.length > 0 && <ul className="highlight-notes">{marks.map((mark) => <li key={mark.id}><Highlighter size={13} />
      <span>{mark.note || mark.quote.slice(0, 58)}</span><button className="icon-button" aria-label="移除高亮" onClick={(event) => { event.stopPropagation(); remove(mark.id); }}><X size={13} /></button></li>)}</ul>}
    </div>
  </article>;
}

export function Reader({ paper, update, settings, nextSection, previousSection, toggleRead, toggleSidebar, sidebarClosed, openSettings, addNote, toast, changePreparation }: {
  paper: Paper; update(action: (current: Paper) => Paper): void; settings: Settings;
  nextSection?: () => void; previousSection?: () => void; toggleRead(): void; toggleSidebar(): void; sidebarClosed: boolean;
  openSettings(): void; addNote(note: NoteInput): void; toast(text: string): void;
  changePreparation(action: 'pause' | 'resume'): void;
}) {
  const section = paper.structure.sections.find((item) => item.id === paper.position.section) ?? paper.structure.sections[0];
  const status = paper.statuses[section.id] ?? { phase: 'idle' };
  const analysis = paper.analyses[section.id] ?? {};
  const keys = companionKeys(section);
  const cached = keys.filter((id) => !!analysis[id]).length;
  const [layout, setLayout] = useState(paper.position.mode);
  const [split, setSplit] = useState(paper.position.split ?? 50);
  const [companionHidden, setCompanionHidden] = useState(paper.position.companionHidden ?? false);
  const [quizOpen, setQuizOpen] = useState(false);
  const [quizBusy, setQuizBusy] = useState(false);
  const [page, setPage] = useState<number | null>(null);
  const [focus, setFocus] = useState(paper.position.block);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [quoted, setQuoted] = useState<Selection | null>(null);
  const [annotation, setAnnotation] = useState<Selection | null>(null);
  const [draft, setDraft] = useState('');
  const [saveResearch, setSaveResearch] = useState(false);
  const [chatOpen, setChatOpen] = useState(paper.position.chatOpen ?? false);
  const [chatError, setChatError] = useState('');
  const [busy, setBusy] = useState<{ kind: Job['kind']; section: string } | null>(null);
  const [stopping, setStopping] = useState(false);
  const [live, setLive] = useState<Record<string, string>>({});
  const [backgroundLive, setBackgroundLive] = useState<Record<string, string>>({});
  const currentJob = useRef<Job | null>(null);
  const auto = useRef(new Set<string>());
  const focusRef = useRef(focus);
  const currentSection = useRef(section.id);
  const storage = useRef<Position>(paper.position);
  const lastSent = useRef('');
  const time = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sync = useRef<HTMLDivElement>(null);
  const source = useRef<HTMLDivElement>(null);
  const aide = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const history = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const night = settings.theme === 'dark';
  const prefix = paperURL(paper.id);
  const preparation = paper.preparation;
  const preparing = preparationActive(preparation);
  const scheduled = Boolean(preparation?.targets.includes(section.id));
  const backgroundHere = preparation?.phase === 'running' && preparation.current === section.id;
  currentSection.current = section.id;

  const persist = useCallback(() => {
    if (time.current) clearTimeout(time.current);
    const snapshot = { ...storage.current };
    const key = JSON.stringify({ ...snapshot, stamp: 0 });
    if (key === lastSent.current) return;
    lastSent.current = key;
    snapshot.stamp = Math.max(Date.now(), snapshot.stamp + 1);
    storage.current.stamp = snapshot.stamp;
    void api(`${prefix}/position`, 'PUT', snapshot, true).catch(() => { if (lastSent.current === key) lastSent.current = ''; });
  }, [prefix]);

  useEffect(() => {
    const hide = () => { if (document.visibilityState === 'hidden') persist(); };
    window.addEventListener('pagehide', persist);
    document.addEventListener('visibilitychange', hide);
    return () => { window.removeEventListener('pagehide', persist); document.removeEventListener('visibilitychange', hide); persist(); currentJob.current?.controller.abort(); };
  }, [persist]);

  function queueSave() {
    if (time.current) clearTimeout(time.current);
    time.current = setTimeout(persist, 200);
  }

  function setAnchor(block: string | null) {
    if (focusRef.current !== block) { focusRef.current = block; setFocus(block); }
    storage.current.block = block;
  }

  function onScroll(pane: 'sync' | 'source' | 'ai', node: HTMLDivElement) {
    if (storage.current.section !== currentSection.current) return;
    if (pane === 'ai') storage.current.aiScroll = node.scrollTop;
    else {
      storage.current.sourceScroll = node.scrollTop;
      if (pane === 'sync') storage.current.aiScroll = node.scrollTop;
      const top = node.getBoundingClientRect().top + 26;
      const rows = [...node.querySelectorAll<HTMLElement>('[data-block]')];
      const current = rows.find((row) => row.getBoundingClientRect().bottom > top);
      if (current?.dataset.block) setAnchor(current.dataset.block);
    }
    queueSave();
  }

  useLayoutEffect(() => {
    if (layout !== 'independent' || companionHidden || page !== null || !source.current || !aide.current) return;
    const companions = new Map(Array.from(aide.current.querySelectorAll<HTMLElement>('[data-companion]'), (node) => [node.dataset.companion, node]));
    const pairs = Array.from(source.current.querySelectorAll<HTMLElement>('[data-block]')).flatMap((left) => {
      const right = companions.get(left.dataset.block);
      const original = left.firstElementChild;
      const explanation = right?.firstElementChild;
      return right && original && explanation ? [{ left, right, original, explanation }] : [];
    });
    function align() {
      if (!pairs.length) return;
      const style = getComputedStyle(pairs[0].left);
      const padding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) + parseFloat(style.borderBottomWidth);
      const heights = pairs.map(({ original, explanation }) => Math.ceil(Math.max(original.getBoundingClientRect().height, explanation.getBoundingClientRect().height) + padding));
      pairs.forEach(({ left, right }, index) => { left.style.minHeight = right.style.minHeight = `${heights[index]}px`; });
    }
    const observer = new ResizeObserver(align);
    pairs.forEach(({ original, explanation }) => { observer.observe(original); observer.observe(explanation); });
    align();
    return () => observer.disconnect();
  }, [section.id, layout, page, companionHidden]);

  useLayoutEffect(() => {
    if (storage.current.section !== section.id) {
      const block = section.blocks[0]?.id ?? null;
      storage.current = { ...storage.current, section: section.id, block, sourceScroll: 0, aiScroll: 0, mode: layout, stamp: Math.max(storage.current.stamp, paper.position.stamp) };
      focusRef.current = block; setFocus(block); setPage(null); setSelection(null); setQuoted(null);
      for (const area of [sync.current, source.current, aide.current]) if (area) area.scrollTop = 0;
      persist();
    }
  }, [section.id]);

  useLayoutEffect(() => {
    if (page !== null) return;
    const { sourceScroll, aiScroll, block } = storage.current;
    if (sync.current) sync.current.scrollTop = sourceScroll;
    if (source.current) source.current.scrollTop = sourceScroll;
    if (aide.current) aide.current.scrollTop = aiScroll;
    const area = sync.current ?? source.current;
    if (block && area && sourceScroll > area.scrollHeight - area.clientHeight + 2) {
      area.querySelector<HTMLElement>(`[data-block="${block}"]`)?.scrollIntoView({ block: 'start' });
    }
  }, [layout, page, companionHidden]);

  useEffect(() => { persist(); }, [persist]);
  useEffect(() => {
    storage.current.chatOpen = chatOpen;
    storage.current.split = split;
    storage.current.companionHidden = companionHidden;
    queueSave();
  }, [chatOpen, split, companionHidden]);
  useEffect(() => {
    if (chatOpen && history.current) history.current.scrollTop = history.current.scrollHeight;
  }, [chatOpen, paper.messages.length, live]);

  const changeStatus = (id: string, value: Status) => update((current) => ({ ...current, statuses: { ...current.statuses, [id]: value } }));

  useEffect(() => {
    if (!preparation) return;
    let active = true;
    type Snapshot = { preparation: Preparation; analysis: Record<string, string>; statuses: Paper['statuses'] };
    let checking = false;
    const refresh = async () => {
      if (checking) return;
      checking = true;
      try {
        const next = await api<Snapshot>(`${prefix}/companion-state?section=${encodeURIComponent(section.id)}`);
        if (!active) return;
        update((current) => ({ ...current, preparation: next.preparation,
          analyses: { ...current.analyses, [section.id]: { ...next.analysis, ...current.analyses[section.id] } },
          statuses: currentJob.current?.kind === 'generate' ? current.statuses : next.statuses }));
      } catch { /* The next refresh will retry. */ }
      finally { checking = false; }
    };
    void refresh();
    const interval = preparing ? setInterval(() => void refresh(), 1000) : undefined;
    return () => { active = false; clearInterval(interval); };
  }, [prefix, section.id, preparing]);

  useEffect(() => {
    setBackgroundLive({});
    if (!backgroundHere || companionHidden) return;
    const controller = new AbortController();
    void stream(`${prefix}/background-stream?section=${encodeURIComponent(section.id)}`, undefined, controller.signal, (event) => {
      if (event.type === 'delta') setBackgroundLive((current) => ({ ...current, [event.key]: (current[event.key] ?? '') + event.text }));
      if (event.type === 'saved') {
        update((current) => ({ ...current, analyses: { ...current.analyses, [section.id]: { ...current.analyses[section.id], [event.key]: event.text } } }));
        setBackgroundLive((current) => { const next = { ...current }; delete next[event.key]; return next; });
      }
    }).catch(() => {}).finally(() => { if (!controller.signal.aborted) setBackgroundLive({}); });
    return () => controller.abort();
  }, [prefix, section.id, backgroundHere, companionHidden]);

  async function stop() {
    const job = currentJob.current;
    if (!job) return;
    setStopping(true);
    try { await api(`${prefix}/stop`, 'POST', {}); } catch { job.controller.abort(); }
    await job.promise;
  }

  function run(kind: Job['kind'], id: string, request: unknown) {
    if (currentJob.current) return currentJob.current.promise;
    const controller = new AbortController();
    const job: Job = { id: crypto.randomUUID(), section: id, kind, controller, promise: Promise.resolve() };
    currentJob.current = job;
    setBusy({ kind, section: id }); setStopping(false); setLive({});
    if (kind === 'generate') changeStatus(id, { phase: 'running' });
    job.promise = stream(`${prefix}/${kind}`, request, controller.signal, (event) => {
      if (event.type === 'status') {
        if (kind === 'generate') changeStatus(id, { phase: event.phase, error: event.error });
        else if (event.error) setChatError(event.error);
      } else if (event.type === 'delta') {
        setLive((values) => ({ ...values, [event.key]: (values[event.key] ?? '') + event.text }));
      } else if (event.type === 'saved') {
        update((current) => ({ ...current, analyses: { ...current.analyses,
          [id]: { ...current.analyses[id], [event.key]: event.text } } }));
        setLive((values) => { const next = { ...values }; delete next[event.key]; return next; });
      } else if (event.type === 'message') {
        update((current) => ({ ...current, messages: replaceMessage(current.messages, event.message) }));
        if (event.message.phase !== 'running') setLive((values) => { const next = { ...values }; delete next[event.message.id]; return next; });
      }
    }).catch((error) => {
      if (controller.signal.aborted) { if (kind === 'generate') changeStatus(id, { phase: 'interrupted' }); return; }
      if (kind === 'generate') changeStatus(id, { phase: 'error', error: message(error) });
      else setChatError(message(error));
    }).finally(() => {
      if (currentJob.current?.id !== job.id) return;
      currentJob.current = null;
      setBusy(null); setLive({}); setStopping(false);
    });
    return job.promise;
  }

  useEffect(() => {
    let canceled = false;
    const job = currentJob.current;
    if (job?.kind === 'generate' && job.section !== section.id) void stop();
    if (settings.autoGenerate && !scheduled && !quizBusy && status.phase === 'idle' && cached < keys.length && !auto.current.has(section.id)) {
      void (async () => {
        const previous = currentJob.current;
        if (previous) await previous.promise;
        if (canceled || currentSection.current !== section.id || currentJob.current) return;
        auto.current.add(section.id);
        await run('generate', section.id, { section: section.id });
      })();
    }
    return () => { canceled = true; };
  }, [section.id, settings.autoGenerate]);

  async function ask(event?: FormEvent, visualPage?: number, retry?: Message) {
    event?.preventDefault();
    if (currentJob.current?.kind === 'chat' || quizBusy) return;
    const text = visualPage ? `请从原始 PDF 第 ${visualPage} 页的图像解读关键内容，并指出文字提取可能遗漏的公式、图表或段落。` : retry?.text ?? draft.trim();
    if (!text) return;
    const context: Question = { question: text, section: retry?.section ?? section.id,
      block: retry ? retry.block : quoted?.block ?? focusRef.current,
      quote: retry?.quote ?? quoted?.quote, page: visualPage ?? retry?.page, saveQuestion: !retry && !visualPage && saveResearch };
    setChatOpen(true); setChatError('');
    if (!visualPage && !retry) { setDraft(''); setQuoted(null); setSaveResearch(false); }
    if (currentJob.current) await stop();
    await run('chat', context.section, context);
  }

  async function saveHighlight(value: Selection) {
    try {
      const highlight = await api<Highlight>(`${prefix}/highlights`, 'POST', value);
      update((current) => ({ ...current, highlights: [...current.highlights, highlight] }));
      setSelection(null); setAnnotation(null); window.getSelection()?.removeAllRanges(); toast('已保存高亮');
    } catch (error) { toast(message(error)); }
  }

  async function removeHighlight(id: string) {
    try {
      await api(`${prefix}/highlights/${id}`, 'DELETE', {});
      update((current) => ({ ...current, highlights: current.highlights.filter((mark) => mark.id !== id) }));
    } catch (error) { toast(message(error)); }
  }

  function resize(event: PointerEvent<HTMLButtonElement>) {
    const target = event.currentTarget;
    const width = canvas.current?.getBoundingClientRect();
    if (!width) return;
    target.setPointerCapture(event.pointerId);
    const move = (pointer: globalThis.PointerEvent) => { setSplit(Math.max(31, Math.min(69, (pointer.clientX - width.left) * 100 / width.width))); };
    const end = () => { target.removeEventListener('pointermove', move); target.removeEventListener('lostpointercapture', end); };
    target.addEventListener('pointermove', move);
    target.addEventListener('lostpointercapture', end);
  }

  const changeLayout = () => {
    const mode = layout === 'sync' ? 'independent' : 'sync';
    storage.current.mode = mode;
    setLayout(mode); persist();
  };
  const foregroundHere = busy?.kind === 'generate' && busy.section === section.id;
  const streamingText = (key: string) => foregroundHere ? live[key] : backgroundHere ? backgroundLive[key] : undefined;

  function jumpToSource(id: string) {
    setQuizOpen(false); setPage(null); setAnchor(id); queueSave();
    requestAnimationFrame(() => (sync.current ?? source.current)?.querySelector<HTMLElement>(`[data-block="${id}"]`)?.scrollIntoView({ block: 'start' }));
  }

  function takeNote(text: string, block: string | null, category: NoteInput['category']) {
    addNote({ text, category, source: 'ai', section: section.id, block });
  }

  function assistant(block?: Block) {
    const id = block?.id ?? 'critical';
    const delta = streamingText(id);
    const text = delta || analysis[id];
    return <article className={`reader-cell companion-cell ${!block ? 'critical-cell' : ''} ${focus === id ? 'focused' : ''}`} data-companion={id}>
      <div className="cell-body">
      <header className="cell-meta"><span>{!block ? 'CRITICAL ANALYSIS' : <><Sparkles size={13} />{block.id.toUpperCase()} · 中文讲解</>}</span>
        {analysis[id] && !delta && <button className="icon-button cell-action" aria-label="将此解释保存到研究笔记" onClick={() => takeNote(analysis[id], block?.id ?? null, block?.kind === 'formula' ? 'Mathematical Insights' : block ? 'Key Contributions' : 'Critical Comments')}><BookmarkPlus size={16} /></button>}
        {delta && <span className="stream-label"><i />生成中</span>}
      </header>
      {!block && <h3>批判性分析</h3>}
      {text ? <Markdown text={text} dark={night} streaming={!!delta} /> :
        <div className="analysis-placeholder">{block?.kind === 'page' ? <><span>可根据原始页面请求分析。</span><button className="text-button" disabled={busy?.kind === 'chat'} onClick={() => void ask(undefined, block.page)}>视觉分析 <ExternalLink size={13} /></button></>
          : block && !block.text.trim() ? <span>此图使用原始页面显示。</span>
            : <span>{foregroundHere || backgroundHere ? '等待生成…' : scheduled && preparing ? '已加入后台队列' : '等待伴读内容'}</span>}</div>}
      </div>
    </article>;
  }

  function original(block: Block) {
    return <SourceBlock key={block.id} block={block} paper={paper.id} active={focus === block.id} marks={paper.highlights.filter((mark) => mark.block === block.id)}
      focus={() => { setAnchor(block.id); queueSave(); }} openPage={() => { setAnchor(block.id); persist(); setPage(block.page); }}
      select={setSelection} remove={(id) => void removeHighlight(id)} />;
  }
  const sourceFooter = <div className="section-end reader-cell"><Check size={17} /><span>已到达本节末尾</span>
    {nextSection && <button className="text-button" onClick={nextSection}>下一节<ArrowRight size={14} /></button>}</div>;
  const style = { '--source-width': `${split}%` } as CSSProperties;

  return <main className="workspace reader-workspace">
    <div className="topbar"><div className="crumbs">
      {sidebarClosed && <button className="icon-button" aria-label="展开侧栏" onClick={toggleSidebar}><PanelLeftClose size={18} /></button>}
      <BookOpen size={16} /><span>阅读工作台</span><span className="crumb-slash">/</span><strong>{section.title}</strong>
    </div><div className="top-actions">
      <div className="segmented" aria-label="阅读视图">
        <button aria-pressed={page === null} onClick={() => setPage(null)}><List size={15} />伴读</button>
        <button aria-pressed={page !== null} onClick={() => setPage(section.blocks.find((block) => block.id === focus)?.page ?? section.page)}><FileText size={15} />原始 PDF</button>
      </div>
      {page === null && <button className="icon-button bordered companion-toggle" aria-label={companionHidden ? '展开右侧伴读栏' : '收起右侧伴读栏'}
        title={companionHidden ? '展开右侧伴读栏' : '收起右侧伴读栏'} aria-pressed={!companionHidden} onClick={() => setCompanionHidden((hidden) => !hidden)}>
        {companionHidden ? <PanelRightOpen size={17} /> : <PanelRightClose size={17} />}</button>}
    </div></div>
    <div className="reader-title">
      <div className="paper-metabar"><span className="paper-index"><FileText size={13} />{paper.pages} 页</span>{paper.year && <span>{paper.year}</span>}
        {paper.doi && <a target="_blank" rel="noreferrer" href={`https://doi.org/${encodeURI(paper.doi)}`}>{paper.doi}<ArrowUpRight size={12} /></a>}
        <span className="title-progress">{paper.completeCount}/{paper.sectionCount} 节已读</span></div>
      <h1 lang="en" title={paper.title}>{paper.title}</h1>
      {paper.authors.length > 0 && <div className="paper-authors" title={paper.authors.join(', ')}>{paper.authors.join(' · ')}</div>}
    </div>
    <div className="section-bar">
      <div className="section-heading"><span>当前章节</span><h2>{section.title}</h2></div>
      <div className="section-actions">
        <button className="icon-button bordered" aria-label="Previous Section" title="上一节" disabled={!previousSection} onClick={previousSection}><ArrowLeft size={17} /></button>
        <button className="icon-button bordered" aria-label="Next Section" title="下一节" disabled={!nextSection} onClick={nextSection}><ArrowRight size={17} /></button>
        <button className={`button compact ${paper.read.includes(section.id) ? 'soft' : 'secondary'}`} onClick={toggleRead}><Check size={15} />{paper.read.includes(section.id) ? '已读' : '标记已读'}</button>
        {page === null && !companionHidden && <button className="icon-button bordered sync-control" aria-label={layout === 'sync' ? '切换为独立滚动' : '切换为同步滚动'} title={layout === 'sync' ? '同步滚动' : '独立滚动'} aria-pressed={layout === 'sync'} onClick={changeLayout}>{layout === 'sync' ? <Link2 size={16} /> : <Unlink2 size={16} />}</button>}
        <button className={`button compact quiz-toggle ${quizOpen ? 'soft' : 'secondary'}`} aria-expanded={quizOpen} onClick={() => setQuizOpen((open) => !open)}><ListChecks size={16} />理解检测</button>
      </div>
    </div>
    <div className={`reading-region ${companionHidden ? 'companion-hidden' : ''}`} ref={canvas} style={style}>
      {page !== null ? <Suspense fallback={<div className="loading-pane"><LoaderCircle className="spin" size={22} />正在加载 PDF…</div>}>
        <PdfPane id={paper.id} fileName={paper.fileName} page={page} pages={paper.pages} onPage={setPage} analyze={(number) => void ask(undefined, number)} busy={busy?.kind === 'chat'} />
      </Suspense> : <>
        <div className="pane-titles paired"><div><BookOpen size={17} /><strong>Original Text</strong><span>英文原文</span></div>
          {!companionHidden && <div><Sparkles size={17} /><strong>AI Companion</strong><span>中文精读</span></div>}</div>
        {!companionHidden && <button className="resize-handle" aria-label="调整原文栏宽" title="拖动调整栏宽" onPointerDown={resize}
          onKeyDown={(event) => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); setSplit(Math.max(31, Math.min(69, split + (event.key === 'ArrowLeft' ? -2 : 2)))); } }} />}
        {!companionHidden && !(scheduled && preparing) && (status.phase === 'error' || status.phase === 'interrupted') && <div className="generation-notice" role="status"><CircleAlert size={16} />
          <span>{status.phase === 'interrupted' ? '生成已中断，可以从缺失的段落继续。' : status.error || '生成失败，可以重试。'}</span>
          <button className="text-button" onClick={openSettings}>设置</button></div>}
        {companionHidden ? <div className="reader-scroll single-reader" ref={sync} onScroll={(event) => onScroll('source', event.currentTarget)}>
          <div className="single-paper">{section.blocks.map(original)}{sourceFooter}</div>
        </div> : layout === 'sync' ? <div className="reader-scroll" ref={sync} onScroll={(event) => onScroll('sync', event.currentTarget)}>
          {section.blocks.map((block) => <div className="paired reader-row" key={block.id}>{original(block)}{assistant(block)}</div>)}
          <div className="paired reader-row">{sourceFooter}{keys.length > 0 ? assistant() : <div className="reader-cell companion-cell"><p className="muted">本节没有可索引的文本。打开原始 PDF 可请求视觉分析。</p></div>}</div>
        </div> : <div className="independent-grid paired">
          <div className="reader-scroll" ref={source} onScroll={(event) => onScroll('source', event.currentTarget)}>{section.blocks.map(original)}{sourceFooter}</div>
          <div className="reader-scroll" ref={aide} onScroll={(event) => onScroll('ai', event.currentTarget)}>{section.blocks.map((block) => <Fragment key={block.id}>{assistant(block)}</Fragment>)}{keys.length > 0 && assistant()}</div>
        </div>}
      </>}
      {selection && <div className="selection-toolbar"><span title={selection.quote}>{selection.quote.slice(0, 52)}{selection.quote.length > 52 && '…'}</span>
        <button className="button soft compact" onClick={() => { setQuoted(selection); setSelection(null); input.current?.focus(); }}><MessageCircle size={15} />提问</button>
        <button className="button subtle compact" onClick={() => void saveHighlight(selection)}><Highlighter size={15} />高亮</button>
        <button className="button subtle compact" onClick={() => setAnnotation(selection)}><BookmarkPlus size={15} />批注</button>
        <button className="icon-button" aria-label="清除选择" onClick={() => setSelection(null)}><X size={15} /></button></div>}
      <QuizPanel key={section.id} paper={paper.id} section={section.id} title={section.title}
        available={section.blocks.some((block) => Boolean(block.text.trim()))} dark={night} open={quizOpen} close={() => setQuizOpen(false)}
        source={jumpToSource} blocked={Boolean(busy)} onBusy={setQuizBusy} />
    </div>
    <div className="reader-dock">
      <div className="dock-header">
        <button className="text-button chat-toggle" aria-expanded={chatOpen} onClick={() => setChatOpen(!chatOpen)}><MessageCircle size={17} />论文对话
          {paper.messages.length > 0 && <span>{paper.messages.filter((item) => item.role === 'user').length}</span>}{chatOpen ? <ChevronDown size={14} /> : <ChevronUp size={14} />}</button>
        <div className="dock-actions">
          {preparation && preparing && <span className="reader-preparation"><PreparationStatus value={preparation} /></span>}
          {keys.length > 0 && <span className="cached-count">{cached}/{keys.length} 已缓存</span>}
          {busy ? <button className="button secondary compact" disabled={stopping} onClick={() => void stop()}><Square size={13} />{stopping ? '停止中…' : '停止生成'}</button>
            : preparation && preparing ? <button className="button secondary compact" onClick={() => changePreparation('pause')}><Pause size={14} />暂停后台生成</button>
            : preparation && ['paused', 'interrupted', 'error'].includes(preparation.phase) && scheduled && cached < keys.length ?
              <button className="button secondary compact" onClick={() => changePreparation('resume')}><Play size={14} />继续后台生成</button> : keys.length > 0 &&
            <button className="button secondary compact" disabled={quizBusy} onClick={() => void run('generate', section.id, { section: section.id, regenerate: status.phase === 'complete' && cached === keys.length })}>
              {status.phase === 'idle' ? <Sparkles size={15} /> : <RefreshCw size={14} />}{status.phase === 'complete' ? '重新生成' : status.phase === 'interrupted' ? '继续生成' : status.phase === 'error' ? '重试生成' : '生成伴读'}</button>}
        </div>
      </div>
      {chatOpen && <div className="chat-history" ref={history} aria-label="论文对话历史">
        {!paper.messages.length && <p className="chat-empty">从当前段落开始讨论。你也可以选中左栏文字来引用。</p>}
        {paper.messages.map((item, index) => <div key={item.id} className={`chat-message ${item.role}`}>
          <div className="chat-meta"><strong>{item.role === 'user' ? '你' : 'AI Companion'}</strong><span>{paper.structure.sections.find((entry) => entry.id === item.section)?.title}{item.block && ` · ${item.block.toUpperCase()}`}{item.page && ` · PDF p. ${item.page}`}</span>
            {item.role === 'assistant' && item.phase === 'complete' && <button className="icon-button" aria-label="将回答保存到研究笔记" onClick={() => addNote({ category: 'Key Contributions', text: item.text, source: 'ai', section: item.section, block: item.block })}><BookmarkPlus size={15} /></button>}
            {item.role === 'assistant' && (item.phase === 'interrupted' || item.phase === 'error') && <button className="text-button" disabled={!!busy} onClick={() => void ask(undefined, undefined, paper.messages[index - 1])}>重试</button>}
          </div>
          {item.quote && <blockquote>{item.quote}</blockquote>}
          {item.role === 'user' ? <p className="question-copy">{item.text}</p> : <>
            {item.phase === 'running' && !live[item.id] ? <p className="muted wait"><LoaderCircle size={14} className="spin" />正在思考…</p> : <Markdown text={live[item.id] ?? item.text} dark={night} streaming={item.phase === 'running'} />}
            {(item.phase === 'interrupted' || item.phase === 'error') && <small className="muted">{item.phase === 'interrupted' ? '回答已中断' : '生成失败'}</small>}
          </>}
        </div>)}
        {chatError && <div className="form-error" role="alert">{chatError}</div>}
      </div>}
      <form className="chat-form" onSubmit={(event) => void ask(event)}>
        {quoted && <div className="quote-chip"><ArrowDownRight size={14} /><span>{quoted.block.toUpperCase()} · {quoted.quote.slice(0, 120)}</span><button type="button" className="icon-button" aria-label="移除引用" onClick={() => setQuoted(null)}><X size={13} /></button></div>}
        <div className="chat-entry"><textarea ref={input} rows={1} maxLength={6000} value={draft} onChange={(event) => setDraft(event.target.value)}
          placeholder={`针对${focus ? `段落 ${focus.toUpperCase()}` : '本节'}提问…`} aria-label="向 AI 提问"
          onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); if (busy?.kind !== 'chat') void ask(); } }} />
          <button className="send-button" type="submit" disabled={!draft.trim() || busy?.kind === 'chat' || quizBusy} aria-label="发送问题"><Send size={17} /></button></div>
        {draft.trim() && <label className="check-label research-check"><input type="checkbox" checked={saveResearch} onChange={(event) => setSaveResearch(event.target.checked)} />记为研究问题</label>}
      </form>
    </div>
    {annotation && <Modal title="添加批注" icon={<Highlighter size={19} />} close={() => setAnnotation(null)}><div className="dialog-fields">
      <blockquote>{annotation.quote}</blockquote><label>我的批注<textarea rows={5} value={annotation.note} maxLength={5000}
        onChange={(event) => setAnnotation({ ...annotation, note: event.target.value })} /></label></div>
      <div className="modal-actions"><button className="button secondary" onClick={() => setAnnotation(null)}>取消</button>
        <button className="button primary" onClick={() => void saveHighlight(annotation)}>保存批注</button></div></Modal>}
  </main>;
}
