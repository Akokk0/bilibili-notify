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

/** tab 条的容器。`z-30` 是给 ScopeTabs 的「添加 UP」下拉留的层级。 */
export function TabBarShell({ children }: { children: ReactNode }) {
	return (
		<div
			data-bn="nav"
			className="relative z-30 flex flex-wrap items-center gap-1.5 rounded-bn-sm border border-bn-border-subtle bg-bn-surface/70 p-1.5 backdrop-blur-sm"
		>
			{children}
		</div>
	);
}

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
			// 挂点跟 Btn 同口径 —— 这排按钮此前一个 hook 都没有,选中态的粉还写在
			// inline style 上,而 inline 压过一切 author 样式,皮肤连覆盖的机会都没有。
			data-bn={active ? "btn btn-primary" : "btn"}
			className={`flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-[12.5px] font-bold transition ${
				active
					? "bg-bn-pink text-white shadow-bn-accent"
					: "text-bn-text-tertiary hover:text-bn-text-primary"
			}`}
		>
			{icon}
			{children}
			{code ? (
				<span
					className={`ml-0.5 rounded-sm px-1.5 py-px font-mono text-[10px] font-semibold ${
						active ? "bg-bn-inverse-strong" : "bg-bn-code-bg"
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
					<div className="px-2 text-[11px] text-bn-text-tertiary">{hint}</div>
				</>
			) : null}
		</TabBarShell>
	);
}
