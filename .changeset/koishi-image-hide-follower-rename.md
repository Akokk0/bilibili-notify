---
"koishi-plugin-bilibili-notify-image": major
"@bilibili-notify/image": major
---

**BREAKING · 全链路统一**:`followerDisplay`(显示=true)重命名 + 语义反转为 `hideFollower`(隐藏=true),对齐 `hideDesc` 命名风格。范围横跨 `koishi-plugin-bilibili-notify-image` 的 plugin config Schema 与 `@bilibili-notify/image` 的 `ImageRendererConfig` / `LiveCardProps` 公共接口,两端中间不再做桥接取反。

### koishi-plugin-bilibili-notify-image

1. **字段重命名 + 反转**:plugin config `followerDisplay: boolean(显示=true, default=true)` → `hideFollower: boolean(隐藏=true, default=false)`。
   - 旧配置 `followerDisplay: true`(默认,显示粉丝)→ 升级后无需改动,新字段默认 `false`(=不隐藏)行为一致。
   - 旧配置 `followerDisplay: false`(显式隐藏粉丝)→ koishi Schema 不识别旧字段会被静默丢弃,粉丝又会显示出来。**主人需要手动把 yaml 里改成 `hideFollower: true`**。
2. **font 默认值变更**:从 `"sans-serif"` 改为引 `DEFAULT_CARD_STYLE.font`(`"PingFang SC, sans-serif"`),与独立端 internal 唯一默认源对齐。未显式设 font 的旧用户升级后默认字体会从 sans-serif 变成 PingFang SC,无 PingFang 字体的环境会通过 CSS 兜底链回退到 Microsoft YaHei / Noto Sans CJK / sans-serif。视觉如有不适可在 yaml 里把 `font` 设回 `sans-serif`。

### @bilibili-notify/image

- `ImageRendererConfig.followerDisplay: boolean` → `ImageRendererConfig.hideFollower: boolean`(语义反转)。
- `LiveCardProps.followerDisplay: boolean` → `LiveCardProps.hideFollower: boolean`(语义反转)。

下游所有使用者(`apps/server`、`koishi-plugin-bilibili-notify-image`)同步透传 `hideFollower`,两端不再桥接取反。

### 为什么改

`hideDesc`(隐藏直播间简介)用「隐藏=true」语义,而 `followerDisplay` 用「显示=true」,两个相邻字段方向相反,容易在 yaml / dashboard 里设错。统一成 `hideFollower` 后命名风格一致,跨独立端 dashboard / koishi plugin / 渲染引擎核心三层同名同义。同时把 koishi font 默认值收敛到 internal 单一来源,补 e0083e2(2026-05-23 koishi config 模型整体收敛)的漏点。
