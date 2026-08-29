/**
 * 顶部导航表,以及「显哪几个」的判定 —— 单一真源。
 *
 * BN 的功能面比很多人用得上的宽,导航条一排十来项。主人可以自己挑要看见哪些
 * (入口在导航条右侧那颗按钮),偏好只落在本地浏览器,不进配置文件。
 *
 * 藏起来的只是**入口**:`App.tsx` 的路由一个没动,URL 直达照常打得开 —— 灵动岛的
 * 跳转、外链、收藏夹于是都还活着。真要停用某个功能,那是「系统」页里各自的开关,
 * 与这里无关。
 */

/** 恒显示的那一项。藏掉它等于把「改回来」的唯一入口也藏了,直接锁死。 */
export const ALWAYS_VISIBLE_PATH = "/system";

export interface NavItem {
	to: string;
	label: string;
	/** 标签右侧那颗计数气泡的数据源。没有就不显示气泡。 */
	countKey?: "subs" | "targets";
}

export const NAV_ITEMS: readonly NavItem[] = [
	{ to: "/", label: "概览" },
	{ to: "/subs", label: "订阅 UP 主", countKey: "subs" },
	{ to: "/targets", label: "推送目标", countKey: "targets" },
	{ to: "/history", label: "推送历史" },
	{ to: "/stats", label: "数据统计" },
	{ to: "/rules", label: "高级规则" },
	{ to: "/cards", label: "卡片渲染 · 样式" },
	{ to: "/ai", label: "智能女仆" },
	{ to: ALWAYS_VISIBLE_PATH, label: "系统" },
	{ to: "/logs", label: "日志" },
	{ to: "/guide", label: "新手指引" },
	{ to: "/about", label: "关于" },
];

/** 这一项允许被藏起来吗。 */
export function canHideNav(to: string): boolean {
	return to !== ALWAYS_VISIBLE_PATH;
}

/**
 * 按「藏了哪些」筛出该显示的项,顺序照原表。
 *
 * 参数是**隐藏集合**而不是显示白名单,这一点是刻意的:日后新加的页面不在任何人的
 * 隐藏名单里,于是默认就看得见。反过来存白名单的话,老主人的名单里没有新页面 ——
 * 新功能上线即隐身,而他根本不知道有这么一页,也就永远不会去打开它。
 *
 * 认不出的路径一概忽略:这份名单住在 localStorage,是能手改也能过时的。
 */
export function visibleNav(all: readonly NavItem[], hidden: readonly string[]): readonly NavItem[] {
	const hide = new Set(hidden.filter(canHideNav));
	return all.filter((item) => !hide.has(item.to));
}

/**
 * 按主人拖出来的顺序重排。
 *
 * `order` 里**没提到**的项一律追加在末尾 —— 与 {@link visibleNav} 存隐藏集合是同一个
 * 道理:这份名单是主人**当时**排的,不该让它决定往后所有新页面的生死。认不出的路径
 * 忽略(页面删了),重复的只算一次(localStorage 是能手改的)。
 */
export function orderedNav(all: readonly NavItem[], order: readonly string[]): readonly NavItem[] {
	const byPath = new Map(all.map((item) => [item.to, item]));
	const head: NavItem[] = [];
	const taken = new Set<string>();
	for (const path of order) {
		const item = byPath.get(path);
		if (!item || taken.has(path)) continue;
		taken.add(path);
		head.push(item);
	}
	return [...head, ...all.filter((item) => !taken.has(item.to))];
}

/**
 * 把 `from` 挪到 `to` 现在的位置上,返回新顺序。两者任一不在表里就原样返回 ——
 * 拖到自己身上同理,不白存一次。
 */
export function moveNavPath(order: readonly string[], from: string, to: string): string[] {
	const fromIdx = order.indexOf(from);
	const toIdx = order.indexOf(to);
	if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) return [...order];
	const next = [...order];
	next.splice(fromIdx, 1);
	next.splice(toIdx, 0, from);
	return next;
}

/**
 * 导航条最终显示什么 —— **先排序再过滤**。
 *
 * 合成一个而不是让调用方自己套两层:反过来先过滤再排序,结果一样但多一次遍历,
 * 更要紧的是「先后顺序」这种事一旦交给调用方记,迟早有人记反。
 */
export function resolveNav(
	all: readonly NavItem[],
	prefs: { order: readonly string[]; hidden: readonly string[] },
): readonly NavItem[] {
	return visibleNav(orderedNav(all, prefs.order), prefs.hidden);
}
