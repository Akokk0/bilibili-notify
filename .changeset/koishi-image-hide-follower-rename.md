---
"koishi-plugin-bilibili-notify-image": major
---

**BREAKING**:`followerDisplay` 重命名 + 语义反转为 `hideFollower`,对齐 `hideDesc` 命名风格(「隐藏=true」)。

升级路径:

- 旧配置 `followerDisplay: true`(默认值,显示粉丝)→ 升级后无需改动,新字段 `hideFollower` 默认 `false`(=不隐藏)行为一致。
- 旧配置 `followerDisplay: false`(显式隐藏粉丝)→ koishi Schema 不识别旧字段名,会被静默丢弃,新字段取默认 `false` → 粉丝又会显示出来。**主人需要手动把 yaml 里的字段改成 `hideFollower: true`**。

为什么改:`hideDesc`(隐藏直播间简介)用「隐藏=true」语义,而 `followerDisplay` 用「显示=true」,两个相邻字段方向相反,容易写错。统一成 `hideFollower` 后命名风格一致,跨独立端 dashboard(同名 `hideFollower`)也对齐。
