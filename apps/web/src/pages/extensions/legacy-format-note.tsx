/**
 * 老格式(清单 v1)拓展头卡里那块提示(ADR-0019 决策 44)。
 *
 * 这一版 BN 仍认 v1(区间 `[1, 2]`),所以装着的老桥升级 BN 之后推送照常 —— 可面板只会照 v2 的
 * 声明画设置与视图,v1 在这一页上什么都管不了。不说的话,主人看到的是一页「没交面板」,既不知道
 * 为什么,也不知道怎么办。下一版抬最低档到 2、删掉这条退路时,这块跟着删。
 *
 * 出路就地给:市场里有它的新版就是那颗「更新」(与已装卡片上**同一颗**,走同一份 installer);
 * 没有就说清为什么、指去市场那一节 —— 不给一颗按了没用的钮。
 */

import type { ExtensionDTO, MarketplaceResponse } from "@bilibili-notify/contract";
import { ErrorNote, HintNote } from "@bilibili-notify/ui";
import { Link } from "react-router-dom";
import {
	type MarketplaceInstaller,
	MarketplaceUpdateOffer,
	useMarketplace,
} from "./marketplace-section";
import { PARAGRAPH_CLS, reasonOf } from "./shared";

/**
 * 市场里为什么没有它能更新到的版本。每一档是不同的事实、出路也不同(修源 / 加源 / 等新版 /
 * 自己拿包装),合成一句「没有更新」主人就不知道该做哪件。还在问的时候是 `null`:先说一句
 * 「没有」再改口,比晚一拍说更糟。
 */
function whyNoUpdate(
	id: string,
	data: MarketplaceResponse | undefined,
	error: Error | null,
): string | null {
	// 测试替身与老服务端可能缺格,缺了按空的算。
	const entry = (data?.extensions ?? []).find((candidate) => candidate.id === id);
	// 手里那份还说有新版就给钮 —— 重拉失败时 react-query 留着上一份,别一边给钮一边说「问不到」。
	if (entry?.state === "updatable") return null;
	if (error) return `市场问不到:${reasonOf(error)}`;
	if (!data) return null;
	const sources = data.sources ?? [];
	if (!entry) {
		if (!data.available && !sources.some((source) => !source.official)) {
			return "这个构建没有官方源,也还没加第三方源。";
		}
		const failed = sources.filter((source) => !source.ok);
		if (failed.length > 0) {
			return `市场里没查到它:${failed.map((source) => `源「${source.name}」`).join("、")}这次没拉到。`;
		}
		return "配着的源里都没有它。";
	}
	// `updatable` 上面已经接走了,这里只剩没有钮可给的几档。
	switch (entry.state) {
		case "installed":
			// 索引里的更新版本自己装不了(被撤回 / 要更高一格的契约)时,服务端也压回这一档。
			return entry.installed?.version === entry.version
				? "市场里最新的就是装着的这一版,还没有新格式的。"
				: `市场里的 v${entry.version} 这台 BN 装不了,没有能更新到的版本。`;
		case "installed-elsewhere":
			return "你这份不是从市场装的,市场不提示它的更新。";
		case "revoked":
			// 撤回了、却有能换过去的新版时服务端给的是 `updatable`(带 `installed.revoked`),红字
			// 跟着那颗钮画在 `MarketplaceUpdateOffer` 里;走到这一档说明没有新版可换。
			return "装着的这一版被市场撤回了。";
		// 装着的拓展走不到这两档(服务端对装着的只给上面四种);留着让 switch 穷尽。
		case "installable":
		case "incompatible":
			return "市场里没有它能更新到的版本。";
	}
}

interface LegacyFormatNoteProps {
	ext: ExtensionDTO;
	/** 页面那一份「从市场装」—— 确认框、换装与失败那句话都挂在它上面。 */
	installer: MarketplaceInstaller;
}

export function LegacyFormatNote({ ext, installer }: LegacyFormatNoteProps) {
	/*
	 * 更新过了、新版等着换上(跑着的还是 v1 那份,ADR-0012 决策 47):再说「去市场更新」就是
	 * 假话 —— 市场那条已经是「已装」,照着去只会扑空。怎么换就在头卡上面那块(重启 BN / 只重载),
	 * 这里只说换上之后就能管。这一档也用不着问市场。
	 */
	if (ext.staged) {
		return (
			<HintNote tone="neutral">
				<p className={PARAGRAPH_CLS}>
					这是老格式的拓展。新版 v{ext.staged.version} 已经下好了,换上之后才能在这里管理。
				</p>
			</HintNote>
		);
	}
	return <LegacyUpdateNote ext={ext} installer={installer} />;
}

/** 还没更新的那一档:那句话 + 市场给得出的出路。单拆一件是因为只有这一档要问市场。 */
function LegacyUpdateNote({ ext, installer }: LegacyFormatNoteProps) {
	const market = useMarketplace();
	const entry = (market.data?.extensions ?? []).find((candidate) => candidate.id === ext.id);
	const why = whyNoUpdate(ext.id, market.data, market.error);
	return (
		<HintNote tone="neutral" className="flex flex-col gap-2">
			<p className={PARAGRAPH_CLS}>这是老格式的拓展,去市场更新之后才能在这里管理。</p>
			{entry?.state === "updatable" ? (
				<MarketplaceUpdateOffer entry={entry} installer={installer} />
			) : null}
			{/*
			 * 没更新成就在那颗钮旁边说,原因照服务端那句原样摆(下不动 / 校验不过 / 装不上)。这一页
			 * 只有「更新」这一件事会用那份 installer,所以不必像列表页那样分「装不了」。
			 */}
			{installer.errors.length > 0 ? (
				<ErrorNote size="sm">更新不了:{installer.errors.join(";")}</ErrorNote>
			) : null}
			{why ? (
				<div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-bn-2xs leading-[1.6] text-bn-text-tertiary">
					<span>{why}</span>
					{/* 市场是拓展页上的一节(ADR-0013 决策 14),源与「重新拉索引」都在那儿。 */}
					<Link
						to="/extensions"
						className="shrink-0 font-bold text-bn-pink underline decoration-from-font underline-offset-2"
					>
						去拓展市场
					</Link>
				</div>
			) : null}
		</HintNote>
	);
}
