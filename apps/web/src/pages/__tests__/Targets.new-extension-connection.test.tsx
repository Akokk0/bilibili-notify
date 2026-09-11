// @vitest-environment jsdom
/**
 * 从推送目标页的「新建连接」建一条拓展连接 —— **挑一个 bot**(ADR-0012 决策 45)。
 *
 * 主人 2026-09-10:「我希望的是我自己去新建里添加出来」,又说「选择了 koishi / astrbot 就要
 * 决定哪个 bot,而不是在创建推送目标时才选择」—— 与直连同一套操作逻辑:一条连接就是一个
 * bot。跑着的推送源拓展是平台那一排的一档,选了它,底下列出它现在借得到的 bot
 * (`/api/ext/:id/bots`),挑中的那个:config 原样落进连接、平台从它身上抄、名字补进显示名。
 */

import type { ExtensionsResponse } from "@bilibili-notify/contract";
import { PlatformMetaProvider } from "@bilibili-notify/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { buildPlatformTable } from "../../components/platform-meta";
import Targets from "../Targets";

vi.mock("../../services/api", () => ({
	api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
	ApiError: class extends Error {},
}));

import { api } from "../../services/api";

const BRIDGE: ExtensionsResponse["extensions"][number] = {
	id: "bridge",
	name: "机器人框架桥接",
	enabled: true,
	state: "running",
	provides: ["push"],
	dir: "/data/extensions/bridge",
	descriptor: {
		label: "机器人框架桥接",
		shortLabel: "桥接",
		tint: "#a855f7",
		targetKind: "session",
		scopes: ["private", "group"],
		addressNouns: {},
		inbound: true,
		atAll: false,
	},
	// 桥的字段表是空的:连接是挑出来的,没有一栏是人填的。
	configFields: [],
};

const ICON = "data:image/png;base64,QUJD";

const BOTS = [
	{
		config: { link: "link-home", botId: "onebot:2854196310" },
		platform: "onebot",
		name: "阿库娅",
		selfId: "2854196310",
		via: "家里那台",
	},
	{
		config: { link: "link-home", botId: "telegram:7777" },
		platform: "telegram",
		name: "小电视",
		selfId: "7777",
		icon: ICON,
		via: "家里那台",
	},
];

const EXISTING_ID = "11111111-1111-4111-8111-111111111111";

/** 已经绑成连接的那个 bot(名单里带 `boundTo`)。 */
const EXISTING = {
	id: EXISTING_ID,
	name: "小电视",
	enabled: true,
	kind: "extension",
	extensionId: "bridge",
	platform: "telegram",
	config: { link: "link-home", botId: "telegram:7777" },
};

/** `bots` 传 `null` = 拓展没跑起来,那一口 404。 */
function renderPage(opts: { bots?: unknown; connections?: unknown[] } = {}) {
	const bots = "bots" in opts ? opts.bots : { bots: BOTS };
	vi.mocked(api.get).mockImplementation(async (url: string) => {
		if (url === "/api/ext") return { extensions: [BRIDGE] };
		if (url === "/api/connections") return opts.connections ?? [];
		if (url === "/api/ext/bridge/bots") {
			if (bots === null) throw new Error("not found");
			return bots;
		}
		return [];
	});
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<PlatformMetaProvider value={buildPlatformTable([BRIDGE])}>
			<QueryClientProvider client={qc}>
				<Targets />
			</QueryClientProvider>
		</PlatformMetaProvider>,
	);
}

async function openNewConnection(
	opts: Parameters<typeof renderPage>[0] = {},
): Promise<HTMLElement> {
	renderPage(opts);
	// 一条连接都没有时中间那张卡上是「+ 新建连接」;有连接时只剩左栏那颗「+ 新建」。
	fireEvent.click((await screen.findAllByRole("button", { name: /\+ 新建/ }))[0] as HTMLElement);
	const dialog = await screen.findByRole("dialog");
	fireEvent.click(await within(dialog).findByRole("button", { name: /机器人框架桥接/ }));
	return dialog;
}

