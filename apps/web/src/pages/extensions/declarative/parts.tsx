import { Btn, Icon, IconButton, SELECTED_LANGUAGE } from "@bilibili-notify/ui";
import { type CSSProperties, type ReactNode, useState } from "react";
import { copyToClipboard } from "../../../utils/clipboard";

/**
 * 拓展页上反复出现的那几件小东西 —— 手写的桥页与照声明画的页(ADR-0019 决策 19)**共用这一份**。
 *
 * 迁移的承诺是「长相保持今天这样」(决策 24),而这句话只有在两页画的是**同一个组件**时才
 * 守得住:抄一份的话,桥页今天改一个圆角,声明式那页明天就对不上了,两边都不会报错。
 */

// ── 「哪一种」方块 ──────────────────────────────────────────────────────────────

/** 中性灰的「12% 底 + 同色字」—— 设计稿上所有「哪一种」方块与「哪一种」徽章都是这一档。 */
const MUTED_TINT: CSSProperties = {
	background: "color-mix(in srgb, var(--color-bn-inactive) 12%, transparent)",
	color: "var(--color-bn-inactive)",
};

/** 三档尺寸各自的形状:方块大小 / 圆角 / 字号。尺寸是**几何量**,不进皮肤词表。 */
const KIND_MARK_SHAPE: Record<26 | 28 | 32, string> = {
	26: "size-[26px] rounded-md text-bn-xs",
	28: "size-7 rounded-md text-bn-sm",
	32: "size-8 rounded-bn-sm text-bn-base",
};

/**
 * 「哪一种」那枚方块:灰底,里面是 logo 或两个字母。接入卡左上(32)、表格的 icon 格(26)、
 * 选项卡片(28)三处同一件,尺寸不同。
 *
 * 走中性灰而不是语义色:种类**不是状态**,给它一档语义色的话,卡上真正的状态(连没连上)
 * 就得跟它抢注意力。
 *
 * `logo` 是一个图片 data URL,走 `<img>` —— 不跑脚本、拉不进外部资源,不用过白名单
 * (ADR-0019 决策 31)。`glyph` 是库里已有的图标(BN 自己认得的平台)。都没有才印字母。
 */
export function KindMark({
	text,
	size,
	label,
	logo,
	glyph,
	style,
}: {
	text: string;
	size: 26 | 28 | 32;
	label?: string;
	logo?: string;
	glyph?: ReactNode;
	style?: CSSProperties;
}) {
	const className = `grid shrink-0 place-items-center font-bold lowercase ${KIND_MARK_SHAPE[size]}`;
	const tint = style ?? MUTED_TINT;
	// logo 占方块的六成出头 —— 与 GlassBox 图标芯片里 17/32 那个比例一档
	const inner = Math.round(size * 0.62);
	const body = logo ? (
		<img src={logo} alt="" draggable={false} style={{ width: inner, height: inner }} />
	) : glyph ? (
		glyph
	) : (
		text.slice(0, 2)
	);
	// 有名字的是一枚「图」(读屏器念 label);没名字的是旁边那行字的装饰,读屏器跳过。
	return label ? (
		<span role="img" aria-label={label} className={className} style={tint}>
			{body}
		</span>
	) : (
		<span aria-hidden="true" className={className} style={tint}>
			{body}
		</span>
	);
}

/** 等宽小字的那种底 —— 地址、token 都装在这里面。 */
export function MonoChip({ children, className }: { children: string; className?: string }) {
	return (
		<span
			className={`rounded-bn-xs bg-bn-surface-muted px-[7px] py-[3px] font-mono text-bn-xs text-bn-text-secondary ${className ?? ""}`}
		>
			{children}
		</span>
	);
}

/**
 * 一张可选的卡(桥的「哪一种桥」、声明式 `enum` 选项带图标时,ADR-0019 决策 30)。与备份页的
 * ChoiceCard 同一种东西:一张可选的卡,不是按钮 —— 挂 `option`。
 */
export function OptionCard({
	active,
	label,
	mark,
	logo,
	onSelect,
}: {
	active: boolean;
	label: string;
	/** 没有图时方块里印的字(取头两个)。 */
	mark: string;
	logo?: string;
	onSelect: () => void;
}) {
	return (
		<button
			type="button"
			aria-pressed={active}
			data-bn={active ? "option option-active" : "option"}
			onClick={onSelect}
			className={`flex items-center gap-2.5 rounded-lg border px-3 py-[11px] text-left transition ${
				active
					? SELECTED_LANGUAGE
					: "border-bn-border bg-bn-surface text-bn-text-secondary hover:border-bn-text-tertiary"
			}`}
		>
			<KindMark
				text={mark}
				size={28}
				logo={logo}
				style={
					active
						? {
								background: "color-mix(in srgb, var(--color-bn-pink) 16%, transparent)",
								color: "var(--color-bn-pink)",
							}
						: undefined
				}
			/>
			<span className={`text-bn-sm font-bold ${active ? "text-bn-text-primary" : ""}`}>
				{label}
			</span>
		</button>
	);
}

