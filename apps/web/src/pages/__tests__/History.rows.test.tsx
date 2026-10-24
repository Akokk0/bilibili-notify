// @vitest-environment jsdom
/**
 * 推送历史的行:一行 = 一次推送 × 一个目标。
 *
 * 守的是:类型按 8 把特性键标(行上那一格叫 `feature`);首条本体当文案、多条挂「N 条」胶囊;四态各有 pill;行可展开逐条看
 * (文案 / 图 / 结果);目标列写目标名。
 */

import type { ExtensionDTO } from "@bilibili-notify/contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { HistoryEntryView } from "../../services/dashboard";
import { makeEmptySubscription, type Subscription } from "../../types/domain";
import History from "../History";

vi.mock("../../services/api", () => ({
	api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
	ApiError: class extends Error {},
}));

import { api } from "../../services/api";

const T1 = "22222222-2222-4222-8222-222222222222";
/** 图库引用(词云配图 / 头像快照)。 */
const WORDCLOUD = `${"a".repeat(64)}.png`;
const SNAPSHOT = `${"e".repeat(64)}.png`;

function row(over: Partial<HistoryEntryView> = {}): HistoryEntryView {
	return {
		id: "h1",
		pushId: "p1",
		createdAt: new Date().toISOString(),
		feature: "liveEnd",
		status: "partial",
		identity: { sourceKey: "bilibili", externalId: "u1" },
		subscriptionId: "s1",
		targetId: T1,
		messages: [
			{ text: "下播了", kind: "text", role: "main", ok: true },
			{
				text: "[弹幕词云]",
				kind: "image",
				image: WORDCLOUD,
				role: "extra",
				ok: true,
			},
			{
				text: "总结正文",
				kind: "text",
				role: "extra",
				ok: false,
				code: "unknown",
				message: "boom",
			},
		],
		nameSnapshot: "某UP",
		...over,
	};
}

function mockApi(
	entries: HistoryEntryView[],
	subs: Subscription[] = [],
	extensions: ExtensionDTO[] = [],
) {
	(api.get as ReturnType<typeof vi.fn>).mockImplementation((path: string) => {
		if (path.startsWith("/api/history")) return Promise.resolve({ entries });
		if (path === "/api/targets")
			return Promise.resolve([{ id: T1, name: "测试群", platform: "onebot", enabled: true }]);
		if (path === "/api/subscriptions") return Promise.resolve(subs);
		if (path === "/api/ext") return Promise.resolve({ extensions });
		return Promise.resolve({ history: { retentionDays: 30 } });
	});
}

function renderHistory() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<History />
		</QueryClientProvider>,
	);
}

