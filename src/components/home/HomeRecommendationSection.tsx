'use client';

import { RecommendSection } from '@/components/douban-section';
import type { DoubanItem } from '@/lib/types';

type HomeRecommendationSectionProps = {
  isV2: boolean;
  enabled: boolean;
  onPick: (item: DoubanItem) => void;
};

/**
 * 首页推荐展示容器。
 * 只负责今日热门标题与既有推荐模块的组合，数据请求和来源切换仍由 RecommendSection 处理。
 */
export function HomeRecommendationSection({
  isV2,
  enabled,
  onPick,
}: HomeRecommendationSectionProps) {
  return (
    <>
      {isV2 && enabled ? (
        <h2 className="home-v2-trending-title">今日热门</h2>
      ) : null}
      <RecommendSection onPick={onPick} />
    </>
  );
}
