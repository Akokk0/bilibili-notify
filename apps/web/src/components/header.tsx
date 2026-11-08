import { Btn, Icon, MenuItem, PopoverShell, StatusDot, useDismiss } from "@bilibili-notify/ui";
import {
	closestCenter,
	DndContext,
	type DragEndEvent,
	KeyboardSensor,
	PointerSensor,
	useSensor,
	useSensors,
} from "@dnd-kit/core";
import {
	SortableContext,
	sortableKeyboardCoordinates,
	useSortable,
	verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { canHideNav, NAV_ITEMS, type NavItem, orderedNav, resolveNav } from "../config/nav";
import { SOURCE_AUTH_QUERY_PREFIX } from "../hooks/use-source-auth";
import { ACCOUNTS_QUERY_KEY } from "../hooks/useAccounts";
import { useBackendReachable } from "../hooks/useBackendReachable";
import { i18n, useT } from "../i18n";
import { api } from "../services/api";
import { submitLogout } from "../services/session";
import { useNavStore } from "../store/nav";
import { useSessionStore } from "../store/session";
import { useSkinStore, useSkinText } from "../store/skin";
import { type ThemePreference, useThemeStore } from "../store/theme";
import type { PushTarget, Subscription } from "../types/domain";
import { AccountChip } from "./accounts/account-chip";
import { DragHandle } from "./drag-handle";
import { ProblemBox } from "./problem-box";

/**
 * 面板里的一行 —— ⠿ 拖动排序 + 勾选显隐。
 *
 * `useSortable` 必须 per-item,所以单抽一个组件(同 `rules/MessageLayoutEditor`)。
 * 拖拽手柄只绑在 ⠿ 上,勾选框照常点得动。
 */
function NavEditorRow({ item, shown, locked }: { item: NavItem; shown: boolean; locked: boolean }) {
	const tx = useT();

	const toggle = useNavStore((s) => s.toggle);
	const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition } =
		useSortable({ id: item.to });

	return (
		<div
			ref={setNodeRef}
			style={{ transform: CSS.Transform.toString(transform), transition }}
			className="flex items-center gap-1.5 rounded-md px-1 py-1 hover:bg-bn-surface-muted"
		>
			<DragHandle
				attributes={attributes}
				listeners={listeners}
				setActivatorNodeRef={setActivatorNodeRef}
				label={item.label}
			/>
			<label
				className={`flex flex-1 items-center gap-2 text-bn-sm ${
					locked
						? "cursor-not-allowed text-bn-text-tertiary"
						: "cursor-pointer text-bn-text-primary"
				}`}
				// 「系统」是唯一能把别的改回来的地方,藏了就锁死了。说清楚原因,
				// 否则一个点不动的勾选框只会让人以为是坏了。
				title={locked ? tx("panelUi.components.header.1") : undefined}
			>
				<input
					type="checkbox"
					checked={shown}
					disabled={locked}
					onChange={() => toggle(item.to)}
					className="accent-bn-pink"
				/>
				{item.label}
			</label>
		</div>
	);
}

/**
 * 导航条右侧那颗按钮展开的面板 —— 主人自己挑要看见哪几项、按什么顺序摆。
 *
 * 藏的只是入口:路由一个没动,URL 直达照常打得开。所以这里的文案说的是「显示」,
 * 不是「启用」—— 后者是「系统」页里各功能自己的开关,与这份名单无关。
 *
 * 面板里列的是**全部**项(含藏起来的),排序也照排:这样可以先把一项摆到想要的位置,
 * 再决定要不要显示它,而不必为了调顺序先把它放出来。
 */
