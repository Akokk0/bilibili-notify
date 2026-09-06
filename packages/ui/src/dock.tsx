/**
 * Dock —— 底边工作台的两件(Vue DevTools 7 / Nuxt DevTools 那种形态):
 *
 * - `DockPill`:左下角常驻的玻璃药丸。主钮开合面板;右侧几个快捷位(最常按的那几个动作);
 *   有假状态 / 截流生效时亮一颗呼吸点。与右下角 AI 胶囊同基线(bottom-5 / h-12),底部
 *   居中让给灵动岛。面板升起时药丸**骑在面板顶边上**(调用方传 `offsetBottom`),不被盖住。
 * - `DockPanel`:底边升起的整宽面板。顶边可拖改高(受控 `height` / `onHeightChange`,记住
 *   与否归调用方)、ESC 收、左栏分组(与 SectionNav 竖栏同一套 nav / nav-item 语汇)、
 *   顶部一条插槽给「当前生效」。
 *
 * 两件都是纯展示:开没开、多高、选了哪组全由调用方握着。层级走 `z-bn-dock`(45):压住页面
 * 与吸顶栏,让开弹窗(300)/ 菜单(60)/ toast(200)/ 灵动岛(100)。
 *
 * 入场动画是纯位移(bn-anim-dock-in):底是玻璃面,opacity/filter 动画会让它成为 backdrop
 * root、磨砂瞬时熄灭(见 theme.css 的 bn-fade-in 注释)。
 */

