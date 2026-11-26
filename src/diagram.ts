import mermaid from 'mermaid';

const output = document.getElementById('diagram')!;
let requested = false;
window.addEventListener('message', async (event) => {
  if (event.source !== window.parent || requested || event.data?.type !== 'paper-diagram') return;
  requested = true;
  const { source, dark } = event.data;
  const reply = (height: number) => window.parent.postMessage({ type: 'paper-diagram-height', height }, '*');
  try {
    if (typeof source !== 'string' || source.length > 12000 || !/^\s*(?:graph|flowchart|sequenceDiagram|stateDiagram(?:-v2)?|classDiagram|erDiagram)\b/.test(source) ||
        /%%\{|^\s*---|\b(?:click|href|linkStyle|callback)\s|<|(?:javascript|data):/im.test(source)) {
      throw new Error('Invalid diagram');
    }
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: dark ? 'dark' : 'neutral',
      flowchart: { htmlLabels: false }, maxTextSize: 12000, maxEdges: 120, suppressErrorRendering: true });
    await mermaid.parse(source);
    const { svg } = await mermaid.render('paper-figure', source);
    output.innerHTML = svg; // Mermaid's strict renderer, inside an opaque-origin sandbox.
    document.body.style.cssText = 'margin:8px; background:transparent; text-align:center;';
    const graphic = output.querySelector('svg');
    if (graphic) {
      const naturalWidth = graphic.viewBox.baseVal.width;
      graphic.style.maxWidth = naturalWidth > 0 ? `min(100%, ${naturalWidth}px)` : '100%';
      graphic.style.height = 'auto';
    }
    new ResizeObserver(() => reply(output.getBoundingClientRect().height + 18)).observe(output);
  } catch {
    output.textContent = 'Mermaid 图表规格无效。';
    output.style.cssText = `font:13px system-ui; color:${dark ? '#d9dfef' : '#535d76'}; padding:10px;`;
    reply(60);
  }
});