function NavEditor() {
	const tx = useT();

	const hidden = useNavStore((s) => s.hidden);
	const order = useNavStore((s) => s.order);
	const showAll = useNavStore((s) => s.showAll);
	const reorder = useNavStore((s) => s.reorder);
	const resetOrder = useNavStore((s) => s.resetOrder);

	// pointer 拖拽设 4px 启动阈值,免得点一下手柄被误判成拖拽;键盘可达走 KeyboardSensor。
	// 与 rules/MessageLayoutEditor 同一套参数。
	const sensors = useSensors(
		useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
		useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
	);

	const rows = orderedNav(NAV_ITEMS, order);

	function onDragEnd(e: DragEndEvent): void {
		const { active, over } = e;
		if (!over || active.id === over.id) return;
		reorder(String(active.id), String(over.id));
	}

	return (
		<PopoverShell align="right" variant="panel" layer="nav" surface="glass" className="w-60">
			<div className="flex items-center justify-between gap-1 px-1 py-1">
				<span className="text-bn-xs font-bold text-bn-text-secondary">
					{tx("panelUi.components.header.2")}
				</span>
				<div className="flex items-center gap-0.5">
					<Btn variant="ghost" size="sm" onClick={showAll}>
						{tx("panelUi.components.header.3")}
					</Btn>
					<Btn variant="ghost" size="sm" onClick={resetOrder}>
						{tx("panelUi.components.header.4")}
					</Btn>
				</div>
			</div>
			<DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
				<SortableContext items={rows.map((i) => i.to)} strategy={verticalListSortingStrategy}>
					{rows.map((item) => {
						const locked = !canHideNav(item.to);
						return (
							<NavEditorRow
								key={item.to}
								item={item}
								locked={locked}
								shown={locked || !hidden.includes(item.to)}
							/>
						);
					})}
				</SortableContext>
			</DndContext>
		</PopoverShell>
	);
}

const THEME_OPTIONS: ReadonlyArray<{ value: ThemePreference; label: string; hint: string }> = [
	{
		value: "system",
		get label() {
			return i18n.t("panelUi.components.header.5");
		},
		get hint() {
			return i18n.t("panelUi.components.header.6");
		},
	},
	{
		value: "light",
		get label() {
			return i18n.t("panelUi.components.header.7");
		},
		get hint() {
			return i18n.t("panelUi.components.header.8");
		},
	},
	{
		value: "dark",
		get label() {
			return i18n.t("panelUi.components.header.9");
		},
		get hint() {
			return i18n.t("panelUi.components.header.10");
		},
	},
];

function themeLabel(value: ThemePreference): string {
	return (
		THEME_OPTIONS.find((o) => o.value === value)?.label ?? i18n.t("panelUi.components.header.11")
	);
}

function ThemeSwitcher() {
	const tx = useT();

	const preference = useThemeStore((s) => s.preference);
	const resolved = useThemeStore((s) => s.resolved);
	const setPreference = useThemeStore((s) => s.setPreference);
	// 锁模式时切换无效,按钮置灰说明原因,而不是让用户点了没反应。
	// (已启用的皮肤按深浅槽各自生效,不锁 —— 锁只发生在试穿与编辑器里。)
	const lockedTheme = useSkinStore((s) => s.lockedTheme);
	// 两种锁法要说两句话:试穿是「这皮肤只有一套」,编辑器是「你正在编这一套」。
	// 编辑器抽屉里没有「应用/取消试穿」那两颗钮,照搬那句会让主人去找一个不存在的东西。
	const editing = useSkinStore((s) => s.editing);
	const [open, setOpen] = useState(false);
	const containerRef = useRef<HTMLDivElement | null>(null);
	const current = themeLabel(preference);

	// 点击下拉外部时关闭(与 Rules/draft-island 的下拉一致),仅在展开时挂监听。
	useDismiss(containerRef, () => setOpen(false), { enabled: open });

	if (lockedTheme) {
		return (
			<Btn
				variant="outline"
				size="sm"
				icon={
					<span className="bn-header-compact-icon">
						<Icon.sun size={16} />
					</span>
				}
				disabled
				title={
					editing
						? tx("panelUi.components.header.12", { value0: themeLabel(lockedTheme) })
						: tx("panelUi.components.header.13", { value0: themeLabel(lockedTheme) })
				}
			>
				<span className="bn-header-action-label">
					{tx("panelUi.components.header.14")}
					{themeLabel(lockedTheme)}(
					{editing ? tx("panelUi.components.header.15") : tx("panelUi.components.header.16")})
				</span>
			</Btn>
		);
	}

	return (
		<div className="relative" ref={containerRef}>
			<Btn
				variant="outline"
				size="sm"
				onClick={() => setOpen((v) => !v)}
				icon={
					<span className="bn-header-compact-icon">
						<Icon.sun size={16} />
					</span>
				}
				ariaHasPopup
				ariaExpanded={open}
				title={tx("panelUi.components.header.17", {
					value0: current,
					value1:
						preference === "system"
							? `(${resolved === "dark" ? tx("panelUi.components.header.18") : tx("panelUi.components.header.19")})`
							: "",
				})}
			>
				<span className="bn-header-action-label">
					{tx("panelUi.components.header.20")}
					{current}
				</span>
			</Btn>
			{open ? (
				<PopoverShell align="right" className="w-42">
					{THEME_OPTIONS.map((o) => {
						const active = o.value === preference;
						return (
							<MenuItem
								key={o.value}
								ariaLabel={o.label}
								active={active}
								onClick={() => {
									setPreference(o.value);
									setOpen(false);
								}}
							>
								{/* MenuItem 本体是横向 flex,两个兄弟 span 会被摆成左右两列互相挤 ——
								    标签和小字必须包进同一个块里才是上下两行。 */}
								<span className="block min-w-0">
									<span className="block">{o.label}</span>
									<span className="block text-bn-2xs font-normal text-bn-text-secondary">
										{o.hint}
									</span>
								</span>
							</MenuItem>
						);
					})}
				</PopoverShell>
			) : null}
		</div>
	);
}

