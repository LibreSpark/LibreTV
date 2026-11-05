'use client';

import { useEffect } from 'react';
import { useAppStore, resolveSource } from '@/lib/store';
import { validateSourceUrl } from '@/lib/utils';
import { normalizeFridayMovieId } from '@/lib/friday/movie-detail';
import type { SearchResultItem } from '@/lib/types';
import type { ToastType } from '@/components/toast';

type FridayDetailToast = (message: string, type?: ToastType) => void;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Bridges Friday movie-detail events into the existing LibreTV detail modal.
 * Validation and source resolution stay identical to the homepage implementation.
 */
export function useFridayDetailBridge(
  onOpenDetail: (item: SearchResultItem) => void,
  toast: FridayDetailToast,
) {
  useEffect(() => {
    const handleFridayOpenDetail = (event: Event) => {
      const raw = (event as CustomEvent<unknown>).detail;
      if (!isRecord(raw)) return;

      const {
        sourceKey,
        sourceName,
        sourceUrl,
        vodId,
        name,
        pic,
        typeName,
        year,
        area,
        remarks,
        isAdult,
      } = raw;

      const normalizedVodId = normalizeFridayMovieId(vodId);
      const normalizedYear =
        typeof year === 'number' && Number.isFinite(year)
          ? String(year)
          : year;

      if (
        typeof sourceKey !== 'string' ||
        !sourceKey.trim() ||
        sourceKey.length > 100 ||
        (sourceName !== undefined &&
          (typeof sourceName !== 'string' || sourceName.length > 100)) ||
        !normalizedVodId ||
        typeof name !== 'string' ||
        !name.trim() ||
        name.length > 100
      ) {
        toast('影片详情参数无效，无法打开详情', 'warning');
        return;
      }

      if (sourceUrl !== undefined && typeof sourceUrl !== 'string') {
        toast('影片详情来源地址格式无效', 'warning');
        return;
      }

      const suppliedSourceUrl =
        typeof sourceUrl === 'string' ? sourceUrl.trim() : '';

      if (suppliedSourceUrl && !validateSourceUrl(suppliedSourceUrl)) {
        toast('影片详情来源地址未通过安全校验', 'warning');
        return;
      }

      if (
        (pic !== undefined && typeof pic !== 'string') ||
        (typeName !== undefined && typeof typeName !== 'string') ||
        (normalizedYear !== undefined && typeof normalizedYear !== 'string') ||
        (area !== undefined && typeof area !== 'string') ||
        (remarks !== undefined && typeof remarks !== 'string') ||
        (isAdult !== undefined && typeof isAdult !== 'boolean')
      ) {
        toast('影片详情附加参数格式无效', 'warning');
        return;
      }

      const normalizedSourceKey = sourceKey.trim();
      const suppliedSourceName =
        typeof sourceName === 'string' ? sourceName.trim() : '';
      const currentStore = useAppStore.getState();

      // Preserve the existing local-source resolution and Friday CMS URL priority.
      const localSource = resolveSource(currentStore, normalizedSourceKey);
      const normalizedSourceName =
        suppliedSourceName || localSource?.name || normalizedSourceKey;
      let source = localSource;

      if (normalizedSourceKey === 'friday-cms' && suppliedSourceUrl) {
        source = {
          ...(localSource ?? {}),
          key: normalizedSourceKey,
          name: normalizedSourceName,
          url: suppliedSourceUrl,
          detail: undefined,
        };
      } else if (!source && suppliedSourceUrl) {
        source = {
          key: normalizedSourceKey,
          name: normalizedSourceName,
          url: suppliedSourceUrl,
        };
      }

      if (!source || !source.url) {
        toast(
          normalizedSourceKey === 'friday-cms'
            ? 'Friday CMS 数据源地址缺失，请检查搜索结果或本地配置'
            : '本地数据源配置不存在，请检查数据源设置',
          'error',
        );
        return;
      }

      if (!validateSourceUrl(source.url)) {
        toast('数据源地址未通过安全校验', 'error');
        return;
      }

      const item: SearchResultItem = {
        sourceKey: source.key,
        sourceName: normalizedSourceName || source.name,
        sourceUrl: source.url,
        vodId: normalizedVodId,
        name: name.trim(),
        ...(typeof pic === 'string' && pic ? { pic } : {}),
        ...(typeof typeName === 'string' && typeName ? { typeName } : {}),
        ...(typeof normalizedYear === 'string' && normalizedYear
          ? { year: normalizedYear }
          : {}),
        ...(typeof area === 'string' && area ? { area } : {}),
        ...(typeof remarks === 'string' && remarks ? { remarks } : {}),
        ...(typeof isAdult === 'boolean'
          ? { isAdult }
          : source.isAdult !== undefined
            ? { isAdult: source.isAdult }
            : {}),
      };

      onOpenDetail(item);
    };

    window.addEventListener('friday-open-detail', handleFridayOpenDetail);
    return () => {
      window.removeEventListener('friday-open-detail', handleFridayOpenDetail);
    };
  }, [onOpenDetail, toast]);
}
