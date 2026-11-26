import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Check, CircleHelp, ListChecks, LoaderCircle, Sparkles, X } from 'lucide-react';
import type { Quiz } from '../shared/quiz.ts';
import { api, message, paperURL, stream } from './api';
import { Markdown } from './Content';

export function QuizPanel({ paper, section, title, available, dark, open, close, source, blocked, onBusy }: {
  paper: string; section: string; title: string; available: boolean; dark: boolean; open: boolean;
  close(): void; source(id: string): void; blocked: boolean; onBusy(value: boolean): void;
}) {
  const [quiz, setQuiz] = useState<Quiz | null>(null);
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [answering, setAnswering] = useState<number | null>(null);
  const [issue, setIssue] = useState('');
  const controller = useRef<AbortController | null>(null);
  const prefix = paperURL(paper, `/quiz/${section}`);

  useEffect(() => () => { controller.current?.abort(); onBusy(false); }, [prefix, onBusy]);
  useEffect(() => {
    if (!open) return;
    let active = true;
    setLoading(true);
    void api<Quiz | null>(prefix).then((value) => { if (active) setQuiz(value); })
      .catch((error) => { if (active) setIssue(message(error)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [prefix, open]);

  async function generate() {
    if (controller.current || blocked) return;
    const pending = new AbortController();
    controller.current = pending;
    setGenerating(true); onBusy(true); setIssue('');
    try {
      await stream(prefix, {}, pending.signal, (event) => {
        if (event.type === 'status' && event.phase === 'error') setIssue(event.error ?? '生成失败。');
        if (event.type === 'status' && event.phase === 'interrupted') setIssue('生成已中断，可再试一次。');
      });
      if (!pending.signal.aborted) {
        const saved = await api<Quiz | null>(prefix);
        if (!pending.signal.aborted) setQuiz(saved);
      }
    } catch (error) { if (!pending.signal.aborted) setIssue(message(error)); }
    finally { controller.current = null; setGenerating(false); if (!pending.signal.aborted) onBusy(false); }
  }

  async function answer(item: number, choice: number) {
    if (answering !== null || quiz?.items[item].result) return;
    setAnswering(item); setIssue('');
    try { setQuiz(await api<Quiz>(prefix, 'PUT', { item, choice })); }
    catch (error) { setIssue(message(error)); }
    finally { setAnswering(null); }
  }

  const earned = quiz?.items.filter((item) => item.result && item.result.selected === item.result.correct).length ?? 0;
  const attempted = quiz?.items.filter((item) => item.result).length ?? 0;
  return <aside className="quiz-panel" aria-label="理解检测" hidden={!open} onKeyDown={(event) => { if (event.key === 'Escape') close(); }}>
    <header className="quiz-header"><span className="quiz-icon"><ListChecks size={19} /></span><div><h2>理解检测</h2><p>{title}</p></div>
      <button className="icon-button" aria-label="收起理解检测" onClick={close}><X size={18} /></button></header>
    <div className="quiz-body">
      {issue && <p className="form-error" role="alert">{issue}</p>}
      {loading && <p className="quiz-loading" role="status"><LoaderCircle size={16} className="spin" />读取已保存的题目…</p>}
      {generating && <p className="quiz-loading" role="status"><LoaderCircle size={16} className="spin" />正在根据本节原文出题…</p>}
      {!loading && !generating && !quiz && <div className="quiz-intro"><CircleHelp size={32} strokeWidth={1.4} /><h3>读完这节了吗？</h3>
        <p>{available ? '生成三道单选题，检查你对本节观点、技术推理和研究证据的理解。提交后可查看解析与原文出处。' : '本节没有可索引的文本。请选择有正文的章节。'}</p>
        {available && <button className="button primary" onClick={() => void generate()} disabled={blocked}><Sparkles size={15} />{issue ? '重新生成题目' : '生成 3 道题'}</button>}</div>}
      {quiz && <><div className="quiz-progress" aria-live="polite"><span>已答 {attempted}/{quiz.items.length}</span>{attempted > 0 && <strong>答对 {earned} 题</strong>}</div>
        {quiz.items.map((item, index) => <article className="quiz-question" key={index}>
          <p className="quiz-question-title"><span>{index + 1}</span>{item.prompt}</p>
          <div className="quiz-choices">{item.choices.map((choice, k) => {
            const correct = item.result?.correct === k;
            const wrong = item.result?.selected === k && !correct;
            return <button className={correct ? 'correct' : wrong ? 'wrong' : ''} key={k} type="button" aria-pressed={item.result?.selected === k}
              disabled={!!item.result || answering !== null} onClick={() => void answer(index, k)}>
              <span className="quiz-choice-key">{'ABCD'[k]}</span><span>{choice}</span>{correct && <Check size={15} />}{wrong && <X size={15} />}</button>;
          })}</div>
          {item.result && <div className="quiz-explanation"><strong>{item.result.selected === item.result.correct ? '答对了' : `正确答案 ${'ABCD'[item.result.correct]}`}</strong>
            <Markdown text={item.result.explanation} dark={dark} /><div className="quiz-evidence">原文段落
              {[...new Set(item.result.evidence)].map((id) => <button className="text-button" key={id} onClick={() => source(id)}>{id.toUpperCase()}<ArrowUpRight size={12} /></button>)}
            </div></div>}
        </article>)}
      </>}
    </div>
  </aside>;
}
