/**
 * 会员与醒目留言的设置搬家(㉓d)—— 函数级:
 *
 * | 0.x(改名之后的形状) | 1.0 |
 * | --- | --- |
 * | `filters.minScPrice` | `superchat.minAmount`(全局里旧值 0 不写;逐订阅覆盖有就写,0 也写) |
 * | `filters.minGuardLevel`(B 站 guard_level:1 = 总督、3 = 舰长) | `membership.minRank.guard`,rank = 旧等级倒过来(1 → 3、2 → 2、3 → 1);全局里旧值 3(全推)不写,覆盖有就写,rank 1 也写 |
 * | `templates.guardBuy`(`enable` + captain / commander / governor 各一份 `{ template, imageUrl }`) | `templates.membership.guard = { enabled, default, tiers }` |
 * | 默认文案账本里六条 `guardBuy.<档>.template` / `.imageUrl` | 两条 `membership.guard.default.template` / `.imageUrl`,指纹是新默认的 |
 *
 * 期望值都是手写的字面量。接缝(第 0 代 → 迁一代 → 配置仓开机)那几条在 `feature-renames.test.ts`、
 * `zero-generation-settings.test.ts`。
 */

import { DEFAULT_TEMPLATES } from "@bilibili-notify/internal/constants";
import { allTemplateFingerprints } from "@bilibili-notify/internal/template-defaults";
import { describe, expect, it } from "vite-plus/test";
import {
	MEMBERSHIP_DEFAULT_TEMPLATE,
	moveGlobalMembership,
	moveSubscriptionMembership,
} from "../membership-moves.js";
import { OLD_GUARD } from "../templates.js";
import { ZERO_DEFAULT_TEMPLATES } from "../zero-vocabulary.js";
import { zeroGuardBuy } from "./zero-fixtures.js";

type Obj = Record<string, unknown>;

/** 新默认文案与空串的指纹(手算的字面量)。 */
const FP_DEFAULT_TEMPLATE = "8q6guf";
const FP_EMPTY = "ztntfp";

/** 改名之后、搬家之前的全局设置:只带这一步要碰的几格。 */
function globals(over: { filters?: Obj; guardBuy?: Obj; ledger?: Obj } = {}): Obj {
	return {
		app: { logLevel: "info" },
		defaults: {
			features: { post: true },
			filters: over.filters ?? {
				blockReposts: false,
				blockKeywords: [],
				minScPrice: 0,
				minGuardLevel: 3,
			},
			schedule: { quietHours: [] },
			templates: {
				liveStart: "a",
				post: "b",
				guardBuy: over.guardBuy ?? zeroGuardBuy(),
				wordcloudStopWords: "",
			},
			templateDefaultsSeen: over.ledger ?? {
				liveStart: "x1",
				"guardBuy.captain.imageUrl": FP_EMPTY,
				"guardBuy.captain.template": "1n2b5zl",
				"guardBuy.commander.imageUrl": FP_EMPTY,
				"guardBuy.commander.template": "c2qled",
				"guardBuy.governor.imageUrl": FP_EMPTY,
				"guardBuy.governor.template": "1qek1pk",
				post: "x2",
			},
		},
	};
}

const defaultsOf = (raw: unknown): Obj => (raw as { defaults: Obj }).defaults;

describe("体系默认文案", () => {
	it("迁移写的体系默认就是此刻的出厂默认(出厂默认改了这条就红:迁移是冻住的,要不要跟着改得当场定)", () => {
		expect(MEMBERSHIP_DEFAULT_TEMPLATE).toBe(DEFAULT_TEMPLATES.membership.guard.default.template);
		expect(MEMBERSHIP_DEFAULT_TEMPLATE).toBe("{viewer} 成为了 {name} 的{tier}！");
		expect(allTemplateFingerprints(DEFAULT_TEMPLATES)).toMatchObject({
			"membership.guard.default.template": FP_DEFAULT_TEMPLATE,
			"membership.guard.default.imageUrl": FP_EMPTY,
		});
	});
});