/**
 * Dashboard logout (Q6). Icon-only, rightmost in the header cluster, rendered
 * only when auth is configured AND the session is authed. Lightweight 2-step
 * inline confirm (click → "确认登出?" ~3s → second click executes) — guards a
 * fat-finger from dropping unsaved edits, no modal infra.
 */
function LogoutButton() {
	const tx = useT();

	const qc = useQueryClient();
	const authRequired = useSessionStore((s) => s.authRequired);
	const authed = useSessionStore((s) => s.authed);
	const markLoggedOut = useSessionStore((s) => s.markLoggedOut);
	const [confirming, setConfirming] = useState(false);
	const [busy, setBusy] = useState(false);
	const revertTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(() => {
		return () => {
			if (revertTimer.current) clearTimeout(revertTimer.current);
		};
	}, []);

	if (!authRequired || !authed) return null;

	function armOrConfirm(): void {
		if (busy) return;
		if (!confirming) {
			setConfirming(true);
			if (revertTimer.current) clearTimeout(revertTimer.current);
			revertTimer.current = setTimeout(() => setConfirming(false), 3000);
			return;
		}
		if (revertTimer.current) clearTimeout(revertTimer.current);
		setBusy(true);
		void submitLogout().finally(() => {
			// authed=false → AuthGate effect tears the WS down + shows the
			// (cold) login card; drop cached server data so a re-login starts
			// from a clean slate.
			markLoggedOut();
			qc.clear();
		});
	}

	return (
		<>
			<span className="bn-header-logout-divider mx-1 h-5 w-px bg-bn-border" aria-hidden="true" />
			<Btn
				variant="outline"
				size="sm"
				icon={<Icon.logout size={14} />}
				onClick={armOrConfirm}
				disabled={busy}
				title={tx("panelUi.components.header.21")}
			>
				{confirming ? tx("panelUi.components.header.22") : ""}
			</Btn>
		</>
	);
}

/**
 * 那枚「服务器通不通」的徽章。两个分支此前各写一遍,共用一串 60 字符的类名 ——
 * 谁改了其中一边的内边距,页面就会在后端掉线的瞬间换个形状,而那正是最难复现的
 * 时刻。收成一处,两态就只剩 tone 一个差异。
 *
 * 不走库里的 `Pill`:那个是 `rounded-sm` 的实底/淡底徽章,这枚是带前导圆点的
 * 圆头状态条。圆点本身用库里的 `StatusDot`(`sm` 档,`ok` / `err` 走 token,
 * 跟皮肤换装)—— 它早已不是写死 hex。
 */
function ReachBadge({
	tone,
	title,
	children,
}: {
	tone: "success" | "danger";
	title?: string;
	children: ReactNode;
}) {
	const box =
		tone === "success"
			? "bg-bn-success-soft text-bn-success-text"
			: "bg-bn-danger-soft text-bn-danger-text";
	return (
		<span
			data-bn="badge"
			className={`bn-header-reach inline-flex items-center gap-1.5 rounded-bn-pill px-2.5 py-1 text-bn-xs font-semibold ${box}`}
			title={title ?? (typeof children === "string" ? children : undefined)}
		>
			{/* 那颗点用库里的 —— 尺寸阶梯与档位色都归 StatusDot 管,手画一颗就等着
			    它哪天改了阶梯而这里原地不动。 */}
			<StatusDot size="sm" kind={tone === "success" ? "ok" : "err"} />
			<span className="bn-header-action-label">{children}</span>
		</span>
	);
}

