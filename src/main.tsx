import { createRoot } from 'react-dom/client';
import { useEffect, useRef, useState } from 'react';
import { BookOpen, BookOpenCheck, Check, ChevronDown, Circle, Clock3, FileText, LibraryBig, LoaderCircle, Menu, Moon, NotebookPen,
  PanelLeftClose, Plus, Settings2, Sparkles, Sun, Upload, X } from 'lucide-react';
import type { Note, NoteInput, Paper, PaperSummary, Preparation, Settings } from '../shared/model.ts';
import { companionKeys, preparationActive } from '../shared/model.ts';
import { api, message, paperURL, upload } from './api';
import { NoteDialog, SettingsDialog } from './Dialogs';
import { Library, Progress } from './Library';
import { Reader } from './Reader';
import { Research } from './Research';
import './style.css';

type Route = 'library' | 'reader' | 'notes';

function App() {
  const [route, setRoute] = useState<Route>('library');
  const [settings, setSettings] = useState<Settings | null>(null);
  const [papers, setPapers] = useState<PaperSummary[]>([]);
  const [paper, setPaper] = useState<Paper | null>(null);
  const [sidebarClosed, setSidebarClosed] = useState(window.innerWidth <= 790);
  const [outlineOpen, setOutlineOpen] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [editing, setEditing] = useState<{ paper: string; input: NoteInput; id?: string } | null>(null);
  const [noteVersion, setNoteVersion] = useState(0);
  const [working, setWorking] = useState(false);
  const [importing, setImporting] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [initialError, setInitialError] = useState('');
  const [toastValue, setToastValue] = useState('');
  const timeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);
  const request = useRef(0);
  const active = useRef<HTMLButtonElement>(null);
  const importingRef = useRef(false);
  const paperId = paper?.id;
  const dark = settings?.theme === 'dark';
  const hasBackground = papers.some((entry) => preparationActive(entry.preparation));

  function toast(value: string) {
    setToastValue(value);
    if (timeout.current) clearTimeout(timeout.current);
    timeout.current = setTimeout(() => setToastValue(''), 5700);
  }

  async function refreshLibrary() {
    try { setPapers(await api<PaperSummary[]>('/api/papers')); } catch (error) { toast(message(error)); }
  }

  useEffect(() => {
    void Promise.all([api<Settings>('/api/settings'), api<PaperSummary[]>('/api/papers')])
      .then(([preferences, list]) => { setSettings(preferences); setPapers(list); })
      .catch((error) => setInitialError(message(error)));
  }, []);

  useEffect(() => { document.documentElement.dataset.theme = dark ? 'dark' : 'light'; }, [dark]);
  useEffect(() => {
    if (!hasBackground) return;
    let active = true;
    const interval = setInterval(() => { void api<PaperSummary[]>('/api/papers').then((list) => { if (active) setPapers(list); }).catch(() => {}); }, 1400);
    return () => { active = false; clearInterval(interval); };
  }, [hasBackground]);
  useEffect(() => { active.current?.scrollIntoView({ block: 'nearest' }); }, [paper?.position.section, outlineOpen]);

  const update = (action: (current: Paper) => Paper) => setPaper((current) => current && current.id === paperId ? action(current) : current);
  const toggleSidebar = () => setSidebarClosed((closed) => !closed);
  const showSidebar = sidebarClosed ? <button className="icon-button" onClick={toggleSidebar} aria-label="展开侧栏"><Menu size={18} /></button> : undefined;

  function library() {
    request.current++;
    setWorking(false);
    setRoute('library');
    void refreshLibrary();
  }

  async function openPaper(id: string, destination: Route = 'reader', target?: string) {
    const ticket = ++request.current;
    setWorking(true);
    try {
      const next = await api<Paper>(paperURL(id));
      if (request.current !== ticket) return;
      if (target && target !== next.position.section) {
        const section = next.structure.sections.find((item) => item.id === target);
        if (section) next.position = { ...next.position, section: target, block: section.blocks[0]?.id ?? null, sourceScroll: 0, aiScroll: 0, stamp: Date.now() };
      }
      setPaper(next); setRoute(destination);
      if (window.innerWidth <= 790) setSidebarClosed(true);
    } catch (error) { if (request.current === ticket) toast(message(error)); }
    finally { if (request.current === ticket) setWorking(false); }
  }

  function openNotes() {
    if (paperId || papers[0]) void openPaper(paperId ?? papers[0].id, 'notes');
    else setRoute('notes');
  }

  function move(id: string) {
    if (!paper || paper.position.section === id) return;
    const section = paper.structure.sections.find((entry) => entry.id === id);
    if (!section) return;
    update((current) => ({ ...current, position: { ...current.position, section: id, block: section.blocks[0]?.id ?? null, sourceScroll: 0, aiScroll: 0, stamp: Date.now() } }));
    if (window.innerWidth <= 790) setSidebarClosed(true);
  }

  async function importFiles(files: File[]) {
    if (!files.length || importingRef.current) return;
    importingRef.current = true; setImporting(true);
    let imported = 0;
    let queued = 0;
    let duplicates = 0;
    const failures: string[] = [];
    try {
      for (const file of files) {
        try {
          if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') throw new Error('请导入 PDF 文件。');
          const { duplicate, preparation } = await upload(file);
          imported++;
          if (!duplicate && preparation) queued++;
          if (duplicate) duplicates++;
        } catch (error) { failures.push(`${file.name} · ${message(error)}`); }
      }
      await refreshLibrary();
      if (failures.length) toast(failures.join('\n'));
      else if (imported && imported === duplicates) toast('这些 PDF 已在论文库中。');
      else if (queued) toast(`已导入 ${imported - duplicates} 篇论文，${queued} 篇已加入后台生成队列。`);
      else if (imported) toast(`已导入 ${imported - duplicates} 篇论文。`);
    } finally { importingRef.current = false; setImporting(false); }
  }

  async function changePreparation(id: string, action: 'pause' | 'resume') {
    try {
      const result = await api<Preparation | null>(paperURL(id, '/preparation'), 'POST', { action });
      if (!result) return;
      setPapers((current) => current.map((entry) => entry.id === id ? { ...entry, preparation: result } : entry));
      setPaper((current) => current?.id === id ? { ...current, preparation: result } : current);
    } catch (error) { toast(message(error)); }
  }

  async function toggleRead() {
    if (!paper) return;
    const section = paper.position.section;
    const read = !paper.read.includes(section);
    try {
      await api(paperURL(paper.id, '/read'), 'PUT', { section, read });
      update((current) => {
        const list = read ? [...new Set([...current.read, section])] : current.read.filter((item) => item !== section);
        return { ...current, read: list, completeCount: list.length };
      });
      void refreshLibrary();
    } catch (error) { toast(message(error)); }
  }

  async function toggleTheme() {
    if (!settings) return;
    const next: Settings = { ...settings, theme: dark ? 'light' : 'dark' };
    setSettings(next);
    try { await api('/api/settings', 'PUT', next); }
    catch (error) { setSettings(settings); toast(message(error)); }
  }

  function add(input: NoteInput) { if (paperId) setEditing({ paper: paperId, input }); }
  function edit(note: Note) {
    if (!paperId) return;
    const { category, text, source, section, block } = note;
    setEditing({ paper: paperId, id: note.id, input: { category, text, source, section, block } });
  }

  const sectionIndex = paper?.structure.sections.findIndex((section) => section.id === paper.position.section) ?? -1;
  const reader = route === 'reader' && paper && settings;

  return <div className={`app-shell ${sidebarClosed ? 'sidebar-closed' : ''}`}
    onDragEnter={(event) => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); dragDepth.current++; setDragging(true); } }}
    onDragOver={(event) => { if (event.dataTransfer.types.includes('Files') || dragging) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; } }}
    onDragLeave={(event) => { event.preventDefault(); if (--dragDepth.current <= 0) { dragDepth.current = 0; setDragging(false); } }}
    onDrop={(event) => { if (event.dataTransfer.files.length) { event.preventDefault(); dragDepth.current = 0; setDragging(false); void importFiles([...event.dataTransfer.files]); } }}>
    <input type="file" ref={fileInput} className="file-input" accept="application/pdf,.pdf" multiple onChange={(event) => {
      if (event.target.files) void importFiles([...event.target.files]); event.target.value = '';
    }} />
    {!sidebarClosed && <><button className="mobile-scrim" aria-label="关闭侧栏" onClick={toggleSidebar} />
      <aside className="sidebar" aria-label="应用侧栏">
        <div className="brand-row"><button className="brand" onClick={library}><span className="brand-mark"><BookOpenCheck size={19} strokeWidth={1.8} /></span><span>PaperFellow</span></button>
          <button className="icon-button collapse" aria-label="收起侧栏" title="收起侧栏" onClick={toggleSidebar}><PanelLeftClose size={17} /></button></div>
        <button className="button primary sidebar-import" onClick={() => fileInput.current?.click()} disabled={importing}>
          {importing ? <LoaderCircle className="spin" size={17} /> : <Plus size={18} />}{importing ? '正在索引 PDF…' : '导入 PDF'}</button>
        <nav className="sidebar-nav" aria-label="工作区">
          <button className={route === 'library' ? 'active' : ''} onClick={library} aria-current={route === 'library' ? 'page' : undefined}><LibraryBig size={17} />论文库</button>
          <button className={route === 'notes' ? 'active' : ''} onClick={openNotes} aria-current={route === 'notes' ? 'page' : undefined}><NotebookPen size={17} />研究笔记</button>
        </nav>
        <div className="sidebar-scroll">
          {reader && <section className="outline-section">
            <div className="sidebar-progress"><div><span>阅读进度</span><span>{paper.completeCount}/{paper.sectionCount} 节</span></div><Progress paper={paper} /></div>
            <div className="sidebar-caption"><button onClick={() => setOutlineOpen(!outlineOpen)} aria-expanded={outlineOpen}><span>章节目录</span><ChevronDown size={14} className={outlineOpen ? '' : 'closed-chevron'} /></button></div>
            {outlineOpen && <nav className="toc" aria-label="章节目录">{paper.structure.sections.map((section) => {
              const current = section.id === paper.position.section;
              const completed = paper.read.includes(section.id);
              const phase = paper.statuses[section.id]?.phase;
              const keys = companionKeys(section);
              const cached = keys.length > 0 && keys.every((key) => !!paper.analyses[section.id]?.[key]);
              const label = completed ? '已阅读' : phase === 'running' ? '正在生成' : phase === 'interrupted' ? '生成已中断' : cached ? '已有伴读' : '未阅读';
              return <button key={section.id} ref={current ? active : undefined} className={`toc-link ${current ? 'current' : ''}`} title={`${section.title} · ${label} · PDF p. ${section.page}`}
                style={{ paddingInlineStart: `${10 + Math.min(section.level - 1, 3) * 10}px` }} onClick={() => move(section.id)} aria-current={current ? 'location' : undefined}>
                <span className="toc-state" aria-label={label}>{completed ? <Check size={14} /> : phase === 'running' ? <LoaderCircle size={13} className="spin" /> : cached ? <Sparkles size={12} /> : <Circle size={8} />}</span>
                <span>{section.title}</span>
              </button>;
            })}</nav>}
          </section>}
          {!!papers.length && <section className="recents"><div className="sidebar-caption"><span><Clock3 size={14} />最近阅读</span></div>
            {papers.slice(0, 6).map((entry) => <button className={`recent-link ${route === 'reader' && entry.id === paperId ? 'current' : ''}`} key={entry.id}
              onClick={() => { if (!(route === 'reader' && entry.id === paperId)) void openPaper(entry.id); }} title={entry.title}><FileText size={15} /><span>{entry.title}</span></button>)}</section>}
          {!papers.length && !reader && <div className="sidebar-empty"><BookOpen size={16} />暂无最近阅读</div>}
        </div>
        <div className="sidebar-footer"><button className="settings-button" onClick={() => setSettingsOpen(true)} disabled={!settings}><Settings2 size={17} />设置</button>
          <button className="icon-button theme-button" onClick={() => void toggleTheme()} aria-label={dark ? '切换浅色主题' : '切换深色主题'} title={dark ? '浅色主题' : '深色主题'} disabled={!settings}>{dark ? <Sun size={17} /> : <Moon size={17} />}</button></div>
      </aside></>}
    {!settings ? <main className="workspace initial-state">{initialError ? <><h1>无法连接本地服务</h1><p>{initialError}</p><button className="button secondary" onClick={() => location.reload()}>重试</button></> : <LoaderCircle className="spin" size={27} />}</main> :
      reader ? <Reader key={paper.id} paper={paper} settings={settings} update={update} sidebarClosed={sidebarClosed} toggleSidebar={toggleSidebar}
        nextSection={sectionIndex + 1 < paper.structure.sections.length ? () => move(paper.structure.sections[sectionIndex + 1].id) : undefined}
        previousSection={sectionIndex > 0 ? () => move(paper.structure.sections[sectionIndex - 1].id) : undefined}
        openSettings={() => setSettingsOpen(true)} toggleRead={() => void toggleRead()} addNote={add} toast={toast} changePreparation={(action) => void changePreparation(paper.id, action)} /> : route === 'notes' ?
        <Research paper={paper} papers={papers} load={(id) => void openPaper(id, 'notes')} read={(id, section) => void openPaper(id, 'reader', section)}
          revision={noteVersion} add={add} edit={edit} dark={dark} toast={toast} sidebarButton={showSidebar} /> :
        <Library papers={papers} open={(id) => void openPaper(id)} importing={importing} importPdf={() => fileInput.current?.click()} sidebarButton={showSidebar}
          changePreparation={(id, action) => void changePreparation(id, action)} />}
    {dragging && <div className="drop-zone"><Upload size={44} strokeWidth={1.5} /><h2>释放以导入 PDF</h2></div>}
    {working && <div className="working-indicator" role="status"><LoaderCircle className="spin" size={16} />正在打开论文…</div>}
    {!!toastValue && <div className="toast" role="status"><span>{toastValue}</span><button className="icon-button" aria-label="关闭提示" onClick={() => setToastValue('')}><X size={16} /></button></div>}
    {settingsOpen && settings && <SettingsDialog initial={settings} save={setSettings} close={() => setSettingsOpen(false)} />}
    {editing && <NoteDialog initial={editing.input} title={editing.id ? '编辑研究笔记' : '保存研究笔记'} close={() => setEditing(null)} save={async (input) => {
      await api(paperURL(editing.paper, editing.id ? `/notes/${editing.id}` : '/notes'), editing.id ? 'PUT' : 'POST', input);
      setNoteVersion((version) => version + 1); toast('已保存研究笔记');
    }} />}
  </div>;
}

createRoot(document.getElementById('root')!).render(<App />);
