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

import type { CardSkinShotResponse } from "@bilibili-notify/contract";
import type { CardSkinKind } from "@bilibili-notify/internal";
import { Btn, ErrorNote, HintNote, LoadingBlock, WarnNote } from "@bilibili-notify/ui";
import { useEffect, useRef, useState } from "react";
import { serverErrors } from "./preview-error";
import { usePreviewCardSkin, useRenderSource, useShotCardSkin } from "./skin-editor-query";

/** 防抖窗口。改一个旋钮到看见新图之间的等待,与「别把 server 打满」之间的折中。 */
const DEBOUNCE_MS = 400;

/** 预览窗口的可视高度 px。卡比它高时在 iframe 里自己滚 —— 隔离的 iframe 量不到内容高度。 */
const VIEW_H = 560;

/** 截成功那一支。失败那支只有 `err` / `errors`,没有图可摆。 */
type ShotOk = Extract<CardSkinShotResponse, { ok: true }>;

/**
 * 卡片摆在一块**底板**上,不贴着栏边(2026-09-14 主人指着卡片页的全家福说「预览放框里」)。
 *
 * 底板走 `surface-muted`(那一族里的凹陷档):卡自己是 `surface`,两层差一档才看得出「这是
 * 一张摆在台面上的卡」。半透明的皮肤会把底板透出来,所以这层不能写死白。
 */
function Stage({ children }: { children: React.ReactNode }) {
	return (
		<div className="flex w-full justify-center rounded-bn-md bg-bn-surface-muted p-4">
			{children}
		</div>
	);
}

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
	const shot = useShotCardSkin();
	const chrome = useRenderSource();
	/**
	 * 最近截的那一张,连**它是照哪一版草稿截的**一起记。只存图的话,主人改完草稿还挂着
	 * 一张旧图,而那张图看上去就是「改完的样子」—— 正是这颗按钮本来要消灭的那种误会。
	 */
	const [snap, setSnap] = useState<{ res: ShotOk; of: unknown } | null>(null);
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
	const errors = serverErrors(preview.error);
	/** 画出来多宽、缩多少。卡比这一栏窄时就按卡宽画,不拉伸(拉伸出来的不是那张卡)。 */
	const shown = Math.min(width, Math.max(boxWidth, 1));
	const scale = shown / width;

	const stale = snap !== null && snap.of !== manifest;
	/** 没配 Chrome 就别让主人按下去吃一个 503 —— 禁掉,并且把该去配什么说出来。 */
	const noChrome = chrome.data?.enabled === false;

	return (
		<div className="flex flex-col items-center gap-2">
			<div className="flex w-full items-center justify-between gap-2">
				<span className="text-bn-2xs text-bn-text-tertiary">
					{snap === null ? "实时预览 · 浏览器画的" : "最终效果 · server 上的 Chrome 画的"}
				</span>
				<div className="flex items-center gap-1.5">
					{snap === null ? null : (
						<Btn size="sm" variant="ghost" onClick={() => setSnap(null)}>
							回到实时预览
						</Btn>
					)}
					<Btn
						size="sm"
						variant="outline"
						disabled={noChrome || manifest === null || shot.isPending}
						onClick={() => {
							if (manifest === null) return;
							const of = manifest;
							shot.mutate(
								{ skinId, kind, scene, manifest },
								{ onSuccess: (r) => r.ok && setSnap({ res: r, of }) },
							);
						}}
					>
						{shot.isPending ? "正在截…" : "最终效果"}
					</Btn>
				</div>
			</div>

			{noChrome ? (
				<HintNote className="w-full">
					没配渲染浏览器,截不了图 —— 去系统页的「卡片渲染浏览器」设一下,或者设环境变量
					BN_CHROME_PATH / BN_CHROME_ENDPOINT。上面的实时预览不受影响。
				</HintNote>
			) : null}

			{snap !== null ? (
				<>
					<Stage>
						<div
							className="overflow-auto rounded-bn-sm bg-bn-surface shadow-md"
							style={{
								width: Math.min(snap.res.width, Math.max(boxWidth, 1)),
								maxHeight: VIEW_H,
							}}
						>
							{/* 截图就是一张 JPEG,按卡宽画、放不下时这一格自己滚 —— 缩放会让
							    「像素级以最终效果为准」那句话当场失效。 */}
							<img src={snap.res.dataUrl} alt="最终效果" style={{ width: snap.res.width }} />
						</div>
					</Stage>
					<span className="text-bn-2xs text-bn-text-tertiary">
						{snap.res.width} × {Math.round(snap.res.height)}
					</span>
					{stale ? (
						<WarnNote className="w-full" size="sm">
							草稿在这张截图之后又改过了,这张是上一版 —— 再按一次「最终效果」。
						</WarnNote>
					) : null}
					{snap.res.overHeight ? (
						<ErrorNote className="w-full" size="sm">
							这张 {Math.round(snap.res.height)} px,超过卡片高度上限 —— 真出图时它会被判失败、
							回落到默认皮肤,而推送那头不会有任何提示。
						</ErrorNote>
					) : null}
				</>
			) : html === null ? (
				preview.isError ? null : (
					<LoadingBlock label="正在画第一张预览…" variant="inset" />
				)
			) : (
				<>
					<Stage>
						<div
							// 底走 token 不写死白:皮肤能重绘这一层,而半透明的卡会把它透出来。
							className="overflow-hidden rounded-bn-sm bg-bn-surface shadow-md"
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
					</Stage>
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
				选中的块在预览里不画选框 —— 预览是隔离的 iframe,读不到里面的位置。要对位置看中间画布的行列。
			</HintNote>
		</div>
	);
}
