/**
 * 编辑器的实时预览栏(ADR-0014 决策 22)。
 *
 * **HTML 不是截图**:server 回一整份 HTML,这里塞进 `sandbox` iframe 画。代价是像素级
 * 与真出图有细微差(这边是看的人的浏览器在画,那边是 server 上的 Chrome),换来的是
 * **没装 Chrome 也能编皮肤** —— 决策 22 的全部意义。
 *
 * **iframe 不给 `allow-scripts` 也不给 `allow-same-origin`**:皮肤里能写自定义 HTML 与
 * CSS,给了脚本就等于让皮肤作者在主人的面板里执行代码;给了同源就等于让它读会话。
 * 这条也是「画布只能是示意图、不能把选框叠在预览上」的根由 —— 父页面读不到 iframe 里
 * 每个块的位置。
 *
 * 草稿每敲一个字都重画太贵(一趟 SSR + UnoCSS),所以**防抖**;而「正在重画」不能把上一
 * 张图撤掉 —— 一边改一边闪白比慢半拍难受得多,所以旧图留着、只在角上标一句。
 */

import type { CardSkinKind } from "@bilibili-notify/internal";
import { ErrorNote, HintNote, LoadingBlock, WarnNote } from "@bilibili-notify/ui";
import { useEffect, useRef, useState } from "react";
import { usePreviewCardSkin } from "./skin-editor-query";

/** 防抖窗口。改一个旋钮到看见新图之间的等待,与「别把 server 打满」之间的折中。 */
const DEBOUNCE_MS = 400;

/** 预览窗口的可视高度 px。卡比它高时在 iframe 里自己滚 —— 隔离的 iframe 量不到内容高度。 */
const VIEW_H = 560;

export function SkinPreviewPane({
	skinId,
	kind,
	scene,
	manifest,
	boxWidth,
}: {
	skinId: string;
	kind: CardSkinKind;
	scene: string;
	/** 当前草稿。`null` = 清单还没到。 */
	manifest: unknown;
	/**
	 * 这一栏能用的宽度 px。卡比它宽时**整张按比例缩**给看 —— 硬挤会把右半张切掉
	 * (600 宽的栏里塞 640 的卡就是这样),而缩放至少比例是对的。
	 */
	boxWidth: number;
}) {
	const preview = usePreviewCardSkin(skinId);
	/** 上一张画成功的图。重画期间**不撤掉** —— 闪白比慢半拍难受。 */
	const [html, setHtml] = useState<string | null>(null);
	const [width, setWidth] = useState(600);
	const [warnings, setWarnings] = useState<string[]>([]);
	// mutate 的引用每次渲染都在变,进 deps 会让这条 effect 每帧重跑一遍防抖。
	const run = useRef(preview.mutate);
	run.current = preview.mutate;

	useEffect(() => {
		if (manifest === null) return;
		const timer = setTimeout(() => {
			run.current(
				{ kind, scene, manifest },
				{
					onSuccess: (r) => {
						setHtml(r.html);
						setWidth(r.width);
						setWarnings(r.warnings);
					},
				},
			);
		}, DEBOUNCE_MS);
		return () => clearTimeout(timer);
	}, [kind, scene, manifest]);

	/** 装包门拒了:`errors` 是逐条原因,原样列出来 —— 自编一句「预览失败」等于把线索吞掉。 */
	const errors = errorsOf(preview.error);
	/** 画出来多宽、缩多少。卡比这一栏窄时就按卡宽画,不拉伸(拉伸出来的不是那张卡)。 */
	const shown = Math.min(width, Math.max(boxWidth, 1));
	const scale = shown / width;

	return (
		<div className="flex flex-col items-center gap-2">
			{html === null ? (
				preview.isError ? null : (
					<LoadingBlock label="正在画第一张预览…" variant="inset" />
				)
			) : (
				<>
					<div
						// 底走 token 不写死白:皮肤能重绘这一层,而半透明的卡会把它透出来。
						className="overflow-hidden rounded-bn-sm bg-bn-surface shadow-sm"
						style={{ width: shown, height: VIEW_H }}
					>
						<iframe
							// `srcDoc` + 空 sandbox:不给脚本、不给同源(见文件头)。
							srcDoc={html}
							sandbox=""
							title="皮肤预览"
							className="block border-0"
							// iframe 里按**卡的真实宽度**排版,再整张缩 —— 直接把 iframe 调窄等于让
							// 皮肤在一个它没见过的宽度上重新排,看到的就不是那张卡了。
							style={{
								width,
								height: Math.round(VIEW_H / scale),
								transform: scale < 1 ? `scale(${scale})` : undefined,
								transformOrigin: "top left",
							}}
						/>
					</div>
					{scale < 1 ? (
						<span className="text-bn-2xs text-bn-text-tertiary">
							卡宽 {width},这一栏放不下,按 {Math.round(scale * 100)}% 缩放显示
						</span>
					) : null}
				</>
			)}

			{errors.length > 0 ? (
				<ErrorNote className="w-full" size="sm">
					<div className="space-y-0.5">
						<div className="font-semibold">这版草稿存不进去,预览停在上一张:</div>
						{errors.map((e) => (
							<div key={e}>{e}</div>
						))}
					</div>
				</ErrorNote>
			) : null}

			{warnings.length > 0 ? (
				<WarnNote className="w-full leading-5" size="sm">
					<div className="space-y-0.5">
						<div className="font-semibold">存下去会被清洗掉这些:</div>
						{warnings.map((w) => (
							<div key={w}>{w}</div>
						))}
					</div>
				</WarnNote>
			) : null}

			<HintNote className="w-full">
				选中的块在预览里不画选框 —— 预览是隔离的 iframe,读不到里面的位置。要对位置看左边画布的行列。
			</HintNote>
		</div>
	);
}

/**
 * 装包门那串 `errors`。`api` 那层把 4xx 的响应体挂在 error 上,这里把它捞出来 ——
 * 捞不到就退回 message(至少还有一句话,而不是一片空白)。
 */
function errorsOf(err: unknown): string[] {
	if (!err) return [];
	const body = (err as { body?: { errors?: unknown } }).body;
	if (Array.isArray(body?.errors)) return body.errors.map(String);
	return [String((err as Error).message)];
}
