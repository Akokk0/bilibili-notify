import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { AddButton, IconButton } from "./atoms";

/**
 * SectionNav —— Rules / Targets / Logs 三页共用的「分区/Tab 导航」。
 *
 * 双形态(断点 xl=1280,与页面级 `grid xl:grid-bn-rail` 对齐):
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
	/**
	 * 图标底色 tint;给则把图标包进一个 tinted 圆角盒(Targets 平台色)。
	 * 十六进制与 `var(--color-bn-*)` 都收 —— 透明度走 `color-mix()` 现调。
	 */
	iconTint?: string;
	/** 标题旁内联角标(Rules 覆盖点 / Targets「(停用)」)。 */
	badge?: ReactNode;
}

/**
 * 左栏项旁边那颗小点 —— 「这一项有点特别」的通用记号,喂给 `badge`。
 *
 * 站内两处语义不同但视觉语汇相同:Rules 的「该 UP 主覆盖了这一项」、AI 页的
 * 「女仆平时用的就是这个」。抽出来是为了让观感**只有一处定义** —— 各页自己画的话
 * 立刻就会飘(AI 页那颗一开始画成 8px 绿点,摆在一起明显不是一路)。
 *
 * 纯色块对读屏器等于不存在,所以 `title` 同时喂给 `aria-label`。
 */
