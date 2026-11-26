import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Bot, CircleCheck, FlaskConical, LoaderCircle, Settings2, X } from 'lucide-react';
import { noteCategories, type NoteInput, type ProviderStatus, type Settings } from '../shared/model.ts';
import { api, message } from './api';

export function Modal({ title, icon, children, close, wide = false }: { title: string; icon?: ReactNode; children: ReactNode; close(): void; wide?: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  return <dialog className={`modal ${wide ? 'wide' : ''}`} ref={dialog} aria-labelledby="dialog-title"
    onCancel={(event) => { event.preventDefault(); close(); }} onClick={(event) => { if (event.target === event.currentTarget) close(); }}>
    <div className="modal-content">
      <header className="modal-header"><div>{icon}<h2 id="dialog-title">{title}</h2></div><button className="icon-button" onClick={close} aria-label="关闭"><X size={19} /></button></header>
      {children}
    </div>
  </dialog>;
}

export function SettingsDialog({ initial, save, close }: { initial: Settings; save(value: Settings): void; close(): void }) {
  const [value, setValue] = useState(initial);
  const [verified, setVerified] = useState<ProviderStatus | null>(null);
  const [testing, setTesting] = useState(false);
  const [confirmed, setConfirmed] = useState(initial.provider === 'openai');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');

  async function test() {
    setTesting(true);
    setError('');
    try { setVerified(await api<ProviderStatus>('/api/provider')); }
    catch (error) { setError(message(error)); }
    finally { setTesting(false); }
  }

  return <Modal title="设置" icon={<Settings2 size={21} />} close={close} wide>
    <form className="settings-form" onSubmit={async (event) => {
      event.preventDefault(); setError(''); setPending(true);
      try { save(await api<Settings>('/api/settings', 'PUT', value)); close(); }
      catch (error) { setError(message(error)); }
      finally { setPending(false); }
    }}>
      <div className="settings-body">
        <section><h3><Bot size={17} />模型与认证</h3>
          <div className="field-grid">
            <label>AI Provider<select value={value.provider} onChange={(event) => setValue({ ...value, provider: event.target.value as Settings['provider'] })}>
              <option value="codex">Codex · ChatGPT 登录</option><option value="openai">OpenAI API · 独立计费</option></select></label>
            <label>模型{value.provider === 'codex' ? <input value={value.codexModel} list="codex-models" placeholder="使用 Codex 默认模型"
              onChange={(event) => setValue({ ...value, codexModel: event.target.value })} /> : <input required value={value.openaiModel} placeholder="输入 API 模型 ID"
                onChange={(event) => setValue({ ...value, openaiModel: event.target.value })} />}
              <datalist id="codex-models">{verified?.models.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}</datalist></label>
          </div>
          {value.provider === 'openai' ? <div className="settings-notice"><p>请在后端环境变量或本地 .env 配置 OPENAI_API_KEY。请求由 OpenAI API 账户按用量计费。</p>
            <label className="check-label"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} required />我确认启用计费 API</label></div>
            : <p className="muted">通过本机 Codex app-server 使用 ChatGPT 登录和模型额度。所选论文片段及问题会发送至模型。可运行 <code>codex login</code> 登录。</p>}
          <div className="provider-status"><button type="button" className="button secondary compact" disabled={testing} onClick={() => void test()}>
            {testing ? <LoaderCircle className="spin" size={15} /> : <CircleCheck size={15} />}检查已保存的连接</button>
          {verified && <small className={verified.ready ? 'success' : 'danger-text'}>{verified.message}{verified.defaultModel && ` · ${verified.defaultModel}`}</small>}</div>
        </section>
        <section><h3><FlaskConical size={17} />伴读偏好</h3>
          <div className="field-grid">
            <label>详细程度<select value={value.detail} onChange={(event) => setValue({ ...value, detail: event.target.value as Settings['detail'] })}>
              <option value="concise">简洁</option><option value="balanced">适中</option><option value="detailed">详细</option></select></label>
            <label>界面主题<select value={value.theme} onChange={(event) => setValue({ ...value, theme: event.target.value as Settings['theme'] })}>
              <option value="light">浅色</option><option value="dark">深色</option></select></label>
          </div>
          <label>阅读风格<input placeholder="例如：更关注实验设计与机制" value={value.style} maxLength={1000}
            onChange={(event) => setValue({ ...value, style: event.target.value })} /></label>
          <label>导入后后台生成<select value={value.importGeneration} onChange={(event) => setValue({ ...value, importGeneration: event.target.value as Settings['importGeneration'] })}>
            <option value="paper">全文正文</option><option value="abstract">仅摘要</option><option value="off">关闭</option>
          </select></label>
          <label className="check-label"><input type="checkbox" checked={value.autoGenerate} onChange={(event) => setValue({ ...value, autoGenerate: event.target.checked })} />进入未分析章节时自动生成</label>
          <label>System Prompt<textarea rows={9} value={value.systemPrompt} required maxLength={20000} onChange={(event) => setValue({ ...value, systemPrompt: event.target.value })} /></label>
        </section>
        {error && <p role="alert" className="form-error">{error}</p>}
      </div>
      <div className="modal-actions"><button type="button" className="button secondary" onClick={close}>取消</button>
        <button className="button primary" type="submit" disabled={pending || (value.provider === 'openai' && !confirmed)}>{pending ? '保存中…' : '保存设置'}</button></div>
    </form>
  </Modal>;
}

export function NoteDialog({ initial, title, close, save }: { initial: NoteInput; title: string; close(): void; save(input: NoteInput): Promise<void> }) {
  const [value, setValue] = useState(initial);
  const [pending, setPending] = useState(false);
  const [issue, setIssue] = useState('');
  return <Modal title={title} close={close}>
    <form onSubmit={async (event) => {
      event.preventDefault(); setPending(true); setIssue('');
      try { await save(value); close(); } catch (error) { setIssue(message(error)); } finally { setPending(false); }
    }}>
      <div className="dialog-fields">
        <label>分类<select value={value.category} onChange={(event) => setValue({ ...value, category: event.target.value as NoteInput['category'] })}>
          {noteCategories.map((category) => <option key={category}>{category}</option>)}</select></label>
        <label>{value.source === 'ai' ? '内容 · AI' : '内容 · 读者'}<textarea rows={8} value={value.text} required maxLength={40000} placeholder="支持 Markdown 和 LaTeX"
          onChange={(event) => setValue({ ...value, text: event.target.value })} /></label>
        {issue && <p role="alert" className="form-error">{issue}</p>}
      </div>
      <div className="modal-actions"><button type="button" className="button secondary" onClick={close}>取消</button>
        <button className="button primary" type="submit" disabled={pending || !value.text.trim()}>保存笔记</button></div>
    </form>
  </Modal>;
}
