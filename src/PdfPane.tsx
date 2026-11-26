import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Download, Eye, Minus, Plus } from 'lucide-react';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
import worker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { paperURL } from './api';

GlobalWorkerOptions.workerSrc = worker;

export function PdfPane({ id, fileName, page, pages, onPage, analyze, busy }: {
  id: string; fileName: string; page: number; pages: number; onPage(page: number): void; analyze(page: number): void; busy: boolean;
}) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [zoom, setZoom] = useState(1);
  const [issue, setIssue] = useState('');
  const [width, setWidth] = useState(700);
  const canvas = useRef<HTMLCanvasElement>(null);
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setIssue(''); setDoc(null);
    const loading = getDocument({ url: paperURL(id, '/pdf'), cMapUrl: '/pdfjs/cmaps/',
      cMapPacked: true, standardFontDataUrl: '/pdfjs/standard_fonts/', wasmUrl: '/pdfjs/wasm/', iccUrl: '/pdfjs/iccs/' });
    let canceled = false;
    void loading.promise.then((value) => { if (!canceled) setDoc(value); }).catch(() => { if (!canceled) setIssue('无法渲染原始 PDF，可以下载后在本地查看。'); });
    return () => { canceled = true; void loading.destroy(); };
  }, [id]);
  useEffect(() => {
    if (!container.current) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(container.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!doc) return;
    let task: RenderTask | undefined;
    let canceled = false;
    void doc.getPage(page).then(async (pdfPage) => {
      const target = canvas.current;
      if (canceled || !target) return;
      const initial = pdfPage.getViewport({ scale: 1 });
      const cssWidth = Math.max(260, Math.min(900, width - 54)) * zoom;
      const pixelRatio = Math.min(2, window.devicePixelRatio || 1);
      const view = pdfPage.getViewport({ scale: cssWidth / initial.width * pixelRatio });
      target.width = Math.floor(view.width); target.height = Math.floor(view.height);
      target.style.width = `${cssWidth}px`;
      target.style.height = `${view.height / pixelRatio}px`;
      task = pdfPage.render({ canvas: target, viewport: view });
      await task.promise;
    }).catch(() => { if (!canceled) setIssue('此页面无法渲染。'); });
    return () => { canceled = true; task?.cancel(); };
  }, [doc, page, width, zoom]);

  const [entry, setEntry] = useState(String(page));
  useEffect(() => { setEntry(String(page)); setIssue(''); }, [page]);
  const jump = () => onPage(Math.max(1, Math.min(pages, parseInt(entry, 10) || page)));
  return <div className="pdf-pane">
    <div className="pdf-toolbar">
      <button className="icon-button" aria-label="上一页" disabled={page <= 1} onClick={() => onPage(page - 1)}><ChevronLeft size={16} /></button>
      <input className="page-input" type="number" min={1} max={pages} aria-label="PDF 页码" value={entry}
        onChange={(event) => setEntry(event.target.value)} onBlur={jump} onKeyDown={(event) => { if (event.key === 'Enter') jump(); }} />
      <span className="muted">/ {pages}</span>
      <button className="icon-button" aria-label="下一页" disabled={page >= pages} onClick={() => onPage(page + 1)}><ChevronRight size={16} /></button>
      <span className="toolbar-divider" />
      <button className="icon-button" aria-label="缩小" disabled={zoom <= .6} onClick={() => setZoom(Math.max(.6, zoom - .2))}><Minus size={16} /></button>
      <span className="muted">{Math.round(zoom * 100)}%</span>
      <button className="icon-button" aria-label="放大" disabled={zoom >= 1.8} onClick={() => setZoom(Math.min(1.8, zoom + .2))}><Plus size={16} /></button>
      <div className="toolbar-spacer" />
      <button className="button subtle compact" disabled={busy} onClick={() => analyze(page)}><Eye size={16} />视觉分析</button>
      <a className="icon-button" aria-label="下载原始 PDF" href={paperURL(id, '/pdf')} download={fileName}><Download size={16} /></a>
    </div>
    <div ref={container} className="pdf-canvas-wrap">
      {issue ? <p className="muted">{issue}</p> : <canvas ref={canvas} aria-label={`原始 PDF 第 ${page} 页`} />}
    </div>
  </div>;
}
