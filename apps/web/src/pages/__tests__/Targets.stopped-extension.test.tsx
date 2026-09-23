// @vitest-environment jsdom
/**
 * 拓展停着时,推送目标页上它借来的连接(ADR-0019 决策 41)。
 *
 * v2 的外观(短名 / 标识色 / 图标)与连接配置项写在清单里,服务端**跑没跑都给**
 * (`ExtensionDTO.push`)—— 拓展一停,它借来的连接不该退成灰方章。只有要拓展在场的东西
 * 跟着「在跑」:新建一条它的连接(连接就是一个 bot,得挑)与挑 bot 本身。
 *
 * 走真的 `PlatformMetaRoot`:脸是从 `/api/ext` 经那张表喂给组件库的,手搭一张表等于替
 * 接线把答案写好了。
 */

import type { ExtensionsResponse } from "@bilibili-notify/contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { PlatformMetaRoot } from "../../components/platform-meta";
import Targets from "../Targets";

vi.mock("../../services/api", () => ({
	api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
	ApiError: class extends Error {},
}));

import { api } from "../../services/api";

/** 停着的 v2 桥:`push` 是服务端照清单给的,跟跑着时一模一样。 */
const STOPPED_BRIDGE: ExtensionsResponse["extensions"][number] = {
	id: "bridge",
	name: "机器人框架桥接",
	enabled: false,
	state: "disabled",
	apiVersion: 2,
	provides: ["push"],
	dir: "/data/extensions/bridge",
	push: {
		display: { label: "机器人框架桥接", shortLabel: "桥接", color: "#a855f7" },
		connectionFields: [],
	},
};

/** 桥借来的一个 telegram bot —— telegram 不在内置平台表里,脸落回拓展自己那张。 */
const CONNECTION = {
	id: "11111111-1111-4111-8111-111111111111",
	name: "小电视",
	enabled: true,
	kind: "extension",
	extensionId: "bridge",
	platform: "telegram",
	config: { link: "link-home", botId: "telegram:7777" },
};

/** 桥的标识色经 jsdom 规范化之后的写法。 */
const BRIDGE_TINT = "rgb(168, 85, 247)";

function renderPage(opts: { extension?: unknown; connections?: unknown[] } = {}) {
	vi.mocked(api.get).mockImplementation(async (url: string) => {
		if (url === "/api/ext") {
			return {
				extensions: [opts.extension ?? STOPPED_BRIDGE],
				restart: { can: true, how: "container" },
			};
		}
		if (url === "/api/connections") return opts.connections ?? [CONNECTION];
		if (url === "/api/targets") return [];
		if (url.startsWith("/api/ext/bridge/bots")) throw new Error("not found");
		return [];
	});
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(
		<QueryClientProvider client={qc}>
			<PlatformMetaRoot>
				<Targets />
			</PlatformMetaRoot>
		</QueryClientProvider>,
	);
}

/** 画成拓展那张脸的方章:首字 + 标识色的底(停着的桥这里没给图标,退首字方章)。 */
function tintedBadges(): HTMLElement[] {
	return [...document.querySelectorAll<HTMLElement>("span")].filter(
		(el) => el.style.background === BRIDGE_TINT && el.textContent === "桥",
	);
}

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("停着的 v2 拓展借来的连接", () => {
	it("连接卡照清单画脸:短名与标识色,不退灰方章", async () => {
		renderPage();
		// 左栏那一格的副标题写短名(选中那格的方章吃 currentColor,颜色看右边详情头)
		expect(await screen.findByText(/桥接 · 0 个目标/)).toBeTruthy();
		expect(tintedBadges().length).toBeGreaterThanOrEqual(1);
		expect(screen.getByText(/经 桥接/)).toBeTruthy();
	});

	/**
	 * 🔴 `push` 停着也有了,「有 `push`」不再意味着它在场。新建一条它的连接要挑 bot,而 bot
	 * 名单只有跑着的交得出来 —— 停着给这一档,点进去是条死路(一个 bot 都挑不了、存不了)。
	 */
	it("「新建连接」那一排不给它 —— 连接就是一个 bot,挑 bot 要它在场", async () => {
		renderPage({ connections: [] });
		fireEvent.click((await screen.findAllByRole("button", { name: /新建连接/ }))[0] as HTMLElement);
		const dialog = await screen.findByRole("dialog");
		// 等内置那几档画出来再断言「没有」,别在什么都还没渲染时空跑。
		await within(dialog).findByRole("button", { name: /OneBot/ });
		expect(within(dialog).queryByRole("button", { name: /机器人框架桥接/ })).toBeNull();
	});
});

describe("停着时改一条它的连接", () => {
	async function openEditor(extension?: unknown): Promise<HTMLElement> {
		renderPage(extension ? { extension } : {});
		fireEvent.click((await screen.findAllByRole("button", { name: "配置" }))[0] as HTMLElement);
		return screen.findByRole("dialog");
	}

	/** 弹窗里说「经谁借来的」用的是清单里的全名,不是拓展 id —— 外观停着也在。 */
	it("小标题照清单写它的名字", async () => {
		const dialog = await openEditor();
		expect(dialog.textContent).toContain("经 机器人框架桥接 借来的");
		expect(dialog.textContent).not.toContain("经 bridge");
	});

	/** 挑 bot 要它在场:停着不去问名单(问了也是 404),直接说它没跑起来。 */
	it("挑 bot 那一节说它没跑起来,也不去问 bot 名单", async () => {
		const dialog = await openEditor();
		expect(await within(dialog).findByText(/没跑起来/)).toBeTruthy();
		const asked = vi.mocked(api.get).mock.calls.some(([url]) => String(url).includes("/bots"));
		expect(asked).toBe(false);
	});

	/**
	 * 连接配置项写在清单里、值存在 BN 这边,改它不要拓展在场 —— 同拓展关着时设置照样能改
	 * (ADR-0019 决策 32)。停着就不画的话,那几格在拓展起来之前改不了。
	 */
	it("连接配置项照清单画,停着也改得了", async () => {
		const dialog = await openEditor({
			...STOPPED_BRIDGE,
			push: {
				display: STOPPED_BRIDGE.push?.display,
				connectionFields: [{ type: "string", key: "room", label: "房间" }],
			},
		});
		expect(within(dialog).getByText("连接参数")).toBeTruthy();
		expect(within(dialog).getByText("房间")).toBeTruthy();
	});
});
