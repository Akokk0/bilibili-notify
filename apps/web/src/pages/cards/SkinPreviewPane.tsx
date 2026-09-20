/**
 * 编辑器的实时预览栏(ADR-0014 决策 22)。
 *
 * **HTML 不是截图**:server 回一整份 HTML,这里塞进 `sandbox` iframe 画。代价是像素级
 * 与真出图有细微差(这边是看的人的浏览器在画,那边是 server 上的 Chrome),换来的是
 * **没装 Chrome 也能编皮肤** —— 决策 22 的全部意义。
 *
 * **iframe 只给 `allow-same-origin`、不给 `allow-scripts`**:皮肤里能写自定义 HTML 与
 * CSS,给了脚本就等于让皮肤作者在主人的面板里执行代码。同源是为了量卡高、让框跟着卡
 * 长(2026-09-17),规矩与理由都在 `SkinHtmlFrame` 的文件头。
 *
 * 草稿每敲一个字都重画太贵(一趟 SSR + UnoCSS),所以**防抖**;而「正在重画」不能把上一
 * 张图撤掉 —— 一边改一边闪白比慢半拍难受得多,所以旧图留着、只在角上标一句。
 */

import type { CardSkinShotResponse } from "@bilibili-notify/contract";
import type { CardSkinKind } from "@bilibili-notify/internal";
import {
	Btn,
	ErrorNote,
	GlassBox,
	HintNote,
	Icon,
	LoadingBlock,
	Picker,
	WarnNote,
} from "@bilibili-notify/ui";
import { useEffect, useRef, useState } from "react";
import { type GridMetrics, readGridMetrics } from "./canvas-tracks";
import {
	CELL_DEBUG_LABELS,
	CELL_DEBUG_MODES,
	type CellDebugMode,
	withCellDebug,
} from "./cell-debug";
import { serverErrors } from "./preview-error";
import { SkinHtmlFrame, useStageWidth } from "./SkinHtmlFrame";
import { usePreviewCardSkin, useRenderSource, useShotCardSkin } from "./skin-editor-query";

/** 防抖窗口。改一个旋钮到看见新图之间的等待,与「别把 server 打满」之间的折中。 */
const DEBOUNCE_MS = 400;

/** 量到卡高之前(以及万一量不到时)预览框先占的高度 px。量到了框就跟着卡走。 */
const VIEW_H = 560;

/** 截成功那一支。失败那支只有 `err` / `errors`,没有图可摆。 */
type ShotOk = Extract<CardSkinShotResponse, { ok: true }>;

