/**
 * 「编辑分组」弹框的纯逻辑:勾选切换所属分组、把新建输入并进分组列表。
 * 抽成纯函数便于穷举边界(空白 / 重复 / 顺序),弹框组件只做渲染与状态承接。
 */

/** 勾选切换:已属则移除,未属则追加(保序追加到末尾)。 */
export function toggleGroup(groups: string[], name: string): string[] {
	return groups.includes(name) ? groups.filter((g) => g !== name) : [...groups, name];
}

/** 把新建输入并进分组:trim 两端空白,空白或已存在则原样返回。 */
export function addGroupName(groups: string[], raw: string): string[] {
	const name = raw.trim();
	if (!name || groups.includes(name)) return groups;
	return [...groups, name];
}