beforeEach(() => {
	vi.mocked(api.post).mockResolvedValue([]);
	vi.mocked(api.put).mockResolvedValue([]);
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("新建连接里的拓展那一档", () => {
	it("跑着的推送源拓展出现在平台那一排", async () => {
		renderPage();
		fireEvent.click((await screen.findAllByRole("button", { name: /新建连接/ }))[0] as HTMLElement);
		const dialog = await screen.findByRole("dialog");
		expect(await within(dialog).findByRole("button", { name: /机器人框架桥接/ })).toBeTruthy();
	});

	it("没跑起来的不出现 —— 它的 descriptor 是 activate 里才报的", async () => {
		vi.mocked(api.get).mockImplementation(async (url: string) => {
			if (url === "/api/ext") {
				return {
					extensions: [
						{
							...BRIDGE,
							state: "disabled",
							enabled: false,
							descriptor: undefined,
							configFields: undefined,
						},
					],
				};
			}
			return [];
		});
		const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		render(
			<PlatformMetaProvider value={buildPlatformTable([])}>
				<QueryClientProvider client={qc}>
					<Targets />
				</QueryClientProvider>
			</PlatformMetaProvider>,
		);
		fireEvent.click((await screen.findAllByRole("button", { name: /新建连接/ }))[0] as HTMLElement);
		const dialog = await screen.findByRole("dialog");
		expect(within(dialog).queryByRole("button", { name: /机器人框架桥接/ })).toBeNull();
	});

	it("选了它,列出它现在借得到的 bot(带平台 / 经谁借的 / 桥给的图标);没挑之前存不了", async () => {
		const dialog = await openNewConnection();
		expect(await within(dialog).findByRole("button", { name: /阿库娅/ })).toBeTruthy();
		const tv = within(dialog).getByRole("button", { name: /小电视/ });
		expect(tv.textContent).toMatch(/telegram/);
		expect(tv.textContent).toMatch(/经 家里那台/);
		expect(tv.querySelector("img")?.getAttribute("src")).toBe(ICON);
		// 字段表是空的 —— 「连接参数」那一节不画
		expect(within(dialog).queryByText("连接参数")).toBeNull();
		expect(
			(within(dialog).getByRole("button", { name: "保存" }) as HTMLButtonElement).disabled,
		).toBe(true);
		expect(dialog.textContent).toMatch(/先挑一个 bot/);
	});

	it("挑中一个:显示名补成它的名字,存下去的连接带它的平台、config 原样", async () => {
		const dialog = await openNewConnection();
		fireEvent.click(await within(dialog).findByRole("button", { name: /小电视/ }));
		expect((within(dialog).getByPlaceholderText(/NapCat/) as HTMLInputElement).value).toBe(
			"小电视",
		);
		fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
		await waitFor(() => expect(api.post).toHaveBeenCalled());
		const [url, body] = vi.mocked(api.post).mock.calls[0] as [string, Record<string, unknown>];
		expect(url).toBe("/api/connections");
		expect(body).toMatchObject({
			kind: "extension",
			extensionId: "bridge",
			name: "小电视",
			platform: "telegram",
			enabled: true,
			config: { link: "link-home", botId: "telegram:7777" },
		});
	});

	it("主人自己填了名字就不盖掉", async () => {
		const dialog = await openNewConnection();
		fireEvent.change(within(dialog).getByPlaceholderText(/NapCat/), {
			target: { value: "电报那台" },
		});
		fireEvent.click(await within(dialog).findByRole("button", { name: /小电视/ }));
		expect((within(dialog).getByPlaceholderText(/NapCat/) as HTMLInputElement).value).toBe(
			"电报那台",
		);
	});

	/** 同一个 bot 建两条连接只会让目标各推一遍 —— 已经绑成连接的标出来、不给点。 */
	it("已经绑成别的连接的 bot 标「已加过」,点不了", async () => {
		const dialog = await openNewConnection({
			bots: { bots: [BOTS[0], { ...BOTS[1], boundTo: EXISTING_ID }] },
			connections: [EXISTING],
		});
		const tv = (await within(dialog).findByRole("button", { name: /小电视/ })) as HTMLButtonElement;
		expect(tv.disabled).toBe(true);
		expect(tv.textContent).toMatch(/已加过/);
		expect(
			(within(dialog).getByRole("button", { name: /阿库娅/ }) as HTMLButtonElement).disabled,
		).toBe(false);
	});

	it("桥没连上(一个 bot 都没有)要说出来,不是一片空白", async () => {
		const dialog = await openNewConnection({ bots: { bots: [] } });
		expect(await within(dialog).findByText(/一个 bot 都没有/)).toBeTruthy();
	});

	it("拓展没跑起来(问不到 bot)也要说出来", async () => {
		const dialog = await openNewConnection({ bots: null });
		expect(await within(dialog).findByText(/没跑起来/)).toBeTruthy();
	});

	/** 改一条已有的:它现在绑的那个高亮;桥没连着、名单里没它时也要画出来,别像没绑过。 */
	it("改一条已有的拓展连接:绑着的那个是选中态;名单里没它时照画一行", async () => {
		renderPage({
			bots: { bots: [BOTS[0], { ...BOTS[1], boundTo: EXISTING_ID }] },
			connections: [EXISTING],
		});
		fireEvent.click((await screen.findAllByRole("button", { name: "配置" }))[0] as HTMLElement);
		const dialog = await screen.findByRole("dialog");
		expect(dialog.textContent).toContain("配置连接");
		const tv = await within(dialog).findByRole("button", { name: /小电视/ });
		expect(tv.getAttribute("data-bn")).toBe("option option-active");
		expect(tv.textContent).toMatch(/已选/);
		cleanup();

		renderPage({ bots: { bots: [] }, connections: [EXISTING] });
		fireEvent.click((await screen.findAllByRole("button", { name: "配置" }))[0] as HTMLElement);
		const dialog2 = await screen.findByRole("dialog");
		expect(await within(dialog2).findByText(/现在绑着的那个/)).toBeTruthy();
		expect(dialog2.textContent).toMatch(/不在线/);
	});
});
