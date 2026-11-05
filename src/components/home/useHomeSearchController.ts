'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useSearchHistory } from '@/components/search-history';
import type { ToastType } from '@/components/toast';

type HomeSearchToast = (message: string, type?: ToastType) => void;

/**
 * Owns the homepage search input, history interactions, and URL navigation.
 * Search execution and result fetching remain in the existing page/query flow.
 */
export function useHomeSearchController(
  urlQuery: string,
  selectedSourceCount: number,
  toast: HomeSearchToast,
) {
  const router = useRouter();
  const [input, setInput] = useState(urlQuery);
  const inputRef = useRef<HTMLInputElement>(null);
  const searchHistory = useSearchHistory(input);

  useEffect(() => {
    if (urlQuery) setInput(urlQuery);
  }, [urlQuery]);

  const runSearch = (queryText: string) => {
    const query = queryText.trim().slice(0, 100);
    if (!query) {
      toast('请输入搜索内容', 'info');
      inputRef.current?.focus();
      return;
    }
    if (selectedSourceCount === 0) {
      toast('请先在设置中添加并勾选点播源', 'warning');
      return;
    }
    router.push(`/?q=${encodeURIComponent(query)}`, { scroll: false });
    searchHistory.record(query);
  };

  const pickHistory = (text: string) => {
    setInput(text);
    searchHistory.close();
    runSearch(text);
  };

  return {
    input,
    setInput,
    inputRef,
    searchHistory,
    runSearch,
    pickHistory,
  };
}