beforeEach(() => mockApi([row()]));
afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("推送历史 · 行", () => {
	it("类型「下播」、首条本体当文案、「3 条」胶囊、目标名、「部分失败」pill", async () => {
		renderHistory();
		await waitFor(() => expect(screen.getByText("下播了")).toBeTruthy());
		expect(screen.getByText("下播")).toBeTruthy();
		expect(screen.getByText("3 条")).toBeTruthy();
		expect(screen.getByText(/测试群/)).toBeTruthy();
		expect(screen.getByText("部分失败")).toBeTruthy();
		// 折着的时候后两条不露出来。
		expect(screen.queryByText("总结正文")).toBeNull();
	});

	it("点开一行 → 逐条看文案、图缩略与结果;再点收起", async () => {
		renderHistory();
		await waitFor(() => expect(screen.getByText("下播了")).toBeTruthy());
		const toggle = screen.getByRole("button", { name: /3 条/ });
		expect(toggle.getAttribute("aria-expanded")).toBe("false");
		await userEvent.click(toggle);
		expect(toggle.getAttribute("aria-expanded")).toBe("true");
		expect(screen.getByText("总结正文")).toBeTruthy();
		expect(screen.getByText("boom")).toBeTruthy();
		const img = screen.getByRole("img", { name: /弹幕词云/ }) as HTMLImageElement;
		expect(img.getAttribute("src")).toBe(`/api/images/${WORDCLOUD}`);
		await userEvent.click(toggle);
		expect(screen.queryByText("总结正文")).toBeNull();
	});

	// 文字一直留着,过期的只有图(ADR-0022 决策 9):标题行说的是图留几天,不是整段历史留几天。
	it("标题行:共几条 · 图片留 N 天", async () => {
		renderHistory();
		await waitFor(() => expect(screen.getByText("下播了")).toBeTruthy());
		expect(screen.getByText(/共 1 条 · 图片留 30 天/)).toBeTruthy();
		expect(screen.queryByText(/保留近/)).toBeNull();
	});

	// 过了保留期的行(ADR-0022 决策 9):图与重推原件已清,文字还在。不画那张已经不存在的图。
	it("过了保留期的行:点开看得到文字,图的位置写「图已清理」、不发图的请求", async () => {
		mockApi([row({ isPastRetention: true })]);
		renderHistory();
		await waitFor(() => expect(screen.getByText("下播了")).toBeTruthy());
		await userEvent.click(screen.getByRole("button", { name: /3 条/ }));
		expect(screen.getByText("总结正文")).toBeTruthy();
		expect(screen.getByText("图已清理")).toBeTruthy();
		expect(screen.queryByRole("img", { name: /弹幕词云/ })).toBeNull();
	});

	// 过了保留期的老行,迁移时图格(`image`)已经拿掉,只剩 `kind: "image"`:照样在原来画图的位置写「图已清理」。
	// 纯文字的消息、以及迁移拿掉图格后看不出本来有图的 composite,不写。
	it("过了保留期的老行:图格被迁移拿掉了(只剩 kind: image)→ 仍写「图已清理」;文字消息不写", async () => {
		mockApi([
			row({
				isPastRetention: true,
				messages: [
					{ text: "下播了", kind: "text", role: "main", ok: true },
					{ text: "[卡片图]", kind: "image", role: "extra", ok: true },
					{ text: "图文", kind: "composite", role: "extra", ok: true },
				],
			}),
		]);
		renderHistory();
		await waitFor(() => expect(screen.getByText("下播了")).toBeTruthy());
		await userEvent.click(screen.getByRole("button", { name: /3 条/ }));
		expect(screen.getAllByText("图已清理")).toHaveLength(1);
		expect(screen.getByText("[卡片图]")).toBeTruthy();
	});

	it("没过保留期、图格缺着(图库没收下):不写「图已清理」也不画图", async () => {
		mockApi([
			row({
				messages: [
					{ text: "下播了", kind: "text", role: "main", ok: true },
					{ text: "[卡片图]", kind: "image", role: "extra", ok: true },
				],
			}),
		]);
		const { container } = renderHistory();
		await waitFor(() => expect(screen.getByText("下播了")).toBeTruthy());
		await userEvent.click(screen.getByRole("button", { name: /2 条/ }));
		expect(screen.queryByText("图已清理")).toBeNull();
		expect(container.querySelector("img[src^='/api/images/']")).toBeNull();
	});

	it("失败行红 pill「失败」;已送达绿 pill;单条不挂胶囊", async () => {
		mockApi([
			row({
				id: "a",
				status: "failed",
				messages: [
					{ text: "卡", kind: "text", role: "main", ok: false, code: "unknown", message: "boom" },
				],
			}),
			row({
				id: "b",
				status: "delivered",
				messages: [{ text: "卡2", kind: "text", role: "main", ok: true }],
			}),
		]);
		renderHistory();
		await waitFor(() => expect(screen.getByText("卡")).toBeTruthy());
		expect(screen.getByText("失败")).toBeTruthy();
		expect(screen.getByText("已送达")).toBeTruthy();
		// 表头的「共 N 条」不算;行上的胶囊是「N 条」打头。
		expect(screen.queryByText(/^\d+ 条/)).toBeNull();
	});

	it("搜索也搜后面几条的文案", async () => {
		renderHistory();
		await waitFor(() => expect(screen.getByText("下播了")).toBeTruthy());
		await userEvent.type(screen.getByPlaceholderText(/搜索/), "总结正文");
		expect(screen.getByText("下播了")).toBeTruthy();
		await userEvent.clear(screen.getByPlaceholderText(/搜索/));
		await userEvent.type(screen.getByPlaceholderText(/搜索/), "不存在的词");
		expect(screen.queryByText("下播了")).toBeNull();
	});
});

/**
 * 筛选胶囊按家族归:直播(开播 / 直播中 / 下播 / 特别进房 / 特别弹幕)、动态(作品)、SC(醒目留言)、舰长(上舰)。
 * 行上的特性键怎么归族,只有色表里那一份(⑬f:家族的取值改说特性键那套,筛选不许因此失灵)。
 */
