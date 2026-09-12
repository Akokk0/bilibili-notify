// @vitest-environment jsdom
/**
 * 拓展页上的「拓展市场」一节(ADR-0013)。
 *
 * 🔴 每条条目那颗钮画什么、能不能按,全看服务端算好的 `state` —— 前端不再自己比版本、
 * 不再猜「装没装」。官方条目一键装;第三方条目**装之前先确认**(它会在 BN 进程里跑代码,
 * BN 不担保);源拿不到时那句原因原样摆出来。
 */

import type { MarketplaceResponse } from "@bilibili-notify/contract";
import { ErrorNote } from "@bilibili-notify/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { apiGetMock, apiPostMock, apiPatchMock } = vi.hoisted(() => ({
	apiGetMock: vi.fn(),
	apiPostMock: vi.fn(),
	apiPatchMock: vi.fn(),
}));

vi.mock("../../../services/api", () => ({
	api: { get: apiGetMock, post: apiPostMock, patch: apiPatchMock, upload: vi.fn() },
	ApiError: class ApiError extends Error {
		constructor(
			public readonly status: number,
			public readonly body: unknown,
			message: string,
		) {
			super(message);
		}
	},
}));

import { ExtensionInstallOutcome } from "../install-outcome";
import {
	MarketplaceInstallConfirm,
	MarketplaceSection,
	useMarketplaceInstall,
} from "../marketplace-section";

const MARKET: MarketplaceResponse = {
	available: true,
	fetchedAt: 1,
	sources: [
		{ id: "official", name: "BN 官方拓展", official: true, ok: true },
		{
			id: "s1",
			name: "alice",
			official: false,
			url: "https://alice.example/m.json",
			namespace: "alice",
			ok: true,
		},
	],
	extensions: [
		{
			source: "official",
			official: true,
			id: "bridge",
			name: "机器人框架桥接",
			description: "借机器人",
			version: "0.0.2",
			apiVersion: 1,
			prerelease: false,
			size: 1000,
			state: "installable",
		},
		{
			source: "official",
			official: true,
			id: "foo",
			name: "Foo",
			description: "",
			version: "0.2.0",
			apiVersion: 1,
			prerelease: false,
			size: 1000,
			installed: { version: "0.1.0", source: "official" },
			state: "updatable",
		},
		{
			source: "official",
			official: true,
			id: "bar",
			name: "Bar",
			description: "",
			version: "1.0.0",
			apiVersion: 2,
			prerelease: false,
			size: 1000,
			state: "incompatible",
		},
		{
			source: "official",
			official: true,
			id: "baz",
			name: "Baz",
			description: "",
			version: "1.0.0",
			apiVersion: 1,
			prerelease: false,
			size: 1000,
			installed: { version: "0.9.0" },
			state: "installed-elsewhere",
		},
		{
			source: "official",
			official: true,
			id: "qux",
			name: "Qux",
			description: "",
			version: "1.0.0",
			apiVersion: 1,
			prerelease: false,
			size: 1000,
			installed: { version: "1.0.0", source: "official" },
			state: "revoked",
		},
		{
			source: "s1",
			official: false,
			id: "alice.douyin",
			name: "抖音订阅",
			description: "第三方的",
			version: "1.0.0",
			apiVersion: 1,
			prerelease: false,
			size: 1000,
			state: "installable",
		},
	],
};

const GLOBALS = {
	marketplace: { sources: [{ id: "s1", name: "alice", url: "https://alice.example/m.json" }] },
};

/**
 * 与拓展页同构的宿主:`installer` 是**页面**那一份,「装完那句话」、失败那几句与第三方
 * 那道确认框都由页面画,市场那一节只出卡与钮。
 *
 * 🔴 这里不许让 `MarketplaceSection` 自己起一份 installer:那条路生产里不存在
 * (`Extensions.tsx` 永远传),照着它写的测试钉住的是一条没人走的路 —— 真路上画不出
 * 那几句话也照样全绿。
 */
function Host() {
	const installer = useMarketplaceInstall();
	return (
		<>
			{installer.errors.length > 0 ? (
				<ErrorNote size="sm">
					{installer.action === "update" ? "更新不了:" : "装不了:"}
					{installer.errors.join(";")}
				</ErrorNote>
			) : null}
			<ExtensionInstallOutcome done={installer.done} />
			<MarketplaceSection installer={installer} />
			<MarketplaceInstallConfirm installer={installer} />
		</>
	);
}

