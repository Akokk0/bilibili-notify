---
paths:
  - "apps/web/**"
  - "apps/desktop/**"
  - "packages/ui/**"
---

# 写前端 UI 前先查组件清单

`packages/ui`(`@bilibili-notify/ui`)是纯展示基础件库,给 web / desktop 写任何 UI **之前必须先读 `packages/ui/README.md` 的组件清单**——清单里有的组件不许重写。新增纯展示件(零业务依赖)进库并**同步更新清单**;缠 api/store/react-query 的留在 `apps/web/src/components`。库是源码直出(exports 指 src,无构建步),消费方入口 CSS 要 `@import "@bilibili-notify/ui/theme.css"` + `@source` 库的 src。
