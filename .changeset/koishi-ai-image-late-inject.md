---
"@bilibili-notify/dynamic": patch
"@bilibili-notify/live": patch
---

修 koishi 端 AI 总结 / 图片渲染在 sibling service 时序不利时静默失效的潜伏 bug。

**现象**:升 `koishi-plugin-bilibili-notify@5.0.0-alpha.1` 后,部分用户反馈动态推送不再带 AI 点评(直播总结同源),AI 插件本身存活、日志无报错。

**根因**:`koishi-plugin-bilibili-notify-dynamic` 与 `-live` 的 Service 类级 `inject` 只列了必需依赖 `["bilibili-notify"]`,`bilibili-notify-ai` / `-image` 是插件级 `optional` 不阻塞启动。`start()` 内通过 `this.ctx.get("bilibili-notify-ai")?.engine` 一次性把引擎引用塞进 `DynamicEngine` / `LiveEngine` 构造参数 —— 若 ai/image 子插件比当前服务**晚** ready,拿到的就是 undefined,后续推送在 engine 内 silent skip(`if (this.ai && ...)` 第一个条件失败,连 debug 日志都不打)。`e0083e2` 重构 koishi config 模型时改了主插件 `bringUp` 启动序,把这条原本不会触发的时序 race 翻成常态。

**修复**:

- `@bilibili-notify/dynamic` 加 `DynamicEngine.setImage(image)` 后置注入接口,与已存在的 `setAi(ai)` 对称
- `@bilibili-notify/live` 加 `LiveEngine.setImageRenderer(renderer)`,内部把 imageRenderer 重构成 provider 模式,`WordcloudGenerator` / `RoomContext` 通过共享 `getImageRenderer()` 现取,setter 仅更新单一可变 state
- `koishi-plugin-bilibili-notify-dynamic` 与 `-live` 改用 `ctx.inject(["bilibili-notify-ai"], cb)` / `ctx.inject(["bilibili-notify-image"], cb)` 在依赖服务 ready/卸载时分别调 setter,fork 跟随 service 生命周期自动 dispose
- koishi 端 `toEngineConfig` 的 `aiEnabled` / `imageEnabled` 改为常量 true —— 用户开关下沉给 ctx.inject 决策,与"装了即启用"语义一致

主人无感升级:旧版用户拿到新版,AI 总结自动恢复,无需调整任何配置。
