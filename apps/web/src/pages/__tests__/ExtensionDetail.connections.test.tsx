// @vitest-environment jsdom

import type { ExtensionsResponse } from "@bilibili-notify/contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import ExtensionDetail from "../ExtensionDetail";
// 写回名单的读法只有一份 —— 那句 `as` 断言形状漂了不会红,所以不许再抄(见该文件)。
import { savedLinks } from "../extensions/__tests__/bridge-harness";

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
			dir: "/data/extensions/bridge",
		},
	],
};

/** 接入住桥的设置里(`globals.extensions.bridge.settings.links`),不在连接表里(ADR-0012 决策 45)。 */
const LINKS = [
	{ id: LINK_ID, name: "家里那台", enabled: true, token: OLD_TOKEN, bridgeKind: "koishi" },
];

/** 拓展没跑起来时这一口是 404 —— 接入照样得管得了。 */
function mockApi(opts: { statusFails?: boolean } = {}) {
	apiGetMock.mockImplementation(async (url: string) => {
		if (url === "/api/ext") return LISTED;
		if (url === "/api/globals")
			return { extensions: { bridge: { enabled: true, settings: { links: LINKS } } } };
		if (url === "/api/connections") return [];
		if (url.startsWith("/api/ext/")) {
			if (opts.statusFails) throw new Error("not found");
			return { sessions: [{ linkId: LINK_ID, connected: false, bots: [] }] };
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
	 * 🔴 **插件那头必须手敲这个地址**,面板不给就等于让主人去翻文档。
	 *
	 * 而且它最容易填错的那一处也得说出来:BN 常在 NAS / 容器里,`127.0.0.1` 对桥来说
	 * 是**桥自己那台机器**。
	 */
	it("把插件那头要填的 BN 地址印出来,还能一键复制", async () => {
		const writeText = vi.fn().mockResolvedValue(undefined);
		Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
		renderDetail();

		const address = `ws://${window.location.host}/ext/bridge`;
		expect(await screen.findByText(address)).toBeTruthy();
		// 「别填 127.0.0.1」那句与地址一样要紧 —— 填错了这一页不会留下任何记录。
		expect(screen.getByText(/127\.0\.0\.1/)).toBeTruthy();

		fireEvent.click(screen.getByLabelText("复制 BN 地址"));
		await waitFor(() => expect(writeText).toHaveBeenCalledWith(address));
	});

	/**
	 * 🔴 **token 是前端生成的**(桥接设计定案):它只需要「两边一样」,不需要服务端参与。
	 * 生成得不够随机的话,这条接入就是一把谁都猜得到的钥匙 —— 而那条 WS 端点**刻意**
	 * 在 dashboard 鉴权之外。
	 */
	it("建一条接入:token 现生成,128 位随机", async () => {
		renderDetail();
		fireEvent.click(await screen.findByText("新建接入"));
		fireEvent.change(screen.getByLabelText("接入名字"), { target: { value: "公司那台" } });
		fireEvent.click(screen.getByText("创建"));

		await waitFor(() => expect(apiPatchMock).toHaveBeenCalled());
		// 原来那条原样带着,新的在末尾 —— 名单是整份写回的。
		const links = savedLinks();
		expect(links).toHaveLength(2);
		expect(links[0]).toMatchObject({ id: LINK_ID, token: OLD_TOKEN });
		expect(links[1]).toMatchObject({ name: "公司那台", bridgeKind: "koishi" });
		expect(links[1]?.token).toMatch(/^[0-9a-f]{32}$/);
		expect(links[1]?.id).toMatch(/^[0-9a-f-]{36}$/);
	});

	/** 重新生成 = 换一把新钥匙。发出去的必须**不是**旧那把,否则这个动作等于没做。 */
	/** 换钥匙会把正连着的桥踢下线,所以有旧钥匙时先问一句(`bridge-regenerate-token.test.tsx` 管那道门)。 */
	it("重新生成 token:确认之后发出去的是一把新的", async () => {
		renderDetail();
		fireEvent.click(await screen.findByLabelText("重新生成 家里那台 的 token"));
		expect(apiPatchMock).not.toHaveBeenCalled();
		// 卡上那颗叫「重新生成 家里那台 的 token」,弹窗里那颗就叫「重新生成」
		fireEvent.click(screen.getByRole("button", { name: "重新生成" }));
		await waitFor(() => expect(apiPatchMock).toHaveBeenCalled());
		const [link] = savedLinks();
		expect(link?.token).toMatch(/^[0-9a-f]{32}$/);
		expect(link?.token).not.toBe(OLD_TOKEN);
	});

	/** 删接入是不可逆的,要问一句再动手。 */
	it("删接入先问一句", async () => {
		renderDetail();
		fireEvent.click(await screen.findByLabelText("删除 家里那台"));
		expect(apiPatchMock).not.toHaveBeenCalled();
		// 卡上那颗叫「删除 家里那台」,弹窗里那颗就叫「删除」—— 按名字取,别按文字
		fireEvent.click(screen.getByRole("button", { name: "删除" }));
		await waitFor(() => expect(apiPatchMock).toHaveBeenCalled());
		expect(savedLinks()).toEqual([]);
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
