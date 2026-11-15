import { resolve4, resolve6 } from 'node:dns/promises';
import { isIP } from 'node:net';

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

/** IPv4 地址转无符号整数；输入必须是标准点分十进制。 */
function ipv4ToNumber(ip: string): number {
  return ip.split('.').reduce((value, part) => ((value << 8) | Number(part)) >>> 0, 0);
}

/** 判断 IPv4 是否落在 CIDR 网段内。 */
function ipv4InCidr(ip: string, network: string, prefix: number): boolean {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipv4ToNumber(ip) & mask) === (ipv4ToNumber(network) & mask);
}

const BLOCKED_IPV4_CIDRS: Array<[string, number]> = [
  ['0.0.0.0', 8],       // 当前网络
  ['10.0.0.0', 8],      // 私有
  ['100.64.0.0', 10],   // 运营商级 NAT
  ['127.0.0.0', 8],     // 回环
  ['169.254.0.0', 16],  // 链路本地 / 云元数据
  ['172.16.0.0', 12],   // 私有
  ['192.0.0.0', 24],    // IETF 协议分配（含全球可达例外地址，按保守策略整体拒绝）
  ['192.31.196.0', 24], // AS112 特殊用途
  ['192.52.193.0', 24], // AMT 特殊用途
  ['192.175.48.0', 24], // AS112 特殊用途
  ['192.0.2.0', 24],    // 文档示例
  ['192.88.99.0', 24],  // 6to4 中继（已弃用）
  ['192.168.0.0', 16],  // 私有
  ['198.18.0.0', 15],   // 基准测试
  ['198.51.100.0', 24], // 文档示例
  ['203.0.113.0', 24],  // 文档示例
  ['224.0.0.0', 4],     // 多播
  ['240.0.0.0', 4],     // 保留 / 广播
];

/** 判断 IP 是否为私有、回环、链路本地、多播或特殊用途保留地址。 */
export function isPrivateIP(ip: string): boolean {
  let value = stripBrackets(ip.trim()).toLowerCase();
  if (!value) return true;

  // IPv4-mapped IPv6 先还原，再统一按 IPv4 CIDR 判断。
  value = toIPv4(value) ?? value;

  if (isIP(value) === 4) {
    return BLOCKED_IPV4_CIDRS.some(([network, prefix]) =>
      ipv4InCidr(value, network, prefix),
    );
  }

  if (isIP(value) !== 6) return true;

  // IPv6 仅接受全球单播空间 2000::/3；其余空间均按非公网地址拒绝。
  // 这样同时封闭未列全的 IANA 特殊用途、兼容/过渡及未来保留网段。
  const firstHextet = parseInt(value.split(':')[0] || '0', 16);
  if (!Number.isFinite(firstHextet) || firstHextet < 0x2000 || firstHextet > 0x3fff) return true;
  // 以下为全球单播空间内部仍需拒绝的特殊用途范围。
  if (value === '::' || value === '::1') return true;
  if (/^(fc|fd)/i.test(value)) return true;       // fc00::/7
  if (/^fe[89ab]/i.test(value)) return true;      // fe80::/10
  if (/^ff/i.test(value)) return true;            // ff00::/8
  if (/^2001:db8:/i.test(value)) return true;     // 2001:db8::/32 文档示例
  if (/^2001:/i.test(value)) {
    const secondHextet = parseInt(value.split(':')[1] || '0', 16);
    if (Number.isFinite(secondHextet) && secondHextet <= 0x01ff) return true; // 2001::/23 特殊用途
  }
  if (/^2002:/i.test(value)) return true;          // 2002::/16 6to4
  if (/^3fff:/i.test(value)) return true;          // 3fff::/20 文档示例
  return false;
}

const BLOCKED_HOSTNAMES = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1']);
const DNS_LOOKUP_TIMEOUT_MS = 4000;

/** URL 字面量校验：协议白名单 + 主机名/字面量 IP 黑名单 */
export function isValidProxyUrl(urlString: string): boolean {
  try {
    const parsed = new URL(urlString);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    // URL 中的 userinfo 容易造成鉴权混淆，也可能泄露凭据给重定向目标；上游地址不接受嵌入式账号密码。
    if (parsed.username || parsed.password) return false;
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
    // Cloudflare Workers 不实现 dns.lookup；resolve4/resolve6 使用 Workers DNS API。
    // ENODATA 只表示该地址族没有记录；其他解析错误一律 fail-closed。
    const resolveFamily = async (resolver: typeof resolve4 | typeof resolve6) => {
      try {
        return await resolver(hostname);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code;
        // Workers DNS resolvers may report ENOTFOUND for an address family
        // with no records. Treat it like ENODATA; other resolver failures remain fail-closed.
        if (code === 'ENODATA' || code === 'ENOTFOUND') return [];
        throw error;
      }
    };

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let resolved: [string[], string[]];
    try {
      const lookup = Promise.all([
        resolveFamily(resolve4),
        resolveFamily(resolve6),
      ]) as Promise<[string[], string[]]>;
      const timeout = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error('DNS 查询超时')),
          DNS_LOOKUP_TIMEOUT_MS,
        );
      });
      resolved = await Promise.race([lookup, timeout]);
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    }
    const [ipv4, ipv6] = resolved;
    const addresses = [...ipv4, ...ipv6];
    // 没有任何 A/AAAA 记录时无法确认目标安全，拒绝请求。
    if (addresses.length === 0) return true;
    return addresses.some((address) => isPrivateIP(address));
  } catch {
    // DNS 失败必须 fail-closed：无法证明目标是公网地址时，不发起上游请求。
    return true;
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
  let parsed: URL;
  try {
    parsed = new URL(urlString);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { ok: false, reason: '直播地址仅支持 http/https 协议' };
    }
    // 内网例外只放宽目标 IP 范围，不放宽 URL 结构与凭据校验。
    if (parsed.username || parsed.password || !parsed.hostname) {
      return { ok: false, reason: '直播地址格式不安全' };
    }
  } catch {
    return { ok: false, reason: '无效的直播地址' };
  }
  if (allowLivePrivate()) return { ok: true };
  return checkUpstreamAllowed(urlString);
}
