# LibreTV 智能采集引擎

独立的 Scrapling + PostgreSQL 采集服务；与 LibreTV 现有 `/resource-studio` 管理页和正式资源搜索链路连接。它面向可持续扩展的任务队列，不是“同时请求一千个网站”的开关。

## 实现范围

1. **安全出站**：任务目标必须是公开 HTTP(S)；DNS 固定代理拒绝私网、回环、链路本地和混合危险解析；重定向重新校验。Worker 没有直连公网路由。
2. **发现与规则**：robots.txt、同源 BFS、页数/深度限制；AI 仅能提出有界发现参数和 CSS/XPath 规则。规则版本化、先测试、默认不启用，人工审核后才能激活；连续失败自动停用。
3. **持久任务运行时**：一次批次最多 1,000 个独立工作流；幂等提交、PostgreSQL 事务、事件日志、状态快照、租约与 fencing token、指数退避、人工重试。全局活动任务设 20,000 上限。
4. **媒体质量**：HLS/DASH 清单只作为声明；MP4/WebM 由无网络探测容器抽帧并解码最多 8 秒。不会据此宣称“原生 4K”。检测到 HLS/DASH 加密或保护标记时禁止预览和发布。
5. **候选审批**：必须先有质量报告，再由当前 PlayerShell 实际解码并推进时间轴，最后由已验证的管理员身份人工批准。批准与写入正式资源库在同一数据库事务中；拒绝不发布。
6. **管理界面**：`/resource-studio` 可创建批次、查看全部任务汇总、分页任务、回放事件、重试失败任务、预览审核候选，以及人工启停规则。正式资源搜索同时查询旧 Collector 和新资源库。

不会绕过 DRM、登录、付费墙、验证码或其他访问控制。当前播放器仅接受 HLS、MP4、WebM；DASH 可分析清单，但不能通过播放器验收，因此不会发布。

## 安全并发与资源上限

批次只是排队，不代表同时出站。Docker 默认运行 1 个 workflow worker；按主机容量谨慎扩容，例：

```bash
docker compose --profile crawler up -d --build
docker compose --profile crawler up -d --scale scrapling-workflow-worker=4
```

同一代理内同站点请求默认串行、至少间隔 1.5 秒；robots.txt 的 crawl-delay/request-rate 另行遵守。连续 429、5xx 或连接失败会触发站点熔断。每个媒体候选最多预留 64 MiB，每批媒体探测预算默认 1 GiB，按数据库原子预留；超出预算的候选会被跳过。探测容器无网络、只读挂载输入并单独写报告。Compose 为 PostgreSQL、API、worker、代理、探测容器分别设置 CPU、内存、PID 和文件系统限制。

## 部署

引擎位于根目录 Compose 的可选 `crawler` profile，默认 LibreTV 启动不会启动它。根 `.env` 至少应提供独立强随机值：

```dotenv
SCRAPLING_API_KEY=至少32字符的随机服务密钥
SCRAPLING_DB_PASSWORD=另一条独立的强随机数据库密码
```

随后启动：

```bash
docker compose --profile crawler up -d --build
```

LibreTV 经内部网络访问 `http://scrapling-engine:8787`；引擎和数据库端口不发布到宿主机。Next.js 服务持有引擎 API 密钥并作为唯一管理代理。若用 Cloudflare Access 作为审核身份源，还需设置 `CF_ACCESS_TEAM_DOMAIN` 和 `CF_ACCESS_AUD`；服务端会校验 JWT 签名、issuer、audience、期限并从 `sub` 生成审核人身份。未配置 Access 时使用 LibreTV 已签名的管理员会话。审核请求体不接受客户端自报 `reviewer_id`。

AI 规则生成是可选项；配置 `SUPERVISOR_API_BASE`、`SUPERVISOR_API_KEY`、`SUPERVISOR_MODEL` 后，模型请求也只能经验证出口代理。任何凭据都只放在本地 `.env` 或密钥管理器，不要提交到仓库。

## 主要 API

所有 `/v1/*` 路由需 `X-API-Key`，正式部署仅内部网络可达。