export function SkinPreviewPane({
	skinId,
	kind,
	scene,
	manifest,
	boxWidth,
	onMetrics,
	hotCell,
}: {
	skinId: string;
	kind: CardSkinKind;
	scene: string;
	/** 当前草稿。`null` = 清单还没到。 */
	manifest: unknown;
	/**
	 * 这一栏能用宽度的**兜底值** px。真正算缩放用的是底板量出来的实际宽度(三栏改成按
	 * 占比分之后,列宽不再是调用方能算出来的数);量不到时(首帧、以及 jsdom 里没有
	 * `ResizeObserver`)才用这个。卡比可用宽度宽就**整张按比例缩** —— 硬挤会把右半张
	 * 切掉,而缩放至少比例是对的。
	 */
	boxWidth: number;
	/**
	 * 把预览框里**量到的**网格交出去(ADR-0018 决策 3):十二条列轨道给画布画列线,
	 * 每条行轨道多高给它印在行号旁。量不到(预览还没画完、jsdom 里没有布局引擎)各交
	 * `null`,画布退回按清单估、行高不印。
	 *
	 * ⚠️ 这条线**断了是静默的**:画布照旧画得出来,只是列线又开始凭清单猜,而那个偏差
	 * 只有拿尺子量才看得见。所以它自己有一条守卫(剪断必红),见测试。
	 */
	onMetrics?: (metrics: GridMetrics) => void;
	/**
	 * 画布指到的那个块(块 id;`null` = 指走了)。真卡里对应的格子会亮起来 —— 亮成什么样
	 * 归注进去的那段调试 CSS,所以**调试关着时点了也没反应**,正是主人说的「打开格子显示后」。
	 */
	hotCell?: string | null;
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
	/**
	 * 格子的调试叠层开到哪一档(ADR-0018 决策 5)。默认关着 —— 常显会把卡看花,而这块地方
	 * 平时是用来看卡好不好看的。
	 */
	const [cells, setCells] = useState<CellDebugMode>("off");
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

	/** 量不到就退回 `boxWidth`(首帧、以及 jsdom 里根本没有 `ResizeObserver`)。 */
	const [stageRef, measured] = useStageWidth();
	const usable = Math.max(measured ?? boxWidth, 1);

	/** 装包门拒了:`errors` 是逐条原因,原样列出来 —— 自编一句「预览失败」等于把线索吞掉。 */
	const errors = serverErrors(preview.error);
	/** 画出来多宽、缩多少。卡比这一栏窄时就按卡宽画,不拉伸(拉伸出来的不是那张卡)。 */
	const shown = Math.min(width, usable);
	const scale = shown / width;

	const stale = snap !== null && snap.of !== manifest;
	/** 没配 Chrome 就别让主人按下去吃一个 503 —— 禁掉,并且把该去配什么说出来。 */
	const noChrome = chrome.data?.enabled === false;

	return (
		<div className="space-y-3.5">
			<GlassBox
				title="实时预览"
				subtitle="server 出 HTML、浏览器画;字体渲染与截图有细微差,像素级以「最终效果」为准"
				accent="var(--color-bn-purple)"
				icon={<Icon.eye size={14} />}
			>
				<div className="flex flex-col gap-2">
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

					{/* 格子的调试叠层。摆在这儿而不是画布那边:看不见格子的是**真卡**,这个钮
					    就该长在真卡旁边。截的那张「最终效果」是 server 出的图,描不上去 ——
					    所以只在实时预览这一档给。 */}
					{snap === null ? (
						<div className="flex w-full items-center gap-2">
							<span className="shrink-0 text-bn-2xs text-bn-text-tertiary">格子</span>
							<Picker
								value={cells}
								onChange={setCells}
								options={CELL_DEBUG_MODES.map((m) => ({ value: m, label: CELL_DEBUG_LABELS[m] }))}
							/>
						</div>
					) : null}

					{noChrome ? (
						<HintNote className="w-full">
							没配渲染浏览器,截不了图 —— 去系统页的「卡片渲染浏览器」设一下,或者设环境变量
							BN_CHROME_PATH / BN_CHROME_ENDPOINT。下面的实时预览不受影响。
						</HintNote>
					) : null}

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
								{/* 不全是「清洗掉」:还混着装包时的提醒(用了没声明的旋钮之类),
								    那些什么都没删。每条自己会说清是哪一种。 */}
								<div className="font-semibold">存下去时有几处要留意:</div>
								{warnings.map((w) => (
									<div key={w}>{w}</div>
								))}
							</div>
						</WarnNote>
					) : null}

					<HintNote className="w-full">
						选中的块在预览里不画选框 —— 要对位置看中间画布的行列。
					</HintNote>
				</div>
			</GlassBox>

			{/* **卡片自己一块地方**(2026-09-14 主人拍板):从上面那张小卡里拿出来,单独一个
			    线框,卡摆在里面。说明与注记归小卡,这一块只管「这张卡长什么样」。
			    框照卡片页「卡片全家福」那一个(`rounded-bn-card` + `border-bn-border` + `p-4`)
			    —— **不铺底色**:铺了就成了一块实心板,而卡自己的底(以及半透明皮肤透出来的
			    那层)本来该落在页面底上。 */}
			<div
				ref={stageRef}
				className="flex justify-center rounded-bn-card border border-bn-border p-4"
			>
				{snap !== null ? (
					<div
						className="overflow-x-auto rounded-bn-sm shadow-md"
						style={{ width: Math.min(snap.res.width, usable) }}
					>
						{/* 截图就是一张 JPEG,按卡宽画、整张摊开(不限高,与实时预览一样跟着
						    卡长);宽放不下时这一格横着滚 —— 缩放会让「像素级以最终效果为准」
						    那句话当场失效。 */}
						<img src={snap.res.dataUrl} alt="最终效果" style={{ width: snap.res.width }} />
					</div>
				) : html === null ? (
					preview.isError ? null : (
						<LoadingBlock label="正在画第一张预览…" variant="inset" />
					)
				) : (
					<SkinHtmlFrame
						html={withCellDebug(html, cells)}
						width={width}
						usable={usable}
						fallbackHeight={VIEW_H}
						title="皮肤预览"
						// 画好了就量一次交给画布。只在 `load` 那一刻量 —— 与量卡高同一个时机。
						onDocument={onMetrics ? (doc) => onMetrics(readGridMetrics(doc)) : undefined}
						hotCell={hotCell}
					/>
				)}
			</div>

			{/* 这张卡当下的尺寸 / 缩放 / 过期状态 —— 跟着上面那块走,所以摆在它底下。 */}
			{snap !== null ? (
				<div className="space-y-2 text-center">
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
				</div>
			) : scale < 1 ? (
				<div className="text-center text-bn-2xs text-bn-text-tertiary">
					卡宽 {width},这一栏放不下,按 {Math.round(scale * 100)}% 缩放显示
				</div>
			) : null}
		</div>
	);
}