describe("推送历史 · 按家族筛选", () => {
	const ALL = [
		["liveStart", "开播了"],
		["liveStreaming", "还在播"],
		["liveEnd", "下播了"],
		["viewerEnter", "进房了"],
		["viewerChat", "弹幕来了"],
		["post", "新作品"],
		["superchat", "醒目留言"],
		["membership", "上舰了"],
	] as const;

	function oneRowEach(): HistoryEntryView[] {
		return ALL.map(([feature, text], i) =>
			row({
				id: `h${i}`,
				feature,
				status: "delivered",
				messages: [{ text, kind: "text", role: "main", ok: true }],
			}),
		);
	}

	const shown = () =>
		ALL.filter(([, text]) => screen.queryByText(text)).map(([feature]) => feature);

	it("「全部」八把键的行都在", async () => {
		mockApi(oneRowEach());
		renderHistory();
		await waitFor(() => expect(screen.getByText("新作品")).toBeTruthy());
		expect(shown()).toEqual(ALL.map(([feature]) => feature));
	});

	it.each<[chip: string, expected: string[]]>([
		["直播", ["liveStart", "liveStreaming", "liveEnd", "viewerEnter", "viewerChat"]],
		["动态", ["post"]],
		["SC", ["superchat"]],
		["舰长", ["membership"]],
	])("点「%s」只剩这一族的行", async (chip, expected) => {
		mockApi(oneRowEach());
		renderHistory();
		await waitFor(() => expect(screen.getByText("新作品")).toBeTruthy());
		await userEvent.click(screen.getByRole("button", { name: chip }));
		expect(shown()).toEqual(expected);
	});
});

/** 一条 B 站订阅,资料缓存里的名字就是面板上显示的名字。 */
function biliSub(id: string, uid: string, name: string): Subscription {
	return {
		...makeEmptySubscription({ sourceKey: "bilibili", externalId: uid }),
		id,
		cachedProfile: { name, refreshedAt: "2026-09-23T00:00:00Z" },
	};
}

/**
 * 行是哪条订阅(ADR-0019 决策 50):先认行上的 `subscriptionId`,不在了再找第一个 uid 相同的
 * B 站订阅 —— 与服务端重推同一条规矩。
 */
describe("推送历史 · 行对到哪条订阅", () => {
	it("行的订阅删了、同 uid 又加了一条 → 按现在那条的名字搜得到", async () => {
		mockApi(
			[row({ subscriptionId: "s-gone", nameSnapshot: "当时的名字" })],
			[biliSub("s-readded", "u1", "现在的名字")],
		);
		renderHistory();
		await waitFor(() => expect(screen.getByText("下播了")).toBeTruthy());
		await userEvent.type(screen.getByPlaceholderText(/搜索/), "现在的名字");
		expect(screen.getByText("下播了")).toBeTruthy();
	});

	it("同 uid 几条订阅都在 → 行对到自己那条(按 id),不是先出现、也不是后出现的那条", async () => {
		mockApi(
			[row({ subscriptionId: "s-own", nameSnapshot: undefined })],
			[
				biliSub("s-first", "u1", "先出现的那条"),
				biliSub("s-own", "u1", "行自己那条"),
				biliSub("s-last", "u1", "后出现的那条"),
			],
		);
		renderHistory();
		// 行上没有写入期快照时,显示的就是对到的那条订阅的名字。
		await waitFor(() => expect(screen.getByText("行自己那条")).toBeTruthy());
		expect(screen.queryByText("先出现的那条")).toBeNull();
		expect(screen.queryByText("后出现的那条")).toBeNull();
		// 搜索串也是按同一条订阅拼的。
		await userEvent.type(screen.getByPlaceholderText(/搜索/), "先出现");
		expect(screen.queryByText("下播了")).toBeNull();
	});
});

/**
 * 拓展行(ADR-0019 决策 73):身份的来源键是拓展 id。名字对不上时写外部 id(B 站行写 uid);
 * 行对订阅照同一条规矩 —— 先认 id,不在了按「同一个拓展 + 同一个外部 id」找。
 */
