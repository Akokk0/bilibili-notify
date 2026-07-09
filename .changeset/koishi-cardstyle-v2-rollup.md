---
"koishi-plugin-bilibili-notify": patch
"@bilibili-notify/internal": minor
"@bilibili-notify/image": minor
"@bilibili-notify/live": minor
"@bilibili-notify/dynamic": minor
---

卡片版式 v2 + 每类型独立样式 + 背景图廊与轮换

补发独立端 alpha.14~16 已验证、但此前从未随 koishi 侧 changeset 发布的整套卡片渲染升级(实现早已合入,只是缺 changeset,koishi 用户此前一直依赖发布于该批改动之前的旧版 `@bilibili-notify/image` / `live` / `dynamic` / `internal`):

- 卡片版式描述式模型 v2:块的顺序、显隐、块间距、插入分割线可视化编辑;开播 / 动态 / SC / 上舰四种卡片改为按块类型渲染,旧版保存的版式自动迁移补齐每块间距
- 每卡片类型可各自设置独立样式(渐变色、背景图、玻璃片透明度),未覆盖的类型继承全局基准;per-UP 亦可覆盖
- 背景图列表模型 + 每次推送轮换下一张(开播 / 动态 / SC / 上舰各自独立游标)
- 玻璃片透明度调节,以及与之互斥的「完全透明」开关
- 直播卡「数据区」统一开关取代原先零散的隐藏标志
- 充电专属动态(未充电时接口不返回正文)渲染为专门占位提示,不再是空白卡片
- 动态卡版式细化:话题标签并入正文块顶部、附加内容独立成块、转发的内部原动态跟随同一套版式