describe("全局:filters.minScPrice → superchat.minAmount", () => {
	it("调过的(> 0)才写;老键从 filters 里拿掉,filters 里别的键与键序不变", () => {
		const out = moveGlobalMembership(
			globals({
				filters: { minScPrice: 30, blockReposts: true, minGuardLevel: 3, blockKeywords: ["广告"] },
			}),
		);
		const defaults = defaultsOf(out);
		expect(defaults.superchat).toEqual({ minAmount: 30 });
		expect(defaults.filters).toEqual({ blockReposts: true, blockKeywords: ["广告"] });
		expect(Object.keys(defaults.filters as Obj)).toEqual(["blockReposts", "blockKeywords"]);
	});

	it("旧值是出厂的 0:不写(没配 = 不设门槛),老键照样拿掉", () => {
		const defaults = defaultsOf(moveGlobalMembership(globals()));
		expect(defaults).not.toHaveProperty("superchat");
		expect(defaults.filters).toEqual({ blockReposts: false, blockKeywords: [] });
	});

	it("读不懂的旧值(负数、小数以外的:字符串、NaN 写不进 JSON 不用管)不写,老键拿掉", () => {
		for (const bad of [-5, "30", null, true]) {
			const defaults = defaultsOf(moveGlobalMembership(globals({ filters: { minScPrice: bad } })));
			expect(defaults, String(bad)).not.toHaveProperty("superchat");
			expect(defaults.filters, String(bad)).toEqual({});
		}
	});

	it("小数金额照写(新 schema 允许 ≥ 0 的任意数)", () => {
		const defaults = defaultsOf(moveGlobalMembership(globals({ filters: { minScPrice: 6.5 } })));
		expect(defaults.superchat).toEqual({ minAmount: 6.5 });
	});
});

describe("全局:filters.minGuardLevel → membership.minRank.guard(倒序换算)", () => {
	it("旧 1(仅总督)→ rank 3;旧 2(提督以上)→ rank 2", () => {
		const level = (minGuardLevel: number) =>
			defaultsOf(moveGlobalMembership(globals({ filters: { minGuardLevel } }))).membership;
		expect(level(1)).toEqual({ minRank: { guard: 3 } });
		expect(level(2)).toEqual({ minRank: { guard: 2 } });
	});

	it("旧 3(全推,出厂值)→ 不写;老键拿掉", () => {
		const defaults = defaultsOf(moveGlobalMembership(globals({ filters: { minGuardLevel: 3 } })));
		expect(defaults).not.toHaveProperty("membership");
		expect(defaults.filters).toEqual({});
	});

	it("认不出的等级(0、4、小数、字符串)不写,老键拿掉", () => {
		for (const bad of [0, 4, 1.5, "2", null]) {
			const defaults = defaultsOf(
				moveGlobalMembership(globals({ filters: { minGuardLevel: bad } })),
			);
			expect(defaults, String(bad)).not.toHaveProperty("membership");
			expect(defaults.filters, String(bad)).toEqual({});
		}
	});

	it("两个门槛一起调:superchat 与 membership 紧跟在 filters 后面,键序是字面量", () => {
		const out = moveGlobalMembership(globals({ filters: { minScPrice: 50, minGuardLevel: 1 } }));
		expect(Object.keys(defaultsOf(out))).toEqual([
			"features",
			"filters",
			"superchat",
			"membership",
			"schedule",
			"templates",
			"templateDefaultsSeen",
		]);
	});
});

