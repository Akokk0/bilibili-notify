/**
 * 从预览文档里数出「这一轮真画出来的块」(2026-09-18 主人反馈:各个场景画布都一样)。
 *
 * 画布画的是皮肤 JSON,而 JSON 只有一份 —— 切预览场景它一动不动。可真卡是分场景的:
 * `showIf` 判假、或者内置块这一场没数据,整块就不画(渲染器筛那一步)。编辑器得说出这件事,
 * 不然主人对着一堆块猜哪些这会儿有用 —— 拆得越细这事越要紧(视频卡那几块与图廊是**互斥**
 * 地占同一片行的)。
 *
 * **不需要给预览另加标注**:块 id 本来就在真卡的 DOM 里,每个块 wrapper 都带着
 * `bn-blk-<id>` 这个 class(`render-skin.tsx` 的 `blockClass`)。
 *
 * 只认**外层网格的直接子**:转发框里那张内层卡跟着同一份皮肤走,外层没摆的块内层也可能
 * 画出来,但画布画的是外层那一层的布局。找外层靠一条性质 —— **文档序里第一个 `bn-blk-*`
 * 元素必定是外层网格的直接子**(内层的都嵌在某个外层块里,那个外层块在文档序里更靠前)。
 */

const PREFIX = "bn-blk-";

/**
 * 这一份文档里,外层画出来的块 id。文档里一个块都认不出来时回 `null` —— 画布据此**一个都
 * 不淡**,而不是把满屏的块都标成「这一场不出现」。
 *
 * 拿到 `grid` 之后就不会再空了:它是「第一个块元素的父亲」,那个块**必然**在它的孩子里。
 */
export function drawnBlocks(doc: Document): string[] | null {
	const grid = doc.querySelector(`[class*="${PREFIX}"]`)?.parentElement;
	if (!grid) return null;
	const out: string[] = [];
	for (const child of grid.children) {
		for (const c of child.classList) {
			if (c.startsWith(PREFIX)) {
				out.push(c.slice(PREFIX.length));
				break;
			}
		}
	}
	return out;
}
