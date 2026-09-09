/**
 * 清单里那枚图标过白名单 —— **在加载那一步**,不是画的时候(ADR-0012 决策 20)。
 *
 * 为什么图标跟着拓展走:让它住进 `packages/ui` 的闭表看似省事,但那会把拓展的独立发版
 * 废掉 —— 新拓展要等主程序发一版才有脸。代价就是这份过滤器。
 *
 * 🔴 **过滤只此一处**:面板拿到的那段字符串是直接塞进 DOM 的(`dangerouslySetInnerHTML`,
 * 图标要吃 `currentColor` 才能在渐变方块上是白的,`<img src="data:">` 做不到)。所以这里
 * 是唯一的门 —— 清单读出来立刻过一遍,下游没有任何一条路能看见原样的 SVG。
 *
 * 至于「往页面塞外来 SVG 有 XSS 面」这件事本身:拓展已经在同进程跑我们签过的任意代码了,
 * 再担心它的图标有点滑稽(ADR 原话)。这道门真正挡的是**下载来的那些** —— 分发链路日后
 * 会验签,而签名管的是「这份包没被人改过」,管不了发包的人本来就写了什么。
 *
 * 放行是**整枚**放行,拦下是**整枚**丢掉:剪掉一半的图既不好看也说不清是什么,而灰方章
 * 至少诚实。
 */

/**
 * 认得的元素 —— 画形状的那些,加渐变。
 *
 * `image` / `use` / `foreignObject` **刻意不在**:它们能把外面的东西拉进来,而主人打开
 * 面板的那一刻就是替对家点的一次名(拿得到内网 IP 与访问时间),图标不该有这个本事。
 */
const ALLOWED_TAGS = new Set([
	"svg",
	"g",
	"path",
	"circle",
	"ellipse",
	"rect",
	"line",
	"polyline",
	"polygon",
	"defs",
	"lineargradient",
	"radialgradient",
	"stop",
	"clippath",
	"mask",
	"title",
	"desc",
]);

/**
 * 认得的属性。
 *
 * `style` 不在名单里:它是一整门语言,白名单管不住它里头写什么。`href` / `xlink:href`
 * 同 `image` 那条理由。
 */
const ALLOWED_ATTRS = new Set([
	"viewbox",
	"xmlns",
	"width",
	"height",
	"fill",
	"fill-rule",
	"fill-opacity",
	"stroke",
	"stroke-width",
	"stroke-linecap",
	"stroke-linejoin",
	"stroke-dasharray",
	"stroke-dashoffset",
	"stroke-opacity",
	"clip-rule",
	"clip-path",
	"mask",
	"opacity",
	"transform",
	"d",
	"cx",
	"cy",
	"r",
	"rx",
	"ry",
	"x",
	"y",
	"x1",
	"y1",
	"x2",
	"y2",
	"points",
	"offset",
	"stop-color",
	"stop-opacity",
	"gradientunits",
	"gradienttransform",
	"id",
]);

/** 一个标签(含它整段属性),引号里的 `>` 不算结束。 */
const TAG = /<\s*\/?\s*([a-zA-Z][a-zA-Z0-9:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
/** 属性名 + 可选的值(双引号 / 单引号 / 裸值)。 */
const ATTR = /([a-zA-Z_:][a-zA-Z0-9_.:-]*)\s*(?:=\s*("[^"]*"|'[^']*'|[^\s"'>]+))?/g;
/** `url(` 后面不是 `#` 的一律不认 —— 只准引用自己文档里的东西。 */
const FOREIGN_URL = /url\(\s*['"]?\s*(?!#)/i;

function attributesOk(raw: string): boolean {
	ATTR.lastIndex = 0;
	for (let m = ATTR.exec(raw); m; m = ATTR.exec(raw)) {
		const name = (m[1] ?? "").toLowerCase();
		if (!ALLOWED_ATTRS.has(name)) return false;
		const value = (m[2] ?? "").replace(/^["']|["']$/g, "");
		if (FOREIGN_URL.test(value)) return false;
	}
	return true;
}

/**
 * 过一遍白名单:能放行就原样返回,否则 `undefined`(→ 面板画灰方章)。
 *
 * 扫的是**标签**而不是解析成树:这里不引 DOM 实现(server bundle 旁边没有 node_modules,
 * 而 jsdom 那一套已经为了词云进过一次载荷)。代价是判据必须比解析器更保守 ——
 * 注释、CDATA、处理指令、以及标签之外任何一个裸尖括号,一律不放行:那正是「两套解析器
 * 对同一段字节看法不同」钻进来的缝。
 */
export function safeExtensionIcon(icon: string | undefined): string | undefined {
	const svg = icon?.trim();
	if (!svg) return undefined;
	if (!svg.toLowerCase().startsWith("<svg")) return undefined;
	// 注释 / CDATA / 处理指令 —— 不去猜里头是什么。
	if (/<[!?]/.test(svg)) return undefined;

	let cursor = 0;
	TAG.lastIndex = 0;
	for (let m = TAG.exec(svg); m; m = TAG.exec(svg)) {
		// 标签与标签之间只许是文字。裸的 `<` / `>` 说明这个扫描器跟浏览器看到的不是同一份。
		if (/[<>]/.test(svg.slice(cursor, m.index))) return undefined;
		cursor = m.index + m[0].length;
		if (!ALLOWED_TAGS.has((m[1] ?? "").toLowerCase())) return undefined;
		if (!attributesOk(m[2] ?? "")) return undefined;
	}
	if (/[<>]/.test(svg.slice(cursor))) return undefined;
	// 只认一枚图标:`</svg>` 之后还有别的东西,前面那句「根是 svg」就形同虚设。
	if (!svg.toLowerCase().endsWith("</svg>")) return undefined;
	return svg;
}
