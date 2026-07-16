/**
 * 背景图廊选择的纯操作。`selected` = cardStyle.backgroundImages —— 选中顺序即轮换顺序
 * (空=渐变,1=单张,>1=每次推送顺序轮换)。全部不可变,供 GalleryPicker 与单测复用。
 */

/** 切换某图的选中:未选则追加到末尾(进轮换序列),已选则移除。 */
export function toggleSelected(selected: string[], id: string): string[] {
	return selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id];
}

/** 某图被从图廊删盘后,把它从当前选择里剔除(若在)。 */
export function removeFromGallery(selected: string[], id: string): string[] {
	return selected.filter((x) => x !== id);
}

/** 调整轮换次序:把 from 处的图移到 to 处。 */
export function moveSelected(selected: string[], from: number, to: number): string[] {
	if (from === to) return selected;
	const next = [...selected];
	const [moved] = next.splice(from, 1);
	if (moved !== undefined) next.splice(to, 0, moved);
	return next;
}

/** 背景图与直播封面两个图列表字段 —— 删盘清扫只碰这两个键。 */
interface StyleWithImageLists {
	backgroundImages?: string[];
	liveCoverImages?: string[];
}

/**
 * 资产删盘后,把该 id 从样式对象的两类图列表里剔除(缺省字段保持缺省,其余键不动)。
 * 图廊删除只会同步当前 picker 绑定的字段;页面上其他样式状态(全局基准 / per-kind /
 * per-UP)若还攥着这个 id,下次保存就会落盘成悬空引用 —— Cards 页删盘回调用它全量清扫。
 */
export function removeAssetFromStyle<T extends StyleWithImageLists>(style: T, id: string): T {
	const out = { ...style };
	if (out.backgroundImages) out.backgroundImages = removeFromGallery(out.backgroundImages, id);
	if (out.liveCoverImages) out.liveCoverImages = removeFromGallery(out.liveCoverImages, id);
	return out;
}

/** 同上,作用于 per-kind 覆盖表:逐 kind 清扫,非列表键原样保留。 */
export function removeAssetFromByKind<T extends StyleWithImageLists>(
	byKind: Record<string, T>,
	id: string,
): Record<string, T> {
	const out: Record<string, T> = {};
	for (const [kind, style] of Object.entries(byKind)) out[kind] = removeAssetFromStyle(style, id);
	return out;
}
