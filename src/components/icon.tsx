import type { ReactNode } from 'react';

/**
 * 统一图标集（Heroicons outline 风格，24×24 线性）。
 * 替代此前散落在各处的 Unicode 符号（✎ ✕ ⟳ ⚡ ⇩）：同一笔画粗细与网格，
 * 不会因字体/平台不同而粗细不一，与顶部导航的图标风格保持一致。
 */

export type IconName =
  | 'close'
  | 'edit'
  | 'refresh'
  | 'bolt'
  | 'download'
  | 'chevronDown'
  | 'plus'
  | 'search'
  | 'microphone'
  | 'clock'
  | 'check'
  | 'arrowDown'
  | 'undo'
  | 'trash'
  | 'filter'
  | 'link'
  | 'alert'
  | 'gear'
  | 'home'
  | 'play'
  | 'database'
  | 'radio'
  | 'rss'
  | 'palette'
  | 'image'
  | 'languages'
  | 'house'
  | 'audio-lines'
  | 'shield-check'
  | 'database-backup'
  | 'network'
  | 'info';

const PATHS: Record<IconName, ReactNode> = {
  close: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />,
  edit: (
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L6.832 19.82a4.5 4.5 0 0 1-1.897 1.13l-2.685.8.8-2.685a4.5 4.5 0 0 1 1.13-1.897L16.863 4.487Zm0 0L19.5 7.125"
    />
  ),
  refresh: (
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99"
    />
  ),
  bolt: (
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      d="m3.75 13.5 10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75Z"
    />
  ),
  download: (
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3"
    />
  ),
  chevronDown: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="m19.5 8.25-7.5 7.5-7.5-7.5" />,
  plus: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4.5v15m7.5-7.5h-15" />,
  microphone: (
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 18.75a4.5 4.5 0 0 0 4.5-4.5v-6a4.5 4.5 0 1 0-9 0v6a4.5 4.5 0 0 0 4.5 4.5Zm0 0v3m-4.5 0h9m-13.5-9a9 9 0 0 0 18 0" />
  ),
  search: (
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z"
    />
  ),
  clock: (
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      d="M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"
    />
  ),
  check: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="m4.5 12.75 6 6 9-13.5" />,
  arrowDown: (
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 14l-7 7m0 0l-7-7m7 7V3" />
  ),
  undo: (
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      d="M9 15 3 9m0 0 6-6M3 9h12a6 6 0 0 1 0 12h-3"
    />
  ),
  trash: (
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0"
    />
  ),
  filter: (
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      d="M12 3c2.755 0 5.455.232 8.083.678.533.09.917.556.917 1.096v1.044a2.25 2.25 0 0 1-.659 1.591l-5.432 5.432a2.25 2.25 0 0 0-.659 1.591v2.927a2.25 2.25 0 0 1-1.244 2.013L9.75 21v-6.568a2.25 2.25 0 0 0-.659-1.591L3.659 7.409A2.25 2.25 0 0 1 3 5.818V4.774c0-.54.384-1.006.917-1.096A48.32 48.32 0 0 1 12 3Z"
    />
  ),
  link: (
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      d="M13.19 8.688a4.5 4.5 0 0 1 1.242 7.244l-4.5 4.5a4.5 4.5 0 0 1-6.364-6.364l1.757-1.757m13.35-.622 1.757-1.757a4.5 4.5 0 0 0-6.364-6.364l-4.5 4.5a4.5 4.5 0 0 0 1.242 7.244"
    />
  ),
  alert: (
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      d="M12 9v3.75m9-.75a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 3.75h.008v.008H12v-.008Z"
    />
  ),
  gear: (
    <>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 0 0-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 0 0-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 0 0-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 0 0-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 0 0 1.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065Z"
      />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
    </>
  ),
  home: (
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      d="m2.25 12 8.954-8.955c.44-.439 1.152-.439 1.591 0L21.75 12M4.5 9.75v10.125c0 .621.504 1.125 1.125 1.125H9.75v-4.875c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21h4.125c.621 0 1.125-.504 1.125-1.125V9.75"
    />
  ),
  play: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.7} d="M8 5.5v13l10-6.5-10-6.5Z" />,
  database: <><ellipse cx="12" cy="5" rx="8" ry="3" strokeWidth={1.7}/><path strokeWidth={1.7} d="M4 5v7c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12v7c0 1.7 3.6 3 8 3s8-1.3 8-3v-7"/></>,
  radio: <><circle cx="12" cy="13" r="2" strokeWidth={1.7}/><path strokeWidth={1.7} d="M5.6 6.6a9 9 0 0 0 0 12.8M18.4 6.6a9 9 0 0 1 0 12.8M8.5 9.5a5 5 0 0 0 0 7M15.5 9.5a5 5 0 0 1 0 7"/></>,
  rss: <><path strokeWidth={1.7} d="M5 19h.01M5 12a7 7 0 0 1 7 7M5 5a14 14 0 0 1 14 14"/><circle cx="5" cy="19" r="1" strokeWidth={1.7}/></>,
  palette: <><path strokeWidth={1.7} d="M12 3a9 9 0 1 0 0 18h1.2a2.1 2.1 0 0 0 1.5-3.6 1.7 1.7 0 0 1 1.2-2.9H18a3 3 0 0 0 3-3c0-4.7-4-8.5-9-8.5Z"/><circle cx="7.5" cy="11" r=".8"/><circle cx="10" cy="7.5" r=".8"/><circle cx="15" cy="8" r=".8"/></>,
  image: <><rect x="3" y="4" width="18" height="16" rx="2" strokeWidth={1.7}/><circle cx="8.5" cy="9" r="1.5" strokeWidth={1.7}/><path strokeWidth={1.7} d="m4 17 5-5 3.5 3 2.5-2 5 4"/></>,
  languages: <><circle cx="12" cy="12" r="9" strokeWidth={1.7}/><path strokeWidth={1.7} d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></>,
  house: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.7} d="m3 11 9-7 9 7M5.5 10v10h13V10M9 20v-6h6v6"/>,
  'audio-lines': <><path strokeWidth={1.7} d="M4 10v4M8 6v12M12 3v18M16 7v10M20 10v4"/></>,
  'shield-check': <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.7} d="M12 3 19 6v5c0 4.8-3 8-7 10-4-2-7-5.2-7-10V6l7-3Zm-3 9 2 2 4-4"/>,
  'database-backup': <><ellipse cx="11" cy="5" rx="7" ry="2.5" strokeWidth={1.7}/><path strokeWidth={1.7} d="M4 5v6c0 1.4 3.1 2.5 7 2.5M4 11v5c0 1.4 3.1 2.5 7 2.5"/><path strokeWidth={1.7} d="M17 13v7m-3-3 3-3 3 3"/></>,
  network: <><circle cx="12" cy="5" r="2" strokeWidth={1.7}/><circle cx="5" cy="18" r="2" strokeWidth={1.7}/><circle cx="19" cy="18" r="2" strokeWidth={1.7}/><path strokeWidth={1.7} d="m11 7-5 9m7-9 5 9M7 18h10"/></>,
  info: <><circle cx="12" cy="12" r="9" strokeWidth={1.7}/><path strokeWidth={1.7} d="M12 11v5m0-8h.01"/></>
};

export function Icon({ name, className = 'w-5 h-5' }: { name: IconName; className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
      {PATHS[name]}
    </svg>
  );
}
