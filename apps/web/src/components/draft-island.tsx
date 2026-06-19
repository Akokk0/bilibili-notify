/**
 * DraftIsland —— 灵动岛草稿机制(Phase D 5 态 chip + Phase E expand panel)。
 *
 * 从 zustand draftStore 订阅 uiState / current / errorMessage,AnimatePresence
 * mode="wait" 切 5 个子组件:
 * - idle  → 不渲染(灵动岛消失)
 * - dirty → 粉紫 dot + 页名 + 字段数徽章(pop 动画)+ 「保存」主按钮 + expand panel
 * - saving → 旋转 refresh + "保存中…"
 * - saved → 绿色 ✓ + "已保存"(1.2s 后 runSaveFlow 自动转 idle)
 * - error → 摇晃 200ms + 红边 pulse + 错误文案 + dismiss x(不自动消失)
 *
 * Expand panel(仅 dirty 态显示):
 * - 双轨触发:hover preview(useState 本地)+ click 锁定(panelLocked store)
 * - 移动端无 hover:tap chip 内容区 = click 锁定
 * - panel 内字段级 diff list(按 section 分组),单行 click 跳转对应 Field
 * - 左下「丢弃全部更改」按钮
 *
 * 位置 / 层级:fixed 居中底部,bottom = 1rem + safe-area。z-100 故意低于
 * ToastShell(z-200)与 Dialog(z-300)— toast/dialog 弹出时不被遮挡。
 */

import { AnimatePresence, motion } from "motion/react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useAiBarStore } from "../store/aiBar";
import type { DraftRegistration, DraftUiState } from "../store/draft";
import { useDraftStore } from "../store/draft";
import { formatDiffValue } from "../utils/formatDiffValue";
import { type DiffSection, groupDiffsBySection } from "../utils/groupDiffs";
import type { FieldDiff } from "../utils/walkTreeDiff";
import { Icon } from "./icons";

const SHELL_SPRING = { type: "spring" as const, stiffness: 380, damping: 28 };
const PANEL_SPRING = { type: "spring" as const, stiffness: 320, damping: 30 };
const STACK_SPRING = { type: "spring" as const, stiffness: 220, damping: 26 };

/**
 * 灵动岛跟 FloatingAiBar 垂直堆叠避让(plan Q9):
 * - AiBar 未 dismissed → 贴底全宽 bar 占据 bottom-4 区域 → 灵动岛上移 64px
 * - AiBar dismissed → 收成右下小圆按钮,不冲突 → 灵动岛回默认位
 *
 * 64px ≈ AiBar 折叠态高度(48px h + 8px gap),实测对齐。展开态会更高,但
 * 也只是 AiBar 文本溢出向上推,不影响灵动岛的稳定位移基线。
 */
const STACK_LIFT_PX = -64;

/**
 * 灵动岛 chip 子组件选择:5 态 + (idle / 无 current) → "none"。抽成纯函数
 * 便于单测条件分支,不被 motion / DOM 渲染复杂度卡住。
 */
export type ChipKind = "dirty" | "saving" | "saved" | "error" | "none";

export function selectChipKind(uiState: DraftUiState, current: DraftRegistration | null): ChipKind {
	if (uiState === "dirty" && current !== null) return "dirty";
	if (uiState === "saving") return "saving";
	if (uiState === "saved") return "saved";
	if (uiState === "error") return "error";
	return "none";
}

