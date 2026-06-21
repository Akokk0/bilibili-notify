import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";

/**
 * SectionNav —— Rules / Targets / Logs 三页共用的「分区/Tab 导航」。
 *
 * 双形态(断点 xl=1280,与页面级 `grid xl:grid-cols-[220px_1fr]` 对齐):
 * - xl 以上(桌面):左侧竖向 `aside` 富列表,保持各页原观感。
 * - xl 以下(iPad 等窄视口):顶部横向可滚 chip 条。
 *
 * 修复要点:横向条 `sticky top-30` 的同时带「不透明背景 + backdrop-blur + z-index」,
 * 让下方内容滚动时从其下方穿过,而不是覆盖被钉住的 Tab —— 根治窄视口下的坍缩。
 * (旧实现是无条件 `sticky` 的竖栏,单列时被钉住又无背景/层级,被内容从下往上盖住。)
 */

export interface SectionNavItem {
	id: string;
	label: string;
	/** 仅在竖栏(xl+)显示的副标题;横向 chip 省略以保持条矮。 */
	desc?: string;
	/** 已渲染的图标 glyph(调用方控制大小/字重)。 */
	icon?: ReactNode;
	/** 图标底色 tint(hex);给则把图标包进一个 tinted 圆角盒(Targets 平台色)。 */
	iconTint?: string;
	/** 标题旁内联角标(Rules 覆盖红点 / Targets「(停用)」)。 */
	badge?: ReactNode;
}

export interface SectionNavProps {
	heading: ReactNode;
	items: SectionNavItem[];
	activeId: string | null;
	onPick: (id: string) => void;
	/** 可选「新建」动作。竖栏渲染 heading 行按钮,横向渲染尾部 dashed chip。 */
	onAdd?: () => void;
	addLabel?: string;
	/** items 为空时竖栏显示的占位(Targets 空态)。 */
	emptyState?: ReactNode;
}

const RAIL_ITEM_BASE =
	"flex w-full min-w-0 items-start gap-2.5 rounded-[9px] border px-3 py-2.5 text-left transition";
const RAIL_ITEM_ACTIVE = "border-bn-pink/35 bg-bn-surface/90 shadow-[0_2px_8px_rgba(0,0,0,0.04)]";
const RAIL_ITEM_IDLE = "border-transparent hover:bg-bn-surface/55";

// 吸顶位置 = header 实测高(`--bn-header-h`,由 GlassHeader 用 ResizeObserver 发布) + 1.5rem 间隔。
// 该 1.5rem 与页面 `<main>` 的 pt-6 一致,故吸顶位恰好等于 Tab 在文档流中的自然起点 ——
// sticky 从第一像素滚动即钉住,不再「先随内容往下带一段再钉住」;header 高度变化时自动跟随。
// fallback 7.5rem 仅用于 header 尚未测量的首帧(estimate),测量落定后被实测值取代。
const STICKY_TOP = "calc(var(--bn-header-h, 7.5rem) + 1.5rem)";

const CHIP_BASE =
	"flex shrink-0 items-center gap-1.5 rounded-lg border px-3 py-1.5 text-[12.5px] font-bold transition";
const CHIP_ACTIVE = "border-bn-pink/40 bg-bn-pink/10 text-bn-pink";
const CHIP_IDLE =
	"border-transparent text-bn-text-secondary hover:bg-bn-surface/70 hover:text-bn-text-primary";

function Chevron({ dir }: { dir: "left" | "right" }) {
	return (
		<svg
			viewBox="0 0 24 24"
			width={16}
			height={16}
			fill="none"
			stroke="currentColor"
			strokeWidth={2.4}
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
			focusable="false"
		>
			<path d={dir === "left" ? "m15 18-6-6 6-6" : "m9 18 6-6-6-6"} />
		</svg>
	);
}

