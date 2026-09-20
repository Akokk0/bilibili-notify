/**
 * 卡片工坊回复末尾的预览块(ADR-0015 决策 20 / 22 的 🔗)。
 *
 * - **这条回复碰过几套就放几块**;块里按卡种切换,默认停在这一轮写过的第一种。
 * - **读的是盘上当前那份**,不是这条回复那一刻的样子 —— 皮肤库没有版本,所以标题写
 *   「当前样子」,不假装是快照。缓存键带着列表里的 `updatedAt`:皮肤一改,列表一刷,
 *   这里跟着重画。
 * - **走 HTML 不走截图**:不需要 Chrome,与编辑器的实时预览同一条路、同一个沙箱框。
 * - **「换上这套」是人点的**(决策 21 / 22):AI 手上没有这一把;已经在用就只说「正在用」。
 */

import type {
	AiCardSkinTouchDTO,
	CardSkinManifestResponse,
	CardSkinPreviewResponse,
} from "@bilibili-notify/contract";
import type { CardSkinKind } from "@bilibili-notify/internal";
import { CARD_SKIN_KIND_NAMES, CARD_SKIN_KINDS } from "@bilibili-notify/internal/constants";
import {
	Btn,
	ErrorNote,
	HintNote,
	Icon,
	LoadingBlock,
	Pill,
	TabBar,
	WarnNote,
} from "@bilibili-notify/ui";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useActivateCardSkin, useCardSkinList } from "../../pages/cards/card-skins-query";
import { SkinHtmlFrame, useStageWidth } from "../../pages/cards/SkinHtmlFrame";
import { api } from "../../services/api";

/** 量到卡高之前预览框先占的高度 px。量到了框就跟着卡走(与编辑器同一个框)。 */
const VIEW_H = 460;
/** 量不到可用宽度时(首帧、jsdom 里没有 ResizeObserver)的兜底。 */
const FALLBACK_WIDTH = 600;

const KIND_TABS = CARD_SKIN_KINDS.map((id) => ({ id, label: CARD_SKIN_KIND_NAMES[id] }));

export function CardSkinPreviews({ touches }: { touches: readonly AiCardSkinTouchDTO[] }) {
	return (
		<div className="flex flex-col gap-3">
			{touches.map((t) => (
				<CardSkinPreviewBlock key={t.id} touch={t} />
			))}
		</div>
	);
}

function CardSkinPreviewBlock({ touch }: { touch: AiCardSkinTouchDTO }) {
	const list = useCardSkinList();
	const skin = list.data?.skins.find((s) => s.id === touch.id);
	const inUse = list.data?.active === touch.id;
	const [kind, setKind] = useState<CardSkinKind>(touch.kinds[0] ?? CARD_SKIN_KINDS[0]);

	const preview = useQuery({
		queryKey: ["ai-chat", "card-skin-preview", touch.id, kind, skin?.updatedAt ?? 0],
		queryFn: async () => {
			const path = `/api/card-skins/${encodeURIComponent(touch.id)}`;
			const { manifest } = await api.get<CardSkinManifestResponse>(path);
			return api.post<CardSkinPreviewResponse>(`${path}/preview`, { kind, manifest });
		},
		// 列表里没有它 = 删了(或列表还没到):画不出来的就别去要。
		enabled: skin !== undefined,
	});

	// 同皮肤库那颗钮的**同一个** mutation(要作废哪几个 key 归它管)—— 这个动作在站里
	// 有两处入口,两处各写各的话,漏掉的那一处症状是「换了皮肤,这里的预览还是旧的」。
	const activate = useActivateCardSkin();

	const [stageRef, measured] = useStageWidth();

	const gone = list.isSuccess && skin === undefined;

	return (
		<div
			data-testid="card-skin-preview"
			className="bn-glass flex flex-col gap-2.5 rounded-bn-card p-3.5 shadow-bn-card"
		>
			<div className="flex items-center justify-between gap-2">
				<div className="flex min-w-0 items-center gap-2">
					<span className="flex text-bn-text-tertiary" aria-hidden="true">
						<Icon.image size={14} />
					</span>
					<span className="truncate text-bn-sm font-bold text-bn-text-primary">
						「{skin?.name ?? touch.id}」
					</span>
					<span className="shrink-0 text-bn-2xs text-bn-text-tertiary">当前样子 · 示例数据</span>
				</div>
				{gone ? null : inUse ? (
					<Pill subtle size="sm">
						正在用
					</Pill>
				) : (
					<Btn
						size="sm"
						variant="primary"
						disabled={skin === undefined || activate.isPending}
						onClick={() => activate.mutate(touch.id)}
					>
						换上这套
					</Btn>
				)}
			</div>

			{gone ? (
				<HintNote>这套皮肤已经不在库里了,预览没得看了。</HintNote>
			) : (
				<>
					<TabBar items={KIND_TABS} value={kind} onChange={setKind} />
					<div ref={stageRef} className="flex justify-center">
						{preview.data ? (
							<SkinHtmlFrame
								html={preview.data.html}
								width={preview.data.width}
								usable={measured ?? FALLBACK_WIDTH}
								fallbackHeight={VIEW_H}
								title={`「${skin?.name ?? touch.id}」的${CARD_SKIN_KIND_NAMES[kind]}`}
							/>
						) : preview.isError ? (
							<ErrorNote size="sm" className="w-full">
								这张画不出来:{String((preview.error as Error).message)}
							</ErrorNote>
						) : (
							<LoadingBlock label="正在画预览…" variant="inset" />
						)}
					</div>
					{preview.data?.warnings.length ? (
						// 标题不说「削掉了」:这里混着清洗器削掉的与装包时的提醒(用了没声明的
						// 旋钮之类),后者什么都没删。每条自己会说清是哪一种。
						<WarnNote size="sm" className="leading-5">
							<div className="space-y-0.5">
								<div className="font-semibold">有几处要留意:</div>
								{preview.data.warnings.map((w) => (
									<div key={w}>{w}</div>
								))}
							</div>
						</WarnNote>
					) : null}
				</>
			)}

			{activate.isError ? (
				<ErrorNote size="sm">没换上:{String((activate.error as Error).message)}</ErrorNote>
			) : null}
		</div>
	);
}