| 路由 | 用途 |
| --- | --- |
| `POST /v1/batches` | 以 `Idempotency-Key` 提交 1–1,000 个网址，原子创建工作流 |
| `GET /v1/batches/summary` | 全部批次的任务、成功/失败、重试、候选和媒体预算汇总 |
| `GET /v1/batches`、`GET /v1/batches/{id}` | 批次列表与任务分页 |
| `GET /v1/batches/{id}/events`、`POST /v1/batches/{id}/retry` | 批次事件回放与失败项人工重试 |
| `GET /v1/candidates` | 待审核候选及证据 |
| `POST /v1/candidates/{id}/playback` | 记录服务端注入的已验证管理员身份及真实播放器证据 |
| `POST /v1/candidates/{id}/review` | 人工批准/拒绝；批准事务性发布至正式资源库 |
| `GET /v1/rules`、`POST /v1/rules/{id}/activate|disable` | 查看规则并人工启停 |
| `GET /v1/workflows/{id}/events`、`GET /v1/workflows/{id}/snapshots` | 工作流事件与可恢复状态快照 |

当前 UI 每页展示 25 个任务、每次读取 100 条事件；可逐页查看，不影响服务端对整批/全库的统计。

## 本地验证

Python 3.12+：

```bash
cd scrapling-engine
python -m venv .venv
. .venv/bin/activate
pip install -e ".[dev]"
ruff check .
ruff format --check app tests
pytest -q
```

PostgreSQL 集成测试需设置 `DATABASE_URL`；不配置时会跳过。根目录网站验证：

```bash
npm ci
npm run typecheck
npm run lint
npm test
```

GitHub Actions 对引擎、PostgreSQL 集成、隔离容器验收和网站 API/UI 分别运行检查。公网 Smoke test 只访问公开的 `example.com`，不会访问私人站点。

## 重要限制

- Worker 自动采集只能在同一网站来源内继续发现页面；不跨站扩张到任意域名。
- HLS/DASH 的码率、分辨率和 HDR 是清单声明，不等于真实画质；抽帧探测也不是全片损坏扫描或视觉质量评估。
- 人工批准仅发布当前播放器能实际验收且未检测到加密/DRM保护的来源。
- 公网采集与任意站点兼容性仍需在部署方授权范围内验证；CI 容器通过不代表任意目标网站都能抓取。


## 真实 AI 网关验收（显式授权、单页探测）

CI 的 MockTransport 测试不代表真实模型已接通。要做一次真实网关验收，必须先取得目标站点授权，并在运行环境设置：

```dotenv
SUPERVISOR_API_BASE=https://你的兼容接口/v1
SUPERVISOR_API_KEY=由密钥管理器注入
SUPERVISOR_MODEL=实际模型名
SCRAPLING_EGRESS_PROXY=http://scrapling-egress-proxy:8080
LIVE_ACCEPTANCE_PAGE_URL=https://已授权站点.example/catalog
LIVE_ACCEPTANCE_ALLOWED_HOSTS=已授权站点.example
LIVE_ACCEPTANCE_GOAL=提取公开目录中的影片标题
```

从 `scrapling-engine` 目录执行：

```bash
python -m scripts.verify_live_supervisor
```

该探针只抓取 allowlist 中的一个页面，并发起一次模型 completion；遵守 robots.txt、使用受控出口代理、拒绝跨主机重定向。它只验证真实网关返回的 CSS/XPath 规则能否在同一页面命中，不保存或激活规则，也不注册候选资源。没有明确授权域名和网关凭据时不会运行真实探测。


## 授权公网规模验收（最多 1,000 个明确列出的 URL）

真实公网规模验收不能由队列压力测试替代。运行前，必须获得目标站点授权，并将每个允许测试的页面 URL 写入 UTF-8 文件（每行一个 URL）；通过精确主机 allowlist 限制目标：

```bash
python -m scripts.verify_live_authorized_scale \
  --input ./authorized-urls.txt \
  --allowed-hosts example.org,www.example.org \
  --max-urls 1000
```

该探针只请求文件中明确列出的 URL，不跟随页面链接扩张；遵守 robots.txt，按域名单并发、至少 1 秒间隔，并使用采集器已配置的安全出口代理。目标主机不在 allowlist、URL 不安全或超过数量上限时立即拒绝。输出包含提交数、成功数、失败/缺失数和 Spider 统计。只有实际运行并保存报告后，才能声称完成了真实公网规模验收。测试必须遵守站点授权方另行规定的更严格频率限制；当前探针默认不支持提高请求频率。


## 端到端真实验收

真实 AI 网关、授权公网采集和持续 4K 浏览器播放的手动验收入口、所需 GitHub Actions Secrets/Variables 与证据等级，见 [`docs/authorized-live-acceptance.md`](../docs/authorized-live-acceptance.md)。这些测试只在显式手动触发并提供授权目标后执行；普通 CI 不会访问用户未授权的目标。
