'use client';

import type { ReactNode } from 'react';
import { FridayHero } from '@/components/friday/FridayHero';

type HomeIntentCanvasProps = {
  variant: 'legacy' | 'v2';
  children: ReactNode;
};

/**
 * 首页意图画布：统一承载 Friday 主视觉与搜索入口。
 * 只负责展示组合，不接管搜索状态、语音会话或搜索请求。
 */
export function HomeIntentCanvas({
  variant,
  children,
}: HomeIntentCanvasProps) {
  return (
    <>
      {variant === 'v2' ? (
        <FridayHero />
      ) : null}
      {children}
    </>
  );
}
