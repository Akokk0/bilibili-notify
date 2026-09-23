// @vitest-environment jsdom

/**
 * 老格式(v1)拓展的详情页(ADR-0019 决策 44):这一版 BN 还认它、推送照常,但面板管不了它 ——
 * 头卡里得说清「老格式,去市场更新之后才能在这里管理」,并就地给出更新入口。
 *
 * 值得钉的:
 * - 这句话只给 v1:v2 有自己的「配置」,多一句「老格式」就是说谎。
 * - 🔴 **市场有更新就给那颗「更新」,走的是市场那一套**(同一个 source + id、同一段换装、第三方
 *   同一道确认框)—— 在这儿另接一份 `install.mutate`,等于给第三方开一条零确认装代码的路。
 * - 市场查不到更新时**不给钮**,说清为什么、指去市场 —— 一颗按了没用的钮比没有更糟。
 */

import type {
	ExtensionDTO,
	ExtensionsResponse,
	MarketplaceResponse,
} from "@bilibili-notify/contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import ExtensionDetail from "../ExtensionDetail";
import { type CardMotion, EXT_UPDATE_BUTTON, useCardMotionStore } from "../extensions/card-motion";
import { cardSelector } from "../extensions/install-flight";

const { apiGetMock, apiPostMock } = vi.hoisted(() => ({
	apiGetMock: vi.fn(),
	apiPostMock: vi.fn(),
}));

vi.mock("../../services/api", () => ({
	api: {
		get: apiGetMock as unknown as (url: string) => Promise<unknown>,
		patch: vi.fn(),
		post: apiPostMock as unknown as (url: string, body?: unknown) => Promise<unknown>,
		delete: vi.fn(),
	},
	ApiError: class extends Error {},
}));

/** 唯一发出去过的 v1:桥 0.0.1。升级 BN 之后它照跑,面板却管不了它的接入。 */
const LEGACY: ExtensionDTO = {
	id: "bridge",
	name: "机器人框架桥接",
	description: "把别的机器人框架里的 bot 借过来发推送",
	version: "0.0.1",
	apiVersion: 1,
	provides: ["push"],
	enabled: true,
	state: "running",
	dir: "/data/extensions/bridge",
};

/** 市场那一口的默认回答:官方源在、什么都没列。 */
const MARKET: MarketplaceResponse = {
	available: true,
	fetchedAt: 1,
	sources: [{ id: "official", name: "BN 官方拓展", official: true, ok: true }],
	extensions: [],
};

/** 市场里桥的那一条:装着 0.0.1、索引里有 0.1.0(新格式)。 */
const BRIDGE_ENTRY: MarketplaceResponse["extensions"][number] = {
	source: "official",
	official: true,
	id: "bridge",
	name: "机器人框架桥接",
	description: "",
	version: "0.1.0",
	apiVersion: 2,
	prerelease: false,
	size: 1,
	installed: { version: "0.0.1", source: "official" },
	state: "updatable",
};

function marketWith(
	entry: Partial<MarketplaceResponse["extensions"][number]>,
	sources: MarketplaceResponse["sources"] = MARKET.sources,
): MarketplaceResponse {
	return { ...MARKET, sources, extensions: [{ ...BRIDGE_ENTRY, ...entry }] };
}

/** 盖掉一份跑着的 v1 之后的回话:新版等着换上。 */
const UPDATED = {
	id: "bridge",
	name: "机器人框架桥接",
	version: "0.1.0",
	staged: true,
	enabled: true,
	restart: { can: true, how: "container" },
};

interface Setup {
	ext?: ExtensionDTO;
	/** 市场那一口:一份回答,或一个错。 */
	market?: MarketplaceResponse | Error;
	/** 拓展自己带的那两份说明 —— 带上它们页签条才会出现,「没有配置那一档」才有得看。 */
	docs?: { readme?: string; changelog?: string };
}

