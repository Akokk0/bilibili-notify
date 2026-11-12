# 机器人框架桥接

把 **koishi 或 AstrBot 里已经配好的 bot 借给 bilibili-notify 用**。

BN 自己只认识 QQ 官方机器人、OneBot 和几种群机器人 webhook。Telegram、Discord、KOOK 这些平台，koishi、AstrBot 早就写好适配器了 —— 这个拓展不再各写一份，而是**把那些 bot 借过来当推送目标**。

借来的 bot 走的是和直连完全同一条路：推送照发，私聊指令、群里贴链接自动出卡也都照常。

## 语言与日志

清单、设置标签、连接视图、桥接侧失败说明与运行日志支持简体中文、繁体中文、英文和日文，取宿主当前语言；切语言无需重连。插件上报的 bot 名、用户自填名称和上游错误保留原文。

运行日志采用平实说明，事件标识、接入/连接/bot ID放在参数中，由宿主统一过滤和脱敏；连接生命周期由传输层记录，入口不重复记录。译文随包放在`locales/<语言码>.json`，清单译文使用`$manifest`，运行时只经`ctx.i18n`取字。

## 怎么用

1. **在这一页把开关拨开**（拓展装完默认是关着的）。
2. **建一条「接入」** —— 填个名字、挑框架种类（koishi 或 AstrBot，挑你要装插件的那一个），拿到一段 **BN 地址**和一条 **token**。
3. **去那台框架装插件**，把地址和 token 填进去：

   - koishi：插件已发 npm，`koishi-plugin-bilibili-notify-bridge`
   - AstrBot（4.14.7 起）：`astrbot_plugin_bilibili_notify_bridge`，仓库 <https://github.com/Akokk0/astrbot_plugin_bilibili_notify_bridge>，装法见它的 README

   装好之后桥会**自己连过来**，这张卡就亮了。
4. **回「推送目标」页建连接** —— 平台挑「机器人框架桥接」，再从连着的 bot 里挑一个。**挑中的那个 bot 就是这条连接**，要用几个 bot 就建几条。

## 两个最容易踩的坑

**BN 地址是按你浏览器地址栏算的。** 在 BN 那台机器上用 `localhost` 打开面板，复制出来就是 `ws://localhost:8787/ext/bridge` —— 填进另一台机器、另一个容器里的 koishi / AstrBot，必然连不上。要填**那台框架访问得到**的地址。

**接入不等于推送目标。** 卡片亮了只说明桥连上了，消息还发不出去 —— 还要回推送目标页，为每个要用的 bot 建一条连接。这一步最常被漏掉。

## 关于方向

**桥主动连 BN，BN 从不反过来连它。** 所以 BN 跑在 NAS、软路由、家宽后面都不用开端口、不用打洞 —— 要出得去的是那台 koishi / AstrBot。

token 只在新建那一刻给全文，之后只显示头尾；忘了就重新生成，旧的立刻作废。

## 能力

每个 bot 能干什么，是**桥握手时自己报的**，因为同一个平台经不同的框架连进来，拿得到的能力可能不一样。面板上用三种形状画：支持 / 不支持 / **它没报**。「没报」不是「不支持」—— 那是「值得一试」。

对面读不了 markdown 时，版式会自动剥成干净纯文本，而不是甩一屏字面星号过去。

## 写自己的桥

线上协议写在 [`PROTOCOL.md`](https://github.com/Akokk0/bilibili-notify/blob/main/extensions/bridge/PROTOCOL.md)：帧、握手、close code、能力表，以及一份最小实现清单。BN 只认识「桥」这一档，桥后面挂着什么，是握手时你告诉它的。

## 在主仓联调桥拓展

在准备好的主仓运行 `vp run dev:apps`。打开拓展页，点「挂载开发拓展」，选择 `extensions/bridge` 源码目录，保留「源码变化时自动重载」并挂载，再启用桥接。BN 直接运行源码，开发面板中会出现「假装一条桥连上来」和「桥驮一条消息上来」两个场景。联调结束后，在桥接卡片上点「解除挂载」。

---

bilibili-notify 主仓：<https://github.com/Akokk0/bilibili-notify>

🔗现状（4-55，2026-10-31）：本仓当前使用全新1.0拓展契约apiVersion1/apiRevision0；这是保留当前完整接口的新基线，不是恢复历史v1。拓展包自身version和桥WS协议号独立，不随本次契约重编号重置。
