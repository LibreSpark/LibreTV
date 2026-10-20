'use client';

import { useAppStore } from '@/lib/store';
import { validateIntroEnd, validateOutroStart } from '@/lib/skip-marks';
import { formatTime } from '@/lib/utils';
import { useToast } from './toast';

/**
 * 播放页的片头/片尾标记面板。
 *
 * 采集站不提供片头片尾元数据，边界只能由用户在看的时候标记一次，
 * 之后同剧各集与同名资源自动套用。面板只负责「记录当前 / 清除」两个动作，
 * 真正的跳过判定在 player-shell.tsx，存储与校验在 lib/skip-marks.ts。
 */

interface PlayerClock {
  currentTime: number;
  duration: number;
}

type MotionField = 'introEnd' | 'outroStart';

const ROWS: { field: MotionField; label: string; hint: string }[] = [
  { field: 'introEnd', label: '片头结束', hint: '正片开始的位置' },
  { field: 'outroStart', label: '片尾开始', hint: '片尾曲开始的位置' },
];

export function SkipMarkPanel({
  markKey,
  getPlayerClock,
}: {
  /** 已归一化的标记键（watch 页按剧名计算） */
  markKey: string;
  /** 读取播放器当前时间；播放器未就绪时返回 null */
  getPlayerClock: () => PlayerClock | null;
}) {
  const mark = useAppStore((s) => s.skipMarks[markKey]);
  const setSkipMark = useAppStore((s) => s.setSkipMark);
  const { toast } = useToast();

  const record = (field: MotionField) => {
    const clock = getPlayerClock();
    if (!clock || clock.currentTime <= 0) {
      toast('播放器尚未就绪，请稍后再试', 'warning');
      return;
    }
    // 保留 0.1s：显示按秒取整，但跳转位置不因取整而漂移
    const value = Math.round(clock.currentTime * 10) / 10;
    const error =
      field === 'introEnd'
        ? validateIntroEnd(value, clock.duration, mark)
        : validateOutroStart(value, clock.duration, mark);
    if (error) {
      toast(error, 'error');
      return;
    }
    setSkipMark(markKey, { [field]: value });
    toast(
      `已将${field === 'introEnd' ? '片头结束' : '片尾开始'}设为 ${formatTime(value)}`,
      'success'
    );
  };

  const clear = (field: MotionField) => {
    setSkipMark(markKey, { [field]: null });
    toast(`已清除${field === 'introEnd' ? '片头' : '片尾'}标记`, 'info');
  };

  return (
    <div className="mt-3 rounded-lg border border-line bg-surface-raised p-3">
      <div className="space-y-2">
        {ROWS.map(({ field, label, hint }) => {
          const value = mark?.[field];
          return (
            <div key={field} className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-baseline gap-2 min-w-0">
                <span className="text-sm text-content">{label}</span>
                <span className="text-xs text-faint">{hint}</span>
                <span className="text-xs font-mono text-muted">
                  {value !== undefined ? formatTime(value) : '未设置'}
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                <button type="button" className="btn-ghost btn-sm" onClick={() => record(field)}>
                  记录当前
                </button>
                <button
                  type="button"
                  className="btn-ghost btn-sm"
                  disabled={value === undefined}
                  onClick={() => clear(field)}
                >
                  清除
                </button>
              </div>
            </div>
          );
        })}
      </div>
      <p className="mt-2.5 text-[11px] text-faint leading-relaxed">
        标记按剧名记忆，对本剧所有剧集与同名资源生效；命中时播放器底部显示「跳过片头/片尾」按钮，
        自动跳过可在「设置 → 播放与过滤」中关闭。
      </p>
    </div>
  );
}