function renderDetail({ ext = LEGACY, market = MARKET, docs = {} }: Setup = {}) {
	apiGetMock.mockImplementation(async (url: string) => {
		if (url === "/api/ext") {
			return {
				extensions: [ext],
				restart: { can: true, how: "container" },
			} satisfies ExtensionsResponse;
		}
		if (url.startsWith("/api/ext/marketplace")) {
			if (market instanceof Error) throw market;
			return market;
		}
		if (url === `/api/ext/${ext.id}/docs`) return docs;
		if (url === `/api/ext/${ext.id}/settings`) return { revision: "r1", values: {} };
		if (url === `/api/ext/${ext.id}/status`) return {};
		throw new Error(`没有这个口:${url}`);
	});
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<MemoryRouter initialEntries={[`/extensions/${ext.id}`]}>
				<Routes>
					<Route path="/extensions/:id" element={<ExtensionDetail />} />
				</Routes>
			</MemoryRouter>
		</QueryClientProvider>,
	);
}

/** 头卡:名字所在的那张玻璃卡(面包屑里也印着名字,所以挑落在玻璃卡上的那一处)。 */
async function headCard(name = LEGACY.name): Promise<HTMLElement> {
	const titles = await screen.findAllByText(name);
	const card = titles.map((el) => el.closest(".bn-glass")).find(Boolean);
	if (!card) throw new Error("找不到头卡");
	return card as HTMLElement;
}

const LEGACY_LINE = /老格式的拓展,去市场更新之后才能在这里管理/;

