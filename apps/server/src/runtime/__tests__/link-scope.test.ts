/**
 * 链接解析的逐群答案 —— 把「默认行 + 逐群例外」(例外引用推送目标 id)对上入站帧里的群。
 *
 * 缝在 `resolveLinkParsingPolicies`:配置 + 目标表 + 适配器表进,一张「群键 → 解不解析、
 * 回什么」的表出。它是纯函数,所有决定都在这儿:哪些目标算群、停用算不算、悬空 id
 * 怎么办、不是目标的群跟谁。解析器(link-parser)只拿结果做一次查表,不再各自判一遍。
 */

import type { PushAdapter, PushTarget } from "@bilibili-notify/internal";
import { describe, expect, it } from "vite-plus/test";
import { linkScopeKey, resolveLinkParsingPolicies } from "../link-scope.js";

const ONEBOT_ADAPTER = "11111111-1111-4111-8111-111111111111";
const QQ_ADAPTER = "22222222-2222-4222-8222-222222222222";
const T_GROUP = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const T_GROUP_2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const T_PRIVATE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const T_QQ_GROUP = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const T_GONE = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

function adapter(id: string, platform: "onebot" | "qq-official", enabled = true): PushAdapter {
	return { id, name: platform, enabled, platform, config: {} } as unknown as PushAdapter;
}

function onebotGroup(id: string, groupId: string, over: Partial<PushTarget> = {}): PushTarget {
	return {
		id,
		name: `群 ${groupId}`,
		adapterId: ONEBOT_ADAPTER,
		scope: "group",
		enabled: true,
		platform: "onebot",
		session: { groupId },
		...over,
	} as PushTarget;
}

function onebotPrivate(id: string, userId: string): PushTarget {
	return {
		id,
		name: `私聊 ${userId}`,
		adapterId: ONEBOT_ADAPTER,
		scope: "private",
		enabled: true,
		platform: "onebot",
		session: { userId },
	} as PushTarget;
}

function qqGroup(id: string, groupOpenid: string, over: Partial<PushTarget> = {}): PushTarget {
	return {
		id,
		name: `官机群 ${groupOpenid}`,
		adapterId: QQ_ADAPTER,
		scope: "group",
		enabled: true,
		platform: "qq-official",
		session: { groupOpenid },
		...over,
	} as PushTarget;
}

const ADAPTERS = [adapter(ONEBOT_ADAPTER, "onebot"), adapter(QQ_ADAPTER, "qq-official")];

const K_GROUP = linkScopeKey("onebot", ONEBOT_ADAPTER, "123");
const K_GROUP_2 = linkScopeKey("onebot", ONEBOT_ADAPTER, "456");
/** 机器人在、但没配成推送目标的群 —— 没有 id,只能跟默认行。 */
const K_STRANGER = linkScopeKey("onebot", ONEBOT_ADAPTER, "789");

const ALL_ON = { defaults: { parse: true, form: "image" as const }, groups: {} };
const NONE_ON = { defaults: { parse: false, form: "image" as const }, groups: {} };