function renderSection(market: MarketplaceResponse = MARKET) {
	apiGetMock.mockImplementation(async (url: string) => {
		if (url.startsWith("/api/ext/marketplace")) return market;
		if (url === "/api/globals") return GLOBALS;
		if (url === "/api/system/restart") return { version: "0.10.1", startedAt: "OLD" };
		throw new Error(`没有这一口:${url}`);
	});
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<Host />
		</QueryClientProvider>,
	);
}

async function cardOf(name: string): Promise<HTMLElement> {
	const card = (await screen.findByText(name)).closest(".bn-glass");
	if (!card) throw new Error(`「${name}」不在一张卡上`);
	return card as HTMLElement;
}

beforeEach(() => {
	apiGetMock.mockReset();
	apiPostMock.mockReset();
	apiPatchMock.mockReset();
	apiPatchMock.mockResolvedValue({});
	apiPostMock.mockResolvedValue({
		id: "bridge",
		name: "机器人框架桥接",
		version: "0.0.2",
		needsRestart: false,
		restart: { can: true, how: "container" },
	});
});

afterEach(() => {
	cleanup();
});

describe("拓展市场", () => {
	it("没装的各画各的:装 / 要升级 BN / 已撤回;官方与来源标清", async () => {
		renderSection();
		const bridge = await cardOf("机器人框架桥接");
		expect(within(bridge).getByText("官方")).toBeTruthy();
		expect(within(bridge).getByRole("button", { name: "安装" })).toBeTruthy();

		expect(within(await cardOf("Bar")).getByText(/先升级 BN/)).toBeTruthy();
		expect(within(await cardOf("Bar")).queryByRole("button")).toBeNull();
		expect(within(await cardOf("Qux")).getByText(/已被撤回/)).toBeTruthy();

		const douyin = await cardOf("抖音订阅");
		expect(within(douyin).getByText("来自 alice")).toBeTruthy();
		expect(within(douyin).queryByText("官方")).toBeNull();
	});

	/**
	 * 🔴 **装了的不在市场里露面**。它已经在上面那一排「已装」的卡里了,同一件东西画两遍
	 * 会让人以为装了两份。更新也没丢:「有新版 vX」+「更新」钮长在已装那张卡上
	 * (`Extensions.tsx`),数据同样来自这份索引。
	 */
	it.each([
		["已装的", "Foo"],
		["别处装的", "Baz"],
	])("%s不出现在市场里", async (_label, name) => {
		renderSection();
		// 等市场画完再断言「没有」—— 没等的话空 DOM 也会让它过。
		await cardOf("机器人框架桥接");
		expect(screen.queryByText(name)).toBeNull();
	});

	it("官方条目一键装:POST source+id,装完那句话与传包装的同一段,列表与市场都重取", async () => {
		renderSection();
		await userEvent.click(
			within(await cardOf("机器人框架桥接")).getByRole("button", { name: "安装" }),
		);
		await waitFor(() =>
			expect(apiPostMock).toHaveBeenCalledWith("/api/ext/marketplace/install", {
				source: "official",
				id: "bridge",
			}),
		);
		expect(await screen.findByText(/装好了/)).toBeTruthy();
	});

	it("第三方条目装之前先确认 —— 取消就不发,确认才发", async () => {
		renderSection();
		await userEvent.click(within(await cardOf("抖音订阅")).getByRole("button", { name: "安装" }));
		const confirm = await screen.findByRole("dialog");
		expect(within(confirm).getByText(/在 BN 进程里跑代码/)).toBeTruthy();
		await userEvent.click(within(confirm).getByRole("button", { name: "取消" }));
		expect(apiPostMock).not.toHaveBeenCalled();

		await userEvent.click(within(await cardOf("抖音订阅")).getByRole("button", { name: "安装" }));
		await userEvent.click(await screen.findByRole("button", { name: /照样装/ }));
		await waitFor(() =>
			expect(apiPostMock).toHaveBeenCalledWith("/api/ext/marketplace/install", {
				source: "s1",
				id: "alice.douyin",
			}),
		);
	});

	it("装不了 → 服务端那句原样摆出来", async () => {
		const { ApiError } = await import("../../../services/api");
		apiPostMock.mockRejectedValueOnce(
			new ApiError(400, { errors: ["下载到的包校验和与索引写的对不上"] }, "400"),
		);
		renderSection();
		await userEvent.click(
			within(await cardOf("机器人框架桥接")).getByRole("button", { name: "安装" }),
		);
		expect(await screen.findByText(/校验和/)).toBeTruthy();
	});

	/**
	 * 🔴 装与更新走同一发请求,失败那句话却不是同一句。一律说「更新不了」的话,从市场装
	 * 一个**没装过**的拓展失败了,主人会去找一个根本不存在的旧版本;反过来一律说「装不了」,
	 * 更新失败时又会让人以为已装的那份也没了。
	 */
	/** 「更新不了」那一半搬去了 `Extensions.render.test.tsx` —— 更新钮现在只长在已装卡上。 */
	it("装砸了说「装不了」", async () => {
		const { ApiError } = await import("../../../services/api");
		apiPostMock.mockRejectedValue(new ApiError(400, { errors: ["下不动"] }, "400"));

		renderSection();
		await userEvent.click(
			within(await cardOf("机器人框架桥接")).getByRole("button", { name: "安装" }),
		);
		expect(await screen.findByText(/装不了:下不动/)).toBeTruthy();
	});

	it("源拿不到 → 那句原因原样摆出来;没有官方源的构建说清楚、还能加源", async () => {
		renderSection({
			...MARKET,
			sources: [
				{
					id: "official",
					name: "官方源",
					official: true,
					ok: false,
					err: "官方索引的签名验不过 —— 内容被改过,或不是我们签的",
				},
			],
			extensions: [],
		});
		expect(await screen.findByText(/签名验不过/)).toBeTruthy();
		cleanup();
		renderSection({ available: false, fetchedAt: 1, sources: [], extensions: [] });
		expect(await screen.findByText(/没有官方源/)).toBeTruthy();
		expect(screen.getByRole("button", { name: /市场源/ })).toBeTruthy();
	});
});