import { type CSSProperties, type ReactNode, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { IconButton, Pill, StatusDot } from "./atoms";
import { Icon } from "./icons";
import { RAIL_ITEM_LANGUAGE } from "./section-nav";

// ── DockPill ────────────────────────────────────────────────────────────────

export interface DockPillAction {
	id: string;
	/** 读屏器与 tooltip 都念它 —— 快捷位只有图标,没文字。 */
	label: string;
	icon?: ReactNode;
	onRun: () => void;
	/** 正在跑:禁用,免得连点两下造两条。 */
	busy?: boolean;
}

export interface DockPillProps {
	label: string;
	icon: ReactNode;
	open: boolean;
	onToggle: () => void;
	/** 有假状态 / 截流生效 —— 亮呼吸点,提醒「你看到的不全是真的」。 */
	active?: boolean;
	/** 呼吸点念给读屏器的话(「2 项生效」)。 */
	activeTitle?: string;
	actions?: ReadonlyArray<DockPillAction>;
	/**
	 * 离视口底边的距离(px)。面板升起时传面板高 + 间隔,药丸就骑在面板顶边上;
	 * 不传贴底(与 AI 胶囊同基线)。运行时几何量,落 style。
	 */
	offsetBottom?: number;
}

const PILL_BUTTON =
	"flex h-9 cursor-pointer items-center gap-1.5 rounded-bn-pill px-3 text-bn-sm font-bold text-bn-text-primary transition-colors hover:bg-(--bn-glass-bg)";

export function DockPill({
	label,
	icon,
	open,
	onToggle,
	active = false,
	activeTitle = "有注入生效",
	actions = [],
	offsetBottom,
}: DockPillProps) {
	const style: CSSProperties | undefined =
		offsetBottom === undefined ? undefined : { bottom: offsetBottom };
	return (
		<div
			data-dock-pill=""
			data-bn="glass-strong"
			className="bn-anim-dock-in bn-glass-strong fixed bottom-5 left-5 z-bn-dock flex h-12 items-center gap-0.5 rounded-bn-pill p-1.5 shadow-bn-elev transition-[bottom]"
			style={style}
		>
			<span className="relative flex">
				<button
					type="button"
					// 开合钮,与 DisclosurePill 同一档挂点:它是「展开 / 收起下面那块」,不是主动作按钮。
					data-bn={open ? "chip chip-active" : "chip"}
					aria-expanded={open}
					onClick={onToggle}
					className={`${PILL_BUTTON} ${open ? "bg-(--bn-glass-bg)" : ""}`}
				>
					<span className="grid h-5 w-5 place-items-center text-bn-pink">{icon}</span>
					{label}
				</button>
				{active ? (
					// 角标而不是塞进按钮里:塞进去会把「2 项生效」并进按钮的名字。纯色点对读屏器
					// 等于不存在,包一层 img 把那句话念出来。
					<span
						role="img"
						aria-label={activeTitle}
						title={activeTitle}
						className="absolute top-0 right-0.5 flex"
					>
						<StatusDot kind="live" size="sm" />
					</span>
				) : null}
			</span>
			{actions.length > 0 ? (
				<>
					<span aria-hidden="true" className="mx-1 h-5 w-px bg-bn-border" />
					{actions.map((a) => (
						<IconButton
							key={a.id}
							icon={a.icon ?? <span className="text-bn-xs font-bold">{a.label.slice(0, 1)}</span>}
							label={a.label}
							title={a.label}
							size="lg"
							shape="pill"
							tone="accent"
							onClick={a.onRun}
							disabled={a.busy}
						/>
					))}
				</>
			) : null}
		</div>
	);
}

// ── DockPanel ───────────────────────────────────────────────────────────────

export interface DockRailItem {
	id: string;
	label: string;
	icon?: ReactNode;
	/** 分组里有几项(状态组里几条生效之类)。 */
	count?: number;
}

export interface DockPanelProps {
	/** 读屏器的面板名,也是左栏 nav 名的前缀。 */
	title: string;
	height: number;
	onHeightChange: (height: number) => void;
	/** 最矮多少 px;最高恒为视口九成。 */
	minHeight?: number;
	onClose: () => void;
	rail: ReadonlyArray<DockRailItem>;
	activeId: string;
	onPick: (id: string) => void;
	/** 顶部那条(「当前生效」+ 一键收摊)。 */
	header?: ReactNode;
	children: ReactNode;
}

const DEFAULT_MIN_HEIGHT = 160;
const MAX_VIEWPORT_SHARE = 0.9;

export function DockPanel({
	title,
	height,
	onHeightChange,
	minHeight = DEFAULT_MIN_HEIGHT,
	onClose,
	rail,
	activeId,
	onPick,
	header,
	children,
}: DockPanelProps) {
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);

	// 拖顶边:按下时记住起点与起始高,之后每一步都从起点算 —— 累加每步位移会把
	// 夹紧(clamp)丢掉的那段也累进去,松手时面板比手指高出一截。
	const drag = useRef<{ startY: number; startHeight: number } | null>(null);
	// 上限**现读**视口:拖动中途转屏 / 改窗口大小都得跟着走,渲染那一刻取一次会锁死在旧值。
	const viewportMax = () =>
		typeof window === "undefined" ? minHeight : Math.round(window.innerHeight * MAX_VIEWPORT_SHARE);
	const clamp = (h: number) => Math.min(Math.max(h, minHeight), viewportMax());

	if (typeof document === "undefined") return null;
	return createPortal(
		<div
			role="dialog"
			aria-label={title}
			data-bn="glass-strong"
			className="bn-anim-dock-in bn-glass-strong fixed inset-x-0 bottom-0 z-bn-dock flex flex-col rounded-t-2xl border-x-0 border-b-0 text-bn-text-primary shadow-bn-elev"
			style={{ height }}
		>
			{/* biome-ignore lint/a11y/useSemanticElements: 拖柄是自定义 separator,原生 <hr> 没法拖 */}
			<div
				role="separator"
				aria-orientation="horizontal"
				aria-label="拖动改高"
				aria-valuenow={height}
				aria-valuemin={minHeight}
				// 少了 max,读屏按 ARIA 的默认上限 100 去念这个像素值,念出来是个没意义的数。
				aria-valuemax={viewportMax()}
				tabIndex={0}
				className="group flex h-4 shrink-0 cursor-row-resize touch-none items-center justify-center"
				onPointerDown={(e) => {
					drag.current = { startY: e.clientY, startHeight: height };
					e.currentTarget.setPointerCapture?.(e.pointerId);
				}}
				onPointerMove={(e) => {
					if (!drag.current) return;
					onHeightChange(clamp(drag.current.startHeight + (drag.current.startY - e.clientY)));
				}}
				onPointerUp={() => {
					drag.current = null;
				}}
				onPointerCancel={() => {
					drag.current = null;
				}}
				onKeyDown={(e) => {
					if (e.key === "ArrowUp") onHeightChange(clamp(height + 24));
					if (e.key === "ArrowDown") onHeightChange(clamp(height - 24));
				}}
			>
				<span className="h-1 w-10 rounded-bn-pill bg-bn-text-disabled transition-colors group-hover:bg-bn-text-tertiary" />
			</div>
			<div className="flex shrink-0 items-center gap-3 px-4 pb-2">
				<div className="min-w-0 flex-1">{header}</div>
				<IconButton
					icon={<Icon.close size={16} />}
					label="收起"
					title="收起(Esc)"
					size="md"
					onClick={onClose}
				/>
			</div>
			<div className="flex min-h-0 flex-1">
				<nav
					aria-label={`${title} 分组`}
					data-bn="nav"
					className="flex w-40 shrink-0 flex-col gap-1 overflow-y-auto border-bn-border border-r px-2 pb-3"
				>
					{rail.map((item) => {
						const active = item.id === activeId;
						return (
							<button
								key={item.id}
								type="button"
								data-bn={active ? "nav-item nav-item-active" : "nav-item"}
								aria-current={active ? "true" : undefined}
								onClick={() => onPick(item.id)}
								className={`${RAIL_ITEM_LANGUAGE.base} items-center py-2 ${
									active ? RAIL_ITEM_LANGUAGE.active : RAIL_ITEM_LANGUAGE.idle
								}`}
							>
								{item.icon ? (
									<span
										className={`grid h-5 w-5 shrink-0 place-items-center ${active ? "" : "text-bn-text-secondary"}`}
									>
										{item.icon}
									</span>
								) : null}
								<span className="min-w-0 flex-1 truncate text-bn-sm font-bold">{item.label}</span>
								{item.count !== undefined && item.count > 0 ? (
									<Pill subtle size="sm">
										{item.count}
									</Pill>
								) : null}
							</button>
						);
					})}
				</nav>
				<div className="min-w-0 flex-1 overflow-y-auto px-4 pb-4">{children}</div>
			</div>
		</div>,
		document.body,
	);
}
