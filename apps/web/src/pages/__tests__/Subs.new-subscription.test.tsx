// @vitest-environment jsdom

/**
 * 新建订阅弹窗只有一套流程(4-15,订阅源文档「新建订阅弹窗只有一套流程」):选平台 → 一个输入框搜人 →
 * 候选列表 → 挑一个进配置弹层 → 创建时带候选资料。
 *
 * - 平台一排列出**在册的全部来源**(来源表里带 `has` 的那些),B 站只是其中一颗;只有一个时不画这一排。
 * - 提示句由 contract 的叫法函数按 `searchAccepts` 拼,没声明就是「搜索{creatorNoun}」。
 * - 搜人走 `GET /api/sources/:sourceKey/creators?q=`;订阅过的(同一来源 + 同一外部 id)标「已订阅」、挑不了,
 *   **绝不跨来源**。服务端那句话原样摆出来,不按状态码换句子。
 * - 挑中的候选(B 站的也一样)经同一个配置弹层建订阅,`cachedProfile` 用候选预填,不编没有的格。
 */

import type { ExtensionDTO, SourceEntry } from "@bilibili-notify/contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { makeEmptySubscription, type Subscription } from "../../types/domain";
import Subs from "../Subs";

const { FakeApiError } = vi.hoisted(() => {
	class FakeApiError extends Error {
		constructor(
			message: string,
			public readonly status = 503,
		) {
			super(message);
		}
	}
	return { FakeApiError };
});

vi.mock("../../services/api", () => ({
	api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
	ApiError: FakeApiError,
}));

import { api } from "../../services/api";

const AVATAR = "data:image/png;base64,iVBORw0KGgo=";

const BILI_SOURCE: SourceEntry = {
	status: "running",
	key: "bilibili",
	descriptor: {
		label: "B 站",
		shortLabel: "B",
		color: "#fb7299",
		externalIdNoun: "UID",
		searchAccepts: ["id", "link", "name"],
		supportedFeatures: ["post", "liveStart"],
	},
	has: { auth: true, liveStatus: true, preview: true },
};

const DOUYIN_SOURCE: SourceEntry = {
	status: "running",
	key: "douyin",
	descriptor: {
		label: "抖音",
		shortLabel: "抖音",
		color: "#161823",
		postNoun: "作品",
		searchAccepts: ["link"],
		supportedFeatures: ["post"],
	},
	has: { auth: false, liveStatus: false, preview: false },
};

/** 在册、可选成员一个没实现。 */
const NO_EXTRAS = { auth: false, liveStatus: false, preview: false };

/** 装着但没在跑的拓展:来源表里照列,只是不带 `has`。 */
const STOPPED_SOURCE: SourceEntry = {
	status: "disabled",
	key: "kuaishou",
	descriptor: { label: "快手", color: "#ff4906", supportedFeatures: ["post"] },
};

function extension(id: string): ExtensionDTO {
	return {
		id,
		name: `${id} 订阅`,
		dir: `/data/extensions/${id}`,
		enabled: true,
		state: "running",
		apiVersion: 3,
		provides: ["subscription"],
	};
}

function named(sub: Subscription, name: string): Subscription {
	return { ...sub, cachedProfile: { name, followers: 0, refreshedAt: "t" } };
}

const BILI = named(makeEmptySubscription({ sourceKey: "bilibili", externalId: "111" }), "UP甲");

let subs: Subscription[];
let sources: SourceEntry[];
/** 按来源键回候选(或一个失败);没摆的回空表。 */
let creators: Record<string, () => Promise<unknown>>;