describe("全局:templates.guardBuy → templates.membership.guard", () => {
	const tiersOf = (guardBuy: Obj) =>
		((defaultsOf(moveGlobalMembership(globals({ guardBuy }))).templates as Obj).membership as Obj)
			.guard as Obj;

	it("三档都是出厂的:enabled 取旧 enable,default 是出厂值,tiers 是空的", () => {
		expect(tiersOf(zeroGuardBuy())).toEqual({
			enabled: false,
			default: { template: "{viewer} 成为了 {name} 的{tier}！", imageUrl: "" },
			tiers: {},
		});
		expect(tiersOf(zeroGuardBuy({ enable: true })).enabled).toBe(true);
	});

	it("`membership` 占的是 `guardBuy` 原来的位置,templates 里别的键与键序不变,老键不留", () => {
		const templates = defaultsOf(moveGlobalMembership(globals())).templates as Obj;
		expect(Object.keys(templates)).toEqual([
			"liveStart",
			"post",
			"membership",
			"wordcloudStopWords",
		]);
		expect(templates).not.toHaveProperty("guardBuy");
	});

	it("改过文案的那一档才进 tiers(key 不变),没动的档不留 key", () => {
		const guard = tiersOf(
			zeroGuardBuy({
				commander: { imageUrl: "", template: "欢迎提督 {uname}" },
			}),
		);
		expect(guard.tiers).toEqual({ commander: { template: "欢迎提督 {viewer}" } });
	});

	it("改过文案:占位符一并改写(花括号写法与 -key 老写法)", () => {
		const guard = tiersOf(
			zeroGuardBuy({
				captain: { imageUrl: "", template: "-uname 登上了 {mname} 的船,档位 -guard" },
				governor: { imageUrl: "", template: "{uname}|{mname}|{guard}\\n{foo}" },
			}),
		);
		expect(guard.tiers).toEqual({
			captain: { template: "{viewer} 登上了 {name} 的船,档位 {tier}" },
			governor: { template: "{viewer}|{name}|{tier}\\n{foo}" },
		});
	});

	it("「没动过」的判据:占位符改写之后等于该档旧默认改写之后的样子 —— 花括号写法、-key 老写法都算", () => {
		const guard = tiersOf(
			zeroGuardBuy({
				captain: { imageUrl: "", template: "-uname 成为了 -mname 的舰长！" },
				commander: { imageUrl: "", template: "{uname} 成为了 -mname 的提督！" },
			}),
		);
		expect(guard.tiers).toEqual({});
	});

	it("更早一代的默认(`{user}` / `{mastername}`,占位符语法统一前)也算没动过 —— 逐订阅覆盖不经 0.x 那一遍的旧默认迁移", () => {
		const guard = tiersOf(
			zeroGuardBuy({
				captain: { imageUrl: "", template: OLD_GUARD.captain },
				commander: { imageUrl: "", template: OLD_GUARD.commander },
				governor: { imageUrl: "", template: OLD_GUARD.governor },
			}),
		);
		expect(guard.tiers).toEqual({});
	});

	it("别的档的默认文案放在这一档上,是改过的:进 tiers", () => {
		const guard = tiersOf(
			zeroGuardBuy({
				captain: { imageUrl: "", template: ZERO_DEFAULT_TEMPLATES.guardBuy.governor },
			}),
		);
		expect(guard.tiers).toEqual({ captain: { template: "{viewer} 成为了 {name} 的总督！" } });
	});

	it("填了图片的档:图片进 tiers[key].imageUrl;空串不搬;文案没动、只填了图片的档只有 imageUrl", () => {
		const guard = tiersOf(
			zeroGuardBuy({
				captain: {
					imageUrl: "https://img.test/captain.png",
					template: "{uname} 成为了 {mname} 的舰长！",
				},
				commander: { imageUrl: "", template: "自己写的 {uname}" },
				governor: {
					imageUrl: "https://img.test/governor.png",
					template: "{uname} 成为了 {mname} 的总督！！",
				},
			}),
		);
		expect(guard.tiers).toEqual({
			captain: { imageUrl: "https://img.test/captain.png" },
			commander: { template: "自己写的 {viewer}" },
			governor: {
				template: "{viewer} 成为了 {name} 的总督！！",
				imageUrl: "https://img.test/governor.png",
			},
		});
	});

	it("tiers 的键序固定是 captain / commander / governor,和盘上谁排前面无关", () => {
		const guard = tiersOf({
			enable: true,
			governor: { imageUrl: "g.png", template: "{uname} 成为了 {mname} 的总督！" },
			commander: { imageUrl: "c.png", template: "{uname} 成为了 {mname} 的提督！" },
			captain: { imageUrl: "k.png", template: "{uname} 成为了 {mname} 的舰长！" },
		});
		expect(Object.keys(guard.tiers as Obj)).toEqual(["captain", "commander", "governor"]);
	});

	it("读不懂的档(不是对象、字段不是字符串)跳过,别的档照常", () => {
		const guard = tiersOf({
			enable: true,
			captain: "坏的",
			commander: { imageUrl: 5, template: 7 },
			governor: { imageUrl: "g.png" },
		});
		expect(guard.tiers).toEqual({ governor: { imageUrl: "g.png" } });
	});

	it("`enable` 不是 true(缺了、字符串)一律是 enabled: false", () => {
		expect(tiersOf({ captain: { template: "x", imageUrl: "" } }).enabled).toBe(false);
		expect(tiersOf(zeroGuardBuy({ enable: "true" })).enabled).toBe(false);
	});

	it("开关关着、但三档写过自定义文案:文案照搬(主人以后开开还在)", () => {
		const guard = tiersOf(
			zeroGuardBuy({ enable: false, captain: { imageUrl: "", template: "关着也留 {uname}" } }),
		);
		expect(guard.enabled).toBe(false);
		expect(guard.tiers).toEqual({ captain: { template: "关着也留 {viewer}" } });
	});
});

