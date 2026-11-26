import { useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { evaluate, parseVisualization } from '../shared/visualization.ts';
import type { Visualization } from '../shared/visualization.ts';
import 'katex/dist/katex.min.css';

export function Markdown({ text, dark, streaming = false }: { text: string; dark: boolean; streaming?: boolean }) {
  const normalized = text.replace(/\\\[([\s\S]*?)\\\]/g, (_, math: string) => `\n\n$$\n${math}\n$$\n\n`)
    .replace(/\\\(([^\n]*?)\\\)/g, (_, math: string) => `$${math}$`);
  const components = useMemo<Components>(() => ({
      a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer">{children}</a>,
      img: ({ alt }) => <span>{alt}</span>,
      table: ({ children }) => <div className="table-scroll"><table>{children}</table></div>,
      pre: ({ children }) => <div className="code-wrap">{children}</div>,
      code: ({ className, children }) => {
        const value = String(children ?? '').trim();
        if (className === 'language-mermaid') return streaming ? <small>正在生成图表…</small> : <Diagram source={value} dark={dark} />;
        if (className === 'language-paper-viz') return streaming ? <small>正在生成可视化…</small> : <VisualizationBlock source={value} />;
        return <code className={className}>{children}</code>;
      },
  }), [dark, streaming]);
  return <div className="markdown"><ReactMarkdown skipHtml remarkPlugins={[remarkGfm, remarkMath]}
    rehypePlugins={[[rehypeKatex, { strict: 'ignore', trust: false }]]} components={components}>{normalized}</ReactMarkdown></div>;
}

function Diagram({ source, dark }: { source: string; dark: boolean }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(135);
  useEffect(() => {
    const handle = (event: MessageEvent) => {
      if (event.source === frame.current?.contentWindow && event.data?.type === 'paper-diagram-height' && Number.isFinite(event.data.height)) {
        setHeight(Math.min(860, Math.max(52, event.data.height)));
      }
    };
    window.addEventListener('message', handle);
    return () => window.removeEventListener('message', handle);
  }, []);
  return <iframe key={`${dark}-${source}`} ref={frame} className="diagram-frame" title="Mermaid 流程图" sandbox="allow-scripts"
    height={height} src="/diagram.html" onLoad={() => frame.current?.contentWindow?.postMessage({ type: 'paper-diagram', source, dark }, '*')} />;
}

function VisualizationBlock({ source }: { source: string }) {
  const spec = useMemo(() => parseVisualization(source), [source]);
  if (!spec) return <p className="muted">可视化规格无效。</p>;
  return <Chart key={source} spec={spec} />;
}

type Point = { x: number; y: number; value?: number };
const colors = ['#4960c2', '#a9613b', '#805bb1', '#a25183', '#8b652b', '#4775a8'];
const format = new Intl.NumberFormat('en', { maximumSignificantDigits: 4 });
const chartWidth = 530;
const height = 262;
const x0 = 65;
const y0 = 18;
const x1 = chartWidth - 23;
const y1 = height - 50;

function Chart({ spec }: { spec: Visualization }) {
  const [values, setValues] = useState<Record<string, number>>(() => spec.kind === 'demo' ? Object.fromEntries(spec.controls.map((control) => [control.id, control.value])) : {});
  const [hover, setHover] = useState<{ name: string; point: Point } | null>(null);
  const series: { name: string; points: Point[] }[] = spec.kind === 'demo' ? [{ name: spec.title, points: Array.from({ length: 121 }, (_, i) => {
    const x = spec.domain[0] + (spec.domain[1] - spec.domain[0]) * i / 120;
    return { x, y: evaluate(spec.expr, { ...values, x }) };
  }) }] : spec.series;
  const points = series.flatMap((row) => row.points).filter(({ y }) => Number.isFinite(y) && Math.abs(y) <= 1e12);
  const xValues = [...new Set(points.map(({ x }) => x))].sort((a, b) => a - b);
  const yValues = [...new Set(points.map(({ y }) => y))].sort((a, b) => a - b);
  const minX = xValues[0] ?? 0;
  const maxX = xValues.at(-1) ?? 1;
  const minY = Math.min(spec.kind === 'bar' ? 0 : Infinity, yValues[0] ?? 0);
  const maxY = Math.max(spec.kind === 'bar' ? 0 : -Infinity, yValues.at(-1) ?? 1);
  const categorical = spec.kind === 'heatmap' || spec.kind === 'bar';
  const cellWidth = (x1 - x0) / Math.max(1, xValues.length);
  const cellHeight = (y1 - y0) / Math.max(1, yValues.length);
  const sx = (x: number) => categorical ? x0 + (xValues.indexOf(x) + .5) * cellWidth : minX === maxX ? (x0 + x1) / 2 : x0 + (x1 - x0) * (x - minX) / (maxX - minX);
  const sy = (y: number) => spec.kind === 'heatmap' ? y1 - (yValues.indexOf(y) + .5) * cellHeight : minY === maxY ? (y0 + y1) / 2 : y1 - (y1 - y0) * (y - minY) / (maxY - minY);
  const ticks = (low: number, high: number) => low === high ? [low] : Array.from({ length: 5 }, (_, i) => low + i * (high - low) / 4);
  const spaced = (values: number[]) => values.filter((_, i) => i % Math.max(1, Math.ceil(values.length / 7)) === 0);
  const heatValues = points.map((point) => point.value ?? 0);
  const heatMin = Math.min(...heatValues);
  const heatMax = Math.max(...heatValues);
  const base = Math.min(21, cellWidth * .72 / Math.max(1, series.length));

  return <figure className="chart-card">
    <figcaption>{spec.title}</figcaption>
    {spec.caption && <small>{spec.caption}</small>}
    {spec.kind === 'demo' && <div className="chart-controls">{spec.controls.map((control) => <label key={control.id}>
      <span>{control.label} <output>{format.format(values[control.id])}</output></span>
      {control.kind === 'slider' ? <input type="range" min={control.min} max={control.max} step={control.step} value={values[control.id]}
        onChange={(event) => { setHover(null); setValues({ ...values, [control.id]: Number(event.target.value) }); }} /> :
        <select value={values[control.id]} onChange={(event) => { setHover(null); setValues({ ...values, [control.id]: Number(event.target.value) }); }}>
          {control.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>}
    </label>)}</div>}
    {points.length ? <svg className="chart-plot" viewBox={`0 0 ${chartWidth} ${height}`} role="img" aria-label={spec.title}>
      {(spec.kind === 'heatmap' ? spaced(yValues) : ticks(minY, maxY)).map((y) => <g key={y}>
        <line x1={x0} x2={x1} y1={sy(y)} y2={sy(y)} className="chart-grid" />
        <text x={x0 - 8} y={sy(y) + 4} textAnchor="end">{format.format(y)}</text>
      </g>)}
      {(categorical ? spaced(xValues) : ticks(minX, maxX)).map((x) => <text key={x} x={sx(x)} y={y1 + 19} textAnchor="middle">{format.format(x)}</text>)}
      <path d={`M ${x0},${y0} V ${y1} H ${x1}`} className="chart-axis" />
      <text x={(x0 + x1) / 2} y={height - 6} textAnchor="middle">{spec.xLabel}</text>
      <text x={-((y0 + y1) / 2)} y="13" transform="rotate(-90)" textAnchor="middle">{spec.yLabel}</text>
      {series.map((row, index) => {
        const color = colors[index % colors.length];
        const sorted = [...row.points].sort((a, b) => a.x - b.x);
        let continues = false;
        const path = sorted.map(({ x, y }) => {
          if (!Number.isFinite(y) || Math.abs(y) > 1e12) { continues = false; return ''; }
          const piece = `${continues ? 'L' : 'M'}${sx(x)},${sy(y)}`;
          continues = true;
          return piece;
        }).join(' ');
        return <g key={`${row.name}-${index}`}>
          {(spec.kind === 'line' || spec.kind === 'demo') && <path d={path} fill="none" stroke={color} strokeWidth="2.5" />}
          {sorted.filter(({ y }) => Number.isFinite(y) && Math.abs(y) <= 1e12).map((point, i) => {
            const props = { onMouseEnter: () => setHover({ name: row.name, point }), onMouseLeave: () => setHover(null),
              'aria-label': `${row.name}, ${format.format(point.x)}, ${format.format(point.y)}` };
            if (spec.kind === 'bar') return <rect key={i} x={sx(point.x) + (index - series.length / 2) * base} width={Math.max(.5, base - 1)}
              y={Math.min(sy(point.y), sy(0))} height={Math.max(1, Math.abs(sy(0) - sy(point.y)))} fill={color} {...props} />;
            if (spec.kind === 'heatmap') return <rect key={i} x={sx(point.x) - cellWidth / 2 + 1} y={sy(point.y) - cellHeight / 2 + 1}
              width={cellWidth - 2} height={cellHeight - 2} rx="2" fill={color} opacity={.12 + .88 * ((point.value ?? 0) - heatMin) / (heatMax - heatMin || 1)} {...props} />;
            return <circle key={i} cx={sx(point.x)} cy={sy(point.y)} r={spec.kind === 'scatter' ? 4 : 3.5} fill={spec.kind === 'scatter' || sorted.length < 2 ? color : 'transparent'} {...props} />;
          })}
        </g>;
      })}
    </svg> : <div className="no-chart">当前参数范围内没有有限数值。</div>}
    <div className="chart-footer">{hover ? <span>{hover.name} · {format.format(hover.point.x)}, {format.format(hover.point.y)}{hover.point.value !== undefined && ` · ${format.format(hover.point.value)}`}</span> :
      spec.kind === 'heatmap' ? <span>色阶 · {format.format(heatMin)} — {format.format(heatMax)}</span> : series.length > 1 ? series.map(({ name }, i) => <span key={`${name}-${i}`}><i style={{ background: colors[i] }} />{name}</span>) : null}</div>
  </figure>;
}