describe("推送历史 · 拓展行", () => {
	function extRow(over: Partial<HistoryEntryView> = {}): HistoryEntryView {
		return row({
			identity: { sourceKey: "douyin", externalId: "sec-1" },
			subscriptionId: "s-gone",
			nameSnapshot: undefined,
			...over,
		});
	}

	it("没有名字快照、订阅也对不上 → 名字写外部 id", async () => {
		mockApi([extRow()]);
		renderHistory();
		await waitFor(() => expect(screen.getByText("下播了")).toBeTruthy());
		expect(screen.getByText("sec-1")).toBeTruthy();
		expect(screen.queryByText("未知")).toBeNull();
	});

	it("订阅删了、同一个拓展同一个外部 id 又加了一条 → 显示现在那条的名字", async () => {
		const readded: Subscription = {
			...makeEmptySubscription({ sourceKey: "douyin", externalId: "sec-1" }),
			id: "s-readded",
			cachedProfile: {
				name: "现在的抖音号",
				refreshedAt: "2026-09-24T00:00:00Z",
			},
		};
		mockApi([extRow()], [readded]);
		renderHistory();
		await waitFor(() => expect(screen.getByText("现在的抖音号")).toBeTruthy());
	});

	describe("头像:写入期快照赢过订阅现在的头像;没有快照就用订阅现在的(⑳c:图库引用 / 远端网址)", () => {
		const REF = `${"d".repeat(64)}.png`;
		const withAvatar = (sub: Subscription, avatar: { avatar?: string }) => ({
			...sub,
			cachedProfile: {
				...(sub.cachedProfile as NonNullable<Subscription["cachedProfile"]>),
				...avatar,
			},
		});
		const readded = (avatar: { avatar?: string }): Subscription =>
			withAvatar(
				{
					...makeEmptySubscription({ sourceKey: "douyin", externalId: "sec-1" }),
					id: "s-readded",
					cachedProfile: { name: "现在的抖音号", refreshedAt: "t" },
				},
				avatar,
			);

		it("拓展行没有快照(老行)→ 订阅现在的图库头像,走 /api/images/<引用>", async () => {
			mockApi([extRow()], [readded({ avatar: REF })]);
			const { container } = renderHistory();
			await waitFor(() => expect(screen.getByText("现在的抖音号")).toBeTruthy());
			expect(container.querySelector(`img[src="/api/images/${REF}"]`)).not.toBeNull();
		});

		it("拓展行有头像快照(图库引用)→ 用快照,不用订阅现在的头像", async () => {
			mockApi([extRow({ avatarSnapshot: SNAPSHOT })], [readded({ avatar: REF })]);
			const { container } = renderHistory();
			await waitFor(() => expect(screen.getByText("现在的抖音号")).toBeTruthy());
			expect(container.querySelector(`img[src="/api/images/${SNAPSHOT}"]`)).not.toBeNull();
			expect(container.querySelector(`img[src="/api/images/${REF}"]`)).toBeNull();
		});

		it("过了保留期的行不用头像快照(图可能已被清扫收走)→ 订阅现在的头像", async () => {
			mockApi(
				[extRow({ avatarSnapshot: SNAPSHOT, isPastRetention: true })],
				[readded({ avatar: REF })],
			);
			const { container } = renderHistory();
			await waitFor(() => expect(screen.getByText("现在的抖音号")).toBeTruthy());
			expect(container.querySelector(`img[src="/api/images/${REF}"]`)).not.toBeNull();
			expect(container.querySelector(`img[src="/api/images/${SNAPSHOT}"]`)).toBeNull();
		});

		it("B 站行没有头像快照 → 用订阅现在的图库头像,走 /api/images/<引用>", async () => {
			mockApi(
				[row({ subscriptionId: "s-bili", nameSnapshot: undefined, avatarSnapshot: undefined })],
				[withAvatar(biliSub("s-bili", "u1", "某B站UP"), { avatar: REF })],
			);
			const { container } = renderHistory();
			await waitFor(() => expect(screen.getByText("某B站UP")).toBeTruthy());
			expect(container.querySelector(`img[src="/api/images/${REF}"]`)).not.toBeNull();
		});

		it("B 站行没有快照 → 没有图库头像就不画图片", async () => {
			mockApi(
				[row({ subscriptionId: "s-bili", nameSnapshot: undefined })],
				[biliSub("s-bili", "u1", "某B站UP")],
			);
			const { container } = renderHistory();
			await waitFor(() => expect(screen.getByText("某B站UP")).toBeTruthy());
			expect(container.querySelector("img")).toBeNull();
		});
	});

	it("外部 id 恰好等于某个 B 站 uid → 不认成那位 B 站 UP", async () => {
		mockApi(
			[extRow({ identity: { sourceKey: "douyin", externalId: "u1" } })],
			[biliSub("s-bili", "u1", "某B站UP")],
		);
		renderHistory();
		await waitFor(() => expect(screen.getByText("下播了")).toBeTruthy());
		expect(screen.queryByText("某B站UP")).toBeNull();
		expect(screen.getByText("u1")).toBeTruthy();
	});

	it("搜外部 id 搜得到这一行", async () => {
		mockApi([extRow({ nameSnapshot: "某抖音号" })]);
		renderHistory();
		await waitFor(() => expect(screen.getByText("下播了")).toBeTruthy());
		await userEvent.type(screen.getByPlaceholderText(/搜索/), "sec-1");
		expect(screen.getByText("下播了")).toBeTruthy();
		await userEvent.clear(screen.getByPlaceholderText(/搜索/));
		await userEvent.type(screen.getByPlaceholderText(/搜索/), "sec-404");
		expect(screen.queryByText("下播了")).toBeNull();
	});
});