export function RailDot({ title }: { title: string }) {
	return (
		<span
			data-rail-dot
			role="img"
			aria-label={title}
			title={title}
			className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-bn-pink"
		/>
	);
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
	"flex w-full min-w-0 items-start gap-2.5 rounded-bn-sm border px-3 py-2.5 text-left transition";
/**
 * 选中态的前景色写在**挂点元素**上,图标与标题继承 —— 别写死在子元素里。
 *
 * 皮肤只够得到挂着 `data-bn` 的那一层:清洗层要求复合选择器每一段都带 hook,
 * `[data-bn~="nav-item-active"] span` 这种压根进不来。颜色写死在子 span 上的话,
 * 皮肤把选中项画成实底也改不了字色 —— 2026-08-24 主人要「选中项变成粉色按钮」,
 * 而那会得到粉底粉字,一个字都看不见。
 *
 * chip 形态(窄视口)一直是这么写的,这一行是让竖栏跟上。外观不变:图标与标题选中态
 * 本来都是 `text-bn-pink`。
 */
const RAIL_ITEM_ACTIVE = "border-bn-pink/35 bg-bn-surface/90 text-bn-pink shadow-bn-card";
const RAIL_ITEM_IDLE = "border-transparent hover:bg-bn-surface/55";

// 吸顶位置 = header 实测高(`--bn-header-h`,由 GlassHeader 用 ResizeObserver 发布) + 1.5rem 间隔。
// 该 1.5rem 与页面 `<main>` 的 pt-6 一致,故吸顶位恰好等于 Tab 在文档流中的自然起点 ——
// sticky 从第一像素滚动即钉住,不再「先随内容往下带一段再钉住」;header 高度变化时自动跟随。
// fallback 7.5rem 仅用于 header 尚未测量的首帧(estimate),测量落定后被实测值取代。
const STICKY_TOP = "calc(var(--bn-header-h, 7.5rem) + 1.5rem)";

const CHIP_BASE =
	"flex shrink-0 items-center gap-1.5 rounded-lg border px-3 py-1.5 text-bn-sm font-bold transition";
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
				className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-bn-xs"
				style={{ background: `color-mix(in srgb, ${tint} 12%, transparent)` }}
			>
				{icon}
			</span>
		);
	}
	return (
		<span
			// 选中态**不写色**:继承挂点元素那一层(见 RAIL_ITEM_ACTIVE)。未选中态两者
			// 不同色(图标 secondary、标题 primary),所以只有选中态能统一继承。
			className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center ${
				active ? "" : "text-bn-text-secondary"
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
		// 单根:xl 下是 block,在 `grid xl:grid-bn-rail` 里占左列 col1。
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
					{/* 这行标题**坐在页面背景上**(见下方 nav 挂点那段:它刻意留在挂点外面),
					    所以没有任何底托着它。壁纸皮肤下 tertiary 那一档只剩 2.1~2.7:1,
					    secondary 在壁纸深处也才 3.3:1 —— 无底的文字只有 primary 稳。
					    卡在 nav 里的那些项不受影响,它们有皮肤给的底。 */}
					<span className="text-bn-xs font-bold uppercase tracking-wider text-bn-text-primary">
						{heading}
					</span>
					{onAdd ? <AddButton onClick={onAdd}>{addLabel}</AddButton> : null}
				</div>
				{/* nav 挂点只裹 tab 列表本身 —— 上面那行 heading 留在外面,否则皮肤给 nav
				    画的底色/描边会把小标题一起罩进去,看着像标题掉进了 tab 卡里。
				    空态也包在里面:挂点是公开 API,不能因为「这页还没内容」就消失。
				    rounded-2xl 默认不可见(无底无边),是给皮肤 CSS 的形状底座 ——
				    没圆角的话皮肤描边会画出直角方框(avatar 同款坑)。 */}
				<div className="flex flex-col gap-1 rounded-2xl" data-bn="nav">
					{items.length === 0
						? (emptyState ?? null)
						: items.map((item) => {
								const active = activeId === item.id;
								return (
									<button
										type="button"
										key={item.id}
										onClick={() => onPick(item.id)}
										aria-current={active ? "true" : undefined}
										// 导航行不是按钮 —— 挂 btn 会让皮肤的按钮实底把每一行画成一颗
										// 按钮(2026-08-23 主人真机指出)。选中态走多挂点:清洗层不放行
										// 属性选择器,皮肤够不到 aria-current。
										data-bn={active ? "nav-item nav-item-active" : "nav-item"}
										className={`${RAIL_ITEM_BASE} ${active ? RAIL_ITEM_ACTIVE : RAIL_ITEM_IDLE}`}
									>
										<IconBox icon={item.icon} tint={item.iconTint} active={active} />
										<span className="block min-w-0 flex-1">
											<span
												// 选中态继承挂点那一层,同 IconBox。
												className={`flex items-center gap-1.5 text-bn-sm font-bold ${
													active ? "" : "text-bn-text-primary"
												}`}
											>
												<span className="truncate">{item.label}</span>
												{item.badge}
											</span>
											{item.desc ? (
												<span className="mt-0.5 block wrap-break-word text-bn-2xs leading-snug text-bn-text-tertiary">
													{item.desc}
												</span>
											) : null}
										</span>
									</button>
								);
							})}
				</div>
			</aside>

			{/* 横向条(窄视口 < xl):sticky + 背景 + z-index → 内容从其下穿过,不再覆盖。
			    左右两端用箭头按钮滚动,隐藏原生滚动条(bn-no-scrollbar)。 */}
			<div
				data-section-nav="bar"
				data-bn="nav"
				style={{ top: STICKY_TOP }}
				className="sticky z-bn-local rounded-bn-sm border border-bn-border-subtle bg-bn-surface/70 backdrop-blur-sm xl:hidden"
			>
				<div className="relative flex items-center">
					{edges.left ? (
						<div className="absolute inset-y-0 left-0 z-bn-raised flex items-center rounded-l-[11px] bg-linear-to-r from-bn-surface via-bn-surface/85 to-transparent pr-6 pl-1">
							<IconButton
								icon={<Chevron dir="left" />}
								label="向左滚动"
								size="lg"
								tone="accent"
								shape="pill"
								surface="filled"
								onClick={() => scrollByDir(-1)}
							/>
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
									// 与竖栏同词:同一批分区在两种视口下必须吃同一套皮肤规则。
									data-bn={active ? "nav-item nav-item-active" : "nav-item"}
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
							<AddButton className="shrink-0" onClick={onAdd}>
								{addLabel}
							</AddButton>
						) : null}
					</div>

					{edges.right ? (
						<div className="absolute inset-y-0 right-0 z-bn-raised flex items-center rounded-r-[11px] bg-linear-to-l from-bn-surface via-bn-surface/85 to-transparent pr-1 pl-6">
							<IconButton
								icon={<Chevron dir="right" />}
								label="向右滚动"
								size="lg"
								tone="accent"
								shape="pill"
								surface="filled"
								onClick={() => scrollByDir(1)}
							/>
						</div>
					) : null}
				</div>
			</div>
		</div>
	);
}
