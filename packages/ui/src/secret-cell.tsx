import type { ReactNode } from "react";
import { Btn, MonoChip } from "./atoms";
import { TInput } from "./form-controls";
import { useUiText } from "./texts";

/**
 * 一格密钥在面板上的样子 —— 拓展设置页、连接表单、智能女仆页共用这一份(ADR-0021 决策 44)。
 *
 * 存下来的密钥只有服务端算好的遮挡(`{ masked }`),浏览器手里本来就没有全文:已存着的显示「遮挡胶囊 +
 * 换一份」,点了才出输入框、可以「不换了」撤回;没存着的直接是输入框。**清空 = 点「换一份」后输入框留空
 * 再保存**,不另加清除钮。纯展示 + 一点交互,不碰 api / store;`MonoChip` 是它的底座。
 */

/**
 * 服务端下发的遮挡格的形状。**这个库不依赖 wire 契约**,所以自己写一份:与 `contract` 的 `MaskedSecret` 同形,
 * 面板把契约那边的类型传进来,结构对得上就过;那边改了形状,面板这头编译会报。
 */
export interface MaskedSecretShape {
	masked: string;
}

/** 草稿里的一格密钥:还是下发的遮挡(没动),或者字符串(换了新的;空串 = 清空)。 */
export type SecretDraftShape = MaskedSecretShape | string;

/**
 * 存着的一格密钥在屏幕上的样子 —— **服务端算好的那一串**(`{ masked }`,决策 35 / 38)。空着(没配、
 * 脱敏备份恢复回来的)交 `undefined`,面板要分得开「没配」与「配了」。
 *
 * 🔴 面板**不再自己截头尾**:浏览器手里本来就没有全文。万一下发的不是遮挡的形状(面板比服务端新的
 * 那几秒、手改过的文件),一律画一串点 —— 一格声明成密钥的值,不管长什么样都不原样上屏。
 */
export function maskedOf(value: unknown): string | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	if (typeof value === "object" && !Array.isArray(value)) {
		const masked = (value as { masked?: unknown }).masked;
		if (typeof masked === "string") return masked;
	}
	return "•".repeat(8);
}

/**
 * 密钥那一格的值:等宽小字胶囊。设置表单(遮住的密钥、生成的那一格)、列表卡的密钥行与连接 / AI 表单共用。
 *
 * `text` 是**摆放处决定好的那一串**:存着的那一把是服务端给的遮挡(`maskedOf`,浏览器不自己截);
 * 刚生成的那一把是明文 —— 主人要把它抄进对面去,只有那一刻明文在面板手里(决策 38)。
 */
export function SecretChip({ text }: { text: string }) {
	return <MonoChip className="min-w-0 flex-1 truncate px-[9px] py-[5px]">{text}</MonoChip>;
}

/**
 * 已存着的密钥格的交互:`savedMask` 有值且没在换 → 胶囊 + 「换一份」;在换 → 输入框(`children`)+
 * 「不换了」;没存着(`savedMask` 为 `undefined`)→ 直接是输入框。
 *
 * 「换了没有」是摆放处的状态(`replacing`),撤回时要把草稿里那格还原也归摆放处(`onCancelReplace`)。
 */
export function SavedSecretControl({
	savedMask,
	replacing,
	onReplace,
	onCancelReplace,
	children,
}: {
	savedMask: string | undefined;
	replacing: boolean;
	onReplace: () => void;
	onCancelReplace: () => void;
	/** 输入框 —— 摆放处按自己的草稿造。 */
	children: ReactNode;
}) {
	const tx = useUiText();

	if (savedMask === undefined) return <>{children}</>;
	if (!replacing) {
		return (
			<div className="flex flex-wrap items-center gap-2.5">
				<SecretChip text={savedMask} />
				<Btn variant="outline" size="sm" onClick={onReplace}>
					{tx("ui.secret-cell.1")}
				</Btn>
			</div>
		);
	}
	return (
		<div className="flex items-start gap-2.5">
			<div className="min-w-0 flex-1">{children}</div>
			<Btn variant="ghost" size="sm" onClick={onCancelReplace}>
				{tx("ui.secret-cell.2")}
			</Btn>
		</div>
	);
}

/**
 * 草稿里直接带着密钥格的表单(智能女仆页)用的那一版:草稿格要么还是**下发的遮挡**(没动),要么是
 * 字符串(换了新的;空串 = 清空)。`saved` 是基线里同一格 —— 它是遮挡才算「已存着」。
 *
 * 点「换一份」草稿格变成空串(出输入框),「不换了」把基线那份遮挡原样放回去 —— 这样保存时 `buildPatch`
 * 看到两边同是遮挡就不发这一格。
 */
export function DraftSecretInput({
	value,
	saved,
	onChange,
	placeholder,
}: {
	value: SecretDraftShape;
	saved: unknown;
	onChange: (next: SecretDraftShape) => void;
	placeholder?: string;
}) {
	const savedMask = typeof saved === "object" ? maskedOf(saved) : undefined;
	return (
		<SavedSecretControl
			savedMask={savedMask}
			replacing={typeof value === "string"}
			onReplace={() => onChange("")}
			onCancelReplace={() => onChange(saved as MaskedSecretShape)}
		>
			<TInput
				value={typeof value === "string" ? value : ""}
				onChange={onChange}
				secret
				mono
				placeholder={placeholder}
			/>
		</SavedSecretControl>
	);
}
