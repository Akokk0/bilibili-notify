---
"@bilibili-notify/dynamic": minor
"koishi-plugin-bilibili-notify-dynamic": minor
---

dynamic 插件文案模板可在控制台编辑 + 移除冗余 `dynamicUrl` 开关

- koishi/dynamic 插件 Schema 新增 `dynamicTemplate` / `videoTemplate` 两项(默认值等于内建文案,未编辑时输出不变),可在控制台直接编辑普通动态 / 视频投稿的推送文案;变量 `{name}`(UP 昵称)、`{url}`(链接)
- 移除 `dynamicUrl` 开关 —— 与模板 `{url}` 占位符职责重叠。要不要带链接改为只看模板里有没有 `{url}`,想去掉链接(如 QQ 官方机器人)把模板里的 `{url}` 删掉即可
- 引擎恒计算动态 / 视频 url;url 为空(如视频转 BV 无匹配)时仍由 renderDynamicText 去掉尾随分隔符
