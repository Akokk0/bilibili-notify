import type { InjectableMarketplace } from "../marketplace-injection.js";
import { DevParamError, type DevScenarioDef } from "../registry.js";

/**
 * 「拓展有更新」—— 已装卡片上的「有新版 vX · 更新」一键造出来,而且按得下去。
 *
 * 装饰在市场那一层(`marketplace-injection.ts`),拓展页与路由一行不改:页面看的就是
 * `GET /api/ext/marketplace` 里那一条 `updatable`,按「更新」走的就是真的那条
 * `POST /api/ext/marketplace/install`。假的只有两处:列表里那一条的状态与版本、以及装的那一下
 * (不下载不写盘,回一个同形状的成功)。
 *
 * 状态类:进「当前生效」条、归一键收摊;按「更新」假装装成之后自己撤掉(现实里更新完那张卡
 * 就不再提示了)。
 */
export function marketplaceUpdateScenario(injectable: InjectableMarketplace): DevScenarioDef {
	return {
		id: "ext.updatable",
		group: "ext",
		title: "拓展有更新",
		icon: "arrowUp",
		desc: "让一张已装卡片出现「有新版 · 更新」(版本 = 装着那版的下一个补丁号;索引里没有它就现造一条官方的)。按「更新」会假装装成:不下载、不写盘,卡上印的版本号也就不变;装成后这条自己撤掉。",
		params: [
			{
				key: "ext",
				label: "拓展 id",
				kind: "text",
				default: "bridge",
				placeholder: "已装的拓展 id,如 bridge",
			},
		],
		run(params) {
			const id = String(params.ext ?? "").trim();
			if (id === "") throw new DevParamError("要给一个拓展 id");
			// 没装的造了也看不见:「有新版」那颗钮长在已装卡片上,市场那一节又把可更新的滤掉了。
			if (!injectable.installed(id)) {
				throw new DevParamError(
					`${id} 没装 —— 「有新版」长在已装卡片上,先装上它(拓展组「装一个仓里的拓展」或从市场装)`,
				);
			}
			injectable.inject(id);
			const version = injectable.injected()?.version;
			return {
				summary: `${id} 的卡上现在有「有新版 v${version} · 更新」;按下去假装装成,盘上一个字节都不动`,
			};
		},
		active() {
			const now = injectable.injected();
			if (!now) return null;
			const tail = now.version ? ` v${now.version}` : "(现在没装,不生效)";
			return { scenarioId: "ext.updatable", label: `拓展有更新 → ${now.id}${tail}` };
		},
		reset() {
			injectable.clear();
		},
	};
}
