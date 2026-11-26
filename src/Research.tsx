import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, BookOpen, Brain, Download, FileText, Highlighter, Lightbulb, LoaderCircle, MessageCircleQuestion,
  NotebookPen, Pencil, Plus, Sparkles, Square, Trash2 } from 'lucide-react';
import { noteCategories, type Note, type NoteInput, type Paper, type PaperSummary } from '../shared/model.ts';
import { api, message, paperURL, stream } from './api';
import { Markdown } from './Content';

const names: Record<NoteInput['category'], string> = {
  'Key Contributions': '主要贡献', 'Mathematical Insights': '数学洞见', 'Critical Comments': '批判性评论',
  'Open Research Questions': '开放研究问题', 'My Own Ideas': '我的想法', 'Potential Research Directions': '研究方向',
};
const icons = [BookOpen, Brain, Pencil, MessageCircleQuestion, Lightbulb, ArrowUpRight];

export function Research({ paper, papers, load, read, dark, revision, add, edit, toast, sidebarButton }: {
  paper: Paper | null; papers: PaperSummary[]; load(id: string): void; read(id: string, section?: string): void;
  dark: boolean; revision: number; add(note: NoteInput): void; edit(note: Note): void; toast(text: string): void;
  sidebarButton?: React.ReactNode;
}) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [filter, setFilter] = useState<NoteInput['category'] | 'all'>('all');
  const [source, setSource] = useState<NoteInput['source'] | 'all'>('all');
  const [loading, setLoading] = useState(false);
  const [issue, setIssue] = useState('');
  const [review, setReview] = useState('');
  const [reviewBusy, setReviewBusy] = useState(false);
  const reviewController = useRef<AbortController | null>(null);
  useEffect(() => {
    let active = true;
    if (!paper) { setNotes([]); return; }
    setLoading(true); setIssue(paper.statuses.review?.error ?? '');
    void api<Note[]>(paperURL(paper.id, '/notes')).then((value) => { if (active) setNotes(value); })
      .catch((error) => { if (active) setIssue(message(error)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [paper?.id, revision]);
  useEffect(() => () => { reviewController.current?.abort(); }, [paper?.id]);

  async function remove(id: string) {
    if (!paper || !window.confirm('删除这条研究笔记？')) return;
    try { await api(paperURL(paper.id, `/notes/${id}`), 'DELETE', {}); setNotes((old) => old.filter((note) => note.id !== id)); }
    catch (error) { toast(message(error)); }
  }

  async function runReview() {
    if (!paper || reviewController.current) return;
    const controller = new AbortController();
    reviewController.current = controller; setReview(''); setReviewBusy(true); setIssue('');
    try {
      await stream(paperURL(paper.id, '/review'), {}, controller.signal, (event) => {
        if (event.type === 'delta') setReview((text) => text + event.text);
        if (event.type === 'status' && event.error) setIssue(event.error);
      });
      const latest = await api<Note[]>(paperURL(paper.id, '/notes'));
      if (!controller.signal.aborted) { setNotes(latest); setReview(''); }
    } catch (error) { if (!controller.signal.aborted) setIssue(message(error)); }
    finally { reviewController.current = null; setReviewBusy(false); }
  }

  const filtered = notes.filter((note) => (filter === 'all' || note.category === filter) && (source === 'all' || note.source === source));
  return <main className="workspace collection-workspace">
    <div className="topbar"><div className="crumbs">{sidebarButton}<NotebookPen size={16} /><strong>研究笔记</strong></div><span className="local-label"><i />本地工作空间</span></div>
    <div className="collection-scroll"><div className="collection-inner research-inner">
      <div className="collection-heading"><div><h1>研究笔记</h1><p>保存论文洞见、开放问题与自己的研究想法。</p></div>
        {paper && <div className="heading-actions"><a className="button secondary" href={paperURL(paper.id, '/export.md')} download><Download size={16} />导出 Markdown</a>
          <button className="button primary" onClick={() => add({ category: filter === 'all' ? 'My Own Ideas' : filter, text: '', source: 'user', section: null, block: null })}><Plus size={18} />新建笔记</button></div>}</div>
      {!papers.length || !paper ? <div className="notes-empty"><NotebookPen size={31} strokeWidth={1.5} /><h2>选择一篇论文</h2><p>每篇论文都有独立的研究笔记。</p>
        {!!papers.length && <select aria-label="选择论文" value="" onChange={(event) => load(event.target.value)}><option value="" disabled>请选择</option>{papers.map((entry) => <option key={entry.id} value={entry.id}>{entry.title}</option>)}</select>}</div> : <>
        <div className="notes-toolbar"><label><FileText size={16} /><select aria-label="笔记所属论文" value={paper.id} onChange={(event) => { if (!reviewBusy) load(event.target.value); }} disabled={reviewBusy}>
          {papers.map((entry) => <option key={entry.id} value={entry.id}>{entry.title}</option>)}</select></label>
          <button className="button secondary compact" onClick={() => read(paper.id)}>打开论文<ArrowUpRight size={15} /></button>
          <button className="button secondary compact" onClick={() => reviewBusy ? void api(paperURL(paper.id, '/stop'), 'POST', {}).catch((error) => toast(message(error))) : void runReview()}>
            {reviewBusy ? <Square size={14} /> : <Sparkles size={15} />}{reviewBusy ? '停止全文评价' : notes.some((item) => item.id === 'full-review') ? '重新生成全文评价' : '生成全文评价'}</button>
        </div>
        <div className="notes-layout"><nav className="notes-categories" aria-label="笔记分类">
          <button onClick={() => setFilter('all')} className={filter === 'all' ? 'current' : ''}><NotebookPen size={16} />全部笔记<span>{notes.length}</span></button>
          {noteCategories.map((category, index) => { const Icon = icons[index]; return <button key={category} className={filter === category ? 'current' : ''} onClick={() => setFilter(category)} title={category}>
            <Icon size={16} /><span>{names[category]}</span><span>{notes.filter((item) => item.category === category).length}</span></button>; })}
        </nav><div className="notes-feed">
          <div className="notes-feed-title"><h2>{filter === 'all' ? '全部笔记' : names[filter]}</h2><div className="segmented">
            {([['all', '全部来源'], ['user', '读者'], ['ai', 'AI']] as const).map(([key, label]) => <button key={key} aria-pressed={source === key} onClick={() => setSource(key)}>{label}</button>)}
          </div></div>
          {issue && <div className="form-error" role="alert">{issue}</div>}
          {reviewBusy && <div className="note-card"><div className="note-card-meta"><span>AI · 全文评价</span><LoaderCircle size={15} className="spin" /></div>
            <Markdown text={review || '正在读取论文证据…'} dark={dark} streaming /></div>}
          {loading && <div className="loading-pane"><LoaderCircle size={18} className="spin" />正在加载笔记…</div>}
          {!loading && !filtered.length && !reviewBusy && <div className="notes-empty compact-empty"><NotebookPen size={25} strokeWidth={1.5} /><h3>暂无笔记</h3><p>可以新建笔记，或从伴读和对话中保存条目。</p></div>}
          {filtered.map((note) => {
            const section = paper.structure.sections.find((item) => item.id === note.section);
            return <article className="note-card" key={note.id}><header className="note-card-meta"><div>
              <span className={`note-source ${note.source === 'ai' ? 'from-ai' : ''}`}>{note.source === 'ai' ? 'AI' : '读者'}</span>
              <span>{note.id === 'full-review' ? '全文评价' : names[note.category]}</span>
              {section && <button className="text-button" onClick={() => read(paper.id, section.id)}>{section.title}<ArrowUpRight size={13} /></button>}</div>
              {!note.automatic && <div><button className="icon-button" aria-label="编辑笔记" onClick={() => edit(note)}><Pencil size={15} /></button>
                <button className="icon-button" aria-label="删除笔记" onClick={() => void remove(note.id)}><Trash2 size={15} /></button></div>}</header>
              <Markdown text={note.text} dark={dark} /></article>;
          })}
          {filter === 'all' && source !== 'ai' && paper.highlights.length > 0 && <section className="annotation-feed"><h3><Highlighter size={15} />批注与高亮</h3>
            {paper.highlights.map((highlight) => {
              const section = paper.structure.sections.find((group) => group.blocks.some((block) => block.id === highlight.block));
              return <article className="note-card" key={highlight.id}><div className="note-card-meta"><span className="note-source">读者</span>
                {section && <button className="text-button" onClick={() => read(paper.id, section.id)}>{section.title}<ArrowUpRight size={13} /></button>}</div>
                <blockquote lang="en">{highlight.quote}</blockquote>{highlight.note && <p>{highlight.note}</p>}</article>;
            })}</section>}
        </div></div>
      </>}
    </div></div>
  </main>;
}
