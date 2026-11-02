---
paths:
  - "apps/server/src/platforms/**"
  - "apps/web/src/pages/Targets.tsx"
  - "apps/web/src/components/platform-meta.tsx"
---

# 连接与平台闭集

按 ADR-0024 决策 1，4-30 已删除 `internal` 的 `CONNECTION_PLATFORMS` 与 `./platform-registry` 子路径。平台描述住 `apps/server/src/platforms/platform-descriptors.ts`，三份连接规则住各适配器的 `*-settings.ts`，由适配器提供候选与设置字段；面板经描述接口绘制。平台名单只属于集成实现，核心里的 `platform` 保持开放字符串。

保留键由 `compose.ts` 从内置设置段收齐为 `BUILTIN_INTEGRATION_KEYS`，交给宿主的存储、拓展清单与 ID 校验。通用打包器只校验格式和核心保留名，宿主安装、发现、市场和设置入口另拒绝内置键；卸载同名坏拓展只清拓展目录，保留内置状态与凭据。冻结迁移 `migration/zero-platforms.ts` 保持原样。

不变的是:**一条连接就是一个借来的 bot**,它的 `platform` 是开放字符串(内置的取自挑中的候选,拓展的今天从桥报的 bot 上抄),桥的接入(token)住拓展自己的设置里,不是连接(ADR-0012 决策 45)。