describe("老格式(v1)拓展的详情页", () => {
	beforeEach(() => {
		apiGetMock.mockReset();
		apiPostMock.mockReset();
		// 那一格是模块级的:上一条用例放进去的一段不许漏到这一条。
		useCardMotionStore.setState({ motion: null });
	});

	afterEach(() => {
		cleanup();
	});

	it("头卡里说清它是老格式、去市场更新之后才能在这里管理;不摆「配置」", async () => {
		renderDetail({ docs: { readme: "# 桥", changelog: "## 0.0.1" } });
		const head = await headCard();
		expect(within(head).getByText(LEGACY_LINE)).toBeTruthy();
		// 页签条是在的(两份说明各一档),只是里面没有「配置」。
		expect(await screen.findByRole("tab", { name: /说明/ })).toBeTruthy();
		expect(screen.queryByRole("tab", { name: /配置/ })).toBeNull();
	});

	it("v2 拓展不说这句 —— 它有自己的「配置」;也不为它去问市场", async () => {
		renderDetail({
			ext: {
				...LEGACY,
				version: "0.1.0",
				apiVersion: 2,
				settings: { fields: [{ key: "interval", type: "number", label: "检查间隔" }] },
			},
			docs: { readme: "# 桥" },
		});
		const head = await headCard();
		expect(await screen.findByRole("tab", { name: /配置/ })).toBeTruthy();
		expect(within(head).queryByText(/老格式/)).toBeNull();
		expect(apiGetMock).not.toHaveBeenCalledWith("/api/ext/marketplace");
	});

	/**
	 * 就地更新,走的是市场那一套:同一个 source + id、同一段换装(球从这颗钮起飞,落在头卡上)。
	 * jsdom 没有动画接口,换装一放进去就当场收摊,所以记的是「放进来过什么」。
	 */
	it("市场里有新版 → 头卡里给「更新」;按下去走市场那一口,并演那段换装", async () => {
		const played: CardMotion[] = [];
		const unsubscribe = useCardMotionStore.subscribe((state) => {
			if (state.motion) played.push(state.motion);
		});
		apiPostMock.mockResolvedValue(UPDATED);
		renderDetail({ market: marketWith({}) });
		const head = await headCard();
		const button = await within(head).findByRole("button", { name: "更新" });
		expect(within(head).getByText(/有新版 v0\.1\.0/)).toBeTruthy();
		// 老形状(没有 `installed.revoked` 那一格):缺了当没撤回,不标红。
		expect(within(head).queryByText(/撤回/)).toBeNull();
		// 有钮可按就不再指去市场 —— 两条路摆一起,主人会以为得先去市场做点什么。
		expect(within(head).queryByRole("link", { name: /去拓展市场/ })).toBeNull();
		// devtools「播放更新动画」认这个标记找起飞点。
		expect(button.hasAttribute(EXT_UPDATE_BUTTON)).toBe(true);
		fireEvent.click(button);

		await waitFor(() =>
			expect(apiPostMock).toHaveBeenCalledWith("/api/ext/marketplace/install", {
				source: "official",
				id: "bridge",
			}),
		);
		await waitFor(() => expect(played).toHaveLength(1));
		unsubscribe();
		const motion = played[0];
		if (motion?.kind !== "update") throw new Error("应该是一段换装");
		expect(motion.id).toBe("bridge");
		expect(motion.from).toBeTruthy();
		// 落点就是这张头卡 —— 找不到的话那颗球等满四秒、静默收摊,主人什么都看不见。
		expect(document.querySelector(cardSelector("bridge"))?.contains(head)).toBe(true);
		await expect(motion.outcome).resolves.toBe(true);
		// 这一页上有人演:jsdom 没有动画接口,演的那头找到卡就当场收摊、把那一格还回来。
		// 没挂演的那一处的话,那一段一直占着那一格,回到列表页还会再演一遍。
		await waitFor(() => expect(useCardMotionStore.getState().motion).toBeNull());
	});

	/**
	 * 🔴 装着那版被撤回、市场里有能换过去的新版(`updatable` + `installed.revoked`):恰恰是最该
	 * 更新的时候 —— 头卡里既标红、又给那颗「更新」,按下去走的还是市场那一口。
	 */
	it("装着那版被撤回、有能换过去的新版 → 标红说撤回,照给「更新」,按下去走市场那一口", async () => {
		apiPostMock.mockResolvedValue(UPDATED);
		renderDetail({
			market: marketWith({ installed: { version: "0.0.1", source: "official", revoked: true } }),
		});
		const head = await headCard();
		const revoked = await within(head).findByText("装着的这一版被撤回了");
		expect(revoked.className).toContain("text-bn-danger");
		expect(within(head).getByText(/有新版 v0\.1\.0/)).toBeTruthy();
		// 有钮可按,就不是「没有能更新到的版本」那几档 —— 不再指去市场。
		expect(within(head).queryByRole("link", { name: /去拓展市场/ })).toBeNull();
		fireEvent.click(within(head).getByRole("button", { name: "更新" }));
		await waitFor(() =>
			expect(apiPostMock).toHaveBeenCalledWith("/api/ext/marketplace/install", {
				source: "official",
				id: "bridge",
			}),
		);
	});

	/**
	 * 市场里查不到能更新到的版本时**不给钮** —— 一颗按了没用的钮比没有更糟;说清为什么,并指去
	 * 市场那一节(源、重新拉索引都在那儿)。每一档说的是不同的事实,别合成一句「没有更新」:
	 * 「源拉不到」要去修源,「已是最新」只能等新版,合成一句主人就不知道该做哪件。
	 */
	it.each<[string, MarketplaceResponse | Error, RegExp]>([
		["没配源", { ...MARKET, available: false, sources: [] }, /这个构建没有官方源,也还没加第三方源/],
		["源里没有它", MARKET, /配着的源里都没有它/],
		[
			"有源没拉到",
			{
				...MARKET,
				sources: [
					{ id: "official", name: "BN 官方拓展", official: true, ok: false, err: "拿不到官方索引" },
				],
			},
			/源「BN 官方拓展」这次没拉到/,
		],
		[
			"已是最新却仍是 v1",
			marketWith({ version: "0.0.1", apiVersion: 1, state: "installed" }),
			/市场里最新的就是装着的这一版/,
		],
		[
			"新版这台 BN 装不了",
			marketWith({ version: "0.2.0", apiVersion: 3, state: "installed" }),
			/市场里的 v0\.2\.0 这台 BN 装不了/,
		],
		[
			"不是从市场装的",
			marketWith({ state: "installed-elsewhere", installed: { version: "0.0.1" } }),
			/你这份不是从市场装的,市场不提示它的更新/,
		],
		["装着的这一版被撤回了", marketWith({ state: "revoked" }), /装着的这一版被市场撤回了/],
		["市场问不到", new Error("超时了"), /市场问不到:超时了/],
	])("%s → 不给「更新」,说清为什么,指去市场", async (_case, market, reason) => {
		renderDetail({ market });
		const head = await headCard();
		expect(await within(head).findByText(reason)).toBeTruthy();
		expect(within(head).queryByRole("button", { name: "更新" })).toBeNull();
		const toMarket = within(head).getByRole("link", { name: /去拓展市场/ });
		// 直接落到市场那一节(它在拓展页最底下),不是页顶。
		expect(toMarket.getAttribute("href")).toBe("/extensions#marketplace");
	});

	/**
	 * 更新过了、新版等着换上(跑着的还是 v1 那份,ADR-0012 决策 47):这时再说「去市场更新」就是
	 * 假话 —— 市场那条已经是「已装」,照着去市场只会扑空。改说新版已经下好,换上就能管;怎么换
	 * 就在头卡上面那块(重启 BN / 只重载)。
	 */
	it("新版已经下好、等着换上 → 说换上之后就能管,不再给更新、不再指去市场", async () => {
		renderDetail({
			ext: { ...LEGACY, staged: { version: "0.1.0" } },
			market: marketWith({
				state: "installed",
				installed: { version: "0.1.0", source: "official" },
			}),
		});
		const head = await headCard();
		expect(within(head).getByText(/新版 v0\.1\.0 已经下好了,换上之后才能在这里管理/)).toBeTruthy();
		expect(within(head).getByRole("button", { name: "重启 BN" })).toBeTruthy();
		expect(within(head).queryByText(LEGACY_LINE)).toBeNull();
		expect(within(head).queryByRole("button", { name: "更新" })).toBeNull();
		expect(within(head).queryByRole("link", { name: /去拓展市场/ })).toBeNull();
	});

	/**
	 * 🔴 **第三方来源的更新也先确认。** 更新与装落地的是同一件事(把一份 BN 不担保的代码放进 BN
	 * 进程里跑);这一页要是没挂那道确认框,按下去什么都不发生 —— 要是自己接了 mutate,第三方源
	 * 抬个版本号就能零确认装进新代码。
	 */
	it("第三方来源的更新先确认 —— 取消就不发,确认才发", async () => {
		apiPostMock.mockResolvedValue({ ...UPDATED, id: "alice.bridge" });
		const sources: MarketplaceResponse["sources"] = [
			...MARKET.sources,
			{
				id: "s1",
				name: "alice",
				official: false,
				url: "https://alice.example/m.json",
				namespace: "alice",
				ok: true,
			},
		];
		renderDetail({
			ext: { ...LEGACY, id: "alice.bridge", dir: "/data/extensions/alice.bridge" },
			market: marketWith({ id: "alice.bridge", source: "s1", official: false }, sources),
		});
		const head = await headCard();
		fireEvent.click(await within(head).findByRole("button", { name: "更新" }));
		const dialog = await screen.findByRole("dialog");
		expect(dialog.textContent).toContain("alice");
		fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
		expect(apiPostMock).not.toHaveBeenCalled();

		fireEvent.click(within(head).getByRole("button", { name: "更新" }));
		fireEvent.click(
			within(await screen.findByRole("dialog")).getByRole("button", { name: "照样更新" }),
		);
		await waitFor(() =>
			expect(apiPostMock).toHaveBeenCalledWith("/api/ext/marketplace/install", {
				source: "s1",
				id: "alice.bridge",
			}),
		);
	});

	it("更新砸了 → 就在那颗钮旁边说「更新不了」和服务端那句原因", async () => {
		apiPostMock.mockRejectedValue(new Error("下不动"));
		renderDetail({ market: marketWith({}) });
		const head = await headCard();
		fireEvent.click(await within(head).findByRole("button", { name: "更新" }));
		expect(await within(head).findByText(/更新不了:下不动/)).toBeTruthy();
	});
});
