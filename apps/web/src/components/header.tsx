import { Btn, Icon, MenuItem, PopoverShell } from "@bilibili-notify/ui";
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
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { NavLink } from "react-router-dom";
import { canHideNav, NAV_ITEMS, type NavItem, orderedNav, resolveNav } from "../config/nav";
import { useBackendReachable } from "../hooks/useBackendReachable";
import { api } from "../services/api";
import { submitLogout } from "../services/session";
import { useAuthStore } from "../store/auth";
import { useNavStore } from "../store/nav";
import { useSessionStore } from "../store/session";
import { useSkinStore, useSkinText } from "../store/skin";
import { type ThemePreference, useThemeStore } from "../store/theme";
import { BiliLoginStatus } from "../types/auth";
import type { PushTarget, Subscription } from "../types/domain";
import { DragHandle } from "./drag-handle";

interface UserCardData {
	card?: {
		mid?: string;
		name?: string;
		face?: string;
	};
}

/**
 * 面板里的一行 —— ⠿ 拖动排序 + 勾选显隐。
 *
 * `useSortable` 必须 per-item,所以单抽一个组件(同 `cards/BlockListEditor`)。
 * 拖拽手柄只绑在 ⠿ 上,勾选框照常点得动。
 */
function NavEditorRow({ item, shown, locked }: { item: NavItem; shown: boolean; locked: boolean }) {
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
				title={locked ? "「系统」不能隐藏 —— 否则就没地方把别的改回来了" : undefined}
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
function NavEditor({ onClose }: { onClose: () => void }) {
	const hidden = useNavStore((s) => s.hidden);
	const order = useNavStore((s) => s.order);
	const showAll = useNavStore((s) => s.showAll);
	const reorder = useNavStore((s) => s.reorder);
	const resetOrder = useNavStore((s) => s.resetOrder);
	const ref = useRef<HTMLDivElement>(null);

	// pointer 拖拽设 4px 启动阈值,免得点一下手柄被误判成拖拽;键盘可达走 KeyboardSensor。
	// 与 cards/BlockListEditor 同一套参数。
	const sensors = useSensors(
		useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
		useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
	);

	// 点外面就收起来。面板本身不拦点击 —— 勾完一项还想勾下一项,不该每次都重新展开。
	useEffect(() => {
		function onDocPointerDown(e: PointerEvent): void {
			if (!ref.current?.contains(e.target as Node)) onClose();
		}
		document.addEventListener("pointerdown", onDocPointerDown);
		return () => document.removeEventListener("pointerdown", onDocPointerDown);
	}, [onClose]);

	const rows = orderedNav(NAV_ITEMS, order);

	function onDragEnd(e: DragEndEvent): void {
		const { active, over } = e;
		if (!over || active.id === over.id) return;
		reorder(String(active.id), String(over.id));
	}

	return (
		<PopoverShell
			ref={ref}
			align="right"
			variant="panel"
			layer="nav"
			surface="glass"
			className="w-60"
		>
			<div className="flex items-center justify-between gap-1 px-1 py-1">
				<span className="text-bn-xs font-bold text-bn-text-secondary">标签显示与排序</span>
				<div className="flex items-center gap-0.5">
					<Btn variant="ghost" size="sm" onClick={showAll}>
						全部显示
					</Btn>
					<Btn variant="ghost" size="sm" onClick={resetOrder}>
						默认顺序
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

function AccountChip() {
	const snapshot = useAuthStore((s) => s.snapshot);
	const loggedIn = snapshot?.status === BiliLoginStatus.LOGGED_IN;
	const card = loggedIn ? (snapshot?.data as UserCardData | undefined)?.card : undefined;
	const name = card?.name;
	const face = card?.face;
	if (loggedIn && name) {
		return (
			<span>
				当前账号 <span className="font-bold text-bn-pink">{name}</span> 已登录
				{face ? (
					<img
						alt={name}
						src={face}
						referrerPolicy="no-referrer"
						data-bn="avatar"
						className="ml-2 inline-block h-5 w-5 rounded-full"
					/>
				) : null}
			</span>
		);
	}
	return (
		<span>
			女仆为您打理一切～(*´∀`)~♡{" "}
			<span className="text-bn-text-secondary">{snapshot?.msg ?? "登录态加载中"}</span>
		</span>
	);
}

const THEME_OPTIONS: ReadonlyArray<{ value: ThemePreference; label: string; hint: string }> = [
	{ value: "system", label: "跟随系统", hint: "自动跟随系统外观" },
	{ value: "light", label: "浅色", hint: "固定使用亮色主题" },
	{ value: "dark", label: "深色", hint: "固定使用深色主题" },
];

function themeLabel(value: ThemePreference): string {
	return THEME_OPTIONS.find((o) => o.value === value)?.label ?? "跟随系统";
}

function ThemeSwitcher() {
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
	useEffect(() => {
		if (!open) return;
		function handleDocClick(e: MouseEvent) {
			if (!containerRef.current) return;
			if (!containerRef.current.contains(e.target as Node)) setOpen(false);
		}
		document.addEventListener("mousedown", handleDocClick);
		return () => document.removeEventListener("mousedown", handleDocClick);
	}, [open]);

	if (lockedTheme) {
		return (
			<Btn
				variant="outline"
				size="sm"
				disabled
				title={
					editing
						? `正在编辑这套皮肤的${themeLabel(lockedTheme)},抽屉顶部换一套即可切换`
						: `试穿中的皮肤只有${themeLabel(lockedTheme)}一套,应用或取消试穿即可切换`
				}
			>
				主题：{themeLabel(lockedTheme)}({editing ? "编辑中" : "试穿锁定"})
			</Btn>
		);
	}

	return (
		<div className="relative" ref={containerRef}>
			<Btn
				variant="outline"
				size="sm"
				onClick={() => setOpen((v) => !v)}
				ariaHasPopup
				ariaExpanded={open}
				title={`当前外观:${current}${preference === "system" ? `(${resolved === "dark" ? "深色" : "浅色"})` : ""}`}
			>
				主题：{current}
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
								<span className="block">{o.label}</span>
								<span className="block text-bn-2xs font-normal text-bn-text-secondary">
									{o.hint}
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
			<span className="mx-1 h-5 w-px bg-bn-border" aria-hidden="true" />
			<Btn
				variant="outline"
				size="sm"
				icon={<Icon.logout size={14} />}
				onClick={armOrConfirm}
				disabled={busy}
				title="登出 Dashboard"
			>
				{confirming ? "确认登出?" : ""}
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
 * 圆头状态条。也不走 `StatusDot` 当圆点:它是 2×2 的**写死 hex**,换过去等于把
 * 这里的 `bg-bn-success` / `bg-bn-danger` token 降级成不跟主题走的颜色。
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
	const cls =
		tone === "success"
			? { box: "bg-bn-success-soft text-bn-success-text", dot: "bg-bn-success" }
			: { box: "bg-bn-danger-soft text-bn-danger-text", dot: "bg-bn-danger" };
	return (
		<span
			className={`inline-flex items-center gap-1.5 rounded-bn-pill px-2.5 py-1 text-bn-xs font-semibold ${cls.box}`}
			title={title}
		>
			<span className={`h-1.5 w-1.5 rounded-full ${cls.dot}`} />
			{children}
		</span>
	);
}

export function GlassHeader() {
	const qc = useQueryClient();
	const reachable = useBackendReachable();
	// 皮肤文案槽:皮肤没给就用产品默认标题。
	const headerTitle = useSkinText("headerTitle") ?? "Bilibili Notify · 女仆值班室";
	const subs = useQuery({
		queryKey: ["subscriptions"],
		queryFn: () => api.get<Subscription[]>("/api/subs"),
	});
	const targets = useQuery({
		queryKey: ["targets"],
		queryFn: () => api.get<PushTarget[]>("/api/targets"),
	});
	const counts = {
		subs: subs.data?.length ?? 0,
		targets: targets.data?.length ?? 0,
	};

	// 导航条显哪几项、按什么顺序 —— 纯本地偏好,见 config/nav.ts。
	const hiddenNav = useNavStore((s) => s.hidden);
	const navOrder = useNavStore((s) => s.order);
	const shownNav = resolveNav(NAV_ITEMS, { order: navOrder, hidden: hiddenNav });
	const [navEditorOpen, setNavEditorOpen] = useState(false);

	function refreshAll(): void {
		qc.invalidateQueries({ queryKey: ["health"] });
		qc.invalidateQueries({ queryKey: ["auth-status"] });
		qc.invalidateQueries({ queryKey: ["subscriptions"] });
		qc.invalidateQueries({ queryKey: ["targets"] });
	}

	// 把 header 实测高度发布到 `--bn-header-h`,供页面内的 SectionNav 竖栏/横向条精确锚定
	// 吸顶位置(= header 高 + 间隔 = 元素自然起点)→ 滚动时零「往下带」,且账号名换行 / 窄视口
	// 按钮换行导致 header 变高时自动跟随。useLayoutEffect 在首帧 paint 前写入,避免回流闪烁。
	const headerRef = useRef<HTMLElement>(null);
	useLayoutEffect(() => {
		const el = headerRef.current;
		if (!el) return;
		const apply = () => {
			document.documentElement.style.setProperty("--bn-header-h", `${el.offsetHeight}px`);
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
			className="bn-glass-strong sticky top-0 z-bn-header shadow-bn-card"
		>
			<div className="flex items-center justify-between gap-4 px-7 pt-4">
				<div className="flex min-w-0 items-center gap-3">
					<div className="flex h-13 items-center px-1">
						<img alt="Bilibili Notify" src="/logo.png" className="h-13 w-auto object-contain" />
					</div>
					<div className="min-w-0">
						<div className="text-bn-lg font-bold tracking-tight text-bn-text-primary">
							{headerTitle}
						</div>
						<div className="mt-0.5 truncate text-bn-xs text-bn-text-secondary">
							<AccountChip />
						</div>
					</div>
				</div>
				<div className="flex shrink-0 items-center gap-2">
					{/*
					 * 这枚徽章只回答一件事:`/api/health` 通不通(见 useBackendReachable)。
					 * 它曾经写着「推送服务运行中」,被读成了推送的启停开关 —— 而推送开没开
					 * 是每位 UP 各自的 features,跟这里毫无关系。措辞必须落在「服务器」上。
					 */}
					{reachable ? (
						<ReachBadge
							tone="success"
							title="后端服务可访问。与推送开关无关 —— 推送是否启用见各 UP 的规则设置。"
						>
							服务器运行中
						</ReachBadge>
					) : (
						<ReachBadge tone="danger">服务器失联</ReachBadge>
					)}
					<ThemeSwitcher />
					<Btn variant="outline" size="sm" icon={<Icon.refresh size={14} />} onClick={refreshAll}>
						刷新
					</Btn>
					<NavLink to="/subs">
						<Btn variant="primary" size="sm" icon={<Icon.plus size={14} />}>
							添加 UP 主
						</Btn>
					</NavLink>
					<LogoutButton />
				</div>
			</div>
			{/* 挂 `nav` 挂点 —— 次级导航(TabBarShell / SectionNav)都挂了,唯独这条
			    一级导航没挂。皮肤给 nav 画底色/描边时,Rules 的作用域条、Targets 的
			    分区列表都换装,顶栏这排纹丝不动 —— 两者常常同屏,比"全都不生效"更露馅。 */}
			<nav data-bn="nav" className="relative flex gap-0 px-5 pt-3">
				{shownNav.map((t) => (
					<NavLink
						key={t.to}
						to={t.to}
						end
						data-bn="btn"
						className={({ isActive }) =>
							`relative flex items-center gap-1.5 px-4 py-2.5 text-bn-base transition ${
								isActive
									? "font-bold text-bn-pink"
									: "font-medium text-bn-text-tertiary hover:text-bn-text-primary"
							}`
						}
					>
						{({ isActive }) => (
							<>
								{t.label}
								{t.countKey ? (
									<span
										className={`rounded-lg px-1.5 py-px text-bn-2xs font-bold ${
											isActive
												? "bg-bn-pink/15 text-bn-pink"
												: "bg-bn-code-bg text-bn-text-secondary"
										}`}
									>
										{counts[t.countKey]}
									</span>
								) : null}
								<span
									className={`absolute inset-x-2 -bottom-px h-0.5 rounded-full transition ${
										isActive ? "bg-bn-pink" : "bg-transparent"
									}`}
								/>
							</>
						)}
					</NavLink>
				))}
				{/* 挑标签的入口。贴在导航条右端 —— 它讲的就是这一条的事,摆在别处得先
				    让人找。图标按钮而非文字,免得这个「让界面别那么满」的功能自己先占一格。 */}
				<div className="relative ml-auto self-center">
					<Btn
						variant="ghost"
						size="sm"
						icon={<Icon.sliders size={14} />}
						title="挑要显示的标签"
						onClick={() => setNavEditorOpen((v) => !v)}
					/>
					{navEditorOpen ? <NavEditor onClose={() => setNavEditorOpen(false)} /> : null}
				</div>
			</nav>
		</header>
	);
}
