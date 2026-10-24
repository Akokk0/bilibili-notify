/**
 * 0.x 里没改过的文字模板不搬进 1.0:输入在夹具之外造,只经迁移模块的公开入口。
 */

import { describe, expect, it } from "vite-plus/test";
import { OLD_DEFAULTS, rewriteText } from "../live-placeholders.js";
import { MEMBERSHIP_DEFAULT_TEMPLATE } from "../membership-moves.js";
import {
	removeUnchangedGlobalTexts,
	removeUnchangedSubscriptionTexts,
} from "../unchanged-texts.js";
import { ZERO_DEFAULT_TEMPLATES } from "../zero-vocabulary.js";

type Obj = Record<string, unknown>;

function oldDefault(key: keyof typeof OLD_DEFAULTS): string {
	const text = OLD_DEFAULTS[key]?.[0];
	if (text === undefined) throw new Error(`missing frozen default: ${key}`);
	return rewriteText(key, text);
}

/** 0.12 出厂文案走完今天的改名、改写之后,流水末尾看到的八条草稿文字。 */
const UNCHANGED_GLOBAL_TEXTS = {
	liveStart: ZERO_DEFAULT_TEMPLATES.liveStart,
	liveStreaming: ZERO_DEFAULT_TEMPLATES.liveOngoing,
	liveEnd: ZERO_DEFAULT_TEMPLATES.liveEnd,
	liveSummary: oldDefault("liveSummary"),
	post: ZERO_DEFAULT_TEMPLATES.dynamic,
	postVideo: ZERO_DEFAULT_TEMPLATES.dynamicVideo,
	viewerChat: oldDefault("viewerChat"),
	viewerEnter: oldDefault("viewerEnter"),
};

const globalWith = (templates: Obj, ledger?: Obj): Obj => ({
	defaults: { templates },
	...(ledger ? { templatesSeen: ledger } : {}),
});

describe("removeUnchangedGlobalTexts", () => {
	it("八条 0.12 出厂文字与会员体系默认都拿掉,停用词、图片、开关与档位不动;locale 写成简体", () => {
		const tiers = { captain: { template: "主人写的舰长文案" } };
		const out = removeUnchangedGlobalTexts(
			globalWith({
				...UNCHANGED_GLOBAL_TEXTS,
				wordcloudStopWords: "主播 直播",
				membership: {
					guard: {
						enabled: true,
						default: {
							template: MEMBERSHIP_DEFAULT_TEMPLATE,
							imageUrl: "guard.png",
						},
						tiers,
					},
				},
			}),
		) as Obj;

		expect(out.defaults).toEqual({
			templates: {
				wordcloudStopWords: "主播 直播",
				membership: {
					guard: {
						enabled: true,
						default: { imageUrl: "guard.png" },
						tiers,
					},
				},
			},
		});
		expect(out.locale).toBe("zh-CN");
	});

	it("改过的文案照存;0.x 里手写成 1.0 的作品默认也照存", () => {
		const templates = {
			liveStart: "主人写的开播文案 {name}",
			post: "{name}发布了一条{postNoun}",
			postVideo: "主人写的视频文案 {name}",
		};

		const out = removeUnchangedGlobalTexts(globalWith(templates)) as {
			defaults: { templates: Obj };
		};

		expect(out.defaults.templates).toEqual(templates);
	});

	it.each(Object.entries(UNCHANGED_GLOBAL_TEXTS))("%s 改过就照存", (key, text) => {
		const templates = { [key]: `${text} 主人改过` };

		const out = removeUnchangedGlobalTexts(globalWith(templates)) as {
			defaults: { templates: Obj };
		};

		expect(out.defaults.templates).toEqual(templates);
	});

	it("账本只留仍有文字存着的条目,停用词与所有 imageUrl 条目删掉", () => {
		const out = removeUnchangedGlobalTexts({
			...globalWith(
				{
					post: "主人写的作品文案 {name}",
					wordcloudStopWords: "主播 直播",
					membership: {
						guard: {
							default: { imageUrl: "guard.png" },
							tiers: {
								captain: {
									template: "主人写的舰长文案",
									imageUrl: "captain.png",
								},
							},
						},
					},
				},
				{
					post: "post-seen",
					postVideo: "post-video-seen",
					wordcloudStopWords: "words-seen",
					"membership.guard.default.template": "default-seen",
					"membership.guard.default.imageUrl": "guard-image-seen",
					"membership.guard.tiers.captain.template": "captain-seen",
					"membership.guard.tiers.captain.imageUrl": "captain-image-seen",
				},
			),
		}) as Obj;

		expect(out.templatesSeen).toEqual({
			post: "post-seen",
			"membership.guard.tiers.captain.template": "captain-seen",
		});
	});

	it("盘上已经有 locale 就不动", () => {
		const raw = { ...globalWith({}), locale: "en" };

		const out = removeUnchangedGlobalTexts(raw) as Obj;

		expect(out.locale).toBe("en");
	});

	it("不改入参", () => {
		const raw = globalWith({
			liveStart: ZERO_DEFAULT_TEMPLATES.liveStart,
			wordcloudStopWords: "",
		});
		const snapshot = structuredClone(raw);

		removeUnchangedGlobalTexts(raw);

		expect(raw).toEqual(snapshot);
	});
});

describe("removeUnchangedSubscriptionTexts", () => {
	it("只拿掉会员体系的默认那一格;别的覆盖、图片、开关与档位原样", () => {
		const tiers = { captain: { template: "主人写的舰长文案" } };
		const row = {
			id: "sub",
			overrides: {
				templates: {
					liveStart: "主人写的开播覆盖 {name}",
					membership: {
						guard: {
							enabled: true,
							default: {
								template: MEMBERSHIP_DEFAULT_TEMPLATE,
								imageUrl: "guard.png",
							},
							tiers,
						},
						fanclub: {
							default: {
								template: "主人写的粉丝团默认",
								imageUrl: "fanclub.png",
							},
						},
					},
				},
			},
		};

		const out = removeUnchangedSubscriptionTexts(row) as {
			overrides: { templates: Obj };
		};

		expect(out.overrides.templates).toEqual({
			liveStart: "主人写的开播覆盖 {name}",
			membership: {
				guard: {
					enabled: true,
					default: { imageUrl: "guard.png" },
					tiers,
				},
				fanclub: {
					default: {
						template: "主人写的粉丝团默认",
						imageUrl: "fanclub.png",
					},
				},
			},
		});
	});

	it("没有会员覆盖时原样回同一个对象", () => {
		const row = { overrides: { templates: { liveStart: "主人写的开播覆盖" } } };

		expect(removeUnchangedSubscriptionTexts(row)).toBe(row);
	});
});