function IconBox({ icon, tint, active }: { icon: ReactNode; tint?: string; active: boolean }) {
	if (icon == null) return null;
	if (tint) {
		return (
			<span
				className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-[5px]"
				style={{ background: `${tint}1f` }}
			>
				{icon}
			</span>
		);
	}
	return (
		<span
			className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center ${
				active ? "text-bn-pink" : "text-bn-text-secondary"
			}`}
		>
			{icon}
		</span>
	);
}

export function SectionNav({
	heading,
	items,
	activeId,
	onPick,
	onAdd,
	addLabel = "+ 新建",
	emptyState,
}: SectionNavProps) {
	// 横向条(窄视口)左右滚动:隐藏滚动条,改用两端箭头按钮,仅在该方向可滚时出现。
	const scrollRef = useRef<HTMLDivElement>(null);
	const [edges, setEdges] = useState({ left: false, right: false });

	const recompute = useCallback(() => {
		const el = scrollRef.current;
		if (!el) return;
		const left = el.scrollLeft > 1;
		const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
		setEdges((prev) => (prev.left === left && prev.right === right ? prev : { left, right }));
	}, []);

	useEffect(() => {
		const el = scrollRef.current;
		if (!el) return;
		recompute();
		if (typeof ResizeObserver === "undefined") {
			window.addEventListener("resize", recompute);
			return () => window.removeEventListener("resize", recompute);
		}
		const ro = new ResizeObserver(recompute);
		ro.observe(el);
		return () => ro.disconnect();
	}, [recompute]);

	// items 变化(数量/宽度)后重算箭头可见性。
	// biome-ignore lint/correctness/useExhaustiveDependencies: 需在 items 变化时重算
	useEffect(recompute, [recompute, items]);

	const scrollByDir = (dir: -1 | 1) => {
		const el = scrollRef.current;
		if (!el) return;
		el.scrollBy({ left: dir * el.clientWidth * 0.75, behavior: "smooth" });
	};

	return (
		// 单根:xl 下是 block,在 `grid xl:grid-cols-[220px_1fr]` 里占左列 col1。
		// xl 以下用 `contents`(不生成盒子),让横向条直接成为 grid 子项 —— 否则它的包含块
		// 只有「自身高度的矮格子」,sticky 无吸附空间,长内容页一滚就被矮格子拖走。
		// contents 后包含块变成整个 grid(与内容等高),sticky 才能真正吸顶整段滚动。
		<div data-section-nav="root" className="contents xl:block xl:min-w-0">
			{/* 竖栏(桌面 xl+) */}
			<aside
				data-section-nav="rail"
				style={{ top: STICKY_TOP }}
				className="sticky hidden h-fit min-w-0 xl:block"
			>
				<div className="mb-2 flex items-center justify-between px-1">
					<span className="text-[11px] font-bold uppercase tracking-wider text-bn-text-tertiary">
						{heading}
					</span>
					{onAdd ? (
						<button
							type="button"
							onClick={onAdd}
							className="rounded-md border border-dashed border-bn-border px-2 py-0.5 text-[10.5px] font-bold text-bn-text-secondary transition hover:border-bn-pink hover:text-bn-pink"
						>
							{addLabel}
						</button>
					) : null}
				</div>
				{items.length === 0 ? (
					(emptyState ?? null)
				) : (
					<div className="flex flex-col gap-1">
						{items.map((item) => {
							const active = activeId === item.id;
							return (
								<button
									type="button"
									key={item.id}
									onClick={() => onPick(item.id)}
									aria-current={active ? "true" : undefined}
									className={`${RAIL_ITEM_BASE} ${active ? RAIL_ITEM_ACTIVE : RAIL_ITEM_IDLE}`}
								>
									<IconBox icon={item.icon} tint={item.iconTint} active={active} />
									<span className="block min-w-0 flex-1">
										<span
											className={`flex items-center gap-1.5 text-[12.5px] font-bold ${
												active ? "text-bn-pink" : "text-bn-text-primary"
											}`}
										>
											<span className="truncate">{item.label}</span>
											{item.badge}
										</span>
										{item.desc ? (
											<span className="mt-0.5 block wrap-break-word text-[10.5px] leading-snug text-bn-text-tertiary">
												{item.desc}
											</span>
										) : null}
									</span>
								</button>
							);
						})}
					</div>
				)}
			</aside>

			{/* 横向条(窄视口 < xl):sticky + 背景 + z-index → 内容从其下穿过,不再覆盖。
			    左右两端用箭头按钮滚动,隐藏原生滚动条(bn-no-scrollbar)。 */}
			<div
				data-section-nav="bar"
				style={{ top: STICKY_TOP }}
				className="sticky z-20 rounded-[11px] border border-bn-border-subtle bg-bn-surface/70 backdrop-blur-sm xl:hidden"
			>
				<div className="relative flex items-center">
					{edges.left ? (
						<div className="absolute inset-y-0 left-0 z-10 flex items-center rounded-l-[11px] bg-linear-to-r from-bn-surface via-bn-surface/85 to-transparent pr-6 pl-1">
							<button
								type="button"
								aria-label="向左滚动"
								onClick={() => scrollByDir(-1)}
								className="grid h-7 w-7 shrink-0 place-items-center rounded-full border border-bn-border-subtle bg-bn-surface text-bn-text-secondary shadow-[0_2px_8px_rgba(0,0,0,0.1)] transition hover:text-bn-pink"
							>
								<Chevron dir="left" />
							</button>
						</div>
					) : null}

					<div
						ref={scrollRef}
						onScroll={recompute}
						className="bn-no-scrollbar flex items-center gap-1.5 overflow-x-auto scroll-smooth p-1.5"
					>
						{items.map((item) => {
							const active = activeId === item.id;
							return (
								<button
									type="button"
									key={item.id}
									onClick={() => onPick(item.id)}
									aria-current={active ? "true" : undefined}
									className={`${CHIP_BASE} ${active ? CHIP_ACTIVE : CHIP_IDLE}`}
								>
									{item.icon != null ? (
										<span className="grid h-4 w-4 shrink-0 place-items-center">{item.icon}</span>
									) : null}
									<span className="whitespace-nowrap">{item.label}</span>
									{item.badge}
								</button>
							);
						})}
						{onAdd ? (
							<button
								type="button"
								onClick={onAdd}
								className="flex shrink-0 items-center gap-1 rounded-lg border border-dashed border-bn-border px-3 py-1.5 text-[12.5px] font-bold text-bn-text-secondary transition hover:border-bn-pink hover:text-bn-pink"
							>
								{addLabel}
							</button>
						) : null}
					</div>

					{edges.right ? (
						<div className="absolute inset-y-0 right-0 z-10 flex items-center rounded-r-[11px] bg-linear-to-l from-bn-surface via-bn-surface/85 to-transparent pr-1 pl-6">
							<button
								type="button"
								aria-label="向右滚动"
								onClick={() => scrollByDir(1)}
								className="grid h-7 w-7 shrink-0 place-items-center rounded-full border border-bn-border-subtle bg-bn-surface text-bn-text-secondary shadow-[0_2px_8px_rgba(0,0,0,0.1)] transition hover:text-bn-pink"
							>
								<Chevron dir="right" />
							</button>
						</div>
					) : null}
				</div>
			</div>
		</div>
	);
}
