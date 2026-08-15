/**
 * @bilibili-notify/ui —— 纯展示基础件的唯一出口。
 *
 * 收录判据:零业务依赖(不碰 api / store / react-query / 业务 schema)。
 * 缠业务的组件(header / AuthGate / draft-island …)留在 apps/web/src/components。
 *
 * 样式约定:组件类名依赖 ./theme.css 的 tokens 与 bn-* 基础类;消费方入口 CSS 必须
 * `@import "@bilibili-notify/ui/theme.css"` 并 `@source` 本包 src(Tailwind v4 要
 * 扫到这里的 class 才会生成对应 utilities)。
 */

export * from "./atoms";
export * from "./dialog";
export * from "./drawer";
export * from "./field-updates";
export * from "./glass";
export * from "./glass-box";
export * from "./icons";
export * from "./section-nav";
export * from "./tab-bar";
