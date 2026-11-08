// @vitest-environment jsdom
import { i18n } from "../../i18n";
import {
	builtinAdapters,
	builtinCandidatesResponse,
} from "../../types/__tests__/connection-fixtures";
/**
 * 从推送目标页的「新建连接」建一条拓展连接 —— **挑一个 bot**(ADR-0012 决策 45)。
 *
 * 主人 2026-09-10:「我希望的是我自己去新建里添加出来」,又说「选择了 koishi / astrbot 就要
 * 决定哪个 bot,而不是在创建推送目标时才选择」—— 与直连同一套操作逻辑:一条连接就是一个
 * bot。跑着的推送源拓展是平台那一排的一档,选了它,底下列出它现在借得到的 bot
 * (`/api/adapters/:id/candidates`),挑中的那个:settings 原样落进连接、平台取 candidate.platform.platform、名字补进显示名。
 */

import type { ExtensionsResponse } from "@bilibili-notify/contract";
import { PlatformMetaProvider } from "@bilibili-notify/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { snapshotFor } from "../../__tests__/platform-snapshot";
import { buildPlatformTable } from "../../components/platform-meta";
import { handleStateEnvelope } from "../../hooks/useStateChannel";
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
};
const BRIDGE_ADAPTER = {
	key: "bridge",
	descriptor: {
		label: "机器人框架桥接",
		shortLabel: "桥接",
		color: "#a855f7",
		// 桥的连接配置项是空的:连接是挑出来的,没有一栏是人填的。
		settingsFields: [],
	},
	has: { connectionAuth: false, listAddressCandidates: false },
};

const ICON = "data:image/png;base64,QUJD";

const BOTS = [
	{
		name: "阿库娅",
		platform: { platform: "onebot", ...snapshotFor("onebot") },
		settings: { link: "link-home", botId: "onebot:2854196310" },
		selfId: "2854196310",
		via: "家里那台",
	},
	{
		name: "小电视",
		platform: { platform: "telegram", ...snapshotFor("telegram"), icon: ICON },
		settings: { link: "link-home", botId: "telegram:7777" },
		selfId: "7777",
		via: "家里那台",
	},
];

const EXISTING_ID = "11111111-1111-4111-8111-111111111111";

/** 已经绑成连接的那个 bot(候选里带 `boundConnectionId`)。 */
const EXISTING = {
	id: EXISTING_ID,
	name: "小电视",
	enabled: true,
	adapterKey: "bridge",
	platform: "telegram",
	platformSnapshot: snapshotFor("telegram"),
	settings: { link: "link-home", botId: "telegram:7777" },
};

/** `bots` 传 `null` = 拓展没跑起来,那一口 404。 */
function renderPage(opts: { bots?: unknown; connections?: unknown[] } = {}) {
	const bots = "bots" in opts ? opts.bots : { candidates: BOTS };
	vi.mocked(api.get).mockImplementation(async (url: string) => {
		if (url === "/api/adapters") return { adapters: [...builtinAdapters, BRIDGE_ADAPTER] };
		const candidates = builtinCandidatesResponse(url);
		if (candidates) return candidates;
		if (url === "/api/ext") return { extensions: [BRIDGE] };
		if (url === "/api/connections") return opts.connections ?? [];
		if (url === "/api/adapters/bridge/candidates") {
			if (bots === null) throw new Error("not found");
			return bots;
		}
		return [];
	});
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const invalidate = vi.spyOn(qc, "invalidateQueries");
	render(
		<PlatformMetaProvider value={buildPlatformTable([BRIDGE_ADAPTER])}>
			<QueryClientProvider client={qc}>
				<MemoryRouter>
					<Targets />
				</MemoryRouter>
			</QueryClientProvider>
		</PlatformMetaProvider>,
	);
	return { qc, invalidate };
}

