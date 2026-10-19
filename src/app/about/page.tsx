'use client';

import { Header } from '@/components/header';
import { SiteFooter } from '@/components/site-footer';
import { useT } from '@/lib/i18n';

export default function AboutPage() {
  const t = useT();
  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main className="flex-1 max-w-2xl w-full mx-auto px-4 py-10 space-y-8">
        <section>
          <h1 className="text-xl font-bold text-content mb-3">{t('关于 LibreTV')}</h1>
          <p className="text-sm text-muted leading-relaxed">
            {t(
              'LibreTV 是一个免费的在线视频搜索与观看平台。输入片名即可在多个点播源中聚合搜索，无需注册、无内嵌广告、不存储任何视频文件。所有播放内容均来自第三方公开接口。'
            )}
          </p>
        </section>

        <section>
          <h2 className="text-base font-semibold text-content mb-2.5">{t('快捷键')}</h2>
          <ul className="text-sm text-muted space-y-1.5 list-disc list-inside">
            <li><code className="text-accent">{t('空格')}</code> {t('播放 / 暂停')}</li>
            <li><code className="text-accent">←</code> / <code className="text-accent">→</code> {t('快退 / 快进 5 秒')}</li>
            <li><code className="text-accent">↑</code> / <code className="text-accent">↓</code> {t('音量调节')}</li>
            <li><code className="text-accent">F</code> {t('切换全屏')}</li>
            <li><code className="text-accent">Alt + ←/→</code> {t('上一集 / 下一集')}</li>
            <li>{t('移动端长按视频可 3 倍速播放')}</li>
          </ul>
        </section>

        <section>
          <h2 className="text-base font-semibold text-content mb-2.5">{t('隐私与数据')}</h2>
          <p className="text-sm text-muted leading-relaxed">
            {t(
              '你的搜索历史、观看进度等数据仅保存在本设备浏览器中（IndexedDB），不会上传到服务器。聚合搜索请求由服务端代理转发，第三方数据源不会看到你的 IP 地址。'
            )}
          </p>
        </section>

        <section>
          <h2 className="text-base font-semibold text-content mb-2.5">{t('免责声明')}</h2>
          <p className="text-sm text-faint leading-relaxed">
            {t(
              '本项目不存储、不制作任何视频内容，仅提供第三方公开接口的聚合与播放能力。请尊重版权，所有内容的合法性由对应数据源负责。'
            )}
          </p>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
