// @vitest-environment jsdom
import {
	builtinAdapters,
	builtinCandidatesResponse,
} from "../../types/__tests__/connection-fixtures";

/**
 * 连接表单的凭据格(ADR-0021 决策 44):`GET /api/connections` 下发的是 `{ masked }`。
 *
 * 面板的规矩:已存着的凭据格画成「遮挡胶囊 + 换一份」;编辑存盘走 `PATCH /api/connections/:id`,
 * **没动过的凭据格不进 PATCH**(带遮挡是 400),换了发新明文,点「换一份」后留空 = 清空;新建走 POST。
 * 断言的都是**发出去的请求体**。
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { snapshotFor } from "../../__tests__/platform-snapshot";
import { PlatformMetaRoot } from "../../components/platform-meta";
import Targets from "../Targets";

vi.mock("../../services/api", () => ({
	api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
	ApiError: class extends Error {},
}));

import { i18n } from "../../i18n";
import { api } from "../../services/api";

// This scenario uses Chinese UI; it must not depend on untranslated fallbacks.
beforeEach(() => {
	i18n.set({ locale: "zh-CN", voice: "plain" });
});

const ID = "11111111-1111-4111-8111-111111111111";
const base = { id: ID, name: "家里那台", enabled: true } as const;
const ONEBOT = {
	...base,
	adapterKey: "onebot",
	platform: "onebot",
	platformSnapshot: snapshotFor("onebot"),
	settings: {
		transport: "http",
		baseUrl: "http://127.0.0.1:5700",
		protocolVersion: "v11",
		headers: {},
		timeoutMs: 15_000,
		imageMinTimeoutMs: 30_000,
		mergeForwardMinTimeoutMs: 60_000,
		maxRetries: 0,
		retryIntervalMs: 1_000,
		accessToken: { masked: "abcd••••••••wxyz" },
	},
};
const WEBHOOK = {
	...base,
	adapterKey: "webhook",
	platform: "dingtalk",
	platformSnapshot: snapshotFor("dingtalk"),
	settings: {
		url: { masked: "http••••••••=tok" },
		secret: { masked: "••••••••" },
		headers: {},
	},
};
const QQ = {
	...base,
	adapterKey: "qq-official",
	platform: "qq-official",
	platformSnapshot: snapshotFor("qq-official"),
	settings: {
		appId: "1145141",
		appSecret: { masked: "••••••••" },
		sandbox: false,
		botType: "public",
		logReconnects: false,
	},
};

let connections: unknown[] = [];

beforeEach(() => {
	connections = [ONEBOT];
	vi.mocked(api.get).mockImplementation(async (url: string) => {
		if (url === "/api/adapters") return { adapters: builtinAdapters };
		const candidates = builtinCandidatesResponse(url);
		if (candidates) return candidates;
		if (url === "/api/connections") return connections;
		return [];
	});
	vi.mocked(api.patch).mockResolvedValue({});
	vi.mocked(api.post).mockResolvedValue([]);
});
afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

async function openEdit(): Promise<HTMLElement> {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(
		<QueryClientProvider client={qc}>
			<PlatformMetaRoot>
				<Targets />
			</PlatformMetaRoot>
		</QueryClientProvider>,
	);
	fireEvent.click(await screen.findByRole("button", { name: "配置" }));
	await waitFor(() => screen.getByRole("dialog"));
	return screen.getByRole("dialog");
}

const click = (dialog: HTMLElement, name: string | RegExp) =>
	fireEvent.click(within(dialog).getByRole("button", { name }));
const save = async (dialog: HTMLElement) => {
	click(dialog, "保存");
	await waitFor(() =>
		expect(
			vi.mocked(api.patch).mock.calls.length + vi.mocked(api.post).mock.calls.length,
		).toBeGreaterThan(0),
	);
};
const field = (dialog: HTMLElement, code: string) =>
	dialog.querySelector(`[data-code="${code}"]`) as HTMLElement;

describe("编辑一条已存着的连接", () => {
	it("凭据格显示遮挡胶囊 + 「换一份」,不是输入框", async () => {
		const dialog = await openEdit();
		const row = field(dialog, "settings.accessToken");
		expect(row.textContent).toContain("abcd••••••••wxyz");
		expect(row.querySelector("input")).toBeNull();
		expect(within(row).getByRole("button", { name: "换一份" })).toBeTruthy();
	});

	it("只改显示名保存 → PATCH 到这条的 id,体里没有 accessToken", async () => {
		const dialog = await openEdit();
		const name = within(dialog).getByDisplayValue("家里那台");
		fireEvent.change(name, { target: { value: "改了名" } });
		await save(dialog);

		expect(api.post).not.toHaveBeenCalled();
		const [url, body] = vi.mocked(api.patch).mock.calls[0] as [string, Record<string, unknown>];
		expect(url).toBe(`/api/connections/${ID}`);
		expect(body).toMatchObject({ name: "改了名" });
		expect(body.settings).not.toHaveProperty("accessToken");
		expect(JSON.stringify(body)).not.toContain("masked");
		expect(JSON.stringify(body)).not.toContain("••");
	});

	it("点「换一份」填新值 → PATCH 里是新明文;「不换了」撤回后又不发", async () => {
		const dialog = await openEdit();
		const row = () => field(dialog, "settings.accessToken");
		fireEvent.click(within(row()).getByRole("button", { name: "换一份" }));
		fireEvent.change(row().querySelector("input") as HTMLElement, { target: { value: "fresh" } });
		fireEvent.click(within(row()).getByRole("button", { name: "不换了" }));
		expect(row().querySelector("input")).toBeNull();
		await save(dialog);
		const body = vi.mocked(api.patch).mock.calls[0]?.[1] as { settings: object };
		expect(body.settings).not.toHaveProperty("accessToken");
	});

	it("点「换一份」填新值保存 → accessToken 是新明文", async () => {
		const dialog = await openEdit();
		const row = field(dialog, "settings.accessToken");
		fireEvent.click(within(row).getByRole("button", { name: "换一份" }));
		fireEvent.change(row.querySelector("input") as HTMLElement, { target: { value: "fresh" } });
		await save(dialog);
		expect(vi.mocked(api.patch).mock.calls[0]?.[1]).toMatchObject({
			settings: { accessToken: "fresh" },
		});
	});

	it("点「换一份」后留空保存 → 可选的凭据格交 null(清空)", async () => {
		const dialog = await openEdit();
		fireEvent.click(
			within(field(dialog, "settings.accessToken")).getByRole("button", { name: "换一份" }),
		);
		await save(dialog);
		const body = vi.mocked(api.patch).mock.calls[0]?.[1] as { settings: Record<string, unknown> };
		expect(body.settings).toHaveProperty("accessToken", null);
	});

	it("切正向 WS:消失的 baseUrl 交 null,凭据不动", async () => {
		const dialog = await openEdit();
		click(dialog, "正向 WS");
		await save(dialog);
		const body = vi.mocked(api.patch).mock.calls[0]?.[1] as {
			settings: Record<string, unknown>;
		};
		expect(body.settings).toMatchObject({ transport: "ws", baseUrl: null });
		expect(body.settings).not.toHaveProperty("accessToken");
	});
});

describe("webhook / 官机", () => {
	it("webhook:地址与 secret 都是凭据胶囊,只改名时一个都不发", async () => {
		connections = [WEBHOOK];
		const dialog = await openEdit();
		expect(field(dialog, "settings.url").textContent).toContain("http••••••••=tok");
		expect(field(dialog, "settings.secret").textContent).toContain("••••••••");
		fireEvent.change(within(dialog).getByDisplayValue("家里那台"), { target: { value: "新名" } });
		await save(dialog);
		const body = vi.mocked(api.patch).mock.calls[0]?.[1] as { settings: Record<string, unknown> };
		expect(body.settings).not.toHaveProperty("url");
		expect(body.settings).not.toHaveProperty("secret");
	});

	it("连接列表只用适配器描述，不读取设置里的地址", async () => {
		connections = [WEBHOOK];
		const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		render(
			<QueryClientProvider client={qc}>
				<PlatformMetaRoot>
					<Targets />
				</PlatformMetaRoot>
			</QueryClientProvider>,
		);
		expect(await screen.findByText(/经 Webhook/)).toBeTruthy();
		expect(screen.queryByText(/http••••••••=tok/)).toBeNull();
	});

	it("官机 appSecret 点「换一份」后留空保存 → 空串(必填的格交空串,不是 null)", async () => {
		connections = [QQ];
		const dialog = await openEdit();
		fireEvent.click(
			within(field(dialog, "settings.appSecret")).getByRole("button", { name: "换一份" }),
		);
		// 必填的格留空:保存钮要让它过(存着的那份被换成空,是主人明确要的)。
		await save(dialog).catch(() => undefined);
		const body = vi.mocked(api.patch).mock.calls[0]?.[1] as { settings: Record<string, unknown> };
		expect(body.settings).toHaveProperty("appSecret", "");
	});
});

describe("新建", () => {
	it("新建走 POST,凭据格就是普通输入框,体里是填的明文", async () => {
		connections = [];
		const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		render(
			<QueryClientProvider client={qc}>
				<PlatformMetaRoot>
					<Targets />
				</PlatformMetaRoot>
			</QueryClientProvider>,
		);
		fireEvent.click(await screen.findByRole("button", { name: /新建连接/ }));
		const dialog = await waitFor(() => screen.getByRole("dialog"));
		fireEvent.change(within(dialog).getByPlaceholderText("如：家里的机器人"), {
			target: { value: "新的" },
		});
		await waitFor(() => expect(field(dialog, "settings.accessToken")).not.toBeNull());
		const token = field(dialog, "settings.accessToken").querySelector("input") as HTMLElement;
		fireEvent.change(token, { target: { value: "tok-new" } });
		await save(dialog);
		expect(api.patch).not.toHaveBeenCalled();
		const [url, body] = vi.mocked(api.post).mock.calls[0] as [
			string,
			{ settings: { accessToken: string } },
		];
		expect(url).toBe("/api/connections");
		expect(body.settings.accessToken).toBe("tok-new");
	});
});

it("描述还没读到时不展开凭据；读到后按字段描述保留已存凭据", async () => {
	let resolveAdapters!: (value: unknown) => void;
	const pending = new Promise((resolve) => {
		resolveAdapters = resolve;
	});
	const get = vi.mocked(api.get).getMockImplementation();
	if (!get) throw new Error("Missing API fixture");
	vi.mocked(api.get).mockImplementation((url: string) =>
		url === "/api/adapters" ? pending : get(url),
	);
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(
		<QueryClientProvider client={qc}>
			<PlatformMetaRoot>
				<Targets />
			</PlatformMetaRoot>
		</QueryClientProvider>,
	);
	fireEvent.click(await screen.findByRole("button", { name: "配置" }));
	expect(screen.queryByRole("dialog")).toBeNull();
	await act(async () => resolveAdapters({ adapters: builtinAdapters }));
	await screen.findByText(/经 OneBot/);
	fireEvent.click(screen.getByRole("button", { name: "配置" }));
	const dialog = await screen.findByRole("dialog");
	expect(field(dialog, "settings.accessToken").querySelector("input")).toBeNull();
	expect(field(dialog, "settings.accessToken").textContent).toContain("abcd••••••••wxyz");
	fireEvent.change(within(dialog).getByDisplayValue("家里那台"), { target: { value: "改名" } });
	await save(dialog);
	expect(vi.mocked(api.patch).mock.calls[0]?.[1]).not.toHaveProperty("settings.accessToken");
});

it("编辑已有连接时扫码返回的新凭据和其他设置一起进入 PATCH", async () => {
	connections = [QQ];
	const get = vi.mocked(api.get).getMockImplementation();
	if (!get) throw new Error("Missing API fixture");
	vi.mocked(api.get).mockImplementation((url: string) =>
		url.endsWith("/auth/task") ? Promise.resolve({ state: { status: "logged-in" } }) : get(url),
	);
	vi.mocked(api.post).mockImplementation(async (url: string) =>
		url.endsWith("/draft")
			? {
					settings: {
						appId: "new-app",
						appSecret: "new-secret",
						botType: "public",
						sandbox: false,
					},
				}
			: {
					taskId: "task",
					pollIntervalSeconds: 1,
					state: { status: "awaiting-scan", qr: { dataUrl: "data:image/png;base64,AA==" } },
				},
	);
	const dialog = await openEdit();
	fireEvent.click(within(dialog).getByRole("button", { name: /扫码/ }));
	await within(dialog).findByDisplayValue("new-app", {}, { timeout: 3000 });
	await save(dialog);
	expect(vi.mocked(api.patch).mock.calls[0]?.[1]).toMatchObject({
		settings: { appId: "new-app", appSecret: "new-secret" },
	});
});
