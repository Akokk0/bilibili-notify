---
"@bilibili-notify/push": patch
"@bilibili-notify/dynamic": patch
"@bilibili-notify/internal": patch
"@bilibili-notify/image": patch
"koishi-plugin-bilibili-notify-dynamic": patch
"koishi-plugin-bilibili-notify-advanced-subscription": patch
---

推送 / 动态过滤 / 卡片渲染三块独立改动:

- **@全体提醒拆为独立消息**(`@bilibili-notify/push`):atAllTargets 之前是把 `{type:"at-all"}` 段塞进卡片消息内部(`[image, at-all, " ", text]`),改为先发独立一条 `composite[{type:"at-all"}]` 再发原 payload,接收端看到的是「@全体 → 卡片 + 文字」两条独立消息。forward-images 合并转发场景一视同仁(@全体 是外层独立消息,与合并转发节点不冲突)。

- **动态类型过滤新增图文 / 视频开关**(`@bilibili-notify/internal` + `@bilibili-notify/dynamic` + `koishi-plugin-bilibili-notify-dynamic` + `koishi-plugin-bilibili-notify-advanced-subscription`):`ContentFilters` 加 `blockDraw`(`DYNAMIC_TYPE_DRAW` 图文,新版 opus 框架下外层 type 仍为 DRAW)和 `blockAv`(`DYNAMIC_TYPE_AV` 视频投稿)。Koishi 端子插件全局过滤 + advanced-subscription per-UP 覆盖同步暴露两个开关。旧 `globals.json` 加载兼容:两字段在 schema 上带 `.default(false)`,缺字段时 zod 自动补值,不会让独立端启动 schema 校验失败。

- **直播 / SC / 上舰卡片渲染修复**(`@bilibili-notify/image`):
  - SC 卡片右边距塌陷 — `image-renderer.ts` 的 `htmlWidth` 与卡片外框 `w-[290px]` 同步(之前是 280px,puppeteer viewport 比卡片窄 10px 导致右侧被裁)。
  - 上舰卡片长用户名挤掉舰长 logo — `guard-card.tsx` 左信息区 `flex-1` 加 `min-w-0`,CSS flex item 默认 `min-width: auto` 不会缩到比内容小,长名导致 sibling shrink-0 锚 logo 越界;`min-w-0` 让 flex-1 真正受 sibling 175px 锚约束,长 desc 走 CJK 默认换行规则。
