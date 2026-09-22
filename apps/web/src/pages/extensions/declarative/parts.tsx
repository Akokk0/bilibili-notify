import {
	Btn,
	Icon,
	IconButton,
	TRISTATE_TEXT,
	type TriState,
	TriStateMark,
} from "@bilibili-notify/ui";
import { useState } from "react";
import { copyToClipboard } from "../../../utils/clipboard";

/**
 * 照声明画的那一页(ADR-0019 决策 19)上反复出现的那几件小东西 —— 积木、列表卡、设置表单、
 * 新建弹窗**共用这一份**。
 *
 * 各抄一份的话,一处今天改一个圆角,别处明天就对不上了,而且哪边都不会报错。
 *
 * `KindMark` / `MonoChip` / `OptionCard` / `TriStateMark` / `TriStateChip` 零业务依赖,住在
 * `@bilibili-notify/ui`(清单见那个包的 README);`CopyControl` 走 web 的剪贴板,留在这儿。
 */

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

/**
 * 图例。**它不是装饰**:三个记号里有两个是空心圈,不告诉人哪个是哪个,就只能猜 ——
 * 2026-09-10 主人就是这么猜错的(把一张正常的能力表读成了故障)。
 */
export function TriStateLegend() {
	return (
		<ul
			aria-label="图例"
			className="flex list-none items-center gap-3 p-0 text-bn-2xs text-bn-text-tertiary"
		>
			{(Object.keys(TRISTATE_TEXT) as TriState[]).map((state) => (
				<li key={state} className="flex items-center gap-[5px]">
					<TriStateMark state={state} size={12} />
					{TRISTATE_TEXT[state]}
				</li>
			))}
		</ul>
	);
}
