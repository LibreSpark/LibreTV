'use client';

import { useEffect, useRef, useState } from 'react';
import type { Dispatch, RefObject, SetStateAction } from 'react';
import { SearchHistoryDropdown, useSearchHistory } from '@/components/search-history';
import { Icon } from '@/components/icon';
import { cn } from '@/lib/utils';

type SearchHistoryState = ReturnType<typeof useSearchHistory>;

type SpeechResultLike = { 0?: { transcript?: string }; isFinal?: boolean };
type SpeechEventLike = Event & { results: ArrayLike<SpeechResultLike> };
type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onstart: (() => void) | null;
  onresult: ((event: SpeechEventLike) => void) | null;
  onerror: ((event: Event & { error?: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};
type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  }
}

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

const VOICE_AUTO_SEND_DELAY = 1200;

/** AI 搜索框：回车/搜索按钮执行普通片源搜索，麦克风则将语音交给 Friday 解析。 */
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
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const autoSendTimerRef = useRef<number | null>(null);
  const finalTranscriptRef = useRef('');
  const recognitionErrorRef = useRef('');
  const [listening, setListening] = useState(false);
  const [voiceError, setVoiceError] = useState('');

  const clearAutoSendTimer = () => {
    if (autoSendTimerRef.current !== null) {
      window.clearTimeout(autoSendTimerRef.current);
      autoSendTimerRef.current = null;
    }
  };

  useEffect(() => {
    return () => {
      clearAutoSendTimer();
      const recognition = recognitionRef.current;
      recognitionRef.current = null;
      try { recognition?.abort(); } catch { /* recognition may already be closed */ }
    };
  }, []);

  const toggleVoiceInput = () => {
    if (recognitionRef.current) {
      try { recognitionRef.current.stop(); } catch { /* ignore stop race */ }
      return;
    }

    setVoiceError('');
    clearAutoSendTimer();

    if (typeof window === 'undefined' || !window.isSecureContext) {
      setVoiceError('语音输入需要 HTTPS 安全连接，请改用文字搜索。');
      return;
    }

    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Recognition) {
      setVoiceError('当前浏览器暂不支持语音识别，请使用文字搜索。');
      return;
    }

    finalTranscriptRef.current = '';
    recognitionErrorRef.current = '';

    let recognition: SpeechRecognitionLike;
    try {
      recognition = new Recognition();
    } catch {
      setVoiceError('无法启动语音识别，请检查浏览器麦克风权限。');
      return;
    }

    recognition.lang = 'zh-CN';
    recognition.continuous = false;
    recognition.interimResults = true;

    recognition.onstart = () => {
      setListening(true);
      setVoiceError('');
    };

    recognition.onresult = (event) => {
      let finalText = '';
      let interimText = '';
      for (let index = 0; index < event.results.length; index += 1) {
        const result = event.results[index];
        const transcript = result?.[0]?.transcript?.trim() ?? '';
        if (!transcript) continue;
        if (result.isFinal) finalText += transcript;
        else interimText += transcript;
      }

      const visibleText = (finalText || interimText).trim().slice(0, 100);
      if (visibleText) setInput(visibleText);
      if (finalText.trim()) {
        finalTranscriptRef.current = finalText.trim().slice(0, 100);
      }
    };

    recognition.onerror = (event) => {
      recognitionErrorRef.current = event.error || 'unknown';
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        setVoiceError('麦克风权限被拒绝。允许网站使用麦克风后可重试，文字搜索不受影响。');
      } else if (event.error === 'no-speech') {
        setVoiceError('没有听清内容，请再点一次麦克风。');
      } else if (event.error !== 'aborted') {
        setVoiceError('语音识别暂时不可用，请检查网络或改用文字搜索。');
      }
      setListening(false);
    };

    recognition.onend = () => {
      if (recognitionRef.current !== recognition) return;
      recognitionRef.current = null;
      setListening(false);

      const transcript = finalTranscriptRef.current.trim();
      if (!transcript || recognitionErrorRef.current) return;

      setInput(transcript);
      clearAutoSendTimer();
      autoSendTimerRef.current = window.setTimeout(() => {
        autoSendTimerRef.current = null;
        window.dispatchEvent(
          new CustomEvent('friday-submit-message', { detail: { text: transcript } }),
        );
      }, VOICE_AUTO_SEND_DELAY);
    };

    recognitionRef.current = recognition;
    try {
      // 必须在麦克风按钮的真实点击事件内同步启动，保留 iOS Safari 用户手势。
      recognition.start();
    } catch (error) {
      recognitionRef.current = null;
      setListening(false);
      const name = error instanceof Error ? error.name : '';
      setVoiceError(
        name === 'NotAllowedError' || name === 'SecurityError'
          ? '浏览器未授予麦克风权限。请在 Safari 网站设置中允许麦克风。'
          : '语音识别启动失败，请稍后重试或使用文字搜索。',
      );
    }
  };

  return (
    <section
      className={cn(
        'flex flex-col items-center',
        urlQuery ? 'mb-6' : showQuickSearches ? 'mt-2 mb-4' : 'mt-8 mb-8',
      )}
    >
      {!urlQuery && showBrandTitle && (
        <header className="text-center mb-6">
          <h1 className="text-4xl sm:text-5xl font-bold brand-gradient">LibreTV</h1>
        </header>
      )}
      {urlQuery && <h1 className="sr-only">LibreTV 视频搜索</h1>}

      <div ref={searchHistory.containerRef} className="relative w-full max-w-2xl">
        <form
          className="w-full"
          onSubmit={(event) => {
            event.preventDefault();
            clearAutoSendTimer();
            runSearch(input);
          }}
        >
          <div
            className={cn(
              'home-v2-ai-search flex items-center min-h-14 border',
              searchHistory.visible
                ? 'rounded-t-2xl rounded-b-none border-accent border-b-line bg-surface-raised'
                : 'rounded-2xl border-line bg-chip',
              listening && 'is-listening',
            )}
          >
            <span className="home-v2-search-leading" aria-hidden="true">
              <Icon name="search" className="w-5 h-5" />
            </span>
            <input
              ref={inputRef}
              className="home-v2-ai-search-input"
              placeholder="说出你想看的内容，或输入片名..."
              value={input}
              maxLength={100}
              onChange={(event) => {
                setInput(event.target.value);
                searchHistory.resetActive();
              }}
              onFocus={searchHistory.onFocus}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                  clearAutoSendTimer();
                }
                searchHistory.onKeyDown(event, pickHistory);
              }}
              role="combobox"
              aria-label="AI 搜索影片"
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
                className="home-v2-search-clear"
                onClick={() => {
                  clearAutoSendTimer();
                  setInput('');
                  searchHistory.resetActive();
                  inputRef.current?.focus();
                }}
                aria-label="清空输入"
              >
                <Icon name="close" className="w-4 h-4" />
              </button>
            )}
            <button
              type="button"
              className={cn('home-v2-mic-button', listening && 'is-listening')}
              onClick={toggleVoiceInput}
              aria-label={listening ? '停止语音输入' : '开始语音输入'}
              aria-pressed={listening}
              title={listening ? '正在聆听，点击结束' : '语音输入并交给 Friday'}
            >
              <Icon name="microphone" className="w-5 h-5" />
            </button>
            <button type="submit" className="home-v2-search-submit" aria-label="搜索">
              <Icon name="search" className="w-5 h-5" />
            </button>
          </div>
        </form>

        {voiceError && (
          <p className="home-v2-voice-error" role="status" aria-live="polite">
            {voiceError}
          </p>
        )}

        {listening && (
          <p className="home-v2-voice-status" role="status" aria-live="polite">
            <span className="home-v2-voice-pulse" />
            正在聆听，说完后会自动交给 Friday
          </p>
        )}

        {showQuickSearches && !urlQuery && (
          <div className="home-v2-quick-searches" aria-label="热门搜索">
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