// ── 复制 ─────────────────────────────────────────────────────────────────────

/**
 * 「复制」那一颗。两档外壳同一件事:`iconOnly` 是塞在一行字里的方钮(地址行、弹窗里
 * 那两格),不填是 token 行上那颗带字的。
 *
 * 🔴 走 `copyToClipboard` 而不是裸 `navigator.clipboard`:BN 常经
 * `http://<内网 IP>:8787` 打开,那是**非安全上下文**,`navigator.clipboard` 根本不存在 ——
 * 裸写法在那里按下去静默无事,而拓展页恰恰最常从内网 IP 打开。两档各写一份的话,
 * 这条只会被记起一半。
 */
export function CopyControl({
	label,
	text,
	iconOnly = false,
}: {
	label: string;
	text: string;
	iconOnly?: boolean;
}) {
	const [copied, setCopied] = useState(false);
	const icon = copied ? <Icon.check size={13} /> : <Icon.copy size={13} />;
	const copy = () => {
		void copyToClipboard(text).then(setCopied);
	};
	// 图标钮没文字,「已复制」只能进 label;带字那颗的 label 得稳住(读屏器按它找钮)。
	if (iconOnly) {
		return (
			<IconButton
				label={copied ? `${label}(已复制)` : label}
				icon={icon}
				size="sm"
				onClick={copy}
			/>
		);
	}
	return (
		<Btn variant="ghost" size="sm" aria-label={label} icon={icon} onClick={copy}>
			{copied ? "已复制" : "复制"}
		</Btn>
	);
}

// ── 三态 ─────────────────────────────────────────────────────────────────────

/** 支持 / 不支持 / 还不知道。桥的能力表与声明式 `table` 的 tristate 列(决策 27)同一套。 */
export type TriState = "supported" | "unsupported" | "unknown";

/**
 * 三态各自的说法与画法。
 *
 * 🔴 **「不支持」与「还不知道」不许并成一档**(ADR-0009 决策 10):前者是结论,后者是
 * 「试试看,可能行」—— 桥对没见过的平台会真的不知道。混成一个记号,主人会以为那条
 * 平台永远做不到,于是再也不试。
 *
 * 🔴 **也不许拿删除线画「不支持」**:删除线在这套界面里说的是「作废 / 坏了」。
 * 2026-09-10 主人正是对着一排划掉的能力说「肯定有问题」—— 那张表其实完全正常。
 * 三档靠**形状**分(实心打勾 / 空心一横 / 虚线空圈),颜色只是第二条通道 ——
 * 色觉差异与截图压缩吃得掉颜色,吃不掉形状。
 */
const TRISTATE: Record<TriState, { text: string; mark: string; label: string }> = {
	supported: {
		text: "支持",
		mark: "bg-bn-success text-bn-on-solid",
		label: "text-bn-text-secondary",
	},
	unsupported: {
		text: "不支持",
		mark: "border-[1.5px] border-bn-text-disabled",
		label: "text-bn-inactive",
	},
	unknown: {
		text: "还不知道",
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
			className={`grid shrink-0 place-items-center rounded-full ${TRISTATE[state].mark}`}
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

export function TriStateChip({ label, state }: { label: string; state: TriState }) {
	const meta = TRISTATE[state];
	return (
		<span
			// 三态在形状与颜色之外**还有一层字面说明** —— 读屏器与鼠标悬停都够得着。
			title={`${label}:${meta.text}`}
			className="inline-flex items-center gap-[5px] whitespace-nowrap text-bn-xs leading-[14px]"
		>
			<TriStateMark state={state} />
			<span className={meta.label}>{label}</span>
		</span>
	);
}

/**
 * 图例。**它不是装饰**:三个记号里有两个是空心圈,不告诉人哪个是哪个,就只能猜 ——
 * 2026-09-10 主人就是这么猜错的(把一张正常的能力表读成了故障)。
 */
export function TriStateLegend() {
	return (
		<ul
			aria-label="能力图例"
			className="flex list-none items-center gap-3 p-0 text-bn-2xs text-bn-text-tertiary"
		>
			{(Object.keys(TRISTATE) as TriState[]).map((state) => (
				<li key={state} className="flex items-center gap-[5px]">
					<TriStateMark state={state} size={12} />
					{TRISTATE[state].text}
				</li>
			))}
		</ul>
	);
}
