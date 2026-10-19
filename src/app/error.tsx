'use client';

import Link from 'next/link';
import { useEffect } from 'react';
import { ErrorState } from '@/components/states';
import { useT } from '@/lib/i18n';

/**
 * 路由段级错误边界：捕获页面渲染/数据异常，避免落到 Next 默认英文白屏。
 * 刻意不放 Header——它依赖 zustand store，若异常源正是 store 会二次崩溃。
 */
export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useT();
  useEffect(() => {
    console.error('[LibreTV] 页面渲染异常:', error);
  }, [error]);

  return (
    <div className="min-h-screen flex flex-col">
      <main className="flex-1 flex items-center justify-center px-4">
        <ErrorState
          message={t('页面出了点问题，请重试。若持续失败请返回首页。')}
          onRetry={reset}
          retryLabel={t('重试')}
        />
      </main>
      <footer className="border-t border-line py-4">
        <p className="text-center text-xs text-faint">
          {t('问题持续存在？')}{' '}
          <Link href="/" className="hover:text-accent">
            {t('返回首页')}
          </Link>
        </p>
      </footer>
    </div>
  );
}
