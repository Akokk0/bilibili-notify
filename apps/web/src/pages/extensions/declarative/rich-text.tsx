import type { ExtensionRichRun, ExtensionRichText } from "@bilibili-notify/contract";
import type { ReactNode } from "react";
import { relativeTime } from "../../up/helpers";
import { extensionAddress } from "./address";

/**
 * 拓展交来的「一段字」(ADR-0019 决策 28)—— 一个字符串,或者一串片段。片段只有五种:
 * 字、`{ b }`、`{ mono }`、`{ time, suffix }`、`{ host: "extensionUrl" }`。
 *
 * 🔴 **没有 HTML**:每一片都当文本交给 React,拓展交来的尖括号画出来就是尖括号。这是
 * 「数据描述 + 主程序渲染」的底线 —— 开一个 `dangerouslySetInnerHTML` 的口子,拓展就能往
 * 面板里塞任意标记,而面板那一页吃的是主人的会话。
 *
 * 两样必须**在浏览器里**算:时刻(服务端算好的「12 分钟前」发到面板就冻住了)与地址
 * (服务端不知道外面经哪个地址访问它,而那正是桥那台机器要填的)。
 *
 * `boldClassName` / `monoClassName` 是摆放处的口子:同一段字在不同位置的强调色不一样
 * (地址行那句正文是 tertiary,加粗那几个字要提一档到 secondary;黄盒里加粗只加粗、跟着
 * 黄字走)。形状由这里定,颜色由摆放处给。
 */
export function RichText({
	text,
	extensionId,
	boldClassName,
	monoClassName,
}: {
	text: ExtensionRichText;
	/** `{ host }` 片段要拼的是**这个**拓展的地址。 */
	extensionId: string;
	boldClassName?: string;
	monoClassName?: string;
}) {
	if (typeof text === "string") return <>{text}</>;
	const ctx: RunContext = { extensionId, bold: boldClassName, mono: monoClassName };
	return (
		<>
			{text.map((run, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: 一段字的片段按位置排,不增删不重排,下标就是身份
				<Run key={i} run={run} ctx={ctx} />
			))}
		</>
	);
}

/** 每一片都要的那几样:拼地址用的 id、摆放处给的两种强调色。 */
interface RunContext {
	extensionId: string;
	bold?: string;
	mono?: string;
}

function Run({ run, ctx }: { run: ExtensionRichRun; ctx: RunContext }): ReactNode {
	const { extensionId, bold, mono } = ctx;
	if (typeof run === "string") return run;
	if ("b" in run) return <strong className={`font-bold ${bold ?? ""}`}>{run.b}</strong>;
	if ("mono" in run) return <span className={`font-mono ${mono ?? ""}`}>{run.mono}</span>;
	if ("time" in run) {
		// 宿主只卡了「非负整数」,没卡上限:越过 Date 能表示的范围时 `toISOString()` 会抛,
		// 一片时间把整页带走不值当 —— 那一格就不给机器可读的时刻。
		const at = new Date(run.time);
		return (
			<time dateTime={Number.isNaN(at.getTime()) ? undefined : at.toISOString()}>
				{relativeTime(run.time)}
				{run.suffix ?? ""}
			</time>
		);
	}
	if ("host" in run && run.host === "extensionUrl") {
		return <span className={`font-mono ${mono ?? ""}`}>{extensionAddress(extensionId)}</span>;
	}
	// 宿主交出来之前校验过,走到这里只可能是面板比服务端旧(应用内升级那几秒)。认不出的
	// 那一片不画 —— 整段字因为一片没见过的形状白屏,比少几个字糟得多。
	return null;
}
