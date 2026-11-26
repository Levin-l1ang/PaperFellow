import { CircleAlert, CircleCheck, Clock3, LoaderCircle, Pause } from 'lucide-react';
import type { Preparation } from '../shared/model.ts';

export function preparationLabel(value: Preparation) {
  return { queued: '待生成', running: '后台生成中', ready: '伴读已就绪', paused: '已暂停', interrupted: '上次已中断', error: '生成失败' }[value.phase];
}

export function PreparationStatus({ value }: { value?: Preparation }) {
  if (!value) return <span className="muted preparation-neutral">—</span>;
  const Icon = { queued: Clock3, running: LoaderCircle, ready: CircleCheck, paused: Pause, interrupted: CircleAlert, error: CircleAlert }[value.phase];
  return <span className={`preparation-status ${value.phase}`} title={value.error}>
    <Icon size={14} className={value.phase === 'running' ? 'spin' : undefined} />
    <span>{preparationLabel(value)}</span><span className="preparation-count">{value.completed}/{value.targets.length}</span></span>;
}
