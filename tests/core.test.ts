import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ParagraphStream } from '../server/companion.ts';
import { Store } from '../server/store.ts';
import type { PaperStructure } from '../shared/model.ts';
import { evaluate, parseVisualization } from '../shared/visualization.ts';
import { quizSchema, visibleQuiz } from '../shared/quiz.ts';

test('paragraph boundaries survive arbitrary stream splits and only finished rows are committed', () => {
  const saved = new Map<string, string>();
  const live = new Map<string, string>();
  const decoder = new ParagraphStream(['p1', 'p2', 'critical'],
    (key, value) => live.set(key, (live.get(key) ?? '') + value), (key, value) => saved.set(key, value));
  for (const chunk of ['<<', '<PAP', 'ER:p1>>>\n第', '一段 $x^2$\n<<', '<PAPER:p2', '>>>\n第二', '段内容']) decoder.push(chunk);
  assert.equal(saved.get('p1'), '第一段 $x^2$');
  assert.equal(live.get('p2'), '第二段内容');
  assert.equal(saved.has('p2'), false);
  decoder.push('\n<<<PAPER:critical>>>\n独立判断');
  decoder.finish();
  assert.deepEqual(Object.fromEntries(saved), { p1: '第一段 $x^2$', p2: '第二段内容', critical: '独立判断' });
});

test('BM25 denominator, sliders and select evaluate through the declarative expression only', () => {
  const spec = { kind: 'demo', title: 'BM25', xLabel: 'Term frequency', yLabel: 'Score', domain: [0, 20],
    controls: [{ id: 'b', label: 'b', kind: 'slider', min: 0, max: 1, step: .05, value: .75 },
      { id: 'length', label: 'Document length', kind: 'select', options: [{ label: 'Average', value: 100 }, { label: 'Long', value: 240 }], value: 100 }],
    expr: { op: 'div', args: [{ op: 'mul', args: [{ var: 'x' }, 2.2] }, { op: 'add', args: [{ var: 'x' },
      { op: 'mul', args: [1.2, { op: 'add', args: [{ op: 'sub', args: [1, { var: 'b' }] }, { op: 'mul', args: [{ var: 'b' }, { op: 'div', args: [{ var: 'length' }, 100] }] }] }] }] }] } };
  const parsed = parseVisualization(JSON.stringify(spec));
  assert.equal(parsed?.kind, 'demo');
  if (parsed?.kind !== 'demo') throw new Error('Invalid demo');
  const typical = evaluate(parsed.expr, { x: 3, b: .75, length: 100 });
  const long = evaluate(parsed.expr, { x: 3, b: .75, length: 240 });
  assert.ok(Math.abs(typical - 6.6 / 4.2) < 1e-8);
  assert.ok(long < typical);
  for (const expr of [{ op: 'eval', args: [1] }, { var: 'document' }, { op: 'sqrt', args: [1, 1] }]) {
    assert.equal(parseVisualization(JSON.stringify({ ...spec, expr })), null);
  }
  assert.equal(parseVisualization(JSON.stringify({ ...spec, html: '<script>bad()</script>' })), null);
  assert.equal(parseVisualization(JSON.stringify({ kind: 'heatmap', title: 'x', xLabel: 'x', yLabel: 'y', series: [{ name: 'x', points: [{ x: 0, y: 0 }] }] })), null);
});

test('SQLite keeps position ordering and completed work and marks unfinished jobs across restarts', () => {
  const root = mkdtempSync(join(tmpdir(), 'paper-companion-unit-'));
  let store = new Store(root);
  try {
    const first = 'a'.repeat(64);
    const second = 'b'.repeat(64);
    const structure: PaperStructure = { title: 'Fixture', authors: [], doi: null, year: null, pages: 1,
      sections: [{ id: 's1', title: 'Abstract', level: 1, page: 1, blocks: [{ id: 'p1', page: 1, text: 'Source paragraph.', kind: 'text', box: [0, 0, 1, 1] }] }],
      uncertainPages: [], columnPages: [], warnings: [] };
    store.addPaper(first, 'first.pdf', structure);
    store.addPaper(second, 'second.pdf', structure);
    const position = store.paper(first)!.position;
    store.position(first, { ...position, stamp: 5, sourceScroll: 146, chatOpen: true });
    store.position(first, { ...position, stamp: 4, sourceScroll: 0 });
    store.saveThread(first, 'thread-first');
    store.markRead(first, 's1', true);
    store.saveAnalysisProgress(first, 's1', 'p1', '中文讲解', { phase: 'running', remaining: ['critical'] });
    store.saveMessage(first, { id: 'qq', role: 'assistant', text: '中间输出', section: 's1', block: 'p1', created: 1, phase: 'running' });
    store.savePreparation(first, { phase: 'running', targets: ['s1'], completed: 0, current: 's1' });
    store.addHighlight(first, { block: 'p1', start: 0, end: 6, quote: 'Source', note: '笔记' });
    store.close(); store = new Store(root);
    const restored = store.paper(first)!;
    assert.equal(restored.position.sourceScroll, 146);
    assert.equal(restored.position.chatOpen, true);
    assert.equal(restored.analyses.s1.p1, '中文讲解');
    assert.equal(restored.statuses.s1.phase, 'interrupted');
    assert.deepEqual(restored.statuses.s1.remaining, ['critical']);
    assert.deepEqual(restored.preparation, { phase: 'interrupted', targets: ['s1'], completed: 0, current: null });
    assert.equal(restored.messages[0].phase, 'interrupted');
    assert.equal(restored.messages[0].text, '中间输出');
    assert.equal(restored.highlights[0].quote, 'Source');
    assert.equal(restored.codexThread, 'thread-first');
    assert.equal(store.paper(second)!.messages.length, 0);
    assert.equal(store.paper(second)!.codexThread, null);
    assert.match(store.export(restored), /中文讲解/);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test('quiz answers stay server-side until the corresponding question is answered', () => {
  const item = { prompt: 'Which result is supported?', choices: ['one', 'two', 'three', 'four'], correct: 1,
    explanation: 'The control supports option two.', evidence: ['p1'] };
  const items = quizSchema.parse([item, item, item]);
  const saved = visibleQuiz({ items, answers: { 0: 2 }, created: 1 });
  assert.deepEqual(saved.items[0].result, { selected: 2, correct: 1, explanation: item.explanation, evidence: ['p1'] });
  assert.deepEqual(saved.items[1], { prompt: item.prompt, choices: item.choices, result: null });
  assert.equal(quizSchema.safeParse([item, { ...item, choices: ['a', 'a', 'c', 'd'] }, item]).success, false);
});