describe("全局:默认文案账本 templateDefaultsSeen", () => {
	const ledgerOf = (raw: unknown) => defaultsOf(raw).templateDefaultsSeen as Obj;

	it("旧的六条拿掉,新路径两条按新默认的指纹记成已见;别的条目与键序不变,新的追加在最后", () => {
		const ledger = ledgerOf(moveGlobalMembership(globals()));
		expect(ledger).toEqual({
			liveStart: "x1",
			post: "x2",
			"membership.guard.default.template": FP_DEFAULT_TEMPLATE,
			"membership.guard.default.imageUrl": FP_EMPTY,
		});
		expect(Object.keys(ledger)).toEqual([
			"liveStart",
			"post",
			"membership.guard.default.template",
			"membership.guard.default.imageUrl",
		]);
	});

	it("升上来不亮「默认文案有更新」:账本里的指纹就是 1.0 出厂默认的指纹", () => {
		const ledger = ledgerOf(moveGlobalMembership(globals()));
		const fresh = allTemplateFingerprints(DEFAULT_TEMPLATES);
		expect(ledger["membership.guard.default.template"]).toBe(
			fresh["membership.guard.default.template"],
		);
		expect(ledger["membership.guard.default.imageUrl"]).toBe(
			fresh["membership.guard.default.imageUrl"],
		);
	});

	it("账本里新路径已经有了(手写过 / 先搬过):以已有的为准,不覆盖", () => {
		const ledger = ledgerOf(
			moveGlobalMembership(
				globals({
					ledger: {
						"guardBuy.captain.template": "old",
						"membership.guard.default.template": "mine",
					},
				}),
			),
		);
		expect(ledger).toEqual({
			"membership.guard.default.template": "mine",
			"membership.guard.default.imageUrl": FP_EMPTY,
		});
	});

	it("没有账本:建一份只有这两条的(别的条目本来就没有)", () => {
		const raw = globals();
		delete (raw.defaults as Obj).templateDefaultsSeen;
		const ledger = ledgerOf(moveGlobalMembership(raw));
		expect(ledger).toEqual({
			"membership.guard.default.template": FP_DEFAULT_TEMPLATE,
			"membership.guard.default.imageUrl": FP_EMPTY,
		});
	});

	it("前缀只认 `guardBuy.`:名字碰巧以 guardBuy 开头的别的键不动", () => {
		const ledger = ledgerOf(
			moveGlobalMembership(
				globals({ ledger: { guardBuyer: "k", "guardBuy.captain.template": "t" } }),
			),
		);
		expect(ledger.guardBuyer).toBe("k");
		expect(ledger).not.toHaveProperty("guardBuy.captain.template");
	});
});

