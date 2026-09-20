/**
 * **格子的调试叠层**(ADR-0018 决策 5)—— 往预览框那份 HTML 后面追一段 CSS,把每个格子
 * 的地盘画出来,浏览器开发者工具查元素那个样子。
 *
 * 它只有在**格子层存在**之后才做得出来:从前那层 wrapper 会被皮肤捏形状(`justify-self`、
 * `margin`),描出来的框不是格子;而 `[data-cell]` 是个恒等于格子的真元素(ADR-0018 决策 2),
 * 一条后代选择器就够。
 *
 * 四条形状,每条对着一个会静默坏掉的地方:
 *
 * 1. **注在 web 这一侧,不在渲染器里。** 出图那条路一个字节都不动 —— 调试样式绝无可能漏
 *    进推送出去的卡,23 份字节基准也不被它污染。代价是预览与出图的 HTML 在**开着调试时**
 *    有意不一样,那正是这个开关的意思。
 * 2. **不占布局。** 只用 `outline` 与 `background`:`border` / `padding` 会把每个格子撑大,
 *    那就成了「看另一张卡」。开着调试看到的必须仍是那张真卡。
 * 3. **只碰 `[data-cell]`。** 选到别的东西就等于替皮肤改样子。
 * 4. **关着的时候逐字节不变。** 留一段注释或空 `<style>`,「所见即所得」就已经破了。
 *
 * 悬停那一档靠浏览器自己的 `:hover`,**不需要脚本** —— 预览框的 `allow-scripts` 照旧不给
 * (ADR-0014 决策 22:同源与脚本永远不许同时给)。
 *
 * 尺寸牌不做:框里没有脚本,牌子只能用 CSS `content` 拼一串渲染时算好的死字符串,还会被
 * 卡片内容盖住、裁掉。要数字去检查器看 —— 那个数就是 ADR-0018 保证过的同一个。
 */

/** 三档。`off` 是默认。 */
export const CELL_DEBUG_MODES = ["off", "hover", "all"] as const;

export type CellDebugMode = (typeof CELL_DEBUG_MODES)[number];

/** 三档各自在界面上怎么说。 */
export const CELL_DEBUG_LABELS: Record<CellDebugMode, string> = {
	off: "不显示",
	hover: "指到才显示",
	all: "全部显示",
};

/** 悬停那一格:实线框 + 一层很淡的底。颜色写死成半透明蓝,不吃皮肤的变量(框里没有它们)。 */
const HOVER_CSS =
	"[data-cell]:hover{outline:1px solid rgba(56,132,255,.9);outline-offset:-1px;background:rgba(56,132,255,.14)}";

/** 常显那一档:每个格子一条淡虚线。压在悬停那条前面,悬停时由后者接管。 */
const ALL_CSS = "[data-cell]{outline:1px dashed rgba(56,132,255,.45);outline-offset:-1px}";

/**
 * 往一份预览 HTML 里追调试样式。`off` 原样返回(**同一个字符串**,不是复制)。
 *
 * 追在 `</body>` 之前;没有 `</body>` 就追在末尾 —— 出图的 HTML 理论上总有,但预览回来的
 * 东西不是我们能打包票的,凭空丢掉一段 CSS 看上去就是「开关点了没反应」。
 */
export function withCellDebug(html: string, mode: CellDebugMode): string {
	if (mode === "off") return html;
	const style = `<style>${mode === "all" ? ALL_CSS : ""}${HOVER_CSS}</style>`;
	const at = html.lastIndexOf("</body>");
	return at === -1 ? html + style : html.slice(0, at) + style + html.slice(at);
}
