'use client';

import { useEffect, useState } from 'react';
import { useAuth } from '@/components/auth';
import { useT } from '@/lib/i18n';

/** 上游仓库最新 tag（即最新版本号），用于页脚的更新检测 */
const UPSTREAM_TAGS_API = 'https://api.github.com/repos/LibreSpark/LibreTV/tags?per_page=1';

/** 页脚版本号的更新检测结果；null 表示无需检测（本地 dev 构建） */
type UpstreamUpdate = { status: 'checking' | 'latest' | 'newer'; latest?: string };

/** 点分版本号比较：a 大于 b 返回正数 */
function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** 检测上游是否有更新的版本；检测失败或本地构建（dev）时静默返回 null */
function useUpstreamUpdate(current: string | null): UpstreamUpdate | null {
  const [state, setState] = useState<UpstreamUpdate | null>({ status: 'checking' });
  useEffect(() => {
    if (!current || current === 'dev') {
      setState(null);
      return;
    }
    // 按当前版本隔离缓存到 sessionStorage：一次会话最多请求一次 GitHub API
    const cacheKey = `upstream-latest-tag:${current}`;
    const cached = sessionStorage.getItem(cacheKey);
    if (cached) {
      setState(
        compareVersions(cached, current) > 0
          ? { status: 'newer', latest: cached }
          : { status: 'latest' },
      );
      return;
    }
    let alive = true;
    fetch(UPSTREAM_TAGS_API)
      .then((r) => (r.ok ? r.json() : []))
      .then((tags: { name?: string }[]) => {
        const name = tags[0]?.name?.replace(/^v/, '');
        if (!name || !alive) return;
        try {
          sessionStorage.setItem(cacheKey, name);
        } catch {
          /* 隐私模式等场景下缓存不可写，忽略即可 */
        }
        setState(
          compareVersions(name, current) > 0
            ? { status: 'newer', latest: name }
            : { status: 'latest' },
        );
      })
      .catch(() => {
        /* 网络受限 / 触发 GitHub 限流时静默跳过 */
        if (alive) setState(null);
      });
    return () => {
      alive = false;
    };
  }, [current]);
  return state;
}

/** 页脚仓库链接上的悬停提示：显示更新检测结果 */
function UpdateTip({ update }: { update: UpstreamUpdate | null }) {
  const t = useT();
  const tip =
    update === null
      ? null
      : update.status === 'newer'
        ? t('发现新版本 v{v}', { v: update.latest })
        : update.status === 'latest'
          ? t('已是最新版本')
          : t('正在检测更新…');
  if (!tip) return null;
  return (
    <span className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1.5 hidden -translate-x-1/2 whitespace-nowrap rounded-md border border-line bg-chip px-2 py-1 text-faint shadow-sm group-hover:block">
      {tip}
    </span>
  );
}

/** 全站统一页脚：仓库链接 + 版本号（悬停显示上游更新检测结果） */
export function SiteFooter() {
  const { version } = useAuth();
  const upstreamUpdate = useUpstreamUpdate(version);
  return (
    <footer className="border-t border-line py-4">
      <p className="text-center text-xs text-faint">
        <a
          href="https://github.com/LibreSpark/LibreTV"
          target="_blank"
          rel="noopener noreferrer"
          className="group relative inline-block cursor-help hover:text-accent"
        >
          LibreTV{version ? ` v${version}` : ''}
          {version && <UpdateTip update={upstreamUpdate} />}
        </a>
        {' · '}
        AGPL-3.0 License
      </p>
    </footer>
  );
}