describe("全局:已是新形状原样回、认不得的形状放过", () => {
	it("搬完再跑一遍:同一个对象(幂等)", () => {
		const once = moveGlobalMembership(
			globals({
				filters: { minScPrice: 30, minGuardLevel: 1 },
				guardBuy: zeroGuardBuy({ enable: true }),
			}),
		);
		expect(moveGlobalMembership(once)).toBe(once);
	});

	it("没有任何老键的新形状输入:同一个对象", () => {
		const fresh = {
			defaults: {
				filters: { blockReposts: false },
				superchat: { minAmount: 5 },
				membership: { minRank: { guard: 2 } },
				templates: {
					membership: {
						guard: { enabled: true, default: { template: "t", imageUrl: "" }, tiers: {} },
					},
				},
				templateDefaultsSeen: { "membership.guard.default.template": "k" },
			},
		};
		expect(moveGlobalMembership(fresh)).toBe(fresh);
	});

	it("新老并存:新键为准、老键丢掉(不看谁在前)", () => {
		const newGuard = {
			guard: { enabled: false, default: { template: "新的", imageUrl: "" }, tiers: {} },
		};
		const oldFirst = {
			defaults: {
				filters: { minScPrice: 99, minGuardLevel: 1 },
				superchat: { minAmount: 5 },
				membership: { minRank: { guard: 2 } },
				templates: {
					guardBuy: zeroGuardBuy({ enable: true }),
					membership: newGuard,
				},
			},
		};
		// 新键排在老键前面:靠「后写的赢」会赢错,只有明说「新键已经在了就不写老键」才对。
		const newFirst = {
			defaults: {
				superchat: { minAmount: 5 },
				membership: { minRank: { guard: 2 } },
				templates: {
					membership: newGuard,
					guardBuy: zeroGuardBuy({ enable: true }),
				},
				filters: { minScPrice: 99, minGuardLevel: 1 },
			},
		};
		for (const raw of [oldFirst, newFirst]) {
			const defaults = defaultsOf(moveGlobalMembership(raw));
			expect(defaults.superchat).toEqual({ minAmount: 5 });
			expect(defaults.membership).toEqual({ minRank: { guard: 2 } });
			expect(defaults.filters).toEqual({});
			expect(defaults.templates).toEqual({ membership: newGuard });
		}
	});

	it("认不得的形状原样放过:同一个值,不抛", () => {
		expect(moveGlobalMembership("junk")).toBe("junk");
		expect(moveGlobalMembership(null)).toBe(null);
		const noDefaults = { app: {} };
		expect(moveGlobalMembership(noDefaults)).toBe(noDefaults);
		const oddDefaults = { defaults: 5 };
		expect(moveGlobalMembership(oddDefaults)).toBe(oddDefaults);
		const oddInner = { defaults: { filters: "坏的", templates: ["x"], templateDefaultsSeen: 3 } };
		expect(moveGlobalMembership(oddInner)).toBe(oddInner);
	});

	it("guardBuy 不是对象(手改坏了):不动它,也不凭空造 membership", () => {
		const raw = { defaults: { templates: { guardBuy: "坏的", post: "p" } } };
		expect(moveGlobalMembership(raw)).toBe(raw);
	});
});

describe("逐订阅:overrides.filters 里的两个阈值", () => {
	const row = (overrides: Obj): Obj => ({ id: "s1", routing: {}, overrides, specialUsers: [] });
	const overridesOf = (r: unknown) => (r as { overrides: Obj }).overrides;

	it("覆盖有就原样写 —— 0 也写(这个订阅不设门槛,全局可能不是 0);rank 1 也写", () => {
		const out = overridesOf(
			moveSubscriptionMembership(row({ filters: { minScPrice: 0, minGuardLevel: 3 } })),
		);
		expect(out.superchat).toEqual({ minAmount: 0 });
		expect(out.membership).toEqual({ minRank: { guard: 1 } });
	});

	it("等级倒序换算:旧 1 → 3、旧 2 → 2、旧 3 → 1", () => {
		const rankOf = (minGuardLevel: number) =>
			(overridesOf(moveSubscriptionMembership(row({ filters: { minGuardLevel } })))
				.membership as Obj) ?? {};
		expect(rankOf(1)).toEqual({ minRank: { guard: 3 } });
		expect(rankOf(2)).toEqual({ minRank: { guard: 2 } });
		expect(rankOf(3)).toEqual({ minRank: { guard: 1 } });
	});

	it("只覆盖阈值的订阅:filters 拿掉两个键后空了,整个 filters 删掉(留一个空壳会被面板当成「覆盖着动态过滤」)", () => {
		const out = overridesOf(
			moveSubscriptionMembership(row({ filters: { minScPrice: 50, minGuardLevel: 2 } })),
		);
		expect(out).toEqual({ superchat: { minAmount: 50 }, membership: { minRank: { guard: 2 } } });
		expect(out).not.toHaveProperty("filters");
	});

	it("过滤域和阈值域混着写:阈值搬走,过滤字段留在 filters 里,键序不变;新两段紧跟在 filters 后面", () => {
		const out = overridesOf(
			moveSubscriptionMembership(
				row({
					features: { post: true },
					filters: { blockKeywords: ["k"], minScPrice: 20, allowRegex: ["r"] },
					templates: { liveEnd: "x" },
				}),
			),
		);
		expect(out.filters).toEqual({ blockKeywords: ["k"], allowRegex: ["r"] });
		expect(Object.keys(out)).toEqual(["features", "filters", "superchat", "templates"]);
	});

	it("没有阈值的 filters(包括本来就是空的):原样,不凭空长出键", () => {
		const r = row({ filters: { blockKeywords: ["k"] } });
		expect(moveSubscriptionMembership(r)).toBe(r);
		const empty = row({ filters: {} });
		expect(moveSubscriptionMembership(empty)).toBe(empty);
	});

	it("读不懂的阈值(负数、字符串;等级 4):不写,老键拿掉;因此空了的 filters 也删掉", () => {
		const out = overridesOf(
			moveSubscriptionMembership(row({ filters: { minScPrice: -1, minGuardLevel: 4 } })),
		);
		expect(out).toEqual({});
	});

	it("新老并存(覆盖里已经有 superchat / membership):新的为准,老键丢掉(不看谁在前)", () => {
		const expected = { superchat: { minAmount: 5 }, membership: { minRank: { guard: 2 } } };
		const oldFirst = overridesOf(
			moveSubscriptionMembership(
				row({
					filters: { minScPrice: 99, minGuardLevel: 1 },
					superchat: { minAmount: 5 },
					membership: { minRank: { guard: 2 } },
				}),
			),
		);
		const newFirst = overridesOf(
			moveSubscriptionMembership(
				row({
					superchat: { minAmount: 5 },
					membership: { minRank: { guard: 2 } },
					filters: { minScPrice: 99, minGuardLevel: 1 },
				}),
			),
		);
		expect(oldFirst).toEqual(expected);
		expect(newFirst).toEqual(expected);
	});
});

