import type { HTMLAttributes, ReactNode } from "react";
import { LoadingBlock } from "./glass";

/** 描边浅底的那张卡 —— 摆在页面 / 别人卡里的扫码块。 */
const QR_FRAME = "rounded-lg border border-bn-border bg-bn-surface/55 p-6";

/** 二维码那一方:224px 见方。图与等图时的占位是同一个尺寸,来图时不跳。 */
const QR_SQUARE = "h-56 w-56";

export interface QrPanelProps extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
	/** 二维码图。没有(还没到 / 不合规矩被调用方滤掉)时看 `loading`。 */
	src?: string | null;
	/** 念给读屏器的「这是什么的二维码」。 */
	alt: string;
	/** 图还没到时,占位方块里转圈说的那句话(「二维码加载中」)。不给就不占位。 */
	loading?: ReactNode;
	/**
	 * `framed`(默认)自带描边浅底的卡,给摆在页面或别人卡里的位置;`bare` 只排版、除了图本身
	 * 什么底和边都不画,给已经在弹窗里的位置 —— 弹窗自己就是底,卡里套卡、占位方块再垫一层底
	 * 都是多出来的。
	 */
	variant?: "framed" | "bare";
	/** 图下面的说明,一个子节点一行、竖着排。 */
	children?: ReactNode;
}

/**
 * 扫码那一块:二维码(或等图时的占位)+ 底下的说明。系统页的 B 站登录、拓展交来的 `qr` 积木、
 * QQ 机器人的扫码绑定共用 —— 任何扫码都该长一个样,此前靠的是三份复制粘贴。
 *
 * 外层的属性原样透传(导览的聚光灯锚点 `data-tour` 就挂在这儿)。
 */
export function QrPanel({
	src,
	alt,
	loading,
	variant = "framed",
	className,
	children,
	...box
}: QrPanelProps) {
	const framed = variant === "framed";
	return (
		<div
			{...box}
			className={["flex flex-col items-center gap-3", framed ? QR_FRAME : "", className ?? ""]
				.filter(Boolean)
				.join(" ")}
		>
			{src ? (
				<img
					alt={alt}
					className={`${QR_SQUARE} rounded-sm bg-bn-surface p-2 shadow-bn-card`}
					src={src}
				/>
			) : loading ? (
				// 卡里的占位垫一块与图同色的底(来图时只是底上多了码);弹窗里不垫,见 `variant`。
				<div
					className={`flex ${QR_SQUARE} items-center justify-center${framed ? " rounded-sm bg-bn-surface" : ""}`}
				>
					<LoadingBlock variant="inset" label={loading} />
				</div>
			) : null}
			{children}
		</div>
	);
}
