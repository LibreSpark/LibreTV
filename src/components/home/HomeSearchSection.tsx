'use client';

import type { Dispatch, RefObject, SetStateAction } from 'react';
import { SearchHistoryDropdown, useSearchHistory } from '@/components/search-history';
import { Icon } from '@/components/icon';
import { cn } from '@/lib/utils';

type SearchHistoryState = ReturnType<typeof useSearchHistory>;

type HomeSearchSectionProps = {
  urlQuery: string;
  input: string;
  setInput: Dispatch<SetStateAction<string>>;
  inputRef: RefObject<HTMLInputElement | null>;
  searchHistory: SearchHistoryState;
  runSearch: (query: string) => void;
  pickHistory: (text: string) => void;
  showBrandTitle?: boolean;
  showQuickSearches?: boolean;
};

/** 首页搜索入口。搜索状态与 URL/数据请求仍由 HomeContent 协调。 */
export function HomeSearchSection({
  urlQuery,
  input,
  setInput,
  inputRef,
  searchHistory,
  runSearch,
  pickHistory,
  showBrandTitle = true,
  showQuickSearches = false,
}: HomeSearchSectionProps) {
  return (
            <section
              className={cn(
                'flex flex-col items-center',
                urlQuery ? 'mb-6' : 'mt-8 mb-8'
              )}
            >
              {!urlQuery && showBrandTitle && (
                <header className="text-center mb-6">
                  <h1 className="text-4xl sm:text-5xl font-bold brand-gradient">
                    LibreTV
                  </h1>
                </header>
              )}
              {urlQuery && <h1 className="sr-only">LibreTV 视频搜索</h1>}
              <div
                ref={searchHistory.containerRef}
                className="relative w-full max-w-2xl"
              >
                <form
                  className="w-full"
                  onSubmit={(e) => {
                    e.preventDefault();
                    runSearch(input);
                  }}
                >
                  <div
                    className={cn(
                      'flex items-stretch min-h-12 pl-4 border',
                      'transition-[background-color,border-color,border-radius] duration-200',
                      searchHistory.visible
                        ? 'rounded-t-xl rounded-b-none border-accent border-b-line bg-surface-raised'
                        : 'rounded-xl border-line bg-chip focus-within:border-accent focus-within:ring-1 focus-within:ring-accent/40'
                    )}
                  >
                    <input
                      ref={inputRef}
                      className="flex-1 min-w-0 pr-2 bg-transparent text-sm text-content placeholder:text-faint focus:outline-none"
                      placeholder="输入影片名称..."
                      value={input}
                      maxLength={100}
                      onChange={(e) => {
                        setInput(e.target.value);
                        searchHistory.resetActive();
                      }}
                      onFocus={searchHistory.onFocus}
                      onKeyDown={(e) => searchHistory.onKeyDown(e, pickHistory)}
                      role="combobox"
                      aria-label="搜索影片"
                      aria-expanded={searchHistory.visible}
                      aria-controls="home-search-history"
                      aria-autocomplete="list"
                      aria-activedescendant={
                        searchHistory.visible && searchHistory.activeIndex >= 0
                          ? `home-search-history-${searchHistory.activeIndex}`
                          : undefined
                      }
                    />
                    {input && (
                      <button
                        type="button"
                        className="shrink-0 self-center mr-1 p-1.5 rounded-full text-faint hover:text-content hover:bg-hover transition-colors"
                        onClick={() => {
                          setInput('');
                          searchHistory.resetActive();
                          inputRef.current?.focus();
                        }}
                        aria-label="清空"
                      >
                        <Icon name="close" className="w-4 h-4" />
                      </button>
                    )}
                    <button
                      type="submit"
                      className={cn(
                        'btn-primary shrink-0 px-4 font-medium transition-[background-color,filter] active:brightness-90',
                        '!rounded-l-none',
                        searchHistory.visible
                          ? '!rounded-tr-xl !rounded-br-none'
                          : '!rounded-r-xl'
                      )}
                    >
                      <Icon name="search" className="w-4 h-4" />
                      搜索
                    </button>
                  </div>
                </form>
                {showQuickSearches && !urlQuery && (
                  <div
                    className="home-v2-quick-searches"
                    aria-label="热门搜索"
                  >
                    {['蜘蛛侠', '科幻', '悬疑', '动漫'].map((term) => (
                      <button
                        key={term}
                        type="button"
                        className="home-v2-quick-search"
                        onClick={() => runSearch(term)}
                      >
                        {term}
                      </button>
                    ))}
                  </div>
                )}
                {searchHistory.visible && (
                  <SearchHistoryDropdown
                    id="home-search-history"
                    matches={searchHistory.matches}
                    activeIndex={searchHistory.activeIndex}
                    onPick={pickHistory}
                    onRemove={searchHistory.remove}
                    onClearAll={searchHistory.clearAll}
                  />
                )}
              </div>
            </section>
  );
}
