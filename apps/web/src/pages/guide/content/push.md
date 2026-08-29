这一章覆盖导览的第二、三、四步:接好推送适配器 → 指定目标 → 测试打通。还没想好走哪条路?先看[总览的选型表](/about/guide)。

## 路线 A:QQ 官方机器人(qq-official)

走腾讯官方 Bot 接口,不碰你的 QQ 账号、零风控风险、零额外部署。代价是能力受官方限制,且**按 bot 等级分层**:扫码一键建的轻量 bot 目前可推创建者私聊与创建者当群主的群;过审 bot、企业主体逐级放宽 —— 以官方最新政策为准。

### A1 · 最快路径:扫码一键创建

1. 打开[推送目标](/targets)页 → 添加适配器 → 平台选「QQ 官方机器人」。
2. 点表单里的「**扫码一键创建**」(实验性),用手机 QQ 扫码,在腾讯页面里确认创建。页面上出现 OpenClaw / 小龙虾字样属正常 —— 这是腾讯给轻量 bot 开的通道。
3. 创建成功后 appId / appSecret 自动回填进表单,**点「保存」**落盘(不保存不生效)。
4. 保存后在适配器上点「测试」,通过则导览「适配器」一步变绿。

> ⚠️ 轻量 bot 的边界:无审核环节,能力目前限创建者私聊与创建者当群主的群(以官方政策为准);每个 QQ 号最多创建 5 个;凭据丢了重新扫码可找回(可重选已建的 bot 重发密钥)。要更宽的能力走 A2 正式注册或路线 B。

### A2 · 正式路径:开放平台注册

1. 在 `q.qq.com` 注册开放平台账号并创建机器人(名称 / 简介 / 头像,需过审)。
2. 「开发 → 开发设置」里拿 `AppID` 与 `AppSecret`,填进 BN 的适配器表单。
3. 同一页配置 **IP 白名单**:填你服务器的公网出口 IP(服务器上执行 `curl ifconfig.me` 可得)。
4. 测试期先在平台配置**沙箱**(指定 ≤20 人的群 / 私聊作为测试环境),BN 表单里勾选 sandbox 与之对应;转正式后记得把 sandbox 关回去。

> 🚫 IP 白名单是最常见的静默死法:家庭宽带的动态 IP 一变,发消息就开始报权限错误 —— 官方路线请部署在有固定公网 IP 的服务器上,或每次 IP 变动后去平台更新白名单。

### A3 · 建目标与官方路线的坑

1. 适配器测试通过后,添加推送目标:群聊填 `groupOpenid`、私聊填 `userOpenid`。
2. 这两个 openid **不是群号 / QQ 号,没法手填** —— 先在 QQ 里给机器人发一句话(群里 @ 它,或私聊它),BN 收到入站事件后会在目标表单里给出可选的会话。
3. 在目标上点「测试」,QQ 里收到消息即通道打通。

其他已知行为:网关每约 30 分钟主动要求重连一次,日志里的 RECONNECT 属正常协议行为;图片消息需要图片可通过公网 URL 访问,BN 会自动处理渲染图的中转,但 markdown 排版能力受 bot 类型(公域 / 私域)权限限制,轻量 bot 无私域特权。

## 路线 B:OneBot 协议端(NapCat)

协议端用一个真实 QQ 号收发消息,群聊 / 私聊 / 图片全都自由。代价:多跑一个容器,且**协议端登号有风控与封号风险**。

> 🚫 强烈建议用小号 —— 协议端本质是模拟客户端登录,存在封号可能,别拿主号冒险。

### B1 · 部署 NapCat(Docker)

与 BN 同一台服务器上,docker compose 起一个 NapCat:

```yaml
services:
  napcat:
    image: mlikiowa/napcat-docker:latest
    container_name: napcat
    restart: unless-stopped
    environment:
      - NAPCAT_UID=1000
      - NAPCAT_GID=1000
    ports:
      - "6099:6099"   # WebUI
    volumes:
      - ./napcat/config:/app/napcat/config
      - ./napcat/qq:/app/.config/QQ
```

1. 启动后浏览器打开 `http://服务器IP:6099/webui`,首次登录 token 看容器日志(`docker logs napcat`)。
2. 在 WebUI 里用小号扫码登录 QQ。
3. 镜像与参数以 [NapCat 官方文档](https://github.com/NapNeko/NapCatQQ) 为准(协议端更新较快,以上模板写作时有效)。

> ⚠️ 千万别把 NapCat 的端口(WebUI 或 WS)裸暴露到公网 —— 它拿着你的 QQ 登录态。只在内网 / Docker 网络内互通,必要时配 accessToken。

### B2 · 连接 BN(推荐反向 WS)

BN 的 onebot 适配器支持三种连接方式,**推荐反向 WS**(BN 开端口等 NapCat 连进来,NapCat 重启自动重连,最省心):

1. BN 侧:添加适配器 → 平台选 OneBot → 连接方式选「反向 WS」→ 填一个监听端口(如 `6199`),保存。
2. NapCat 侧:WebUI → 网络配置 → 新建「Websocket 客户端」,URL 填 `ws://BN所在主机:6199/`,消息格式选 **Array**,启用。
3. 两边都是 Docker 且在同一台机器?把两个容器接进同一个 docker 网络,URL 写 `ws://容器名:端口/` 直连,不用绕宿主机 IP。
4. 回 BN 在适配器上点「测试」,通过则第三步变绿。

另外两种方式:「正向 WS」= BN 主动连 NapCat 开的 WS 服务(URL 形如 `ws://napcat:3001`);「HTTP」= BN POST 到 NapCat 的 HTTP 服务(需要 NapCat 同时开 HTTP 服务端与上报)。配置了 accessToken 的话,两端必须一致。

### B3 · 建目标与协议端的坑

1. 添加推送目标:群聊填群号(`groupId`),私聊填 QQ 号(`userId`) —— 协议端路线可以直接手填。
2. 在目标上点「测试」,QQ 里收到消息即通道打通。

已知行为:**带图消息发送慢是正常的** —— 协议端要先把图上传到 QQ 图床,实测经常超过 15 秒,BN 已为带图消息单独放宽超时,不用改配置;若测试报「疑似 NapCat 未连接」,先去 WebUI 看登录态与网络配置是否还在线。

## 路线 C:Webhook(不用 QQ)

添加 webhook 适配器,填目标 URL 即可 —— 支持钉钉 / 飞书 / 企业微信的群机器人格式与通用 JSON(BN 原生 envelope,自己的服务随便接)。带 secret 的平台把签名密钥填上;同样点「测试」验证。

## 通道验收

回到[推送目标](/targets)页,在目标行点「测试」—— QQ(或 webhook 端)收到测试消息,通道就全线打通了。最后一步:去[订阅](/about/guide/subs)想关注的 UP(记得勾上刚建好的推送目标),订阅上即毕业 🎉
