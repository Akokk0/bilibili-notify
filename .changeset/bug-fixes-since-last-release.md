---
"@bilibili-notify/image": patch
"koishi-plugin-bilibili-notify": patch
---

修上次发版以来积累的两个推送路径 bug:

- **直播卡片简介 HTML 字面字符串**(`@bilibili-notify/image`):B 站 `room_info.description` 可能含 `<p>` / `<br>` 等富文本标签或 entity-encoded 形式(`&lt;p&gt;...`),JSX 文本插值会被 escape 成字面字符串。简介区域统一剥成 plain text(新增 `html-to-plain.ts` 工具,两遍解码兜底)。
- **forward-images 走普通群消息**(`koishi-plugin-bilibili-notify` koishi/core sink):动态图集推送走 koishi `sendGroupForwardMsg` 时,NapCat 长消息 trpc 通道不稳常超时;改为按 `payload.forward` 二分,默认走普通 `send_group_msg` 多 image segment(稳),要合并转发卡片才显式 `h("message", { forward: true }, nodes)`(由 dashboard / koishi `imageGroup.forward` 控制)。
