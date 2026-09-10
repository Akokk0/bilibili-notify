// @vitest-environment jsdom
/**
 * 从推送目标页的「新建连接」建一条拓展连接(桥接入)。
 *
 * 主人 2026-09-10:「我希望的是我自己去新建里添加出来」—— 此前平台那一排只有内置的六档,
 * 桥接入只能在拓展页建,于是它在这一页里像是自己冒出来的。跑着的推送源拓展现在是那一排
 * 的一档,表单照它交上来的字段表画(ADR-0012 决策 33),token 现生成、能换一把。
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
	configFields: [
		{
			kind: "select",
			code: "bridgeKind",
			label: "桥的种类",
			required: true,
			options: [
				{ value: "koishi", label: "Koishi" },
				{ value: "astrbot", label: "AstrBot" },
			],
		},
		{
			kind: "text",
			code: "token",
			label: "接入 token",
			required: true,
			secret: true,
			generate: 16,
		},
	],
};

function renderPage(extensions: ExtensionsResponse["extensions"] = [BRIDGE]) {
	vi.mocked(api.get).mockImplementation(async (url: string) => {
		if (url === "/api/ext") return { extensions };
		return [];
	});
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<PlatformMetaProvider value={buildPlatformTable(extensions)}>
			<QueryClientProvider client={qc}>
				<Targets />
			</QueryClientProvider>
		</PlatformMetaProvider>,
	);
}

async function openNewConnection(): Promise<HTMLElement> {
	renderPage();
	fireEvent.click((await screen.findAllByRole("button", { name: /新建连接/ }))[0] as HTMLElement);
	return screen.findByRole("dialog");
}

beforeEach(() => {
	vi.mocked(api.post).mockResolvedValue([]);
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("新建连接里的拓展那一档", () => {
	it("跑着的推送源拓展出现在平台那一排", async () => {
		const dialog = await openNewConnection();
		expect(await within(dialog).findByRole("button", { name: /机器人框架桥接/ })).toBeTruthy();
	});

	it("没跑起来的不出现 —— 它的字段表是 activate 里才报的", async () => {
		renderPage([
			{
				...BRIDGE,
				state: "disabled",
				enabled: false,
				descriptor: undefined,
				configFields: undefined,
			},
		]);
		fireEvent.click((await screen.findAllByRole("button", { name: /新建连接/ }))[0] as HTMLElement);
		const dialog = await screen.findByRole("dialog");
		expect(within(dialog).queryByRole("button", { name: /机器人框架桥接/ })).toBeNull();
	});

	it("选了它,表单照字段表画:种类可选、token 现生成且能换一把", async () => {
		const dialog = await openNewConnection();
		fireEvent.click(await within(dialog).findByRole("button", { name: /机器人框架桥接/ }));
		expect(within(dialog).getByText("桥的种类")).toBeTruthy();
		expect(within(dialog).getByText("接入 token")).toBeTruthy();
		const token = within(dialog).getByDisplayValue(/^[0-9a-f]{32}$/) as HTMLInputElement;
		const first = token.value;
		fireEvent.click(within(dialog).getByRole("button", { name: /重新生成/ }));
		const second = (within(dialog).getByDisplayValue(/^[0-9a-f]{32}$/) as HTMLInputElement).value;
		expect(second).not.toBe(first);
	});

	/** ADR-0009 决策 21:token 只在新建这一刻给全文,之后只留头尾 —— 改连接时它是遮着的。 */
	it("改一条已有的拓展连接,token 遮着、但还能换一把", async () => {
		const link = {
			id: "11111111-1111-4111-8111-111111111111",
			name: "Koishi",
			enabled: true,
			kind: "extension",
			extensionId: "bridge",
			config: { token: "0123456789abcdef0123456789abcdef", bridgeKind: "koishi" },
		};
		vi.mocked(api.get).mockImplementation(async (url: string) => {
			if (url === "/api/ext") return { extensions: [BRIDGE] };
			if (url === "/api/connections") return [link];
			return [];
		});
		const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		render(
			<PlatformMetaProvider value={buildPlatformTable([BRIDGE])}>
				<QueryClientProvider client={qc}>
					<Targets />
				</QueryClientProvider>
			</PlatformMetaProvider>,
		);
		fireEvent.click((await screen.findAllByRole("button", { name: "配置" }))[0] as HTMLElement);
		const dialog = await screen.findByRole("dialog");
		expect(dialog.textContent).toContain("配置连接");
		const token = within(dialog).getByDisplayValue(
			"0123456789abcdef0123456789abcdef",
		) as HTMLInputElement;
		expect(token.type).toBe("password");
		expect(within(dialog).getByRole("button", { name: /重新生成/ })).toBeTruthy();
	});

	it("存下去的是一条拓展连接:kind extension、挂在它名下、config 照字段表", async () => {
		const dialog = await openNewConnection();
		fireEvent.click(await within(dialog).findByRole("button", { name: /机器人框架桥接/ }));
		fireEvent.click(within(dialog).getByRole("button", { name: "AstrBot" }));
		fireEvent.change(within(dialog).getByPlaceholderText(/NapCat/), {
			target: { value: "机房那台" },
		});
		fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
		await waitFor(() => expect(api.post).toHaveBeenCalled());
		const [url, body] = vi.mocked(api.post).mock.calls[0] as [string, Record<string, unknown>];
		expect(url).toBe("/api/connections");
		expect(body).toMatchObject({
			kind: "extension",
			extensionId: "bridge",
			name: "机房那台",
			enabled: true,
		});
		const config = body.config as { bridgeKind: string; token: string };
		expect(config.bridgeKind).toBe("astrbot");
		expect(config.token).toMatch(/^[0-9a-f]{32}$/);
	});
});
