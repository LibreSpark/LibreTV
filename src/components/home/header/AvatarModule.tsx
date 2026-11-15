'use client';

import { useRouter } from 'next/navigation';
import { GlassButton } from '@/components/ui/glass';
import styles from './Avatar.module.css';

export function AvatarModule({ pathname }: { pathname: string | null }) {
  const router = useRouter();

  return (
    <GlassButton
      className={'v4-avatar ' + styles.root}
      aria-label="打开我的个人空间"
      title="我的"
      onClick={() => pathname === '/me'
        ? window.scrollTo({ top: 0, behavior: 'smooth' })
        : router.push('/me')}
    >
      <svg className="v4-avatar-icon" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="10.25"/>
        <circle cx="12" cy="9" r="3.1" />
        <path d="M5.8 19.2c.8-2.9 3-4.5 6.2-4.5s5.4 1.6 6.2 4.5" />
      </svg>
    </GlassButton>
  );
}
