# 豆瓣海报自动同步（无需本地电脑）

LibreTV 的豆瓣周榜由服务端通过 60s API 获取。海报索引现由 GitHub Actions 定时同步公开榜单中的图片 URL，不再依赖本地 OpenCLI、Chrome 或豆瓣登录会话。

## 工作方式

1. GitHub Actions 每天 UTC 02:30 自动运行，也可以在仓库 Actions 页面手动运行。
2. 从 60s API 获取五类豆瓣周榜，每类最多读取前 12 条。
3. 优先使用豆瓣原始海报地址；原图地址不可用时，尝试 60s 提供的豆瓣图片镜像。
4. 只接受 HTTPS 且域名属于豆瓣图片 CDN 或明确配置的镜像域名。
5. 将结果合并写入 `src/data/douban-posters.json`，不会因单次接口失败清空旧索引。
6. 如索引发生变化，自动提交到 main 分支。若 Cloudflare Pages 已连接该 GitHub 仓库并启用 Git 自动部署，提交会触发后续构建；否则需在 Cloudflare 手动触发一次部署。

## 手动运行

在 GitHub 仓库打开 **Actions → Sync Douban poster index → Run workflow**。

## 重要限制

- 这是公开榜单海报同步，不会访问你设备上的 Chrome，也不会使用豆瓣账号 Cookie。
- 豆瓣或 60s API 可能限流、调整字段或不可用；同步失败时保留已有索引，首页继续回退原始榜单海报。
- 只同步榜单中返回的海报地址，不保证所有条目都有 4K 或高分辨率图片。
- 不要把账号密码、Cookie 或浏览器配置文件提交到仓库。
