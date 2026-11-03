# 独立 Worker 项目

本目录用于集中管理 LibreTV 的独立 Cloudflare Worker 服务。各服务单独安装依赖、单独部署，不与 LibreTV 主站的 Next.js / OpenNext 构建混用。

## 60s API（上游原版）

`60s` 以 Git 子模块形式固定在 `workers/60s`，上游为 [vikiboss/60s](https://github.com/vikiboss/60s)，保留上游目录结构、Cloudflare Worker 入口、依赖清单和 MIT License。当前固定到上游提交：

`0b3e95e8fd8c8d961b446bbc2054c0f12c507feb`

### 首次克隆

必须递归拉取子模块：

```bash
git clone --recurse-submodules https://github.com/421581698/LibreTV.git
cd LibreTV
```

如果已经克隆主仓库：

```bash
git submodule update --init --recursive
```

### 本地部署到 Cloudflare Workers

```bash
cd workers/60s
npm install
npx wrangler deploy
```

首次部署按 Wrangler 提示登录/授权 Cloudflare。该命令部署的是独立的 `60s` Worker，不会部署或覆盖 LibreTV 主站。

### 连接 LibreTV 影视热榜

部署完成后，在 LibreTV 主站对应的 Cloudflare Worker 环境变量中设置：

- **变量名：** `60S_API_BASE`
- **变量值：** 你刚部署的 60s Worker 根地址，例如 `https://60s.<你的子域>.workers.dev`

变量值只填根地址，不要追加 `/v2`，也不要加末尾斜杠。保存后重新部署/重启 LibreTV Worker，使变量生效。

LibreTV 现有热榜代码会请求豆瓣周榜与百度热播剧榜所需的 `/v2/...` 路径。Friday AI 助手和 LibreTV 主站源代码不需要为这一步做改动。

### 更新上游

```bash
git submodule update --remote --merge workers/60s
git add .gitmodules workers/60s
git commit -m "chore: update 60s API upstream"
```

更新后应先检查上游变更和部署结果，再将新提交推送到主仓库。

> 注意：Git 子模块在 GitHub 页面上显示为指向上游仓库的固定版本引用。自动化构建环境若要使用该目录，必须显式初始化子模块；Cloudflare Dashboard 的普通 Git 构建不应假定会自动检出子模块。可按上面的本地 Wrangler 流程独立部署。
