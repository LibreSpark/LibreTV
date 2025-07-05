# LibreTV - 免费在线视频搜索与观看平台

<div align="center">
  <img src="image/logo.png" alt="LibreTV Logo" width="120">
  <br>
  <p><strong>自由观影，畅享精彩</strong></p>
</div>

## 📺 项目简介

LibreTV 是一个轻量级、免费的在线视频搜索与观看平台，提供来自多个视频源的内容搜索与播放服务。无需注册，即开即用，支持多种设备访问。项目结合了前端技术和后端代理功能，可部署在支持服务端功能的各类网站托管服务上。**项目门户**： [libretv.is-an.org](https://libretv.is-an.org)

本项目基于 [bestK/tv](https://github.com/bestK/tv) 进行重构与增强。

<details>
  <summary>点击查看项目截图</summary>
  <img src="https://github.com/user-attachments/assets/df485345-e83b-4564-adf7-0680be92d3c7" alt="项目截图" style="max-width:600px">
</details>

## 🥇 感谢赞助

- **[YXVM](https://yxvm.com)**  
- **[ZMTO/VTEXS](https://zmto.com)**

## 🚀 快速部署

选择以下任一平台，点击一键部署按钮，即可快速创建自己的 LibreTV 实例：

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FLibreSpark%2FLibreTV)  
[![Deploy to Netlify](https://www.netlify.com/img/deploy/button.svg)](https://app.netlify.com/start/deploy?repository=https://github.com/LibreSpark/LibreTV)  
[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/LibreSpark/LibreTV)
[![使用 EdgeOne Pages 部署](https://cdnstatic.tencentcs.com/edgeone/pages/deploy.svg)](https://edgeone.ai/pages/new?repository-url=https://github.com/LibreSpark/LibreTV)

## ⚠️ 安全与隐私提醒

### 🔒 强烈建议设置密码保护

为了您的安全和避免潜在的法律风险，我们**强烈建议**在部署时设置密码保护：

- **避免公开访问**：不设置密码的实例任何人都可以访问，可能被恶意利用
- **防范版权风险**：公开的视频搜索服务可能面临版权方的投诉举报
- **保护个人隐私**：设置密码可以限制访问范围，保护您的使用记录

### 📝 部署建议

1. **设置环境变量 `PASSWORD`**：为您的实例设置一个强密码
2. **仅供个人使用**：请勿将您的实例链接公开分享或传播
3. **遵守当地法律**：请确保您的使用行为符合当地法律法规

### 🚨 重要声明

- 本项目仅供学习和个人使用
- 请勿将部署的实例用于商业用途或公开服务
- 如因公开分享导致的任何法律问题，用户需自行承担责任
- 项目开发者不对用户的使用行为承担任何法律责任

## ⚠️ 请勿使用 Pull Bot 自动同步

Pull Bot 会反复触发无效的 PR 和垃圾邮件，严重干扰项目维护。作者可能会直接拉黑所有 Pull Bot 自动发起的同步请求的仓库所有者。

**推荐做法：**

建议在 fork 的仓库中启用本仓库自带的 GitHub Actions 自动同步功能（见 `.github/workflows/sync.yml`）。 

如需手动同步主仓库更新，也可以使用 GitHub 官方的 [Sync fork](https://docs.github.com/cn/github/collaborating-with-issues-and-pull-requests/syncing-a-fork) 功能。


## 📋 详细部署指南

### Cloudflare Pages

1. Fork 或克隆本仓库到您的 GitHub 账户
2. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/)，进入 Pages 服务
3. 点击"创建项目"，连接您的 GitHub 仓库
4. 使用以下设置：
   - 构建命令：留空（无需构建）
   - 输出目录：留空（默认为根目录）
5. **⚠️ 重要：在"设置" > "环境变量"中添加 `PASSWORD` 变量**
6. **可选：在"Settings" > "Environment Variables"中添加 `ADMINPASSWORD` 变量**
7. 点击"保存并部署"

### Vercel

1. Fork 或克隆本仓库到您的 GitHub/GitLab 账户
2. 登录 [Vercel](https://vercel.com/)，点击"New Project"
3. 导入您的仓库，使用默认设置
4. **⚠️ 重要：在"Settings" > "Environment Variables"中添加 `PASSWORD` 变量**
5. **可选：在"Settings" > "Environment Variables"中添加 `ADMINPASSWORD` 变量**
6. 点击"Deploy"
7. 可选：在"Settings" > "Environment Variables"中配置密码保护和设置按钮密码保护

### Render

1. Fork 或克隆本仓库到您的 GitHub 账户
2. 登录 [Render](https://render.com/)，点击 "New Web Service"
3. 选择您的仓库，Render 会自动检测到 `render.yaml` 配置文件
4. 保持默认设置（无需设置环境变量，默认不启用密码保护）
5. 点击 "Create Web Service"，等待部署完成
6. 部署成功后即可访问您的 LibreTV 实例

> 如需启用密码保护，可在 Render 控制台的环境变量中手动添加 `PASSWORD` 和/或 `ADMINPASSWORD`。

### Docker
```
docker run -d \
  --name libretv \
  --restart unless-stopped \
  -p 8899:8080 \
  -e PASSWORD=your_password \
  -e ADMINPASSWORD=your_adminpassword \
  bestzwei/libretv:latest
```

### Docker Compose

`docker-compose.yml` 文件：

```yaml
services:
  libretv:
    image: bestzwei/libretv:latest
    container_name: libretv
    ports:
      - "8899:8080" # 将内部 8080 端口映射到主机的 8899 端口
    environment:
      - PASSWORD=${PASSWORD:-your_password} # 可将 your_password 修改为你想要的密码，默认为 your_password
      - ADMINPASSWORD=${PASSWORD:-your_adminpassword} # 可将 your_adminpassword 修改为你想要的密码，默认为 your_adminpassword
    restart: unless-stopped
```
启动 LibreTV：

```bash
docker compose up -d
```
访问 `http://localhost:8899` 即可使用。

### 本地开发环境

项目包含后端代理功能，需要支持服务器端功能的环境：

```bash
# 首先，通过复制示例来设置 .env 文件（可选）
cp .env.example .env

# 安装依赖
npm install

# 启动开发服务器
npm run dev
```

访问 `http://localhost:8080` 即可使用（端口可在.env文件中通过PORT变量修改）。

> ⚠️ 注意：使用简单静态服务器（如 `python -m http.server` 或 `npx http-server`）时，视频代理功能将不可用，视频无法正常播放。完整功能测试请使用 Node.js 开发服务器。

## 🔧 自定义配置

### 密码保护

要为您的 LibreTV 实例添加密码保护，可以在部署平台上设置环境变量：

**环境变量名**: `PASSWORD` 
**值**: 您想设置的密码

**环境变量名**: `ADMINPASSWORD` 
**值**: 您想设置的密码

各平台设置方法：

- **Cloudflare Pages**: Dashboard > 您的项目 > 设置 > 环境变量
- **Vercel**: Dashboard > 您的项目 > Settings > Environment Variables
- **Netlify**: Dashboard > 您的项目 > Site settings > Build & deploy > Environment
- **Docker**: 修改 `docker run` 中 `your_password` 为你的密码
- **Docker Compose**: 修改 `docker-compose.yml` 中的 `your_password` 为你的密码
- **本地开发**: SET PASSWORD=your_password

### API兼容性

LibreTV 支持标准的苹果 CMS V10 API 格式。添加自定义 API 时需遵循以下格式：
- 搜索接口: `https://example.com/api.php/provide/vod/?ac=videolist&wd=关键词`
- 详情接口: `https://example.com/api.php/provide/vod/?ac=detail&ids=视频ID`

**添加 CMS 源**:
1. 在设置面板中选择"自定义接口"
2. 接口地址: `https://example.com/api.php/provide/vod`

## ⌨️ 键盘快捷键

播放器支持以下键盘快捷键：

- **空格键**: 播放/暂停
- **左右箭头**: 快退/快进
- **上下箭头**: 音量增加/减小
- **M 键**: 静音/取消静音
- **F 键**: 全屏/退出全屏
- **Esc 键**: 退出全屏

## 🛠️ 技术栈

- HTML5 + CSS3 + JavaScript (ES6+)
- Tailwind CSS
- HLS.js 用于 HLS 流处理
- DPlayer 视频播放器核心
- Cloudflare/Vercel/Netlify Serverless Functions
- 服务端 HLS 代理和处理技术
- localStorage 本地存储

## ⚠️ 免责声明

LibreTV 仅作为视频搜索工具，不存储、上传或分发任何视频内容。所有视频均来自第三方 API 接口提供的搜索结果。如有侵权内容，请联系相应的内容提供方。

本项目开发者不对使用本项目产生的任何后果负责。使用本项目时，您必须遵守当地的法律法规。

## 🎉 贡献者福利

活跃贡献者可以在 [Issue #268](https://github.com/LibreSpark/LibreTV/issues/268) 中留言，申请免费上车 1Password Team，享受团队协作工具的便利！

## 💝 支持项目

如果您想支持本项目，可以考虑进行捐款：

[![捐赠](https://img.shields.io/badge/爱心捐赠-无国界医生-1a85ff?style=for-the-badge&logo=medical-cross)](https://www.msf.hk/zh-hant/donate/general?type=one-off)