describe("逐订阅:overrides.templates.guardBuy", () => {
	const row = (overrides: Obj): Obj => ({ id: "s1", routing: {}, overrides, specialUsers: [] });
	const overridesOf = (r: unknown) => (r as { overrides: Obj }).overrides;

	it("同一份换法:enabled 取旧 enable、default 出厂值、改过的档进 tiers;占位符与 -key 一并改写", () => {
		const out = overridesOf(
			moveSubscriptionMembership(
				row({
					templates: {
						guardBuy: zeroGuardBuy({
							enable: true,
							captain: { imageUrl: "https://img.test/k.png", template: "-uname 来了" },
						}),
					},
				}),
			),
		);
		expect(out.templates).toEqual({
			membership: {
				guard: {
					enabled: true,
					default: { template: "{viewer} 成为了 {name} 的{tier}！", imageUrl: "" },
					tiers: { captain: { template: "{viewer} 来了", imageUrl: "https://img.test/k.png" } },
				},
			},
		});
	});

	it("在 templates 里占 guardBuy 原来的位置,别的覆盖(liveEnd 等)原样", () => {
		const out = overridesOf(
			moveSubscriptionMembership(
				row({ templates: { liveEnd: "e", guardBuy: zeroGuardBuy(), post: "p" } }),
			),
		);
		expect(Object.keys(out.templates as Obj)).toEqual(["liveEnd", "membership", "post"]);
	});

	it("没有覆盖的订阅、overrides 里没有 templates:同一个对象", () => {
		const r = row({ features: { post: true } });
		expect(moveSubscriptionMembership(r)).toBe(r);
		const noOverrides = { id: "s1", routing: {} };
		expect(moveSubscriptionMembership(noOverrides)).toBe(noOverrides);
	});

	it("只覆盖别的文案(没有 guardBuy):同一个对象", () => {
		const r = row({ templates: { liveSummary: "x" } });
		expect(moveSubscriptionMembership(r)).toBe(r);
	});

	it("搬完再跑一遍:同一个对象(幂等)", () => {
		const once = moveSubscriptionMembership(
			row({
				filters: { minScPrice: 5, minGuardLevel: 2 },
				templates: { guardBuy: zeroGuardBuy({ enable: true }) },
			}),
		);
		expect(moveSubscriptionMembership(once)).toBe(once);
	});

	it("认不得的形状原样放过", () => {
		expect(moveSubscriptionMembership("junk")).toBe("junk");
		expect(moveSubscriptionMembership(null)).toBe(null);
		const odd = row({ filters: "坏的", templates: { guardBuy: "坏的" } });
		expect(moveSubscriptionMembership(odd)).toBe(odd);
		const oddOverrides = { id: "s1", overrides: 5 };
		expect(moveSubscriptionMembership(oddOverrides)).toBe(oddOverrides);
	});

	it("拓展订阅的覆盖也一样搬(同一份形状)", () => {
		const out = overridesOf(
			moveSubscriptionMembership(
				row({ filters: { minScPrice: 8 }, templates: { guardBuy: zeroGuardBuy() } }),
			),
		);
		expect(out.superchat).toEqual({ minAmount: 8 });
		expect((out.templates as Obj).membership).toBeDefined();
	});
});
