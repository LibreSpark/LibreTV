import { AsyncLocalStorage } from 'node:async_hooks';
import dns from 'node:dns/promises';
import net from 'node:net';

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

let connectionProtectionInstalled = false;

/**
 * 安装底层的 TCP 连接级 SSRF 与 DNS Rebinding 防护。
 *
 * 背景（#941）：
 * checkUpstreamAllowed 通过 dns.lookup 预检 IP，但随后的 fetch 会执行独立的连接时 DNS 解析。
 * 攻击者可通过 DNS Rebinding 让预检返回公网 IP、实际连接返回内网 IP，导致 SSRF。
 *
 * 本函数通过拦截 net.Socket.prototype.connect，在建立实际连接的瞬间挂载安全 lookup：
 * 只要最终解析出的任何 IP 属于私有/保留网络（且未显式开启 allowPrivate），
 * 立即在握手前抛出 ERR_SSRF_BLOCKED 中断连接，从底层杜绝 TOCTOU 绕过。
 */
export function installConnectionSSRFProtection(): void {
  if (connectionProtectionInstalled) return;
  connectionProtectionInstalled = true;

  const originalConnect = net.Socket.prototype.connect;
  type ConnectFn = (this: net.Socket, ...a: unknown[]) => net.Socket;
  const rawConnect = originalConnect as unknown as ConnectFn;

  net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
    const ctx = ssrfStorage.getStore();
    if (!ctx || !ctx.active) {
      return rawConnect.apply(this, args);
    }

    let opts: Record<string, unknown> | null = null;
    if (Array.isArray(args[0]) && args[0][0] && typeof args[0][0] === 'object') {
      opts = args[0][0] as Record<string, unknown>;
    } else if (args[0] && typeof args[0] === 'object') {
      opts = args[0] as Record<string, unknown>;
    }

    if (opts) {
      const host = typeof opts.host === 'string' ? stripBrackets(opts.host) : '';

      // 1. 若目标是字面量 IP
      if (host && (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':'))) {
        if (!ctx.allowPrivate && isPrivateIP(host)) {
          const blockErr = Object.assign(new Error(`目标地址属于私有/保留网络 (${host})`), {
            code: 'ERR_SSRF_BLOCKED',
          });
          process.nextTick(() => this.destroy(blockErr));
          return this;
        }
      }

      // 2. 若目标为域名，挂载连接时实时 lookup 校验
      type LookupCallback = (
        err: Error | null,
        address?: string | Array<{ address: string; family: number }>,
        family?: number
      ) => void;
      type LookupFn = (hostname: string, options: unknown, cb: LookupCallback) => void;

      const prevLookup = (typeof opts.lookup === 'function' ? opts.lookup : dns.lookup) as LookupFn;
      opts.lookup = ((
        hostname: string,
        lookupOpts: unknown,
        cb: LookupCallback
      ) => {
        const cleanHost = stripBrackets(hostname);
        if (!ctx.allowPrivate && BLOCKED_HOSTNAMES.has(cleanHost.toLowerCase())) {
          const blockErr = Object.assign(new Error(`目标主机名在黑名单中 (${hostname})`), {
            code: 'ERR_SSRF_BLOCKED',
          });
          return cb(blockErr);
        }

        prevLookup(cleanHost, { all: true }, (err: Error | null, addresses) => {
          if (err) return cb(err);
          const list = Array.isArray(addresses) ? addresses : [];
          if (list.length === 0) {
            return cb(new Error(`未找到主机地址: ${hostname}`));
          }
          if (!ctx.allowPrivate) {
            for (const item of list) {
              if (isPrivateIP(item.address)) {
                const blockErr = Object.assign(new Error(`目标地址解析到私有/保留网络 (${item.address})`), {
                  code: 'ERR_SSRF_BLOCKED',
                });
                return cb(blockErr);
              }
            }
          }
          const isAll = lookupOpts && typeof lookupOpts === 'object' && (lookupOpts as { all?: boolean }).all;
          if (isAll) {
            cb(null, list);
          } else {
            cb(null, list[0].address, list[0].family);
          }
        });
      }) as unknown;
    }

    return rawConnect.apply(this, args);
  };
}

// 模块加载时自动激活连接层防护
installConnectionSSRFProtection();

/**
 * 在受连接级 SSRF / DNS Rebinding 防护的作用域中执行异步请求
 */
export function runWithSSRFProtection<T>(
  options: { allowPrivate?: boolean } = {},
  fn: () => Promise<T>
): Promise<T> {
  return ssrfStorage.run({ active: true, allowPrivate: options.allowPrivate }, fn);
}
