/**
 * 页面级 tab 条的**共用外壳** —— 全站只此一套观感。
 *
 * 由来:Rules / Cards 的作用域切换条(`ScopeTabs`)长期是这套观感的唯一持有者,但它
 * 死绑订阅(第一个按钮写死「全局 / 全部 UP」,后面几个必须带头像、覆盖计数与移除
 * 按钮),别的页面想要一条普通 tab 只能照着重画一遍 —— 于是就飘了。把外壳与单个
 * tab 按钮抽出来,`ScopeTabs` 反过来建在它上面,两边**从构造上**不可能再各走各的。
 *
 * 改这里的样式 = 同时改所有页面的 tab,这正是想要的。
 */

import type { ReactNode } from "react";

/** tab 条的容器。`z-bn-nav` 是给 ScopeTabs 的「添加 UP」下拉留的层级。 */
export function TabBarShell({ children }: { children: ReactNode }) {
	return (
		<div
			data-bn="nav"
			className="relative z-bn-nav flex flex-wrap items-center gap-1.5 rounded-bn-sm border border-bn-border-subtle bg-bn-surface/70 p-1.5 backdrop-blur-sm"
		>
			{children}
		</div>
	);
}

/**
 * tab 的两态语汇。**导出**是给库外的 tab 家族成员用的(ScopeTabs 的 per-UP tab
 * 结构上是「主钮 + 移除钮」的复合体,做不成 TabButton,但观感必须同一句话)——
 * 此前它自配「白卡 + 粉描边」,与紧挨着的「全局」实心块并排摆着两种选中态
 * (2026-08-30 审计点名的「另一条账」,今日还清)。
 */
export const TAB_ACTIVE_LANGUAGE = "bg-bn-pink text-bn-on-solid shadow-bn-accent";
export const TAB_IDLE_LANGUAGE = "text-bn-text-tertiary hover:text-bn-text-primary";

export interface TabButtonProps {
	active: boolean;
	onClick: () => void;
	icon?: ReactNode;
	children: ReactNode;
	/** 标签右侧的等宽小码(ScopeTabs 的 `default`;AI 页放英文域名)。 */
	code?: string;
	title?: string;
	/** 传 "tab" 则连同 `aria-selected` 一起上(两者必须成对,单给 aria 是非法标记)。 */
	role?: "tab";
}

/** 单个 tab 按钮。选中态是粉色渐变实心块 —— 与 ScopeTabs 的「全局」按钮同源。 */
export function TabButton({ active, onClick, icon, children, code, title, role }: TabButtonProps) {
	// `aria-selected` 只在 role="tab" 上合法,所以两者绑成一组。选中态的唯一来源是
	// `active` —— 不再多一个能与它对不上的 prop。
	const tabRole = role === "tab" ? ({ role: "tab", "aria-selected": active } as const) : {};
	return (
		<button
			type="button"
			onClick={onClick}
			title={title}
			{...tabRole}
			// 挂点走 tab 家族(曾挂 btn/btn-primary,皮肤的按钮实底把整排 tab 画成
			// 一排按钮 —— 2026-08-23 主人真机指出)。挂点本身不能少:这排按钮更早
			// 连 hook 都没有,选中态的粉还写在 inline style 上,皮肤连覆盖的机会都没有。
			data-bn={active ? "tab tab-active" : "tab"}
			className={`flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-bn-sm font-bold transition ${
				active ? TAB_ACTIVE_LANGUAGE : TAB_IDLE_LANGUAGE
			}`}
		>
			{icon}
			{children}
			{code ? (
				<span
					// 选中态**不给底**。这颗小码的字是继承来的,所以它的可读性顶多等于旁边
					// 的标签 —— 底只要偏离父底,就一定有一边被拉低。原先那层 25% 白纱正是
					// 往错的方向偏:选中块是中等亮度的强调色,叠白只会把底推向白字那边。
					// 实测(默认粉底):旁边的标签 2.64:1,这颗小码 2.08:1 —— 反而是整条
					// tab 上最难认的东西。皮肤把字色改深时白纱又碰巧帮上忙(5.4:1),所以
					// 任何固定方向的纱都只是在两种装扮之间挑一个牺牲。
					// 去掉之后两边都回到「和旁边标签一样」:默认 2.64、深字皮肤 4.27。
					// 形状留着(圆角与内距在无底时不显形),等宽字仍把小码与标签分得开。
					className={`ml-0.5 rounded-sm px-1.5 py-px font-mono text-bn-2xs font-semibold ${
						active ? "" : "bg-bn-code-bg"
					}`}
				>
					{code}
				</span>
			) : null}
		</button>
	);
}

export interface TabBarItem<T extends string> {
	id: T;
	label: string;
	icon?: ReactNode;
	code?: string;
}

export interface TabBarProps<T extends string> {
	items: readonly TabBarItem<T>[];
	value: T;
	onChange: (next: T) => void;
	/** 右侧那行灰字提示,随选中项变化。 */
	hint?: ReactNode;
}

/** 一条普通的 N 项 tab。需要每项各带自定义内容(如 ScopeTabs)时改用上面两个原语。 */
export function TabBar<T extends string>({ items, value, onChange, hint }: TabBarProps<T>) {
	return (
		<TabBarShell>
			<div className="flex flex-wrap items-center gap-1.5" role="tablist">
				{items.map((t) => (
					<TabButton
						key={t.id}
						role="tab"
						active={t.id === value}
						onClick={() => onChange(t.id)}
						icon={t.icon}
						code={t.code}
					>
						{t.label}
					</TabButton>
				))}
			</div>
			{hint ? (
				<>
					<div className="flex-1" />
					<div className="px-2 text-bn-xs text-bn-text-tertiary">{hint}</div>
				</>
			) : null}
		</TabBarShell>
	);
}
