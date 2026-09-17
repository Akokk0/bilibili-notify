/**
 * CSS 框旁那颗「请女仆帮忙写」(ADR-0015 决策 3–10)—— 只写**这一个框**。
 *
 * - **按了才弹**一个小浮层(决策 4):检查器只有 380 宽,常驻一个输入框太挤,而这功能
 *   不是每次编辑都用。
 * - **逐条规则流进框**(决策 7 与它的 🔗),右边预览跟着变;第一条到之前框里还是原文,
 *   免得开写那一瞬这块的样式整个消失。
 * - **一次性的「还原」**(决策 8):编辑器没有撤销栈,不给的话手写的那段当场找不回来。
 * - **重来、失败、停、半路换了选中**,框一律退回动手前的原文 —— 半截 CSS 留在框里,
 *   用户分不清哪句是自己的。
 * - 按不动时 `title` 说得出为什么(决策 10)。
 */

import { CARD_SKIN_AI_INSTRUCTION_MAX } from "@bilibili-notify/contract";
import {
	Btn,
	ErrorNote,
	HintNote,
	Icon,
	PopoverShell,
	useDismiss,
	WarnNote,
} from "@bilibili-notify/ui";
import { useEffect, useRef, useState } from "react";
import { TArea } from "../../components/forms";
import type { CardSkinAiDone, CardSkinAiHandlers } from "../../services/cardSkinAi";
import type { CardSkinAiReadiness } from "./card-skin-ai";

/** 已经绑好「写哪个框」的那一口。 */
export interface CssAiBinding {
	readiness: CardSkinAiReadiness;
	run: (
		instruction: string,
		handlers: CardSkinAiHandlers,
		signal: AbortSignal,
	) => Promise<CardSkinAiDone>;
}

export function CssAiSlot({
	ai,
	value,
	onChange,
}: {
	ai: CssAiBinding;
	value: string;
	onChange: (css: string) => void;
}) {
	const [open, setOpen] = useState(false);
	const [instruction, setInstruction] = useState("");
	const [running, setRunning] = useState(false);
	const [written, setWritten] = useState(0);
	const [note, setNote] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	/** 上一趟写完留下的:动手前的原文(给「还原」)与清洗器削掉了什么。 */
	const [undo, setUndo] = useState<{ original: string; warnings: string[] } | null>(null);

	// 回调里读的都是**最新**的那份:流是异步来的,闭包里那份早就旧了。
	const valueRef = useRef(value);
	valueRef.current = value;
	const onChangeRef = useRef(onChange);
	onChangeRef.current = onChange;
	/** 正在写的这一趟;`null` = 没在写。停、卸载、写完都会把它清掉,迟到的回调据此作废。 */
	const runRef = useRef<{ original: string; ctl: AbortController } | null>(null);
	const wrapRef = useRef<HTMLDivElement>(null);

	// 写的时候点外面不关:那一下多半是去看右边的预览,不是想停。
	useDismiss(wrapRef, () => setOpen(false), { enabled: open && !running, escape: true });

	// 半路卸载(换了选中 / 换了卡种 / 离开页面)就是停:掐断,并把那个框退回原文。
	useEffect(
		() => () => {
			const cur = runRef.current;
			if (!cur) return;
			runRef.current = null;
			cur.ctl.abort();
			onChangeRef.current(cur.original);
		},
		[],
	);

	const stop = () => {
		const cur = runRef.current;
		if (!cur) return;
		runRef.current = null;
		cur.ctl.abort();
		onChangeRef.current(cur.original);
		setRunning(false);
		setNote(null);
	};

	const start = async () => {
		const text = instruction.trim();
		if (text === "" || runRef.current) return;
		const original = valueRef.current;
		const mine = { original, ctl: new AbortController() };
		runRef.current = mine;
		const live = () => runRef.current === mine;
		let acc = "";
		setRunning(true);
		setWritten(0);
		setNote(null);
		setError(null);
		setUndo(null);
		try {
			const done = await ai.run(
				text,
				{
					onRule: (rule) => {
						if (!live()) return;
						acc += rule;
						setWritten((n) => n + 1);
						onChangeRef.current(acc);
					},
					onRetry: () => {
						if (!live()) return;
						acc = "";
						setWritten(0);
						setNote("第一遍没过清洗器,女仆在重写…");
						onChangeRef.current(original);
					},
				},
				mine.ctl.signal,
			);
			if (!live()) return;
			runRef.current = null;
			onChangeRef.current(done.css);
			setUndo({ original, warnings: done.warnings });
			setRunning(false);
			setNote(null);
			setOpen(false);
			setInstruction("");
		} catch (e) {
			// 停了 / 卸载了:原文已经退回去,这边没人在看了。
			if (!live()) return;
			runRef.current = null;
			onChangeRef.current(original);
			setRunning(false);
			setNote(null);
			setError(e instanceof Error ? e.message : String(e));
		}
	};

	const tooLong = instruction.length > CARD_SKIN_AI_INSTRUCTION_MAX;

	return (
		<div className="flex flex-col gap-1.5">
			<div ref={wrapRef} className="relative flex justify-end">
				<Btn
					size="sm"
					variant="ghost"
					icon={<Icon.ai size={12} />}
					disabled={!ai.readiness.ready}
					title={ai.readiness.ready ? "说一句想要的样子,女仆只动这一个框" : ai.readiness.reason}
					aria-haspopup="dialog"
					ariaExpanded={open}
					onClick={() => setOpen((o) => !o)}
				>
					请女仆帮忙写
				</Btn>
				{open ? (
					<PopoverShell
						align="stretch"
						variant="panel"
						layer="raised"
						role="dialog"
						ariaLabel="请女仆帮忙写"
						className="flex flex-col gap-2"
					>
						<TArea
							value={instruction}
							onChange={setInstruction}
							rows={2}
							disabled={running}
							ariaLabel="想让这段 CSS 变成什么样"
							placeholder="比如:毛玻璃、圆角大一点"
						/>
						{tooLong ? (
							<ErrorNote size="sm">最多 {CARD_SKIN_AI_INSTRUCTION_MAX} 字。</ErrorNote>
						) : null}
						{error ? <ErrorNote size="sm">女仆没能写好:{error}</ErrorNote> : null}
						<div className="flex items-center justify-end gap-2">
							{running ? (
								<>
									<span className="mr-auto text-bn-2xs text-bn-text-tertiary" aria-live="polite">
										{note ?? (written > 0 ? `女仆已经写好 ${written} 条了…` : "女仆正在写…")}
									</span>
									<Btn size="sm" variant="outline" onClick={stop}>
										先不用了
									</Btn>
								</>
							) : (
								<Btn
									size="sm"
									onClick={() => void start()}
									disabled={instruction.trim() === "" || tooLong}
								>
									拜托啦
								</Btn>
							)}
						</div>
					</PopoverShell>
				) : null}
			</div>

			{undo ? (
				<HintNote className="flex flex-col gap-1.5">
					<div className="flex items-center gap-2">
						<span className="mr-auto">女仆刚改过这一段。</span>
						<Btn
							size="sm"
							variant="ghost"
							onClick={() => {
								onChangeRef.current(undo.original);
								setUndo(null);
							}}
						>
							还原
						</Btn>
					</div>
					{undo.warnings.length > 0 ? (
						<WarnNote size="sm">
							{undo.warnings.map((w) => (
								<div key={w}>清洗器削掉了:{w}</div>
							))}
						</WarnNote>
					) : null}
				</HintNote>
			) : null}
		</div>
	);
}
