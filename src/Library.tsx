import { ArrowRight, ArrowUpRight, BookOpen, ChevronRight, FileText, LibraryBig, LoaderCircle, Pause, Play, Plus, Search, Upload } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { preparationActive, type PaperSummary } from '../shared/model.ts';
import { PreparationStatus } from './PreparationStatus';

const localDate = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' });

export function Progress({ paper }: { paper: Pick<PaperSummary, 'sectionCount' | 'completeCount'> }) {
  const fraction = paper.sectionCount ? Math.round(100 * paper.completeCount / paper.sectionCount) : 0;
  return <div className="progress-track" role="progressbar" aria-label="阅读进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={fraction}>
    <span style={{ width: `${fraction}%` }} /></div>;
}

export function Library({ papers, open, importPdf, importing, sidebarButton, changePreparation }: {
  papers: PaperSummary[]; open(id: string): void; importPdf(): void; importing: boolean; sidebarButton?: ReactNode;
  changePreparation(id: string, action: 'pause' | 'resume'): void;
}) {
  const [search, setSearch] = useState('');
  const recent = papers[0];
  const active = papers.filter((paper) => preparationActive(paper.preparation)).length;
  const filtered = papers.filter((paper) => `${paper.title} ${paper.authors.join(' ')} ${paper.year ?? ''} ${paper.doi ?? ''}`.toLocaleLowerCase().includes(search.toLocaleLowerCase().trim()));
  return <main className="workspace collection-workspace">
    <div className="topbar"><div className="crumbs">{sidebarButton}<LibraryBig size={16} /><strong>论文库</strong></div>
      <span className="local-label"><i />本地工作空间</span></div>
    <div className="collection-scroll"><div className="collection-inner">
      <div className="collection-heading"><div><h1>论文库</h1><p>{papers.length ? `${papers.length} 篇论文${active ? ` · ${active} 篇正在后台准备伴读` : ''}` : '在本地整理论文、精读原文并保存研究笔记。'}</p></div>
        <button className="button primary" onClick={importPdf} disabled={importing}>{importing ? <LoaderCircle className="spin" size={17} /> : <Plus size={18} />}{importing ? '正在索引 PDF' : '导入 PDF'}</button></div>
      {recent && <section className="continuation" aria-label="继续阅读">
        <div className="continue-icon"><BookOpen size={25} strokeWidth={1.55} /></div>
        <div className="continue-content"><h2 lang="en">{recent.title}</h2>
          <p>{recent.currentTitle || '阅读位置'} <span>·</span> {recent.completeCount}/{recent.sectionCount} 节已读</p></div>
        <button className="button secondary" onClick={() => open(recent.id)}>继续阅读<ArrowRight size={16} /></button>
      </section>}
      {recent ? <section className="library-list"><div className="list-title"><h2>全部论文</h2>
        <label className="search"><Search size={17} /><input aria-label="搜索论文" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索标题、作者或 DOI" /></label></div>
        {!filtered.length ? <div className="empty-search">没有匹配的论文。</div> : <div className="library-table">
          <div className="library-table-head"><span>论文</span><span>阅读进度</span><span>伴读准备</span><span>最近阅读</span><span /></div>
          {filtered.map((paper) => {
            const preparation = paper.preparation;
            const active = preparationActive(preparation);
            const resume = preparation && ['error', 'interrupted', 'paused'].includes(preparation.phase);
            return <div key={paper.id} className="paper-row">
              <button className="row-paper" onClick={() => open(paper.id)}><span className="row-icon"><FileText size={20} strokeWidth={1.65} /></span>
                <span><strong lang="en">{paper.title}</strong><small>{[paper.authors.slice(0, 3).join(', ') + (paper.authors.length > 3 ? ' 等' : ''), paper.year || '', `${paper.pages} 页`].filter(Boolean).join(' · ')}</small></span>
                <ChevronRight className="row-arrow mobile-arrow" size={16} />
              </button>
              <span className="row-progress"><Progress paper={paper} /><small>{paper.completeCount}/{paper.sectionCount} 节</small></span>
              <div className="row-preparation"><PreparationStatus value={preparation} />
                {(active || resume) && <button className="icon-button preparation-control" type="button"
                  title={active ? '暂停后台生成' : '继续后台生成'} aria-label={active ? '暂停后台生成' : '继续后台生成'}
                  onClick={() => changePreparation(paper.id, active ? 'pause' : 'resume')}>{active ? <Pause size={14} /> : <Play size={14} />}</button>}
              </div>
              <span className="row-date">{localDate.format(paper.lastRead)}</span><button className="icon-button row-open" aria-label={`打开 ${paper.title}`} onClick={() => open(paper.id)}><ArrowUpRight size={16} /></button>
            </div>;
          })}
        </div>}
      </section> : <section className="library-empty" aria-label="空论文库">
        <div className="empty-icon" aria-hidden="true"><FileText size={34} strokeWidth={1.45} /><span><Plus size={14} strokeWidth={2.5} /></span></div>
        <h2>导入你的第一篇论文</h2><p>把 PDF 拖到这里，或从本机选择文件。</p>
        <button className="button secondary" onClick={importPdf} disabled={importing}><Upload size={16} />选择本地 PDF</button>
      </section>}
    </div></div>
  </main>;
}
