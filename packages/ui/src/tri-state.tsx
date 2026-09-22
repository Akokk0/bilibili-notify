import { Icon } from "./icons";

/**
 * 三态记号:支持 / 不支持 / 还不知道。拓展视图的 tristate 列(ADR-0019 决策 27)与它的图例
 * 同一套。
 */
export type TriState = "supported" | "unsupported" | "unknown";

/**
 * 三档各自的默认说法。chip 的悬停说明与图例都用它;讲的不是「能力」的地方,chip 可以整份换掉。
 *
 * 🔴 **「不支持」与「还不知道」不许并成一档**(ADR-0009 决策 10):前者是结论,后者是
 * 「试试看,可能行」—— 桥对没见过的平台会真的不知道。混成一个记号,主人会以为那条
 * 平台永远做不到,于是再也不试。
 */
export const TRISTATE_TEXT: Readonly<Record<TriState, string>> = {
	supported: "支持",
	unsupported: "不支持",
	unknown: "还不知道",
};

/**
 * 三档各自的画法。
 *
 * 🔴 **不许拿删除线画「不支持」**:删除线在这套界面里说的是「作废 / 坏了」。
 * 2026-09-10 主人正是对着一排划掉的能力说「肯定有问题」—— 那张表其实完全正常。
 * 三档靠**形状**分(实心打勾 / 空心一横 / 虚线空圈),颜色只是第二条通道 ——
 * 色觉差异与截图压缩吃得掉颜色,吃不掉形状。
 */
const TRISTATE_LOOK: Record<TriState, { mark: string; label: string }> = {
	supported: {
		mark: "bg-bn-success text-bn-on-solid",
		label: "text-bn-text-secondary",
	},
	unsupported: {
		mark: "border-[1.5px] border-bn-text-disabled",
		label: "text-bn-inactive",
	},
	unknown: {
		mark: "border-[1.5px] border-dashed border-bn-text-tertiary",
		label: "text-bn-text-tertiary",
	},
};

/**
 * 那颗记号本身。**图例与正文共用这一个** —— 各画各的话,图例迟早对不上它要解释的东西,
 * 而一份对不上的图例比没有图例更糟。
 */
export function TriStateMark({ state, size = 14 }: { state: TriState; size?: number }) {
	return (
		<span
			data-cap-mark={state}
			className={`grid shrink-0 place-items-center rounded-full ${TRISTATE_LOOK[state].mark}`}
			// 记号是正圆,尺寸是几何量 —— 这两样留在行内,皮肤掰不坏。
			style={{ width: size, height: size }}
		>
			{state === "supported" ? <Icon.check size={Math.round(size * 0.64)} /> : null}
			{/* 「一横」是**空心圈里的减号** —— 与虚线空圈拉开距离靠的就是它。 */}
			{state === "unsupported" ? (
				<span className="h-px w-1.5 rounded-full bg-bn-text-disabled" />
			) : null}
		</span>
	);
}

/** 记号 + 一个名字(「@全体」),一行里横排好几颗。 */
export function TriStateChip({ label, state }: { label: string; state: TriState }) {
	return (
		<span
			// 三态在形状与颜色之外**还有一层字面说明** —— 读屏器与鼠标悬停都够得着。
			title={`${label}:${TRISTATE_TEXT[state]}`}
			className="inline-flex items-center gap-[5px] whitespace-nowrap text-bn-xs leading-[14px]"
		>
			<TriStateMark state={state} />
			<span className={TRISTATE_LOOK[state].label}>{label}</span>
		</span>
	);
}