/** 装着的抖音订阅源 —— 徽章的短名与颜色照它的清单。 */
const DOUYIN = {
	id: "douyin",
	name: "抖音订阅",
	dir: "/data/extensions/douyin",
	enabled: true,
	state: "running",
	apiVersion: 2,
	provides: ["subscription"],
	subscription: {
		display: { label: "抖音", shortLabel: "抖", color: "#161823" },
		events: ["post", "liveStart", "liveEnd"],
	},
} as ExtensionDTO;

/**
 * 拓展行带一枚平台徽章(ADR-0019 决策 9「订阅删了也看得出是哪个平台的」),画法同首页「正在直播」:
 * 短名照清单,拓展卸载了取不到写拓展 id。名字取自快照还是外部 id 兜底都带;B 站行不画。
 */
describe("推送历史 · 平台徽章", () => {
	const extRow = (over: Partial<HistoryEntryView> = {}) =>
		row({
			identity: { sourceKey: "douyin", externalId: "sec-1" },
			subscriptionId: "s-gone",
			nameSnapshot: "某抖音号",
			...over,
		});

	it("拓展行带平台徽章(短名照清单),名字取自快照也带", async () => {
		mockApi([extRow()], [], [DOUYIN]);
		renderHistory();
		await waitFor(() => expect(screen.getByText("抖")).toBeTruthy());
		expect(screen.getByText("某抖音号")).toBeTruthy();
	});

	it("名字是外部 id 兜底的拓展行也带徽章", async () => {
		mockApi([extRow({ nameSnapshot: undefined })], [], [DOUYIN]);
		renderHistory();
		await waitFor(() => expect(screen.getByText("抖")).toBeTruthy());
		expect(screen.getByText("sec-1")).toBeTruthy();
	});

	it("拓展卸载了(清单里没有它)→ 徽章写拓展 id", async () => {
		mockApi([extRow()], [], []);
		renderHistory();
		await waitFor(() => expect(screen.getByText("某抖音号")).toBeTruthy());
		expect(await screen.findByText("douyin")).toBeTruthy();
	});

	it("B 站行没有平台徽章:只有类型与状态那两枚", async () => {
		// 单条、已送达:没有「N 条」那颗展开胶囊,徽章只剩类型与状态。
		mockApi(
			[
				row({
					status: "delivered",
					messages: [{ text: "下播了", kind: "text", role: "main", ok: true }],
				}),
			],
			[],
			[DOUYIN],
		);
		const { container } = renderHistory();
		await waitFor(() => expect(screen.getByText("某UP")).toBeTruthy());
		// 等拓展清单也回来,免得「还没回来所以没画」冒充「B 站行不画」。
		await waitFor(() => expect(api.get).toHaveBeenCalledWith("/api/ext"));
		const badges = [...container.querySelectorAll('[data-bn="badge"]')].map((b) => b.textContent);
		expect(badges).toEqual(["下播", "已送达"]);
	});
});
