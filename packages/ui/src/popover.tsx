import { type ReactNode, type Ref, type RefObject, useEffect, useRef } from "react";

/**
 * 「点外面关掉」—— 浮层人人要的那一段监听。收编前站内抄了五份,行为还不一致:
 * 只有一份处理 Escape、只有一份用 pointerdown,其余三份 mousedown 无键盘,而这些
 * 差异没有一处写过理由。收成一个 hook 后差异变成显式的选项,留在调用点看得见。
 *
 * `onDismiss` 经 ref 转接:调用方传行内闭包也不会每次 render 重挂 document 监听。
 */
export interface UseDismissOptions {
	/** 只在浮层开着时挂监听(减少全局事件流量)。缺省 true —— 组件本身按需挂载时用不到它。 */
	enabled?: boolean;
	/** Escape 也关。 */
	escape?: boolean;
	/** 按下事件的种类。`pointerdown` 连触屏 / 笔一起管;`mousedown` 是收编前多数处的旧默认。 */
	event?: "mousedown" | "pointerdown";
}

export function useDismiss(
	ref: RefObject<HTMLElement | null>,
	onDismiss: () => void,
	{ enabled = true, escape: escToClose = false, event = "mousedown" }: UseDismissOptions = {},
): void {
	const cbRef = useRef(onDismiss);
	useEffect(() => {
		cbRef.current = onDismiss;
	});
	useEffect(() => {
		if (!enabled) return;
		const onDown = (e: Event): void => {
			const node = ref.current;
			if (node && e.target instanceof Node && !node.contains(e.target)) cbRef.current();
		};
		const onKey = (e: KeyboardEvent): void => {
			if (e.key === "Escape") cbRef.current();
		};
		document.addEventListener(event, onDown);
		if (escToClose) document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener(event, onDown);
			if (escToClose) document.removeEventListener("keydown", onKey);
		};
	}, [enabled, escToClose, event, ref]);
}

/**
 * PopoverShell —— 贴着触发器弹出的浮层面板。
 *
 * 装 `MenuItem` 的那个壳。收编前四处各写各的:四种圆角、三种底、三种边、两种阴影、
 * 两种挂点写法,**没有两个是一样的** —— 连「里面装的全是 `MenuItem`」的两处都一个
 * 有内边距一个没有。同 `ModalShell` 当初收编十一个弹窗。
 *
 * **定位靠调用方**:壳子只出 `absolute` 与贴边方向,`relative` 的那个包裹由调用方给
 * (触发器与浮层的相对关系只有它知道)。
 *
 * 开口只有三样,每一样都对应真实的调用方分歧:
 * - `align` 贴左还是贴右
 * - `variant` 内容要不要留呼吸位
 * - `layer` 压在第几层
 *
 * `className` 按库里的老规矩,**只收不冲突的**(宽度、最大高度、滚动),覆盖本体是覆盖
 * 不住的 —— 没有 tailwind-merge,同属性两条 utility 谁赢由样式表顺序决定,不由类名
 * 串顺序决定。要改本体就加档。
 */

/** 与触发器的贴边方向。 */
export type PopoverAlign = "left" | "right";

/**
 * 内容的呼吸位。
 *
 * - `inset`(默认)给 `MenuItem` 留一圈缝,不然首尾两行会贴着描边
 * - `flush` 让内容自己贴边 —— 弹层里有通栏的标题条或分割线时用
 * - `panel` 给自定义面板,比菜单更松
 */
export type PopoverVariant = "inset" | "flush" | "panel";

/**
 * 压在第几层,取值走 `theme.css` 的分层表。
 *
 * 刻意**不定死**:收编前四处用了 nav / nav / local / overlay 三种,而它们该不该统一
 * 没查清 —— 一个弹层要压过什么,取决于它开在哪、下面铺着什么。原样搬过来,至少现在
 * 这个选择是显式的、在调用点看得见的。
 */
export type PopoverLayer = "local" | "nav" | "overlay";

/**
 * 底是实的还是玻璃的。
 *
 * **站里两派,这一轮不并。** 四个浮层里三个是实底(菜单类),一个是强玻璃(顶栏的标签
 * 面板)—— 而那一个的注释写着实测理由:暗色皮肤按最佳实践把 `background` 调到 alpha
 * 0.55、`strongBackground` 0.85,用轻档会透出底下的导航文字,所以它挑了强档。哪一派
 * 对是个设计问题,不该在收编外观时顺手拍板;开成档,至少这个选择在调用点看得见。
 *
 * 注意 `glass` 换的是**底本身**(`.bn-glass-strong` 带 `backdrop-filter`),不是
 * `data-bn="glass-strong"` 那个皮肤挂点 —— 两档都挂那个点。
 */
export type PopoverSurface = "solid" | "glass";

const ALIGN: Record<PopoverAlign, string> = {
	left: "left-0",
	right: "right-0",
};

const VARIANT: Record<PopoverVariant, string> = {
	inset: "p-1",
	flush: "",
	panel: "p-2",
};

const SURFACE: Record<PopoverSurface, string> = {
	solid: "border border-bn-border bg-bn-surface",
	// 玻璃档的底与边都由 `.bn-glass-strong` 出,再叠一层 border 会画出双边。
	glass: "bn-glass-strong",
};

const LAYER: Record<PopoverLayer, string> = {
	local: "z-bn-local",
	nav: "z-bn-nav",
	overlay: "z-bn-overlay",
};

export interface PopoverShellProps {
	children: ReactNode;
	align?: PopoverAlign;
	variant?: PopoverVariant;
	layer?: PopoverLayer;
	surface?: PopoverSurface;
	/** 宽度 / 最大高度 / 滚动这类调用方真的不同的东西。 */
	className?: string;
	/**
	 * 浮层根节点。**几乎每个调用方都要**:「点到外面就关掉」得先知道点的是不是自己。
	 * React 19 起 ref 就是个普通 prop,不用 forwardRef。
	 */
	ref?: Ref<HTMLDivElement>;
}

export function PopoverShell({
	children,
	align = "left",
	variant = "inset",
	layer = "local",
	surface = "solid",
	className,
	ref,
}: PopoverShellProps) {
	return (
		<div
			ref={ref}
			// 弹层走**强**玻璃档:`glass` 的 hook 语义是「轻玻璃卡片」,`glass-strong` 才是
			// 「弹层、浮条、抽屉」。暗色皮肤按最佳实践把 background 调到 alpha 0.55、
			// strongBackground 0.85,用轻档会透出底下的文字。
			data-bn="glass-strong"
			// `top-[calc(100%+6px)]`:贴着触发器下沿再让开 6px。收编前是 `top-full mt-1` /
			// `top-full mt-2` / `top-[calc(100%+6px)]` 三种写法两种间距。
			className={`absolute top-[calc(100%+6px)] ${ALIGN[align]} ${LAYER[layer]} overflow-hidden rounded-bn-card shadow-bn-elev ${SURFACE[surface]} ${VARIANT[variant]} ${className ?? ""}`}
		>
			{children}
		</div>
	);
}
