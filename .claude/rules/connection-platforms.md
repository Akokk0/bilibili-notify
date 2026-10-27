---
paths:
  - "packages/internal/src/platform-registry.ts"
  - "apps/server/src/platforms/**"
  - "apps/web/src/pages/Targets.tsx"
  - "apps/web/src/components/platform-meta.tsx"
---

# 连接与平台闭集

⚠️ **`CONNECTION_PLATFORMS` 不加档**:按 ADR-0024 决策 1,这个闭集与平台表 `PLATFORM_REGISTRY`、三份连接设置规则都要搬出 `internal`、由适配器自带 —— 内置的 OneBot / QQ 官方机器人 / webhook 与拓展已经是同一个 `PlatformAdapter` 接口、同一张登记表,连接的形状是 `{ adapterKey, platform, settings, platformSnapshot, … }`(决策 7,`kind` / `connector` / `extensionId` 已删,拓展的连接 `adapterKey` 就是拓展 id);闭集、平台表与三份规则眼下还留在 `internal`,只因面板还在读,等第 4 期面板改成按适配器的描述画之后一次搬走删掉,在那之前别往里加。

不变的是:**一条连接就是一个借来的 bot**,它的 `platform` 是开放字符串(内置的取自挑中的候选,拓展的今天从桥报的 bot 上抄),桥的接入(token)住拓展自己的设置里,不是连接(ADR-0012 决策 45)。