export function DraftIsland(): ReactNode {
	const uiState = useDraftStore((s) => s.uiState);
	const current = useDraftStore((s) => s.current);
	const errorMessage = useDraftStore((s) => s.errorMessage);
	const panelLocked = useDraftStore((s) => s.panelLocked);
	const togglePanelLocked = useDraftStore((s) => s.togglePanelLocked);
	const aiBarDismissed = useAiBarStore((s) => s.dismissed);

	const [hovered, setHovered] = useState(false);
	const containerRef = useRef<HTMLElement>(null);
	const leaveTimerRef = useRef<number | null>(null);

	// 外部 click → 关闭 locked panel。仅 panelLocked 为 true 时才挂监听,
	// 减少全局事件流量。
	useEffect(() => {
		if (!panelLocked) return;
		function handleOutsideClick(e: MouseEvent) {
			const node = containerRef.current;
			if (node !== null && e.target instanceof Node && !node.contains(e.target)) {
				togglePanelLocked(false);
			}
		}
		document.addEventListener("mousedown", handleOutsideClick);
		return () => document.removeEventListener("mousedown", handleOutsideClick);
	}, [panelLocked, togglePanelLocked]);

	// 鼠标从 chip 跨 panel 的 8px gap 时,motion.section 会瞬间触发 mouseleave
	// → setHovered(false) → panel 退场 → 鼠标到 panel 又 mouseenter → 入场,
	// 视觉上闪烁。debounce 100ms:mouseleave 后等 100ms 才真 setHovered(false),
	// 期间 mouseenter 取消 timer。8px gap + 慢速移动 ~80ms,100ms 足够覆盖。
	function handleMouseEnter() {
		if (leaveTimerRef.current !== null) {
			window.clearTimeout(leaveTimerRef.current);
			leaveTimerRef.current = null;
		}
		setHovered(true);
	}

	function handleMouseLeave() {
		leaveTimerRef.current = window.setTimeout(() => {
			setHovered(false);
			leaveTimerRef.current = null;
		}, 100);
	}

	useEffect(
		() => () => {
			if (leaveTimerRef.current !== null) window.clearTimeout(leaveTimerRef.current);
		},
		[],
	);

	const kind = selectChipKind(uiState, current);
	const showPanel = kind === "dirty" && current !== null && (hovered || panelLocked);

	let chipContent: ReactNode = null;
	if (kind === "dirty" && current !== null) {
		chipContent = <DirtyContent key="dirty" current={current} />;
	} else if (kind === "saving") {
		chipContent = <SavingContent key="saving" />;
	} else if (kind === "saved") {
		chipContent = <SavedContent key="saved" />;
	} else if (kind === "error") {
		chipContent = <ErrorContent key="error" message={errorMessage} />;
	}

	return (
		<motion.section
			ref={containerRef}
			aria-label="草稿状态"
			aria-live="polite"
			data-testid="draft-island"
			className="pointer-events-none fixed left-1/2 z-100 flex -translate-x-1/2 flex-col items-center"
			style={{ bottom: "calc(1rem + env(safe-area-inset-bottom))" }}
			animate={{ y: aiBarDismissed ? 0 : STACK_LIFT_PX }}
			transition={STACK_SPRING}
			onMouseEnter={handleMouseEnter}
			onMouseLeave={handleMouseLeave}
		>
			<AnimatePresence>
				{showPanel && current !== null ? <ExpandPanel key="panel" current={current} /> : null}
			</AnimatePresence>
			<AnimatePresence mode="wait">{chipContent}</AnimatePresence>
		</motion.section>
	);
}

// ── Chip shell:共享外形 / 进退动画 ─────────────────────────────────────────

function ChipShell({
	children,
	extraAnimate,
	className = "",
	onClick,
	aura = false,
}: {
	children: ReactNode;
	extraAnimate?: Record<string, unknown>;
	className?: string;
	onClick?: (e: React.MouseEvent<HTMLDivElement>) => void;
	/** 是否绕一圈外圈流光线。仅 dirty 态传 true(plan Q5)。 */
	aura?: boolean;
}) {
	return (
		<motion.div
			layout
			initial={{ opacity: 0, y: 16, scale: 0.92 }}
			animate={{ opacity: 1, y: 0, scale: 1, ...extraAnimate }}
			exit={{ opacity: 0, y: 16, scale: 0.92 }}
			transition={SHELL_SPRING}
			onClick={onClick}
			className={`pointer-events-auto relative flex items-center gap-2.5 rounded-full bg-black/85 px-4 py-2 text-white shadow-[0_8px_24px_rgba(0,0,0,0.3)] backdrop-blur-xl ${className}`}
		>
			{aura ? <span aria-hidden className="bn-anim-aura" data-testid="draft-island-aura" /> : null}
			{children}
		</motion.div>
	);
}

// ── DirtyContent ──────────────────────────────────────────────────────────

