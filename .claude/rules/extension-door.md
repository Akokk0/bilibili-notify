---
paths:
  - "extensions/**"
  - "packages/extension/**"
  - "apps/server/src/extensions/**"
---

# 拓展只从一扇门拿 BN 的东西

`extensions/<id>/` 底下第三方随便用,但我们自己的东西**只准从 `@bilibili-notify/extension` 进** —— 那个包列出来的就是契约的全部,直接依赖 `internal` 等于把契约放宽成「整个域模型」。反方向也一样:**核心既不 import 拓展,也不 import 那扇门**。东西都定义在 `internal`,门只负责把它们转给拓展。两条都由 `apps/server/src/extensions/__tests__/extension-import-boundary.test.ts` 钉着,越界是静默的(类型、测试、构建全绿)。
