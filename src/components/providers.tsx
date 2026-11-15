'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { ToastProvider } from './toast';
import { AuthProvider } from './auth';
import { ThemeProvider } from './theme';
import { useAppStore, hydrateLiveProbeResults } from '@/lib/store';
import { api, STATUS_QUERY_KEY } from '@/lib/client-api';
import { applyEnvPresets } from '@/lib/subscription-sync';

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 60_000 },
        },
      })
  );

  // store 配置了 skipHydration：等挂载后再读 localStorage，
  // 保证 hydration 阶段客户端与服务端渲染结果一致。
  useEffect(() => {
    // 先等持久化状态恢复，再拉服务端下发数据：
    // 避免 setEnvSources/setLiveEnvSources 的勾选合并发生在 rehydrate 之前被覆盖
    Promise.resolve(useAppStore.persist.rehydrate())
      .then(() => {
        // 测活缓存从 IndexedDB 恢复（并顺带搬迁旧 localStorage 快照里的存量），
        // 与下方 /api/status 拉取互不依赖，失败静默
        void hydrateLiveProbeResults();
        // 拉取部署者通过 DEFAULT_SOURCES / DEFAULT_LIVE_SOURCES 预置的源（失败时静默忽略）
        // 与 AuthProvider 共用同一 query key，/api/status 全站只发一次
        return queryClient.fetchQuery({ queryKey: STATUS_QUERY_KEY, queryFn: () => api.status() });
      })
      .then((d) => {
        // 预置数据（DEFAULT_SOURCES / DEFAULT_LIVE_SOURCES / DEFAULT_SUBSCRIPTIONS）
        // 预置订阅要经鉴权接口拉取，首屏这次可能发生在登录之前而 401 静默失败；
        // 登录成功后由 AuthProvider 再调一次 applyEnvPresets 补齐（函数幂等）
        if (d) {
          // 部署默认值只补齐尚未由用户主动选择的设置；不覆盖持久化的个人选择。
          // /api/status 在服务端读取 Wrangler 运行时变量，客户端不能直接读取 Worker vars。
          const current = useAppStore.getState();
          const deploymentDefaults: {
            recommendSource?: typeof current.recommendSource;
            imageProxyMode?: typeof current.imageProxyMode;
          } = {};
          if (d.defaultRecommendSource && !current.recommendSourceTouched) {
            deploymentDefaults.recommendSource = d.defaultRecommendSource;
          }
          if (d.defaultImageMode && !current.imageProxyModeTouched) {
            deploymentDefaults.imageProxyMode = d.defaultImageMode;
          }
          if (Object.keys(deploymentDefaults).length > 0) {
            useAppStore.setState(deploymentDefaults);
          }
          return applyEnvPresets(d);
        }
      })
      .catch(() => {});
  }, [queryClient]);

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <ToastProvider>
          <AuthProvider>{children}</AuthProvider>
        </ToastProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
