// @vitest-environment jsdom

/**
 * 订阅页的平台选择(ADR-0019 决策 10 / 11 / 49 / 51 / 52)。
 *
 * - 至少一个订阅源拓展**在跑**才出平台选择,否则「添加 UP 主」与今天一模一样。
 * - 选了平台,输入框的字原样交给那个拓展的解析门;候选列出来(已订阅的标出来、挑不了);
 *   解析门报错时原样摆出服务端那句话。
 * - 挑一个候选 → 同一个配置弹层(新建)→「创建订阅」发一整条拓展订阅 + 用候选预填的资料。
 * - 列表里拓展没开的那条订阅置灰、写明「××拓展没开」;拓展列表没回来时不下结论。
 */

import type { ExtensionDTO } from "@bilibili-notify/contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
	type ExtensionSubscription,
	makeEmptySubscription,
	type Subscription,
} from "../../types/domain";
import Subs from "../Subs";

const { FakeApiError } = vi.hoisted(() => {
	class FakeApiError extends Error {}
	return { FakeApiError };
});

vi.mock("../../services/api", () => ({
	api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
	ApiError: FakeApiError,
}));

import { api } from "../../services/api";

const AVATAR = "data:image/png;base64,iVBORw0KGgo=";

function source(over: Partial<ExtensionDTO> = {}): ExtensionDTO {
	return {
		id: "douyin",
		name: "抖音订阅",
		dir: "/data/extensions/douyin",
		enabled: true,
		state: "running",
		apiVersion: 2,
		provides: ["subscription"],
		subscription: {
			display: {
				label: "抖音",
				shortLabel: "抖音",
				color: "#161823",
				postNoun: "作品",
				lookupPlaceholder: "粘主页链接",
			},
			events: ["post", "liveStart"],
		},
		...over,
	};
}

function extSub(over: Partial<ExtensionSubscription> = {}): ExtensionSubscription {
	const {
		kind: _k,
		uid: _u,
		roastSchedule: _r,
		specialUsers: _s,
		followed: _f,
		followError: _e,
		...common
	} = makeEmptySubscription("0");
	return {
		...common,
		kind: "extension",
		extensionId: "douyin",
		externalId: "sec-2",
		cachedProfile: { name: "抖音乙", avatar: "", sign: "", fans: 3, lastRefreshedAt: "t" },
		...over,
	};
}

const BILI: Subscription = {
	...makeEmptySubscription("111"),
	cachedProfile: { name: "UP甲", avatar: "", sign: "", fans: 0, lastRefreshedAt: "t" },
};

let subs: Subscription[];
let extensions: Promise<{ extensions: ExtensionDTO[] }>;

beforeEach(() => {
	subs = [BILI];
	extensions = Promise.resolve({ extensions: [source()] });
	(api.get as ReturnType<typeof vi.fn>).mockImplementation((path: string) => {
		if (path.startsWith("/api/subs")) return Promise.resolve(subs);
		if (path.startsWith("/api/targets")) return Promise.resolve([]);
		if (path === "/api/ext") return extensions;
		if (path.startsWith("/api/ext/douyin/lookup")) {
			return Promise.resolve({
				candidates: [
					{ id: "sec-1", name: "抖音甲", avatar: AVATAR, fans: 12_345 },
					{ id: "sec-2", name: "抖音乙" },
				],
			});
		}
		return Promise.resolve([]);
	});
	(api.post as ReturnType<typeof vi.fn>).mockResolvedValue([]);
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

function renderSubs() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<MemoryRouter initialEntries={["/subs"]}>
				<Subs />
			</MemoryRouter>
		</QueryClientProvider>,
	);
}

/** 打开「添加 UP 主」,等拓展列表回来(平台选择要它)。 */
async function openNewDialog() {
	renderSubs();
	await screen.findByText("UP甲");
	await waitFor(() => expect(api.get).toHaveBeenCalledWith("/api/ext"));
	fireEvent.click(screen.getAllByText("添加")[0] as HTMLElement);
	// 「添加 UP 主」末尾那张加号卡上也写着,等弹窗那句说明。
	return screen.findByText(/选定后进入配置表单/);
}