function DirtyContent({ current }: { current: DraftRegistration }) {
	const togglePanelLocked = useDraftStore((s) => s.togglePanelLocked);

	function handleChipClick(e: React.MouseEvent<HTMLDivElement>) {
		// chip 内容区 click 切 panel 锁定;保存按钮的 click 已经 stopPropagation。
		if ((e.target as HTMLElement).closest("[data-stop-chip-click]") !== null) return;
		togglePanelLocked();
	}

	return (
		<ChipShell onClick={handleChipClick} className="cursor-pointer select-none" aura>
			<span className="block h-1.5 w-1.5 rounded-full bg-bn-pink" aria-hidden />
			<span className="text-[12px] font-medium">{current.pageLabel}</span>
			{/* 数字徽章:diff.length 变化时通过 key 强制重 mount,触发 initial→animate 的 pop。 */}
			<motion.span
				key={current.diff.length}
				initial={{ scale: 0.6, opacity: 0 }}
				animate={{ scale: 1, opacity: 1 }}
				transition={{ type: "spring", stiffness: 500, damping: 22 }}
				className="rounded-full bg-bn-pink px-1.5 py-px text-[10.5px] font-bold leading-3.5"
				aria-label={`${current.diff.length} 项未保存`}
			>
				{current.diff.length}
			</motion.span>
			<button
				type="button"
				data-stop-chip-click
				onClick={(e) => {
					e.stopPropagation();
					current.onSave();
				}}
				className="rounded-full bg-white px-3 py-1 text-[11.5px] font-bold text-black transition hover:bg-white/90 active:scale-95"
			>
				保存
			</button>
		</ChipShell>
	);
}

// ── SavingContent ─────────────────────────────────────────────────────────

function SavingContent() {
	return (
		<ChipShell>
			<motion.span
				animate={{ rotate: 360 }}
				transition={{ duration: 0.9, repeat: Number.POSITIVE_INFINITY, ease: "linear" }}
				className="grid h-3.5 w-3.5 place-items-center text-bn-purple"
				aria-hidden
			>
				<Icon.refresh size={14} />
			</motion.span>
			<span className="text-[12px]">保存中…</span>
		</ChipShell>
	);
}

// ── SavedContent ──────────────────────────────────────────────────────────

function SavedContent() {
	return (
		<ChipShell>
			<motion.span
				initial={{ scale: 0.4, opacity: 0 }}
				animate={{ scale: 1, opacity: 1 }}
				transition={{ type: "spring", stiffness: 500, damping: 18 }}
				className="grid h-4 w-4 place-items-center rounded-full bg-emerald-500 text-white"
				aria-hidden
			>
				<Icon.check size={11} />
			</motion.span>
			<span className="text-[12px]">已保存</span>
		</ChipShell>
	);
}

// ── ErrorContent ──────────────────────────────────────────────────────────

const ERROR_SHAKE_X = [0, -6, 6, -4, 4, -2, 2, 0];
const ERROR_PULSE_BOX_SHADOW = [
	"0 0 0 0 rgba(239, 68, 68, 0.55)",
	"0 0 0 9px rgba(239, 68, 68, 0)",
];

function ErrorContent({ message }: { message: string | null }) {
	const setUiState = useDraftStore((s) => s.setUiState);
	return (
		<ChipShell
			extraAnimate={{
				x: ERROR_SHAKE_X,
				boxShadow: ERROR_PULSE_BOX_SHADOW,
				transition: {
					x: { duration: 0.2, ease: "easeInOut" },
					boxShadow: {
						duration: 1.4,
						repeat: Number.POSITIVE_INFINITY,
						ease: "easeOut",
					},
				},
			}}
			className="border border-red-400/60"
		>
			<span
				className="grid h-4 w-4 place-items-center rounded-full bg-red-500 text-white"
				aria-hidden
			>
				!
			</span>
			<span className="max-w-65 truncate text-[12px]" title={message ?? undefined}>
				{message ?? "保存失败"}
			</span>
			<button
				type="button"
				onClick={() => setUiState("dirty")}
				aria-label="关闭"
				className="grid h-5 w-5 place-items-center rounded-full text-white/70 transition hover:bg-bn-inverse-hover hover:text-white"
			>
				<Icon.close size={12} />
			</button>
		</ChipShell>
	);
}

// ── ExpandPanel:字段级 diff list + 丢弃按钮 ────────────────────────────────

const HIGHLIGHT_CLASS = "bn-anim-highlight";
const HIGHLIGHT_DURATION_MS = 1000;

/**
 * 滚动到目标 Field(`<Field code="X">` → `[data-code="X"]` 锚点)并加 1s 高亮
 * ring。仅命中当前路由下的第一个匹配(每页 code 不重复)。
 */