beforeEach(() => {
	subs = [BILI];
	sources = [BILI_SOURCE, DOUYIN_SOURCE];
	creators = {
		bilibili: async () => ({
			candidates: [
				{ externalId: "111", name: "搜到的甲", followers: 5 },
				{ externalId: "222", name: "搜到的乙", avatarUrl: AVATAR, followers: 12_345 },
			],
		}),
		douyin: async () => ({
			candidates: [
				{ externalId: "111", name: "抖音同号" },
				{ externalId: "sec-2", name: "抖音乙" },
			],
		}),
	};
	(api.get as ReturnType<typeof vi.fn>).mockImplementation((path: string) => {
		// `/api/subscriptions/tags` 也以 `/api/subscriptions` 开头:订阅列表那条必须精确匹配。
		if (path === "/api/subscriptions/tags") return Promise.resolve([]);
		if (path === "/api/subscriptions") return Promise.resolve(subs);
		if (path === "/api/ext") return Promise.resolve({ extensions: [extension("douyin")] });
		if (path === "/api/sources") return Promise.resolve({ sources });
		const searched = /^\/api\/sources\/([^/]+)\/creators\?q=/.exec(path);
		if (searched) return creators[decodeURIComponent(searched[1] ?? "")]?.() ?? { candidates: [] };
		return Promise.resolve([]);
	});
	(api.post as ReturnType<typeof vi.fn>).mockResolvedValue([]);
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

/** 打开新建弹窗,等来源表回来(平台一排与提示句要它);回弹窗那一块。 */
async function openNewDialog() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(
		<QueryClientProvider client={qc}>
			<MemoryRouter initialEntries={["/subs"]}>
				<Subs />
			</MemoryRouter>
		</QueryClientProvider>,
	);
	await screen.findByText("UP甲");
	await waitFor(() => expect(api.get).toHaveBeenCalledWith("/api/sources"));
	fireEvent.click(screen.getAllByText("添加")[0] as HTMLElement);
	await screen.findByText(/配置表单/);
	return within(screen.getByRole("dialog"));
}

async function search(dialog: ReturnType<typeof within>, placeholder: string, query: string) {
	fireEvent.change(await dialog.findByPlaceholderText(placeholder), { target: { value: query } });
	fireEvent.click(dialog.getByRole("button", { name: "搜索" }));
}

describe("平台一排", () => {
	// 验红:`registeredSources` 不看 `has`(停着的拓展也列),这条红(多出一颗「快手」)。
	it("列出在册的全部来源,B 站只是其中一颗;没在跑的(不带 has)不列", async () => {
		sources = [BILI_SOURCE, DOUYIN_SOURCE, STOPPED_SOURCE];
		const dialog = await openNewDialog();
		expect(await dialog.findByRole("button", { name: "B 站" })).toBeTruthy();
		expect(dialog.getByRole("button", { name: "抖音" })).toBeTruthy();
		expect(dialog.queryByRole("button", { name: "快手" })).toBeNull();
	});

	it("只有一个在册来源 → 不画这一排,直接搜它", async () => {
		sources = [BILI_SOURCE, STOPPED_SOURCE];
		const dialog = await openNewDialog();
		expect(await dialog.findByPlaceholderText("UID、主页链接或名字")).toBeTruthy();
		expect(dialog.queryByRole("button", { name: "B 站" })).toBeNull();
	});

	it("钮的名字与颜色取自来源表里的描述符,不写死;默认选中第一颗", async () => {
		sources = [
			{
				...BILI_SOURCE,
				descriptor: { ...BILI_SOURCE.descriptor, label: "哔哩哔哩", color: "#123456" },
			},
			DOUYIN_SOURCE,
		];
		const dialog = await openNewDialog();
		const bili = await dialog.findByRole("button", { name: "哔哩哔哩" });
		expect(bili.style.getPropertyValue("--bn-tint")).toBe("#123456");
		expect(dialog.queryByRole("button", { name: "B 站" })).toBeNull();
	});
});

describe("提示句按 searchAccepts 拼", () => {
	// 验红:提示句改回写死的「搜索 UID 或 UP 主名字」,这条红。
	it("B 站三种都收 → 「UID、主页链接或名字」;只收链接 → 「主页链接」;没声明 → 「搜索{creatorNoun}」", async () => {
		sources = [
			BILI_SOURCE,
			DOUYIN_SOURCE,
			{
				...STOPPED_SOURCE,
				descriptor: { ...STOPPED_SOURCE.descriptor, creatorNoun: "主播" },
				has: NO_EXTRAS,
			},
			{
				key: "plain",
				status: "running",
				descriptor: { label: "无名", supportedFeatures: ["post"] },
				has: NO_EXTRAS,
			},
		];
		const dialog = await openNewDialog();
		expect(await dialog.findByPlaceholderText("UID、主页链接或名字")).toBeTruthy();
		fireEvent.click(dialog.getByRole("button", { name: "抖音" }));
		expect(dialog.getByPlaceholderText("主页链接")).toBeTruthy();
		fireEvent.click(dialog.getByRole("button", { name: "快手" }));
		expect(dialog.getByPlaceholderText("搜索主播")).toBeTruthy();
		fireEvent.click(dialog.getByRole("button", { name: "无名" }));
		expect(dialog.getByPlaceholderText("搜索创作者")).toBeTruthy();
	});
});

describe("搜人", () => {
	// 验红:B 站那一支改回问 `/api/subscriptions/search`,这条红。
	it("走 /api/sources/:sourceKey/creators;订阅过的标「已订阅」、挑不了;描述符有 externalIdNoun 的写身份标签", async () => {
		const dialog = await openNewDialog();
		await search(dialog, "UID、主页链接或名字", " 阿婆 ");
		await waitFor(() =>
			expect(api.get).toHaveBeenCalledWith(
				`/api/sources/bilibili/creators?q=${encodeURIComponent("阿婆")}`,
			),
		);
		const taken = await dialog.findByRole("button", { name: /搜到的甲/ });
		expect((taken as HTMLButtonElement).disabled).toBe(true);
		expect(within(taken).getByText("已订阅")).toBeTruthy();
		const fresh = dialog.getByRole("button", { name: /搜到的乙/ });
		expect((fresh as HTMLButtonElement).disabled).toBe(false);
		expect(within(fresh).getByText("UID 222")).toBeTruthy();
		expect(within(fresh).getByText("1.2万 粉丝")).toBeTruthy();
	});

	it("绝不跨来源:抖音候选的外部 id 恰好等于那条 B 站订阅的 uid → 不算已订阅", async () => {
		const dialog = await openNewDialog();
		fireEvent.click(await dialog.findByRole("button", { name: "抖音" }));
		await search(dialog, "主页链接", "https://v.douyin.com/abc/");
		const sameNumber = await dialog.findByRole("button", { name: /抖音同号/ });
		expect((sameNumber as HTMLButtonElement).disabled).toBe(false);
		expect(within(sameNumber).queryByText("已订阅")).toBeNull();
		// 抖音没声明外部 id 的叫法:不写身份标签(那串 id 是给机器认的)。
		expect(within(sameNumber).queryByText(/111/)).toBeNull();
	});

	it.each([
		["ApiError(状态码与话对不上号)", new FakeApiError("B 站现在很忙，请过一会儿再查", 404)],
		["不是 ApiError(断线之类)", new Error("连接中断，没有拿到服务器响应")],
	])("失败 —— %s:服务端那句话原样摆出来", async (_label, error) => {
		creators.bilibili = () => Promise.reject(error);
		const dialog = await openNewDialog();
		await search(dialog, "UID、主页链接或名字", "999");
		expect(await dialog.findByText(error.message)).toBeTruthy();
		expect(dialog.queryByText(/请检查 UID 是否正确/)).toBeNull();
	});

	it("还没回来就换到另一个来源 → 晚到的候选不许挂到新平台名下", async () => {
		// 挂过去的话,挑中那一个就建出一条「抖音的订阅、外部 id 却是 B 站的」。
		let answer: (value: unknown) => void = () => {};
		creators.bilibili = () =>
			new Promise((resolve) => {
				answer = resolve;
			});
		const dialog = await openNewDialog();
		await search(dialog, "UID、主页链接或名字", "abc");
		await waitFor(() =>
			expect(api.get).toHaveBeenCalledWith(expect.stringMatching(/^\/api\/sources\/bilibili\//)),
		);
		fireEvent.click(dialog.getByRole("button", { name: "抖音" }));
		answer({ candidates: [{ externalId: "333", name: "晚到的 B 站人" }] });
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(dialog.getByPlaceholderText("主页链接")).toBeTruthy();
		expect(dialog.queryByRole("button", { name: /晚到的 B 站人/ })).toBeNull();
	});
});

describe("挑中候选 → 配置弹层 → 创建", () => {
	// 验红:B 站候选改回不带 cachedProfile(从前服务端会剥掉、再刷一次),这条红。
	it("B 站候选也一样:创建时发整条订阅 + 候选预填的资料(头像是候选的 data URL)", async () => {
		const dialog = await openNewDialog();
		await search(dialog, "UID、主页链接或名字", "阿婆");
		fireEvent.click(await dialog.findByRole("button", { name: /搜到的乙/ }));

		fireEvent.click(await screen.findByRole("button", { name: "创建订阅" }));
		await waitFor(() => expect(api.post).toHaveBeenCalled());
		const [path, body] = (api.post as ReturnType<typeof vi.fn>).mock.calls[0] as [
			string,
			Record<string, unknown>,
		];
		expect(path).toBe("/api/subscriptions");
		expect(body).toMatchObject({
			identity: { sourceKey: "bilibili", externalId: "222" },
			enabled: true,
			cachedProfile: { name: "搜到的乙", avatarUrl: AVATAR, followers: 12_345 },
		});
		expect(body.id).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
		);
		expect(body).not.toHaveProperty("problems");
	});

	it("拓展的候选:配置弹层的特性只列这个源报得出的;没带头像 / 粉丝就不带这两格,不编一个 0", async () => {
		const dialog = await openNewDialog();
		fireEvent.click(await dialog.findByRole("button", { name: "抖音" }));
		await search(dialog, "主页链接", "abc");
		fireEvent.click(await dialog.findByRole("button", { name: /抖音乙/ }));

		const create = await screen.findByRole("button", { name: "创建订阅" });
		expect(screen.getAllByText("作品").length).toBeGreaterThan(0);
		expect(screen.queryByText("上舰")).toBeNull();
		fireEvent.click(create);
		await waitFor(() => expect(api.post).toHaveBeenCalled());
		const body = (api.post as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as {
			identity: unknown;
			cachedProfile: Record<string, unknown>;
		};
		expect(body.identity).toEqual({ sourceKey: "douyin", externalId: "sec-2" });
		expect(body.cachedProfile).toEqual({ name: "抖音乙" });
	});
});