/** 这一发失效碰过 `["extension-bots", …]` 没有(整个前缀或某个拓展都算)。 */
function invalidatedBots(invalidate: { mock: { calls: unknown[][] } }): boolean {
	return invalidate.mock.calls.some(
		(args) => (args[0] as { queryKey?: unknown[] } | undefined)?.queryKey?.[0] === "extension-bots",
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

	/**
	 * 清单读不出来的(版本不合):问不出外观与连接配置项(`push` 缺着)。停着的、清单读得懂的照清单交了
	 * `push`、照样不出现 —— 那条在 `Targets.stopped-extension.test.tsx`。
	 */
	it("没跑起来、也没交 push 的不出现", async () => {
		vi.mocked(api.get).mockImplementation(async (url: string) => {
			if (url === "/api/adapters") return { adapters: [...builtinAdapters, BRIDGE_ADAPTER] };
			const candidates = builtinCandidatesResponse(url);
			if (candidates) return candidates;
			if (url === "/api/ext") {
				return {
					extensions: [
						{
							...BRIDGE,
							state: "disabled",
							enabled: false,
							push: undefined,
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
					<MemoryRouter>
						<Targets />
					</MemoryRouter>
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
		expect(dialog.textContent).toMatch(/先挑一个连接候选/);
	});

	/**
	 * bot 的图标是拓展(说到底是桥那头的插件)交来的 —— 画之前要过面板出口那道闸(`safeImage`,与
	 * 声明式积木同一份判据):一个 `https://` 地址当 `<img src>` 画,面板一开就去对家点名。不合格的
	 * 当它没有,退回平台图标。
	 */
	it("不合格的 bot 图标(外链 / 超长)不进 <img src>,退回平台图标", async () => {
		const REMOTE = "https://tracker.example/pixel.png";
		const HUGE = `data:image/png;base64,${"A".repeat(40 * 1024)}`;
		const dialog = await openNewConnection({
			bots: {
				candidates: [
					{ ...BOTS[0], platform: { ...BOTS[0].platform, icon: REMOTE } },
					{ ...BOTS[1], platform: { ...BOTS[1].platform, icon: HUGE } },
				],
			},
		});
		for (const name of [/阿库娅/, /小电视/]) {
			const row = await within(dialog).findByRole("button", { name });
			expect(row.querySelector("img")).toBeNull();
			// 兜底那枚平台图标照画(`PlatformIcon`:图标表里那枚 svg,或首字方章)—— 行首不能空出一块。
			expect(["svg", "span"]).toContain(row.firstElementChild?.tagName.toLowerCase());
		}
		const srcs = [...dialog.querySelectorAll("img")].map((img) => img.getAttribute("src"));
		expect(srcs).not.toContain(REMOTE);
		expect(srcs).not.toContain(HUGE);
	});

	it("挑中一个:显示名补成它的名字,存下去的连接带它的平台、settings 原样", async () => {
		const dialog = await openNewConnection();
		fireEvent.click(await within(dialog).findByRole("button", { name: /小电视/ }));
		expect((within(dialog).getByPlaceholderText(/家里的机器人/) as HTMLInputElement).value).toBe(
			"小电视",
		);
		fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
		await waitFor(() => expect(api.post).toHaveBeenCalled());
		const [url, body] = vi.mocked(api.post).mock.calls[0] as [string, Record<string, unknown>];
		expect(url).toBe("/api/connections");
		expect(body).toMatchObject({
			adapterKey: "bridge",
			name: "小电视",
			platform: "telegram",
			enabled: true,
			settings: { link: "link-home", botId: "telegram:7777" },
		});
	});

	it("主人自己填了名字就不盖掉", async () => {
		const dialog = await openNewConnection();
		fireEvent.change(within(dialog).getByPlaceholderText(/家里的机器人/), {
			target: { value: "电报那台" },
		});
		fireEvent.click(await within(dialog).findByRole("button", { name: /小电视/ }));
		expect((within(dialog).getByPlaceholderText(/家里的机器人/) as HTMLInputElement).value).toBe(
			"电报那台",
		);
	});

	/** 同一个 bot 建两条连接只会让目标各推一遍 —— 已经绑成连接的标出来、不给点。 */
	it("已经绑成别的连接的 bot 标「已加过」,点不了", async () => {
		const dialog = await openNewConnection({
			bots: { candidates: [BOTS[0], { ...BOTS[1], boundConnectionId: EXISTING_ID }] },
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
		const dialog = await openNewConnection({ bots: { candidates: [] } });
		expect(await within(dialog).findByText(/暂时没有连接候选/)).toBeTruthy();
	});

	it("拓展没跑起来(问不到 bot)也要说出来", async () => {
		const dialog = await openNewConnection({ bots: null });
		expect(await within(dialog).findByText(/暂时读不到连接候选/)).toBeTruthy();
	});

	/** 改一条已有的:它现在绑的那个高亮;桥没连着、名单里没它时也要画出来,别像没绑过。 */
	it("改一条已有的拓展连接:绑着的那个是选中态;名单里没它时照画一行", async () => {
		renderPage({
			bots: { candidates: [BOTS[0], { ...BOTS[1], boundConnectionId: EXISTING_ID }] },
			connections: [EXISTING],
		});
		fireEvent.click((await screen.findAllByRole("button", { name: "配置" }))[0] as HTMLElement);
		const dialog = await screen.findByRole("dialog");
		expect(dialog.textContent).toContain("配置连接");
		const tv = await within(dialog).findByRole("button", { name: /小电视/ });
		expect(tv.getAttribute("data-bn")).toBe("option option-active");
		expect(tv.textContent).toMatch(/已选/);
		cleanup();

		renderPage({ bots: { candidates: [] }, connections: [EXISTING] });
		fireEvent.click((await screen.findAllByRole("button", { name: "配置" }))[0] as HTMLElement);
		const dialog2 = await screen.findByRole("dialog");
		expect(await within(dialog2).findByText(/^当前连接$/)).toBeTruthy();
		expect(dialog2.textContent).toMatch(/当前设置与候选不同/);
	});

	/**
	 * 🔴 **改连接时不许换平台。** 连接的平台是底下那些推送目标的平台,而目标不会跟着改 ——
	 * 挑一个别的平台的 bot,那些目标就原地变成「telegram 的地址挂在 onebot 连接上」,
	 * 服务端那头会拒,面板这头却一路绿灯。要换 bot 换到别的平台去,那是另一条连接。
	 */
	it("改连接时别的平台的 bot 挑不动,并说清换平台要重建连接", async () => {
		renderPage({
			bots: { candidates: [BOTS[0], { ...BOTS[1], boundConnectionId: EXISTING_ID }] },
			connections: [EXISTING],
		});
		fireEvent.click((await screen.findAllByRole("button", { name: "配置" }))[0] as HTMLElement);
		const dialog = await screen.findByRole("dialog");
		// 现在绑的是 telegram 的小电视;阿库娅是 onebot
		const other = (await within(dialog).findByRole("button", {
			name: /阿库娅/,
		})) as HTMLButtonElement;
		expect(other.disabled).toBe(true);
		expect(other.textContent).toMatch(/换平台要重建连接/);
		// 同平台的那个(它自己)照样挑得动
		expect(
			(within(dialog).getByRole("button", { name: /小电视/ }) as HTMLButtonElement).disabled,
		).toBe(false);
	});

	/** 新建时没有「底下已挂的目标」这回事 —— 那一档不该拦。 */
	it("新建连接时各平台的 bot 都挑得动", async () => {
		const dialog = await openNewConnection();
		expect(
			((await within(dialog).findByRole("button", { name: /阿库娅/ })) as HTMLButtonElement)
				.disabled,
		).toBe(false);
		expect(
			(within(dialog).getByRole("button", { name: /小电视/ }) as HTMLButtonElement).disabled,
		).toBe(false);
	});

	/**
	 * 🔴 桥那头握完手 / 断了,拓展喊一声 `statusChanged`,WS 按这个拓展的 bot 名单那个键失效。
	 * 这一排读的键与那边失效的键对不上的话,名单停在打开弹窗那一刻 —— 而且不会有任何报错。
	 */
	it("拓展喊了「面板数据变了」→ 开着的 bot 名单当场重取", async () => {
		const { qc } = renderPage();
		fireEvent.click((await screen.findAllByRole("button", { name: /\+ 新建/ }))[0] as HTMLElement);
		const dialog = await screen.findByRole("dialog");
		fireEvent.click(await within(dialog).findByRole("button", { name: /机器人框架桥接/ }));
		await within(dialog).findByRole("button", { name: /小电视/ });
		const asked = () =>
			vi.mocked(api.get).mock.calls.filter(([url]) => url === "/api/adapters/bridge/candidates")
				.length;
		const before = asked();

		act(() =>
			handleStateEnvelope(
				{
					type: "state",
					event: "extension-status-changed",
					ts: "",
					data: { extensionId: "bridge" },
				},
				qc,
			),
		);

		await waitFor(() => expect(asked()).toBe(before + 1));
	});
});

/**
 * 🔴 bot 名单有 5 秒 `staleTime`。存 / 删一条拓展连接之后候选里的 `boundConnectionId` 就变了,不失效
 * 那条键的话,5 秒内再开一次弹窗读到的还是旧名单 —— 刚绑走的那个仍然「挑得动」,于是同一个
 * bot 建出两条连接,每条推一遍。
 */
describe("连接动过之后的 bot 名单", () => {
	it("存下一条拓展连接就把 bot 名单作废", async () => {
		const { invalidate } = renderPage();
		fireEvent.click((await screen.findAllByRole("button", { name: /\+ 新建/ }))[0] as HTMLElement);
		const dialog = await screen.findByRole("dialog");
		fireEvent.click(await within(dialog).findByRole("button", { name: /机器人框架桥接/ }));
		fireEvent.click(await within(dialog).findByRole("button", { name: /小电视/ }));
		fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
		await waitFor(() => expect(api.post).toHaveBeenCalled());
		await waitFor(() => expect(invalidatedBots(invalidate)).toBe(true));
	});

	it("删掉一条拓展连接也把 bot 名单作废 —— 那个 bot 该重新挑得动", async () => {
		const { invalidate } = renderPage({ connections: [EXISTING] });
		fireEvent.click((await screen.findAllByRole("button", { name: "删除" }))[0] as HTMLElement);
		const dialog = await screen.findByRole("dialog");
		fireEvent.click(within(dialog).getByRole("button", { name: "确认移除" }));
		await waitFor(() => expect(api.delete).toHaveBeenCalled());
		await waitFor(() => expect(invalidatedBots(invalidate)).toBe(true));
	});
});

// These scenarios assert Chinese UI labels explicitly.
beforeEach(() => i18n.set({ locale: "zh-CN", voice: "plain" }));

it("translated candidate states retain the current platform, selected bot and edited name", async () => {
	i18n.set({ locale: "en", voice: "plain" });
	renderPage({
		connections: [{ ...EXISTING, settings: { link: "old-link", botId: "telegram:old" } }],
		bots: {
			candidates: [
				...BOTS,
				{
					...BOTS[1],
					name: "已占用的原名称",
					settings: { link: "other-link", botId: "telegram:taken" },
					boundConnectionId: "22222222-2222-4222-8222-222222222222",
				},
			],
		},
	});
	fireEvent.click(await screen.findByRole("button", { name: "Configure" }));
	const dialog = await screen.findByRole("dialog");
	await within(dialog).findByRole("button", { name: /已占用的原名称/ });
	const name = within(dialog).getByDisplayValue("小电视");
	fireEvent.change(name, { target: { value: "原草稿名称" } });
	for (const [locale, current, different, taken, selected] of [
		[
			"en",
			"Current connection",
			"Changing platforms requires a new connection",
			"Already added",
			"Selected",
		],
		["ja", "現在の接続", "プラットフォームを変えるには接続を新規作成", "追加済み", "選択中"],
		["zh-TW", "目前連線", "更換平台需重建連線", "已新增", "已選取"],
	] as const) {
		act(() => i18n.set({ locale }));
		if (locale === "en") expect(within(dialog).getByText(current)).toBeTruthy();
		expect(
			within(dialog)
				.getByRole("button", { name: /阿库娅/ })
				.hasAttribute("disabled"),
		).toBe(true);
		expect(within(dialog).getByText(different)).toBeTruthy();
		expect(
			within(dialog)
				.getByRole("button", { name: /已占用的原名称/ })
				.hasAttribute("disabled"),
		).toBe(true);
		expect(within(dialog).getByText(taken)).toBeTruthy();
		if (locale === "en") fireEvent.click(within(dialog).getByRole("button", { name: /小电视/ }));
		expect(within(dialog).getByText(selected)).toBeTruthy();
		expect(within(dialog).getByDisplayValue("原草稿名称")).toBe(name);
		expect(api.post).not.toHaveBeenCalled();
		expect(api.put).not.toHaveBeenCalled();
	}
	fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
	await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
	expect(api.post).not.toHaveBeenCalled();
});