export function scrollToFieldByCode(code: string): void {
	if (typeof document === "undefined") return;
	const escaped = code.replace(/"/g, '\\"');
	const node = document.querySelector<HTMLElement>(`[data-code="${escaped}"]`);
	if (node === null) return;
	node.scrollIntoView({ behavior: "smooth", block: "center" });
	node.classList.remove(HIGHLIGHT_CLASS); // 重置正在跑的动画(连续 click 同一行)
	void node.offsetWidth; // 强制 reflow,确保 class 重加触发新一次 animation
	node.classList.add(HIGHLIGHT_CLASS);
	setTimeout(() => node.classList.remove(HIGHLIGHT_CLASS), HIGHLIGHT_DURATION_MS);
}

function ExpandPanel({ current }: { current: DraftRegistration }) {
	const sections = groupDiffsBySection(current.diff);
	return (
		<motion.div
			layout
			initial={{ opacity: 0, y: 12, scale: 0.96 }}
			animate={{ opacity: 1, y: 0, scale: 1 }}
			exit={{ opacity: 0, y: 12, scale: 0.96 }}
			transition={PANEL_SPRING}
			className="pointer-events-auto mb-2 w-105 max-w-[calc(100vw-2rem)] overflow-hidden rounded-2xl border border-white/10 bg-black/85 text-white shadow-[0_12px_36px_rgba(0,0,0,0.4)] backdrop-blur-xl"
		>
			<div className="flex max-h-[60vh] flex-col">
				<div className="border-b border-white/10 px-4 py-2.5 text-[11.5px] font-semibold tracking-wide text-white/70">
					{current.pageLabel} · {current.diff.length} 项未保存
				</div>
				<div className="flex-1 overflow-y-auto px-2 py-2">
					{sections.length === 0 ? (
						<div className="px-2 py-4 text-center text-[12px] text-white/50">无字段变更</div>
					) : (
						sections.map((s) => <DiffSectionView key={s.section} section={s} />)
					)}
				</div>
				<PanelFooter onDiscard={current.onDiscard} />
			</div>
		</motion.div>
	);
}

function DiffSectionView({ section }: { section: DiffSection }) {
	return (
		<div className="mb-1.5 last:mb-0">
			<div className="px-2 pb-1 pt-1.5 text-[10.5px] font-bold uppercase tracking-wider text-white/40">
				{section.label}
			</div>
			<div className="flex flex-col gap-0.5">
				{section.rows.map((row) => (
					<DiffRow key={row.code} row={row} />
				))}
			</div>
		</div>
	);
}

function DiffRow({ row }: { row: FieldDiff }) {
	const before = formatDiffValue(row.code, row.oldValue);
	const after = formatDiffValue(row.code, row.newValue);
	return (
		<button
			type="button"
			onClick={() => scrollToFieldByCode(row.code)}
			className="flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left transition hover:bg-bn-inverse-muted"
			title={`跳转到 ${row.code}`}
		>
			<code className="font-mono text-[10.5px] text-white/50">{row.code}</code>
			<div className="flex items-center gap-1.5 text-[12px]">
				<ValueChip value={before} muted />
				<span className="text-white/40">→</span>
				<ValueChip value={after} />
			</div>
		</button>
	);
}

function ValueChip({
	value,
	muted = false,
}: {
	value: { display: string; swatch?: string };
	muted?: boolean;
}) {
	const tone = muted ? "text-white/60" : "text-white";
	return (
		<span className={`inline-flex min-w-0 items-center gap-1 ${tone}`}>
			{value.swatch ? (
				<span
					className="inline-block h-3 w-3 shrink-0 rounded-sm border border-white/30"
					style={{ backgroundColor: value.swatch }}
					aria-hidden
				/>
			) : null}
			<span className="truncate font-mono text-[11.5px]">{value.display}</span>
		</span>
	);
}

function PanelFooter({ onDiscard }: { onDiscard: () => void }) {
	return (
		<div className="flex items-center justify-between border-t border-white/10 px-4 py-2">
			<button
				type="button"
				onClick={onDiscard}
				className="rounded-full px-2.5 py-1 text-[11px] text-white/60 transition hover:bg-bn-inverse-hover hover:text-white"
			>
				丢弃全部更改
			</button>
			<span className="text-[10.5px] text-white/40">click 行跳转字段</span>
		</div>
	);
}