export function GlassHeader() {
	const tx = useT();
	const qc = useQueryClient();
	const reachable = useBackendReachable();
	// 皮肤文案槽:皮肤没给就用产品默认标题。
	const headerTitle = useSkinText("headerTitle") ?? tx("panelUi.components.header.23");
	const subs = useQuery({
		queryKey: ["subscriptions"],
		queryFn: () => api.get<Subscription[]>("/api/subscriptions"),
	});
	const targets = useQuery({
		queryKey: ["targets"],
		queryFn: () => api.get<PushTarget[]>("/api/targets"),
	});
	const counts = {
		subs: subs.data?.length ?? 0,
		targets: targets.data?.length ?? 0,
	};

	// 一级导航的选中态判定(见下方 navActive)。
	const { pathname } = useLocation();
	/**
	 * 刚点下的那一格 —— **不等路由**。
	 *
	 * `data-bn` 是静态属性,选中态由 pathname 手算;而路由切换有一段缝(真机量到
	 * ~58ms)。松手那一刻 `:active` 已经失效、`tab-active` 还没挂上,于是像素风皮肤
	 * 那种「按下位移 3px」的装会弹起来再按回去 —— 主人看到的是点一下抖一下
	 * (2026-08-24 真机:「按下,松手又弹起又按下」)。
	 *
	 * 皮肤修不了这个:CSS 选择器管不到「刚刚被点过」,那一帧元素身上既没有 `:active`
	 * 也没有 `tab-active`。
	 *
	 * 它只活到**路由第一次动**:pathname 一变就当场清掉。不能拿「点下时的 pathname
	 * 等不等于现在」判动没动 —— 点过去再按浏览器后退,pathname 正好回到点下时那个,
	 * 乐观值就复活了,页面回去了、高亮还留在点过的那格(issue #54)。所以比的是
	 * 「上一次渲染看见的 pathname」,在渲染里就地清(React 的「属性变了就调状态」写法),
	 * 不走 effect:effect 要等画完一帧才清,那一帧高亮就是错的。
	 */
	const [pressed, setPressed] = useState<string | null>(null);
	const [seenPathname, setSeenPathname] = useState(pathname);
	if (seenPathname !== pathname) {
		setSeenPathname(pathname);
		setPressed(null);
	}
	// 导航条显哪几项、按什么顺序 —— 纯本地偏好,见 config/nav.ts。
	const hiddenNav = useNavStore((s) => s.hidden);
	const navOrder = useNavStore((s) => s.order);
	const shownNav = resolveNav(NAV_ITEMS, { order: navOrder, hidden: hiddenNav });
	const [navEditorOpen, setNavEditorOpen] = useState(false);
	const navEditorRef = useRef<HTMLDivElement>(null);
	// The trigger and panel share one dismiss boundary; pressing the trigger must only toggle once.
	useDismiss(navEditorRef, () => setNavEditorOpen(false), {
		enabled: navEditorOpen,
		event: "pointerdown",
	});

	function refreshAll(): void {
		qc.invalidateQueries({ queryKey: ["health"] });
		qc.invalidateQueries({ queryKey: SOURCE_AUTH_QUERY_PREFIX });
		qc.invalidateQueries({ queryKey: ACCOUNTS_QUERY_KEY });
		qc.invalidateQueries({ queryKey: ["subscriptions"] });
		qc.invalidateQueries({ queryKey: ["targets"] });
	}

	const navRef = useRef<HTMLElement>(null);
	const [compactNav, setCompactNav] = useState(false);
	const measureNav = useCallback(() => {
		const nav = navRef.current;
		if (!nav || nav.clientWidth === 0) return;
		// Measure full labels even while icons are shown, before the browser paints.
		const hiddenLabels = Array.from(
			nav.querySelectorAll<HTMLElement>(".bn-header-nav-label[hidden]"),
		);
		for (const label of hiddenLabels) label.hidden = false;
		nav.setAttribute("data-measuring", "");
		try {
			setCompactNav(nav.scrollWidth > nav.clientWidth + 1);
		} finally {
			nav.removeAttribute("data-measuring");
			for (const label of hiddenLabels) label.hidden = true;
		}
	}, []);
	// Locale, visibility and count changes can change the natural content width.
	useLayoutEffect(measureNav);
	useLayoutEffect(() => {
		const nav = navRef.current;
		if (!nav) return;
		let active = true;
		const measure = () => {
			if (active) measureNav();
		};
		const observer =
			typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
		observer?.observe(nav);
		if (!observer) window.addEventListener("resize", measure);
		const fonts = document.fonts;
		fonts?.addEventListener("loadingdone", measure);
		void fonts?.ready.then(measure);
		return () => {
			active = false;
			observer?.disconnect();
			window.removeEventListener("resize", measure);
			fonts?.removeEventListener("loadingdone", measure);
		};
	}, [measureNav]);

	// 把 header 实测高度发布到 `--bn-header-h`,供页面内的 SectionNav 竖栏/横向条精确锚定
	// 吸顶位置(= header 高 + 间隔 = 元素自然起点)→ 滚动时零「往下带」,且账号名换行 / 窄视口
	// 按钮换行导致 header 变高时自动跟随。useLayoutEffect 在首帧 paint 前写入,避免回流闪烁。
	const headerRef = useRef<HTMLElement>(null);
	useLayoutEffect(() => {
		const el = headerRef.current;
		if (!el) return;
		const apply = () => {
			// offsetHeight 会取整；半像素误差会让吸顶导航在长短内容间切换时被容器底部推回。
			document.documentElement.style.setProperty(
				"--bn-header-h",
				`${el.getBoundingClientRect().height}px`,
			);
		};
		apply();
		if (typeof ResizeObserver === "undefined") {
			window.addEventListener("resize", apply);
			return () => window.removeEventListener("resize", apply);
		}
		const ro = new ResizeObserver(apply);
		ro.observe(el);
		return () => ro.disconnect();
	}, []);

	return (
		<header
			ref={headerRef}
			data-bn="header"
			// z-bn-header:卡在**页面内容**(最高 z-bn-nav,TabBarShell 给「添加 UP」下拉留的)之上、
			// **覆盖层**(z-bn-scrim 起:AI 抽屉/弹窗/toast/灵动岛)之下。原先是 z-bn-raised,比页面
			// 内容还低 —— 往下滚,tab 条整条画在吸顶顶栏之上,把主导航切掉一截。
			className="bn-header bn-glass-strong sticky top-0 z-bn-header shadow-bn-card"
		>
			<div className="bn-header-top flex items-center justify-between">
				<div className="bn-header-brand flex min-w-0 items-center gap-3">
					<div className="flex h-13 shrink-0 items-center px-1">
						<img alt="Bilibili Notify" src="/logo.png" className="h-13 w-auto object-contain" />
					</div>
					<div className="min-w-0">
						<div
							title={headerTitle}
							className="bn-header-title text-bn-lg font-bold tracking-tight text-bn-text-primary"
						>
							{headerTitle}
						</div>
						<div className="mt-0.5 min-w-0 text-bn-xs text-bn-text-secondary">
							<AccountChip />
						</div>
					</div>
				</div>
				<fieldset
					aria-label={tx("problems.headerActions")}
					className="bn-header-actions flex min-w-0 shrink-0 items-center"
				>
					<ProblemBox />
					{/*
					 * 这枚徽章只回答一件事:`/api/health` 通不通(见 useBackendReachable)。
					 * 它曾经写着「推送服务运行中」,被读成了推送的启停开关 —— 而推送开没开
					 * 是每位 UP 各自的 features,跟这里毫无关系。措辞必须落在「服务器」上。
					 */}
					{reachable ? (
						<ReachBadge tone="success" title={tx("panelUi.components.header.24")}>
							{tx("panelUi.components.header.25")}
						</ReachBadge>
					) : (
						<ReachBadge tone="danger">{tx("panelUi.components.header.26")}</ReachBadge>
					)}
					<ThemeSwitcher />
					<Btn variant="outline" size="sm" icon={<Icon.refresh size={14} />} onClick={refreshAll}>
						<span className="bn-header-action-label">{tx("panelUi.components.header.27")}</span>
					</Btn>
					<NavLink to="/subs">
						<Btn variant="primary" size="sm" icon={<Icon.plus size={14} />}>
							<span className="bn-header-action-label">{tx("panelUi.components.header.28")}</span>
						</Btn>
					</NavLink>
					<LogoutButton />
				</fieldset>
			</div>
			{/* 挂 `nav` 挂点 —— 次级导航(TabBarShell / SectionNav)都挂了,唯独这条
			    一级导航没挂。皮肤给 nav 画底色/描边时,Rules 的作用域条、Targets 的
			    分区列表都换装,顶栏这排纹丝不动 —— 两者常常同屏,比"全都不生效"更露馅。 */}
			<nav
				ref={navRef}
				data-bn="nav"
				data-compact={compactNav || undefined}
				className="bn-header-nav relative flex"
			>
				{shownNav.map((t) => {
					// data-bn 是静态属性,NavLink 的 isActive 回调塞不进去 —— 选中态自己算。
					// 除精确匹配外把子路径也算给父项(/about/guide/push 亮「关于」);
					// "/" 排除在前缀判定外,不然它永远全亮。
					const current = pressed ?? pathname;
					const navActive = current === t.to || (t.to !== "/" && current.startsWith(`${t.to}/`));
					const Glyph = Icon[t.icon ?? "square"];
					return (
						<NavLink
							key={t.to}
							to={t.to}
							aria-label={t.countKey ? `${t.label} ${counts[t.countKey]}` : t.label}
							title={t.label}
							end
							// tab 家族挂点(曾挂 btn,皮肤按钮实底把整排一级导航画成一排按钮)。
							data-bn={navActive ? "tab tab-active" : "tab"}
							// 新手导览的指路挂点:子步不在目标路由时,聚光灯照到对应页签上
							// 让用户自己点过去(tour-companion 的 Spotlight 按此选择器解析)。
							data-tour-nav={t.to}
							onClick={(e) => {
								// 带修饰键的点击是「在新标签打开」—— 这一页的路由压根不变,
								// 乐观值留在那一格上就会一直指错,而且没有下一次 pathname
								// 变化来清它。
								if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
								setPressed(t.to);
							}}
							className={`bn-header-tab relative flex items-center gap-1.5 text-bn-base transition ${
								navActive
									? "font-bold text-bn-pink"
									: "font-medium text-bn-text-tertiary hover:text-bn-text-primary"
							}`}
						>
							<Glyph size={16} className="shrink-0" />
							<span className="bn-header-nav-label" hidden={compactNav}>
								{t.label}
							</span>
							{t.countKey ? (
								// 选中态**不自带颜色**,底与字都跟着这一格自己的文字色走。此前写死
								// `text-bn-pink`,等于假设「选中格的背景仍是页面底色」—— 皮肤把
								// tab-active 画成实心粉块之后这个假设就破了:粉纱铺在粉块上还是粉,
								// 粉字落上去正好隐形(2026-08-24 主人真机指出「未选中看得见数字,
								// 选中就没了」)。跟随之后可读性搭在「选中格的字本来就得看得清」
								// 这条既有不变量上,皮肤把 tab-active 改成什么色都不会掉队。
								// 未选中态反过来要自带:那时父色是 tertiary 浅灰,跟着走会糊成一团。
								<span
									className={`bn-header-nav-count rounded-lg text-bn-2xs font-bold ${
										navActive ? "bg-current/15" : "bg-bn-code-bg text-bn-text-secondary"
									}`}
								>
									{counts[t.countKey]}
								</span>
							) : null}
							<span
								className={`absolute inset-x-2 -bottom-px h-0.5 rounded-full transition ${
									navActive ? "bg-bn-pink" : "bg-transparent"
								}`}
							/>
						</NavLink>
					);
				})}
				{/* 挑标签的入口。贴在导航条右端 —— 它讲的就是这一条的事,摆在别处得先
				    让人找。图标按钮而非文字,免得这个「让界面别那么满」的功能自己先占一格。 */}
				<div ref={navEditorRef} className="bn-header-nav-editor relative self-center">
					<Btn
						variant="ghost"
						size="sm"
						icon={<Icon.sliders size={14} />}
						title={tx("panelUi.components.header.29")}
						onClick={() => setNavEditorOpen((v) => !v)}
					/>
					{navEditorOpen ? <NavEditor /> : null}
				</div>
			</nav>
		</header>
	);
}
