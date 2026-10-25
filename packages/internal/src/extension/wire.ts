/**
 * 拓展交给面板去画的那一层(wire),零依赖,只放常量与纯结构类型。
 *
 * 只许 `import type`,值级 import 只能指向零依赖名单里的同伴。
 * 面板与 contract 经 `@bilibili-notify/internal/extension/wire` 取值。
 */

// ---- 拓展声明式界面(ADR-0019)的零依赖判据 ----------------------------------------
//
// 清单的 schema(`schema/extension-manifest.ts`)与面板都直接从这里取值,两边拿的是同一份。

/** 列表项里保留给 BN 的键 —— 项的身份,由 BN 生成、藏起来、不许改(ADR-0019 决策 29)。 */
export const LIST_ITEM_ID_KEY = "id";

/**
 * 拓展交的图片(选项图标、表格的 icon 格)的上限 —— 整段 data URL 的字数。与桥协议里 bot 图标
 * 那条(`BRIDGE_BOT_ICON_MAX_BYTES`)同一个数:拓展包进不来 internal,只能各写一份。
 */
export const EXTENSION_IMAGE_MAX_CHARS = 32 * 1024;

/**
 * 拓展交的图片长什么样才收 —— **只收图片的 base64 data URL**,面板一律当 `<img>` 画(ADR-0019
 * 决策 31)。字数上限另算({@link EXTENSION_IMAGE_MAX_CHARS})。
 *
 * 不过 SVG 白名单:`<img>` 里的 SVG 不跑脚本、拉不进外部资源,而白名单每宽一格都是把外来标记
 * 塞进页面。不收 http(s) 地址:面板一开就去对家点名,不是图标该有的本事。
 *
 * ⚠️ 不带 `g`:几处共用这一个对象,带 `g` 的话 `test()` 会在两次调用之间记着 `lastIndex`。
 */
export const EXTENSION_IMAGE_DATA_URL_RE =
	/^data:image\/(?:png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/]+=*$/;
