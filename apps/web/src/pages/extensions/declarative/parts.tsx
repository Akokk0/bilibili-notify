import {
	Btn,
	HintNote,
	Icon,
	IconButton,
	MonoChip,
	TRISTATE_TEXT,
	type TriState,
	TriStateMark,
} from "@bilibili-notify/ui";
import { type ReactNode, useState } from "react";
import { copyToClipboard } from "../../../utils/clipboard";

/**
 * 照声明画的那一页(ADR-0019 决策 19)上反复出现的那几件小东西 —— 积木、列表卡、设置表单、
 * 新建弹窗**共用这一份**。
 *
 * 各抄一份的话,一处今天改一个圆角,别处明天就对不上了,而且哪边都不会报错。
 *
 * `KindMark` / `MonoChip` / `OptionCard` / `TriStateMark` / `TriStateChip` 零业务依赖,住在
 * `@bilibili-notify/ui`(清单见那个包的 README);`CopyControl` 走 web 的剪贴板、密钥那几件讲的是
 * 这一页的规矩(存下之后只画服务端给的遮挡、不给复制),留在这儿。
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
	/*
	 * 记的是**复制下去的那一串**,不是一个「复制过」的开关:`text` 一换(重新生成了一把),屏幕
	 * 上这一串就没进过剪贴板 —— 还说「已复制」,主人会以为新的已经在剪贴板里,粘过去的却是作废
	 * 的那一把。复制还没回来就换了一串的,回来那一下记的也是旧的,挂不到新的头上。
	 */
	const [copiedText, setCopiedText] = useState<string | null>(null);
	const copied = copiedText === text;
	const icon = copied ? <Icon.check size={13} /> : <Icon.copy size={13} />;
	const copy = () => {
		void copyToClipboard(text).then((ok) => setCopiedText(ok ? text : null));
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

// ── 密钥 ─────────────────────────────────────────────────────────────────────

/**
 * 密钥那一格的值:等宽小字胶囊。设置表单(遮住的密钥、生成的那一格)与列表卡的密钥行共用。
 *
 * `text` 是**摆放处决定好的那一串**:存着的那一把是服务端给的遮挡(`maskedOf`,浏览器不自己截);
 * 刚生成的那一把是明文 —— 主人要把它抄进对面去,只有那一刻明文在面板手里(决策 38)。
 */
export function SecretChip({ text }: { text: string }) {
	return <MonoChip className="min-w-0 flex-1 truncate px-[9px] py-[5px]">{text}</MonoChip>;
}

/**
 * 「重新生成」那一颗。红描边:存下之后旧的那一把就作废,正用着它的那一头会断开。`label` 是念给
 * 读屏器的那一格(「家里那台 的 token」)—— 光一个「重新生成」,一屏好几颗时分不出是哪一格。
 */
export function RegenerateButton({
	label,
	disabled,
	onClick,
}: {
	label: string;
	disabled?: boolean;
	onClick: () => void;
}) {
	return (
		<Btn
			variant="danger-outline"
			size="sm"
			disabled={disabled}
			aria-label={`重新生成 ${label}`}
			icon={<Icon.refresh size={13} />}
			onClick={onClick}
		>
			重新生成
		</Btn>
	);
}

/**
 * 生成的那一格空着时:红字旁注说清怎么回事(`children`,各处的说法不同)+ 就地一颗「重新生成」。
 * 外面那一排(flex 行、挂什么标记)归摆放处。
 *
 * 🔴 空值是**脱敏备份恢复回来**的常态(那条路把密钥抹掉了),不是稀罕情况。只说一句「生成一个」
 * 却不给那颗钮,等于请人做一件他在这一页上做不到的事 —— 所以钮由这里出,不留给摆放处忘。
 */
export function MissingSecretNote({
	children,
	label,
	disabled,
	onRegenerate,
}: {
	children: ReactNode;
	label: string;
	disabled?: boolean;
	onRegenerate: () => void;
}) {
	return (
		<>
			<HintNote tone="danger" className="min-w-0 flex-1">
				{children}
			</HintNote>
			<RegenerateButton label={label} disabled={disabled} onClick={onRegenerate} />
		</>
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
