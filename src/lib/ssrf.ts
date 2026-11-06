import { AsyncLocalStorage } from 'node:async_hooks';
import type { LookupAddress } from 'node:dns';
import { lookup as callbackLookup } from 'node:dns';
import dns from 'node:dns/promises';
import { Agent, buildConnector } from 'undici';

/** 去掉 URL.hostname 对 IPv6 附加的方括号（"[::1]" → "::1"） */
function stripBrackets(host: string): string {
  return host.trim().replace(/^\[+|\]+$/g, '');
}

/**
 * IPv4-mapped / IPv4-compatible IPv6 还原为点分十进制，命中不到时返回 null。
 * "::ffff:192.168.1.100" 与 "::ffff:c0a8:164" 都会归一化成 "192.168.1.100"，
 * 否则这类地址会绕过下面的私网规则被当成公网放行。
 */
function toIPv4(ip: string): string | null {
  const v = ip.replace(/^0:0:0:0:0:/i, '::'); // 全写形式
  const dotted = /^::(?:ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(v);
  if (dotted) return dotted[1];
  const hex = /^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(v);
  if (!hex) return null;
  const n = (((parseInt(hex[1], 16) << 16) | parseInt(hex[2], 16)) >>> 0);
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

/** 判断 IP 是否为私有/回环/链路本地/保留地址（SSRF 防护） */
export function isPrivateIP(ip: string): boolean {
  let v = stripBrackets(ip.trim());
  v = toIPv4(v) ?? v;
  if (/^(127\.|0\.0\.0\.0$|::1$|::$|fe80:|fc|fd)/i.test(v)) return true;
  if (v.startsWith('10.')) return true;
  if (v.startsWith('192.168.')) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(v)) return true;
  if (v.startsWith('169.254.')) return true; // 链路本地（含云元数据 169.254.169.254）
  if (v.startsWith('100.64.')) return true; // CGNAT
  if (v.startsWith('192.0.0.')) return true; // 协议分配块
  return false;
}

const BLOCKED_HOSTNAMES = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1']);

/** URL 字面量校验：协议白名单 + 主机名/字面量 IP 黑名单 */
export function isValidProxyUrl(urlString: string): boolean {
  try {
    const parsed = new URL(urlString);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    const host = stripBrackets(parsed.hostname); // "[::1]" 也要能被黑名单命中
    if (BLOCKED_HOSTNAMES.has(host)) return false;
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')) {
      if (isPrivateIP(host)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** DNS 解析后校验目标主机名是否解析到内网/保留地址 */
export async function isBlockedByDNS(urlString: string): Promise<boolean> {
  try {
    const hostname = stripBrackets(new URL(urlString).hostname);
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.includes(':')) {
      return isPrivateIP(hostname);
    }
    const result = await dns.lookup(hostname, { all: true });
    return result.some((r) => isPrivateIP(r.address));
  } catch {
    return false; // 解析失败不阻断，交给后续请求处理
  }
}

export type UpstreamVerdict = { ok: true } | { ok: false; reason: string };

/**
 * 出网请求的统一校验入口：字面量校验 + DNS 解析校验。
 *
 * 任何由用户输入驱动的服务端请求（采集站搜索/详情、代理转发）都必须先过这一关，
 * 否则服务器会变成内网探测跳板（/api/search 曾直接用用户传的 source.url 发请求）。
 */
export async function checkUpstreamAllowed(urlString: string): Promise<UpstreamVerdict> {
  if (!isValidProxyUrl(urlString)) {
    return { ok: false, reason: '目标地址不在允许范围内（仅支持公网 http/https）' };
  }
  if (await isBlockedByDNS(urlString)) {
    return { ok: false, reason: '目标地址解析到私有/保留网络' };
  }
  return { ok: true };
}

/** 直播场景是否放行内网地址（自建 IPTV）；由部署者显式开启 */
export function allowLivePrivate(): boolean {
  return process.env.LIVE_ALLOW_PRIVATE === '1';
}

/**
 * 直播地址专用校验：协议必须 http(s)，默认仍拒绝内网，但部署者可用
 * LIVE_ALLOW_PRIVATE=1 显式放行（自建 IPTV 常位于内网）。
 *
 * 与点播侧 checkUpstreamAllowed 的区别只在这一处开关：
 * 订阅/播放列表若沿用点播那把尺子，会静默过滤掉内网自建源。
 */
export async function checkLiveUrlAllowed(urlString: string): Promise<UpstreamVerdict> {
  try {
    const parsed = new URL(urlString);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { ok: false, reason: '直播地址仅支持 http/https 协议' };
    }
  } catch {
    return { ok: false, reason: '无效的直播地址' };
  }
  if (allowLivePrivate()) return { ok: true };
  return checkUpstreamAllowed(urlString);
}


export interface SSRFProtectionContext {
  active: boolean;
  allowPrivate?: boolean;
}

const ssrfStorage = new AsyncLocalStorage<SSRFProtectionContext>();

/**
 * 创建受连接级 SSRF / DNS Rebinding 防护的专用 undici Agent。
 *
 * 核心机制（解决 #941）：
 * 1. 独立 Dispatcher：避免复用全局或其他作用域的连接池，杜绝通过已有的 keep-alive socket 绕过连接层校验；
 * 2. 连接前检查：拦截目标为字面量私网 IP 及黑名单主机名（如 127.0.0.1、localhost）；
 * 3. 连接时 DNS 校验：通过 safeLookup（使用标准 callback 签名的 node:dns 接口）解析域名，
 *    只要解析结果包含任何私网/保留 IP，立即抛出 ERR_SSRF_BLOCKED 中断连接，杜绝 DNS Rebinding TOCTOU 绕过；
 * 4. 禁用连接保活：使用完毕即释放连接，不留复用窗口。
 */
export function createSSRFAgent(options: { allowPrivate?: boolean } = {}): Agent {
  const { allowPrivate = false } = options;

  function safeLookup(
    hostname: string,
    opts: unknown,
    cb: (err: NodeJS.ErrnoException | null, address?: string | LookupAddress[], family?: number) => void
  ): void {
    const cleanHost = stripBrackets(hostname);
    if (!allowPrivate && BLOCKED_HOSTNAMES.has(cleanHost.toLowerCase())) {
      const blockErr = Object.assign(new Error(`目标主机名在黑名单中 (${hostname})`), {
        code: 'ERR_SSRF_BLOCKED',
      });
      return cb(blockErr, '');
    }

    callbackLookup(cleanHost, { all: true }, (err, addresses) => {
      if (err) return cb(err, '');
      const list = Array.isArray(addresses) ? addresses : [];
      if (list.length === 0) {
        return cb(new Error(`未找到主机地址: ${hostname}`), '');
      }
      if (!allowPrivate) {
        for (const item of list) {
          if (isPrivateIP(item.address)) {
            const blockErr = Object.assign(new Error(`目标地址解析到私有/保留网络 (${item.address})`), {
              code: 'ERR_SSRF_BLOCKED',
            });
            return cb(blockErr, '');
          }
        }
      }

      const wantAll = opts && typeof opts === 'object' && (opts as { all?: boolean }).all;
      if (wantAll) {
        cb(null, list);
      } else {
        cb(null, list[0].address, list[0].family);
      }
    });
  }

  const baseConnector = buildConnector({
    lookup: safeLookup as unknown as (hostname: string, options: import('node:dns').LookupOptions, callback: (err: NodeJS.ErrnoException | null, address: string | import('node:dns').LookupAddress[], family?: number) => void) => void,
  });

  function ssrfConnect(opts: buildConnector.Options, cb: buildConnector.Callback) {
    const cleanHost = stripBrackets(opts.hostname || '');
    if (!allowPrivate) {
      if (BLOCKED_HOSTNAMES.has(cleanHost.toLowerCase())) {
        const blockErr = Object.assign(new Error(`目标主机名在黑名单中 (${cleanHost})`), {
          code: 'ERR_SSRF_BLOCKED',
        });
        return cb(blockErr, null);
      }
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(cleanHost) || cleanHost.includes(':')) {
        if (isPrivateIP(cleanHost)) {
          const blockErr = Object.assign(new Error(`目标地址属于私有/保留网络 (${cleanHost})`), {
            code: 'ERR_SSRF_BLOCKED',
          });
          return cb(blockErr, null);
        }
      }
    }
    return baseConnector(opts, cb);
  }

  return new Agent({
    connect: ssrfConnect,
    pipelining: 0,
    keepAliveTimeout: 1,
    keepAliveMaxTimeout: 1,
  });
}

const GLOBAL_FETCH_WRAPPED = Symbol.for('libretv.ssrf.fetch.wrapped');

/**
 * 安装安全的 fetch SSRF 防护包装器。
 * 仅在 runWithSSRFProtection 激活的作用域内生效，自动注入安全专用的 Agent，
 * 不影响外部全局网络通信，杜绝 monkey-patch net.Socket.prototype 造成的全局副作用。
 */
export function installFetchSSRFProtection(): void {
  const g = globalThis as unknown as Record<symbol, boolean>;
  if (g[GLOBAL_FETCH_WRAPPED]) return;
  g[GLOBAL_FETCH_WRAPPED] = true;

  const originalFetch = globalThis.fetch;

  globalThis.fetch = async function ssrfProtectedFetch(
    input: RequestInfo | URL,
    init?: RequestInit & { dispatcher?: unknown }
  ): Promise<Response> {
    const ctx = ssrfStorage.getStore();
    if (!ctx || !ctx.active) {
      return originalFetch(input, init);
    }

    // 在受保护作用域内，如果未提供专属 dispatcher，自动注入安全专用的 Agent
    const agent = createSSRFAgent({ allowPrivate: ctx.allowPrivate });
    try {
      const res = await originalFetch(input, {
        ...init,
        dispatcher: agent,
      } as RequestInit);
      // 收到响应后优雅计划关闭 Agent，避免连接池跨请求保留
      agent.close().catch(() => {});
      return res;
    } catch (err) {
      agent.destroy().catch(() => {});
      throw err;
    }
  };
}

// 兼容别名
export const installConnectionSSRFProtection = installFetchSSRFProtection;

// 模块加载时自动安装防护
installFetchSSRFProtection();

/**
 * 在受连接级 SSRF / DNS Rebinding 防护的作用域中执行异步请求
 */
export function runWithSSRFProtection<T>(
  options: { allowPrivate?: boolean } = {},
  fn: () => Promise<T>
): Promise<T> {
  return ssrfStorage.run({ active: true, allowPrivate: options.allowPrivate }, fn);
}
