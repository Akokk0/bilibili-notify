---
"koishi-plugin-bilibili-notify-image": minor
"@bilibili-notify/image": minor
---

`followerDisplay`(显示=true)全链路重命名 + 语义反转为 `hideFollower`(隐藏=true),对齐 `hideDesc` 命名风格。范围横跨 koishi plugin Schema 与 `@bilibili-notify/image` 的 `ImageRendererConfig` / `LiveCardProps` 公共接口,两端中间不再做桥接取反。

**koishi-plugin-bilibili-notify-image** —— 主人迁移点:

- yaml 字段名 `followerDisplay` → `hideFollower`,且布尔值取反。旧值 `followerDisplay: true`(默认显示)对应新值 `hideFollower: false`(默认不隐藏=显示);旧值 `followerDisplay: false`(隐藏)对应新值 `hideFollower: true`。koishi Schema 不识别旧字段名 → 升级后 yaml 里的 `followerDisplay` 被静默丢弃,新字段取默认 `false`(=显示)。**未显式改过该字段的主人无感**;显式设过 `followerDisplay: false`(想隐藏)的主人需要手动改成 `hideFollower: true`。
- `font` 默认值从 `"sans-serif"` 改为引 `DEFAULT_CARD_STYLE.font`(`"PingFang SC, sans-serif"`),与独立端 internal 唯一默认源对齐。未显式设 font 的主人升级后默认字体会变,无 PingFang 字体的环境通过 CSS 兜底链(Microsoft YaHei / Noto Sans CJK / sans-serif)回退;如视觉不适可在 yaml 里把 `font` 设回 `sans-serif`。

**@bilibili-notify/image**:

- `ImageRendererConfig.followerDisplay: boolean` → `ImageRendererConfig.hideFollower: boolean`(语义反转)
- `LiveCardProps.followerDisplay: boolean` → `LiveCardProps.hideFollower: boolean`(语义反转)

下游使用者(`apps/server`、koishi-plugin-bilibili-notify-image)同步透传 `hideFollower`,两端不再桥接取反。
