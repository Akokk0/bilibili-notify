/**
 * css-tree 自包含 dist bundle 的类型垫片:dist 与主入口 API 同源,直接复用
 * `css-tree` 的官方类型。为什么导入走 dist 见 skins/css-sanitizer.ts 顶部注释。
 */
declare module "css-tree/dist/csstree.esm" {
	export * from "css-tree";
}
