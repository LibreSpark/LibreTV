#!/bin/bash

# LibreTV 启动脚本
# 使用方法: ./start.sh

cd "$(dirname "$0")"

# 配置
export PASSWORD="laona"
export PORT=3000

# 预置点播源（精选高可用）
export DEFAULT_SOURCES='[{"name":"红牛资源","url":"https://www.hongniuzy2.com/api.php/provide/vod"},{"name":"荔枝API","url":"https://cj.lziapi.com/api.php/provide/vod"}]'

# 预置直播源（精选高可用）
export DEFAULT_LIVE_SOURCES='[{"name":"YanG直播合集(123频道)","url":"https://raw.githubusercontent.com/YanG-1989/m3u/main/Gather.m3u"},{"name":"YueChan IPTV(96频道)","url":"https://raw.githubusercontent.com/YueChan/Live/main/IPTV.m3u"}]'

# 首页推荐数据源
export DEFAULT_RECOMMEND_SOURCE=douban

echo "================================"
echo "  LibreTV 正在启动..."
echo "  访问地址: http://localhost:3000"
echo "  登录密码: laona"
echo "================================"

# 清除缓存并启动
rm -rf .next

npm run dev
