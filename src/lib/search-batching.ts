/** Workers 原生 DNS 预检、分页和重定向都会消耗子请求配额。 */
export const WORKERS_SEARCH_BATCH_SIZE = 2;
export const MAX_SEARCH_SOURCES = 50;

/** 部署错误并非源站失败，不能据此自动停用点播源。 */
export function isSearchInfrastructureError(error?: string): boolean {
  return !!error && /Too many subrequests by single Worker invocation|ALPNProtocols|Cloudflare Workers 出网未配置/i.test(error);
}