describe("resolveLinkParsingPolicies", () => {
	it("默认行解析开、没有例外 → 是目标的群和不是目标的群都解析,回默认形式", () => {
		const table = resolveLinkParsingPolicies({
			config: ALL_ON,
			targets: [onebotGroup(T_GROUP, "123")],
			adapters: ADAPTERS,
		});
		expect(table.policyFor(K_GROUP)).toEqual({ parse: true, form: "image" });
		expect(table.policyFor(K_STRANGER)).toEqual({ parse: true, form: "image" });
	});

	it("默认行解析关 + 群显式开 = 原来的白名单:只有那群解析,没勾的目标群与陌生群都不", () => {
		const table = resolveLinkParsingPolicies({
			config: { ...NONE_ON, groups: { [T_GROUP]: { parse: true } } },
			targets: [onebotGroup(T_GROUP, "123"), onebotGroup(T_GROUP_2, "456")],
			adapters: ADAPTERS,
		});
		expect(table.policyFor(K_GROUP).parse).toBe(true);
		expect(table.policyFor(K_GROUP_2).parse).toBe(false);
		expect(table.policyFor(K_STRANGER).parse).toBe(false);
	});

	it("默认行解析开 + 群显式关 → 那一个群不解析,其余照常", () => {
		const table = resolveLinkParsingPolicies({
			config: { ...ALL_ON, groups: { [T_GROUP]: { parse: false } } },
			targets: [onebotGroup(T_GROUP, "123"), onebotGroup(T_GROUP_2, "456")],
			adapters: ADAPTERS,
		});
		expect(table.policyFor(K_GROUP).parse).toBe(false);
		expect(table.policyFor(K_GROUP_2).parse).toBe(true);
	});

	it("形式逐群覆盖:例外写了小程序卡的群回小程序卡,其余跟默认行;默认行改小程序卡则陌生群也跟", () => {
		const table = resolveLinkParsingPolicies({
			config: { ...ALL_ON, groups: { [T_GROUP]: { form: "miniapp" } } },
			targets: [onebotGroup(T_GROUP, "123"), onebotGroup(T_GROUP_2, "456")],
			adapters: ADAPTERS,
		});
		expect(table.policyFor(K_GROUP).form).toBe("miniapp");
		expect(table.policyFor(K_GROUP_2).form).toBe("image");

		const flipped = resolveLinkParsingPolicies({
			config: { defaults: { parse: true, form: "miniapp" }, groups: {} },
			targets: [],
			adapters: ADAPTERS,
		});
		expect(flipped.policyFor(K_STRANGER)).toEqual({ parse: true, form: "miniapp" });
	});

	// 「停用」在链接解析与周报里是同一个意思:目标暂停就不响应,默认行开着、例外显式开着都
	// 压不过它(主人定的,两处要一致)。
	it("目标已停用 → 不解析,哪怕默认行开、例外显式开;形式照算", () => {
		const table = resolveLinkParsingPolicies({
			config: { ...ALL_ON, groups: { [T_GROUP]: { parse: true, form: "miniapp" } } },
			targets: [onebotGroup(T_GROUP, "123", { enabled: false })],
			adapters: ADAPTERS,
		});
		expect(table.policyFor(K_GROUP)).toEqual({ parse: false, form: "miniapp" });
	});

	it("目标所属的适配器已停用、或适配器已不存在 → 不解析", () => {
		const disabledAdapter = resolveLinkParsingPolicies({
			config: ALL_ON,
			targets: [onebotGroup(T_GROUP, "123")],
			adapters: [adapter(ONEBOT_ADAPTER, "onebot", false)],
		});
		expect(disabledAdapter.policyFor(K_GROUP).parse).toBe(false);

		const missingAdapter = resolveLinkParsingPolicies({
			config: ALL_ON,
			targets: [onebotGroup(T_GROUP, "123")],
			adapters: [],
		});
		expect(missingAdapter.policyFor(K_GROUP).parse).toBe(false);
	});

	it("官机群的地址是 groupOpenid,与入站帧里的 groupId 同一个值", () => {
		const table = resolveLinkParsingPolicies({
			config: { ...NONE_ON, groups: { [T_QQ_GROUP]: { parse: true } } },
			targets: [qqGroup(T_QQ_GROUP, "openid-xyz")],
			adapters: ADAPTERS,
		});
		expect(table.policyFor(`qq-official:${QQ_ADAPTER}:openid-xyz`).parse).toBe(true);
	});

	it("私聊目标不进表(链接解析只在群里响应),例外里写了它也没用", () => {
		const table = resolveLinkParsingPolicies({
			config: { ...NONE_ON, groups: { [T_PRIVATE]: { parse: true } } },
			targets: [onebotPrivate(T_PRIVATE, "10001")],
			adapters: ADAPTERS,
		});
		expect(table.policyFor(linkScopeKey("onebot", ONEBOT_ADAPTER, "10001")).parse).toBe(false);
	});

	it("例外里引用的目标已经删掉 → 静默忽略,其余照常", () => {
		const table = resolveLinkParsingPolicies({
			config: { ...NONE_ON, groups: { [T_GONE]: { parse: true }, [T_GROUP]: { parse: true } } },
			targets: [onebotGroup(T_GROUP, "123")],
			adapters: ADAPTERS,
		});
		expect(table.policyFor(K_GROUP).parse).toBe(true);
	});

	it("同一个群配成了两个目标 → 先出现的那个说了算,不来回翻", () => {
		const table = resolveLinkParsingPolicies({
			config: {
				...ALL_ON,
				groups: { [T_GROUP]: { form: "miniapp" }, [T_GROUP_2]: { parse: false } },
			},
			targets: [onebotGroup(T_GROUP, "123"), onebotGroup(T_GROUP_2, "123")],
			adapters: ADAPTERS,
		});
		expect(table.policyFor(K_GROUP)).toEqual({ parse: true, form: "miniapp" });
	});
});
