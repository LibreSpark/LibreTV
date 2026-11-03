# 豆瓣海报同步（OpenCLI）

LibreTV 的 Cloudflare Worker 无法直接访问你电脑上的 Chrome 登录会话。本功能采用本地同步方式：本机 OpenCLI 使用已登录的 Chrome 读取豆瓣海报 URL，将公开图片地址写入 `src/data/douban-posters.json`；LibreTV 构建后优先使用该索引，未命中的条目继续使用原有海报地址。

## 1. 本机准备

要求 Node.js >= 20.18.1，并安装 OpenCLI：

```bash
node --version
npm install -g @jackwener/opencli
opencli doctor
```

安装 OpenCLI Browser Bridge Chrome 扩展，打开 Chrome 登录 `douban.com`。不要导出或复制 Cookie，也不要把浏览器配置目录提交到 Git。

官方说明：
- https://github.com/jackwener/OpenCLI
- https://github.com/jackwener/OpenCLI/blob/main/docs/adapters/browser/douban.md
- https://github.com/jackwener/OpenCLI/blob/main/docs/guide/browser-bridge.md

## 2. 同步海报

在 LibreTV 仓库根目录执行：

```bash
npm run syncDoubanPosters
```

脚本默认从五类豆瓣周榜各取前 8 个条目，最多并发 2 个 OpenCLI 请求。可以调整：

```bash
DOUBAN_POSTERS_PER_CATEGORY=12 DOUBAN_POSTERS_CONCURRENCY=2 npm run syncDoubanPosters
```

脚本会验证返回图片必须是 HTTPS 豆瓣图片 CDN 地址，只写入公开图片 URL，不会读取或上传 Chrome Cookie。遇到登录失效、豆瓣验证或无图片结果时会跳过该条目；如果全部失败，不会覆盖现有索引。

## 3. 发布

同步成功后检查 `src/data/douban-posters.json`，再提交并推送：

```bash
git add src/data/douban-posters.json
git commit -m "chore: sync Douban poster URLs"
git push
```

推送后，按仓库现有 Cloudflare 部署流程发布新版本。部署完成后，首页豆瓣周榜会优先使用索引中对应电影 ID 的图片；索引没有覆盖的电影自动回退原有海报地址。

## 注意

- OpenCLI 必须在登录豆瓣的本机 Chrome 所在设备运行；GitHub Actions 和 Cloudflare Worker 不会共享该浏览器会话。
- 海报索引只包含公开图片 URL，不包含账号、密码、Cookie 或浏览器登录数据。
- 豆瓣可能调整页面结构或触发验证；如同步失败，先运行 `opencli doctor`，在 Chrome 手动打开豆瓣确认登录状态，再重试。
- 这套机制解决的是海报 URL 的获取与回退，不保证豆瓣 CDN 永久可用；图片仍可能受豆瓣访问策略影响。
