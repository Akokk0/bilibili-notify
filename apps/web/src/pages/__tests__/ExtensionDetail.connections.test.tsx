// @vitest-environment jsdom

import type { ExtensionsResponse } from "@bilibili-notify/contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import ExtensionDetail from "../ExtensionDetail";

const { apiGetMock, apiPostMock, apiPatchMock, apiDeleteMock } = vi.hoisted(() => ({
	apiGetMock: vi.fn(),
	apiPostMock: vi.fn(),
	apiPatchMock: vi.fn(),
	apiDeleteMock: vi.fn(),
}));

vi.mock("../../services/api", () => ({
	api: {
		get: apiGetMock as unknown as (url: string) => Promise<unknown>,
		post: apiPostMock as unknown as (url: string, body?: unknown) => Promise<unknown>,
		patch: apiPatchMock as unknown as (url: string, body?: unknown) => Promise<unknown>,
		delete: apiDeleteMock as unknown as (url: string) => Promise<unknown>,
	},
}));

const LINK_ID = "11111111-1111-4111-8111-111111111111";
const OLD_TOKEN = "0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f";

const LISTED: ExtensionsResponse = {
	extensions: [
		{
			id: "bridge",
			name: "机器人框架桥接",
			enabled: true,
			state: "running",
			root: { kind: "data", dir: "/data/extensions/bridge" },
		},
	],
	shadowed: [],
};

const CONNECTIONS = [
	{
		id: LINK_ID,
		name: "家里那台",
		kind: "extension",
		extensionId: "bridge",
		enabled: true,
		config: { token: OLD_TOKEN, bridgeKind: "koishi" },
	},
	{ id: "33333333-3333-4333-8333-333333333333", name: "本地 OneBot", kind: "direct" },
];

/** 拓展没跑起来时这一口是 404 —— 接入照样得管得了。 */
function mockApi(opts: { statusFails?: boolean } = {}) {
	apiGetMock.mockImplementation(async (url: string) => {
		if (url === "/api/ext") return LISTED;
		if (url === "/api/connections") return CONNECTIONS;
		if (url.startsWith("/api/ext/")) {
			if (opts.statusFails) throw new Error("not found");
			return { sessions: [{ connectionId: LINK_ID, connected: false, bots: [] }] };
		}
		return {};
	});
}

function renderDetail() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<MemoryRouter initialEntries={["/extensions/bridge"]}>
				<Routes>
					<Route path="/extensions/:id" element={<ExtensionDetail />} />
				</Routes>
			</MemoryRouter>
		</QueryClientProvider>,
	);
}

describe("桥接接入的增删改", () => {
	beforeEach(() => {
		apiGetMock.mockReset();
		apiPostMock.mockReset();
		apiPatchMock.mockReset();
		apiDeleteMock.mockReset();
		apiPostMock.mockResolvedValue([]);
		apiPatchMock.mockResolvedValue({});
		apiDeleteMock.mockResolvedValue({});
		mockApi();
	});

	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
	});

	/**
	 * 🔴 **token 是前端生成的**(桥接设计定案):它只需要「两边一样」,不需要服务端参与。
	 * 生成得不够随机的话,这条接入就是一把谁都猜得到的钥匙 —— 而那条 WS 端点**刻意**
	 * 在 dashboard 鉴权之外。
	 */
	it("建一条接入:token 现生成,128 位随机", async () => {
		renderDetail();
		fireEvent.click(await screen.findByText("添加接入"));
		fireEvent.change(screen.getByLabelText("接入名字"), { target: { value: "公司那台" } });
		fireEvent.click(screen.getByText("建好了"));

		await waitFor(() => expect(apiPostMock).toHaveBeenCalled());
		const [url, body] = apiPostMock.mock.calls[0] as [string, Record<string, unknown>];
		expect(url).toBe("/api/connections");
		expect(body).toMatchObject({
			name: "公司那台",
			kind: "extension",
			extensionId: "bridge",
			enabled: true,
		});
		const config = body.config as { token: string; bridgeKind: string };
		expect(config.token).toMatch(/^[0-9a-f]{32}$/);
		expect(config.bridgeKind).toBe("koishi");
	});

	/** 重新生成 = 换一把新钥匙。发出去的必须**不是**旧那把,否则这个动作等于没做。 */
	it("重新生成 token:发出去的是一把新的", async () => {
		renderDetail();
		fireEvent.click(await screen.findByLabelText("重新生成 家里那台 的 token"));
		await waitFor(() => expect(apiPatchMock).toHaveBeenCalled());
		const [url, body] = apiPatchMock.mock.calls[0] as [string, { config: { token: string } }];
		expect(url).toBe(`/api/connections/${LINK_ID}`);
		expect(body.config.token).toMatch(/^[0-9a-f]{32}$/);
		expect(body.config.token).not.toBe(OLD_TOKEN);
	});

	/** 删接入是不可逆的,要问一句再动手。 */
	it("删接入先问一句", async () => {
		renderDetail();
		fireEvent.click(await screen.findByLabelText("删除 家里那台"));
		expect(apiDeleteMock).not.toHaveBeenCalled();
		fireEvent.click(screen.getByText("删除"));
		await waitFor(() => expect(apiDeleteMock).toHaveBeenCalledWith(`/api/connections/${LINK_ID}`));
	});

	/** token 是密钥,不该躺在屏幕上等着被截图带走。 */
	it("token 默认不明文显示", async () => {
		renderDetail();
		await screen.findByText("家里那台");
		expect(screen.queryByText(OLD_TOKEN)).toBeNull();
	});

	/**
	 * 🔴 **拓展没跑起来时,接入照样管得了。** 从活着的会话那头看起的话,这一页在最需要它的
	 * 时候(桥挂了)恰好是空的。
	 */
	it("拓展没跑起来时接入照样列得出来", async () => {
		mockApi({ statusFails: true });
		renderDetail();
		expect(await screen.findByText("家里那台")).toBeTruthy();
		expect(screen.getByLabelText("删除 家里那台")).toBeTruthy();
	});
});
