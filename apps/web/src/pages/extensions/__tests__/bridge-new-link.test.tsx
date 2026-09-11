// @vitest-environment jsdom
/**
 * 新建一条桥接入。
 *
 * 🔴 这一步的产出**不是「面板上多了一张卡」**,而是主人手上多了**要填进插件的两样东西**:
 * BN 地址与 token。此前它们分居两处 —— 地址在页顶、token 建完只剩掩码 —— 而这两样是
 * 一对,少一样连不上。所以新建这一刻要把它们摆在一起、都能复制。
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../../../services/api", () => ({
	api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
	ApiError: class extends Error {},
}));

import { api } from "../../../services/api";
import { BridgeConnections } from "../bridge-panel";

/** 接入住桥的设置里(`globals.extensions.bridge.settings.links`),不在连接表里。 */
function globalsWith(links: unknown[]) {
	return { extensions: { bridge: { enabled: true, settings: { links } } } };
}

function renderPanel() {
	vi.mocked(api.get).mockImplementation(async (path: string) => {
		if (path === "/api/globals") return globalsWith([]);
		throw new Error("拓展没跑起来");
	});
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<BridgeConnections extensionId="bridge" enabled />
		</QueryClientProvider>,
	);
}

async function openDialog() {
	renderPanel();
	await userEvent.click(await screen.findByRole("button", { name: /新建.*接入|添加接入/ }));
	const dialog = await screen.findByRole("dialog");
	// 没名字的接入在卡上什么都认不出 —— 「创建」要等名字填了才亮
	await userEvent.type(within(dialog).getByRole("textbox", { name: "接入名字" }), "家里那台");
	return dialog;
}

/** 弹窗里那把明文 token —— 32 位十六进制。 */
function shownToken(dialog: HTMLElement): string {
	const hit = [...dialog.querySelectorAll("*")]
		.map((el) => el.textContent ?? "")
		.find((text) => /^[0-9a-f]{32}$/.test(text.trim()));
	if (!hit) throw new Error("弹窗里没有明文 token");
	return hit.trim();
}

/** 存下去的那条接入 —— 接入名单是整份写回 `globals.extensions.bridge.settings.links` 的,新的那条在末尾。 */
function savedLink(): { token: string; bridgeKind: string; name: string } {
	const [url, body] = vi.mocked(api.patch).mock.calls[0] as [
		string,
		{
			extensions: {
				bridge: { settings: { links: { token: string; bridgeKind: string; name: string }[] } };
			};
		},
	];
	if (url !== "/api/globals") throw new Error(`写去了别处:${url}`);
	const link = body.extensions.bridge.settings.links.at(-1);
	if (!link) throw new Error("名单里没有新的那条");
	return link;
}

beforeEach(() => {
	vi.mocked(api.patch).mockResolvedValue({});
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("新建接入", () => {
	it("token 与 BN 地址摆在一起,两样都能复制 —— 它们是一对", async () => {
		const dialog = await openDialog();
		expect(shownToken(dialog)).toMatch(/^[0-9a-f]{32}$/);
		expect(dialog.textContent).toMatch(/ws:\/\//);
		// 页顶那块也有一颗复制地址 —— 这里问的是**弹窗里**两样是否成对
		const inDialog = within(dialog);
		expect(inDialog.getByRole("button", { name: /复制.*token/ })).toBeTruthy();
		expect(inDialog.getByRole("button", { name: /复制 BN 地址/ })).toBeTruthy();
	});

	/**
	 * 🔴 **显示一把、存下另一把**是这类界面的经典错法,而且症状极难查:主人照着屏幕填进
	 * 插件,插件收到 401,而面板上一切正常。
	 */
	it("存下去的就是屏幕上那一把,不是另生成的", async () => {
		const dialog = await openDialog();
		const shown = shownToken(dialog);
		await userEvent.click(screen.getByRole("button", { name: "创建" }));
		await waitFor(() => expect(api.patch).toHaveBeenCalled());
		expect(savedLink().token).toBe(shown);
	});

	it("在弹窗里换一把,存下去的跟着换", async () => {
		const dialog = await openDialog();
		const first = shownToken(dialog);
		await userEvent.click(within(dialog).getByRole("button", { name: "重新生成 token" }));
		const second = shownToken(dialog);
		expect(second).not.toBe(first);
		await userEvent.click(screen.getByRole("button", { name: "创建" }));
		await waitFor(() => expect(api.patch).toHaveBeenCalled());
		expect(savedLink().token).toBe(second);
	});

	it("取消什么都不发", async () => {
		await openDialog();
		await userEvent.click(screen.getByRole("button", { name: "取消" }));
		expect(api.patch).not.toHaveBeenCalled();
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("两种桥是两张可选的卡,不印插件包名 —— 那两个包今天都还不存在", async () => {
		const dialog = await openDialog();
		const options = within(dialog).getAllByRole("button", { pressed: true });
		expect(options).toHaveLength(1);
		expect(options[0]?.textContent).toMatch(/koishi/);
		await userEvent.click(within(dialog).getByRole("button", { name: /AstrBot/ }));
		expect(within(dialog).getByRole("button", { pressed: true }).textContent).toMatch(/AstrBot/);
		expect(dialog.textContent).not.toMatch(/koishi-plugin|astrbot_plugin/);
		await userEvent.click(screen.getByRole("button", { name: "创建" }));
		await waitFor(() => expect(api.patch).toHaveBeenCalled());
		expect(savedLink().bridgeKind).toBe("astrbot");
	});
});