describe("平台选择出不出现", () => {
	it("没有在跑的订阅源 → 与今天一模一样:没有平台选择", async () => {
		extensions = Promise.resolve({
			extensions: [source({ state: "disabled", enabled: false })],
		});
		await openNewDialog();
		expect(screen.getByPlaceholderText("搜索 UID 或 UP 主名字")).toBeTruthy();
		expect(screen.queryByRole("button", { name: "B 站" })).toBeNull();
		expect(screen.queryByRole("button", { name: "抖音" })).toBeNull();
	});

	it("有在跑的订阅源 → B 站 + 它,默认 B 站;切回 B 站就是今天那一套", async () => {
		await openNewDialog();
		expect(await screen.findByRole("button", { name: "B 站" })).toBeTruthy();
		expect(screen.getByPlaceholderText("搜索 UID 或 UP 主名字")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "抖音" }));
		expect(screen.getByPlaceholderText("粘主页链接")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "B 站" }));
		expect(screen.getByPlaceholderText("搜索 UID 或 UP 主名字")).toBeTruthy();
	});
});

describe("选了订阅源", () => {
	it("提示照清单;查找走它的解析门;候选列出来,已订阅的挑不了", async () => {
		subs = [BILI, extSub()];
		await openNewDialog();
		fireEvent.click(await screen.findByRole("button", { name: "抖音" }));
		const input = screen.getByPlaceholderText("粘主页链接");
		fireEvent.change(input, { target: { value: "https://v.douyin.com/abc/" } });
		fireEvent.click(screen.getByRole("button", { name: "查找" }));

		await waitFor(() =>
			expect(api.get).toHaveBeenCalledWith(
				`/api/ext/douyin/lookup?q=${encodeURIComponent("https://v.douyin.com/abc/")}`,
			),
		);
		const fresh = await screen.findByRole("button", { name: /抖音甲/ });
		expect(within(fresh).getByText("1.2万 粉丝")).toBeTruthy();
		expect((fresh as HTMLButtonElement).disabled).toBe(false);
		// 列表里那张「抖音乙」的卡也叫这个名字,只在弹窗里找。
		const taken = within(screen.getByRole("dialog")).getByRole("button", { name: /抖音乙/ });
		expect((taken as HTMLButtonElement).disabled).toBe(true);
		expect(within(taken).getByText("已订阅")).toBeTruthy();
	});

	it("清单没给提示 → 通用说法", async () => {
		const plain = source();
		plain.subscription = {
			display: { label: "抖音", shortLabel: "抖音", color: "#161823" },
			events: ["post"],
		};
		extensions = Promise.resolve({ extensions: [plain] });
		await openNewDialog();
		fireEvent.click(await screen.findByRole("button", { name: "抖音" }));
		expect(screen.getByPlaceholderText("输入主页链接或账号 id")).toBeTruthy();
	});

	it("解析门报错 → 原样摆出服务端那句话", async () => {
		(api.get as ReturnType<typeof vi.fn>).mockImplementation((path: string) => {
			if (path.startsWith("/api/subs")) return Promise.resolve(subs);
			if (path === "/api/ext") return extensions;
			if (path.startsWith("/api/ext/douyin/lookup")) {
				return Promise.reject(new FakeApiError("拓展交回来的候选形状不对:第 1 条缺 name"));
			}
			return Promise.resolve([]);
		});
		await openNewDialog();
		fireEvent.click(await screen.findByRole("button", { name: "抖音" }));
		fireEvent.change(screen.getByPlaceholderText("粘主页链接"), { target: { value: "x" } });
		fireEvent.click(screen.getByRole("button", { name: "查找" }));
		expect(await screen.findByText(/拓展交回来的候选形状不对:第 1 条缺 name/)).toBeTruthy();
	});

	it("查找还没回来就换到另一个源 → 晚到的候选不许挂到新平台名下", async () => {
		// 挂过去的话,挑中那一个就建出一条「快手的订阅、外部 id 却是抖音的」。
		extensions = Promise.resolve({
			extensions: [
				source(),
				source({
					id: "kuaishou",
					name: "快手订阅",
					subscription: {
						display: { label: "快手", shortLabel: "快手", color: "#ff4906" },
						events: ["post"],
					},
				}),
			],
		});
		let answer: (value: unknown) => void = () => {};
		(api.get as ReturnType<typeof vi.fn>).mockImplementation((path: string) => {
			if (path.startsWith("/api/subs")) return Promise.resolve(subs);
			if (path === "/api/ext") return extensions;
			if (path.startsWith("/api/ext/douyin/lookup")) {
				return new Promise((resolve) => {
					answer = resolve;
				});
			}
			return Promise.resolve([]);
		});
		await openNewDialog();
		fireEvent.click(await screen.findByRole("button", { name: "抖音" }));
		fireEvent.change(screen.getByPlaceholderText("粘主页链接"), { target: { value: "abc" } });
		fireEvent.click(screen.getByRole("button", { name: "查找" }));
		await waitFor(() =>
			expect(api.get).toHaveBeenCalledWith(expect.stringMatching(/^\/api\/ext\/douyin\/lookup/)),
		);
		fireEvent.click(screen.getByRole("button", { name: "快手" }));
		answer({ candidates: [{ id: "sec-1", name: "抖音甲" }] });
		// 让那一发回应走完它的 then 链,再看。
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(screen.getByPlaceholderText("输入主页链接或账号 id")).toBeTruthy();
		expect(screen.queryByRole("button", { name: /抖音甲/ })).toBeNull();
	});

	it("挑一个候选 → 同一个配置弹层 → 创建时发整条拓展订阅 + 候选预填的资料", async () => {
		await openNewDialog();
		fireEvent.click(await screen.findByRole("button", { name: "抖音" }));
		fireEvent.change(screen.getByPlaceholderText("粘主页链接"), { target: { value: "abc" } });
		fireEvent.click(screen.getByRole("button", { name: "查找" }));
		fireEvent.click(await screen.findByRole("button", { name: /抖音甲/ }));

		// 配置弹层:头部写平台,特性只列这个源报得出的。
		const create = await screen.findByRole("button", { name: "创建订阅" });
		expect(screen.getAllByText("作品").length).toBeGreaterThan(0);
		expect(screen.queryByText("上舰")).toBeNull();
		fireEvent.click(create);

		await waitFor(() => expect(api.post).toHaveBeenCalled());
		const [path, body] = (api.post as ReturnType<typeof vi.fn>).mock.calls[0] as [
			string,
			Record<string, unknown>,
		];
		expect(path).toBe("/api/subs");
		expect(body).toMatchObject({
			kind: "extension",
			extensionId: "douyin",
			externalId: "sec-1",
			enabled: true,
			groups: [],
			cachedProfile: { name: "抖音甲", avatar: AVATAR, fans: 12_345, sign: "" },
		});
		expect(body.id).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
		);
		expect(body).not.toHaveProperty("uid");
		expect(typeof (body.cachedProfile as { lastRefreshedAt: unknown }).lastRefreshedAt).toBe(
			"string",
		);
	});

	it("候选没带头像 / 粉丝 → 头像是空串(「没有」),粉丝数不带 —— 不编一个 0", async () => {
		await openNewDialog();
		fireEvent.click(await screen.findByRole("button", { name: "抖音" }));
		fireEvent.change(screen.getByPlaceholderText("粘主页链接"), { target: { value: "abc" } });
		fireEvent.click(screen.getByRole("button", { name: "查找" }));
		fireEvent.click(await screen.findByRole("button", { name: /抖音乙/ }));
		fireEvent.click(await screen.findByRole("button", { name: "创建订阅" }));

		await waitFor(() => expect(api.post).toHaveBeenCalled());
		const body = (api.post as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as {
			cachedProfile: Record<string, unknown>;
		};
		expect(body.cachedProfile.name).toBe("抖音乙");
		expect(body.cachedProfile.avatar).toBe("");
		expect(body.cachedProfile).not.toHaveProperty("fans");
	});
});

describe("列表里的拓展订阅", () => {
	it("拓展停了 → 那张卡写「抖音拓展没开」", async () => {
		subs = [BILI, extSub()];
		extensions = Promise.resolve({
			extensions: [source({ state: "disabled", enabled: false })],
		});
		renderSubs();
		expect(await screen.findByText("抖音拓展没开")).toBeTruthy();
	});

	it("拓展没装 → 拿不到名字,写拓展 id", async () => {
		subs = [BILI, extSub({ extensionId: "kuaishou" })];
		renderSubs();
		expect(await screen.findByText("kuaishou拓展没开")).toBeTruthy();
	});

	it("拓展在跑 → 不说「没开」,有平台徽章", async () => {
		subs = [BILI, extSub()];
		renderSubs();
		await screen.findByText("抖音乙");
		await waitFor(() => expect(screen.getByText("抖音")).toBeTruthy());
		expect(screen.queryByText(/拓展没开/)).toBeNull();
	});

	it("拓展列表还没回来 → 不下结论", async () => {
		subs = [BILI, extSub()];
		extensions = new Promise(() => {});
		renderSubs();
		await screen.findByText("抖音乙");
		expect(screen.queryByText(/拓展没开/)).toBeNull();
	});
});