describe("源", () => {
	it("弹窗列官方(不可删)与第三方(可删,名字是索引报的);加源只填地址、先看见风险提示,存的是整份名单", async () => {
		renderSection();
		await userEvent.click(await screen.findByRole("button", { name: /市场源/ }));
		const dialog = await screen.findByRole("dialog");
		expect(within(dialog).getByText("BN 官方拓展")).toBeTruthy();
		// 名字从市场那一口(索引里的 name)来,不是用户起的。
		expect(within(dialog).getByText("alice")).toBeTruthy();
		expect(within(dialog).queryByLabelText("源的名字")).toBeNull();
		expect(within(dialog).getByText("https://alice.example/m.json")).toBeTruthy();
		expect(within(dialog).getByText(/不审核/)).toBeTruthy();

		await userEvent.type(
			within(dialog).getByLabelText("索引地址"),
			"https://bob.example/marketplace.json",
		);
		await userEvent.click(within(dialog).getByRole("button", { name: "加进来" }));
		await waitFor(() => expect(apiPatchMock).toHaveBeenCalledOnce());
		const [path, body] = apiPatchMock.mock.calls[0] as [
			string,
			{ marketplace: { sources: { id: string; name?: string; url: string }[] } },
		];
		expect(path).toBe("/api/globals");
		expect(body.marketplace.sources.map((s) => s.url)).toEqual([
			"https://alice.example/m.json",
			"https://bob.example/marketplace.json",
		]);
		expect(body.marketplace.sources[1]?.id).toBeTruthy();
		expect(body.marketplace.sources[1]?.name).toBeUndefined();
	});

	it("http 地址不收;删掉一个源存的是剩下的名单", async () => {
		renderSection();
		await userEvent.click(await screen.findByRole("button", { name: /市场源/ }));
		const dialog = await screen.findByRole("dialog");
		await userEvent.type(within(dialog).getByLabelText("索引地址"), "http://bob.example/m.json");
		await userEvent.click(within(dialog).getByRole("button", { name: "加进来" }));
		expect(await within(dialog).findByText(/必须是 https/)).toBeTruthy();
		expect(apiPatchMock).not.toHaveBeenCalled();

		await userEvent.click(within(dialog).getByRole("button", { name: /删掉 alice/ }));
		await waitFor(() =>
			expect(apiPatchMock).toHaveBeenCalledWith("/api/globals", { marketplace: { sources: [] } }),
		);
	});
});
