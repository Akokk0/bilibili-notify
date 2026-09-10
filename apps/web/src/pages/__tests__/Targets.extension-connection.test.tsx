// @vitest-environment jsdom
/**
 * 拓展提供的连接(桥)上建推送目标。
 *
 * 🔴 此前点「新建推送目标」**没反应**:`makeEmptyTarget` 对拓展连接直接 `throw`(注释写着
 * 「眼下面板还建不出拓展连接,这条路不可达」—— 拓展页落地之后它可达了),异常抛在点击处理
 * 器里,界面上什么都不发生、控制台一行红。主人 2026-09-10 报的就是这个。
 *
 * 拓展连接上的目标要绑到**某个 bot** 上(一条桥后面可能挂着好几个),bot 只有拓展知道 ——
 * 它经 `/api/ext/:id/bots/:connectionId` 交上来,这里列给主人挑,挑中的 `botId` 与 `platform`
 * 落进目标。
 */

import { PlatformMetaProvider } from "@bilibili-notify/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { buildPlatformTable } from "../../components/platform-meta";
import type { Connection } from "../../types/domain";
import Targets from "../Targets";

vi.mock("../../services/api", () => ({
	api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
	ApiError: class extends Error {},
}));

import { api } from "../../services/api";

const LINK_ID = "11111111-1111-4111-8111-111111111111";

const LINK = {
	id: LINK_ID,
	name: "Koishi",
	enabled: true,
	kind: "extension",
	extensionId: "bridge",
	config: { token: "0123456789abcdef0123456789abcdef", bridgeKind: "koishi" },
} as unknown as Connection;

const BOTS = [
	{ botId: "onebot:2854196310", platform: "onebot", name: "阿库娅", selfId: "2854196310" },
	{ botId: "telegram:7777", platform: "telegram", name: "小电视", selfId: "7777" },
];

function renderPage(bots: unknown = { bots: BOTS }) {
	vi.mocked(api.get).mockImplementation(async (url: string) => {
		if (url === "/api/connections") return [LINK];
		if (url === "/api/targets") return [];
		if (url === `/api/ext/bridge/bots/${LINK_ID}`) {
			if (bots === null) throw new Error("not found");
			return bots;
		}
		return [];
	});
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<PlatformMetaProvider value={buildPlatformTable([])}>
			<QueryClientProvider client={qc}>
				<Targets />
			</QueryClientProvider>
		</PlatformMetaProvider>,
	);
}

async function openNewTarget(bots?: unknown): Promise<HTMLElement> {
	renderPage(bots);
	await screen.findAllByText("Koishi");
	// 右上那颗;空态卡上还有一颗同名的,按钮取第一颗
	fireEvent.click(screen.getAllByRole("button", { name: /新建推送目标/ })[0] as HTMLElement);
	return screen.findByRole("dialog");
}

beforeEach(() => {
	vi.mocked(api.post).mockResolvedValue([]);
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("拓展连接上建目标", () => {
	it("点「新建推送目标」弹窗真的打开 —— 不再在点击处理器里炸掉", async () => {
		const dialog = await openNewTarget();
		expect(dialog.textContent).toContain("新建推送目标");
	});

	it("列出这条连接上的 bot 让主人挑,挑中的 bot 与它的平台一起落进目标", async () => {
		const dialog = await openNewTarget();
		fireEvent.click(await within(dialog).findByRole("button", { name: /小电视/ }));
		fireEvent.change(within(dialog).getByPlaceholderText(/游戏交流群/), {
			target: { value: "电报群" },
		});
		// 挑了 telegram 的 bot,地址那一格就是 telegram 的会话地址(认不出的平台走通用称呼)
		const address = within(dialog).getByPlaceholderText(/的 id/);
		fireEvent.change(address, { target: { value: "-1001234567890" } });
		fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
		await waitFor(() => expect(api.post).toHaveBeenCalled());
		const [url, body] = vi.mocked(api.post).mock.calls[0] as [string, Record<string, unknown>];
		expect(url).toBe("/api/targets");
		expect(body).toMatchObject({
			connectionId: LINK_ID,
			kind: "session",
			platform: "telegram",
			botId: "telegram:7777",
			scope: "group",
			address: "-1001234567890",
		});
	});

	/** 没挑 bot 的目标发出去也发不到任何地方 —— 保存钮灰着,而且说清楚为什么。 */
	it("没挑 bot 之前存不了", async () => {
		const dialog = await openNewTarget();
		await within(dialog).findByRole("button", { name: /小电视/ });
		fireEvent.change(within(dialog).getByPlaceholderText(/游戏交流群/), {
			target: { value: "电报群" },
		});
		expect(
			(within(dialog).getByRole("button", { name: "保存" }) as HTMLButtonElement).disabled,
		).toBe(true);
		expect(dialog.textContent).toMatch(/先挑一个 bot/);
	});

	it("桥没连上(一个 bot 都没有)要说出来,不是一片空白", async () => {
		const dialog = await openNewTarget({ bots: [] });
		expect(await within(dialog).findByText(/一个 bot 都没有/)).toBeTruthy();
	});

	it("拓展没跑起来(问不到 bot)也要说出来", async () => {
		const dialog = await openNewTarget(null);
		expect(await within(dialog).findByText(/没跑起来/)).toBeTruthy();
	});
});
