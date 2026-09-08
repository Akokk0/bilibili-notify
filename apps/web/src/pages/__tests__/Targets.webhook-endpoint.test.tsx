// @vitest-environment jsdom

/**
 * Webhook 那一支的**刻画测试** —— 钉住「系统托管的投递目标」在界面上的样子。
 *
 * 为什么单开一个文件钉它:webhook 原先同时占着两个身份 —— 它既是 `Connection.platform`
 * 的一档,又是 `PushTarget.platform` 的一档。数据模型重构把它从「平台」降格成了
 * 「连接器」(平台改由原先的 provider 承担:飞书 / 钉钉 / 企业微信 / 未指明)。降格之后
 * `target.platform` 不再等于 `"webhook"`,页面里那几处 `=== "webhook"` 会**静默恒假**:
 *
 * - `managedWebhookTargetForConnection` 认不出自己那张托管目标 → 托管卡从界面消失,
 *   只剩一句「保存 Webhook 后系统会自动创建默认投递目标」的空态;
 * - `targetSessionSummary` 末尾那个**兜底 return** 会把「不是 onebot、不是官机」的目标
 *   一律标成「→ webhook 终点」—— 将来接进来的 telegram 目标会被标错平台。
 *
 * 两处都**没有编译错、没有类型红**(比较的两边都是 string),所以先在这儿把行为钉死:
 * 降格那步一旦漏改,红的是这个文件而不是主人的真机。
 *
 * 判据眼下已经搬到 `target.kind` 上(`endpoint` / `session`),这个文件继续守着它 ——
 * 哪天有人图省事把它改回按平台名比,这里会红。
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { Connection, PushTarget } from "../../types/domain";
import Targets from "../Targets";

vi.mock("../../services/api", () => ({
	api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
	ApiError: class extends Error {},
}));

import { api } from "../../services/api";

const WEBHOOK_ID = "33333333-3333-4333-8333-333333333333";
const ONEBOT_ID = "11111111-1111-4111-8111-111111111111";

const WEBHOOK_CONNECTION = {
	id: WEBHOOK_ID,
	name: "飞书群机器人",
	enabled: true,
	kind: "direct",
	connector: "webhook",
	platform: "feishu",
	config: { url: "https://open.feishu.cn/hook/abcdef", provider: "feishu", headers: {} },
} as unknown as Connection;

const ONEBOT_CONNECTION = {
	id: ONEBOT_ID,
	name: "家里那台 OneBot",
	enabled: true,
	kind: "direct",
	connector: "http",
	platform: "onebot",
	config: { transport: "http", baseUrl: "http://127.0.0.1:5700", accessToken: "" },
} as unknown as Connection;

/** 系统托管的那张:`managedBy: "adapter"`,用户不可编辑 / 删除。 */
const MANAGED_TARGET = {
	id: "44444444-4444-4444-8444-444444444444",
	name: "飞书群机器人 · 投递",
	adapterId: WEBHOOK_ID,
	kind: "endpoint",
	platform: "feishu",
	scope: "group",
	enabled: true,
	managedBy: "adapter",
	session: {},
} as unknown as PushTarget;

function renderPage(connections: Connection[], targets: PushTarget[]) {
	vi.mocked(api.get).mockImplementation(async (url: string) => {
		if (url === "/api/adapters") return connections;
		if (url === "/api/targets") return targets;
		return [];
	});
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<Targets />
		</QueryClientProvider>,
	);
}

/** 右栏那张「Webhook 投递目标」卡。 */
async function endpointPanel(): Promise<HTMLElement> {
	const heading = await screen.findByText("Webhook 投递目标");
	const panel = heading.closest("div.bn-glass");
	if (!panel) throw new Error("找不到 Webhook 投递目标那张卡");
	return panel as HTMLElement;
}

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("系统托管的 webhook 投递目标", () => {
	beforeEach(() => {
		renderPage([WEBHOOK_CONNECTION], [MANAGED_TARGET]);
	});

	it("选中 webhook 连接时,托管目标那张卡要出现在界面上", async () => {
		const panel = await endpointPanel();
		expect(within(panel).getByText("飞书群机器人 · 投递")).toBeTruthy();
		// 认不出托管目标时页面退成这句空态 —— 它出现即等于卡没了。
		expect(within(panel).queryByText(/保存 Webhook 后系统会自动创建默认投递目标/)).toBeNull();
	});

	it("托管目标的会话摘要写「系统托管 webhook 终点」", async () => {
		const panel = await endpointPanel();
		expect(within(panel).getByText("→ 系统托管 webhook 终点")).toBeTruthy();
	});

	it("左栏副标题写「单向投递」而不是目标个数", async () => {
		expect(await screen.findByText(/单向投递/)).toBeTruthy();
	});
});

describe("会话摘要不会把别的平台标成 webhook", () => {
	it("OneBot 群目标写的是群号,不是 webhook 终点", async () => {
		const onebotTarget = {
			id: "55555555-5555-4555-8555-555555555555",
			name: "测试群",
			adapterId: ONEBOT_ID,
			kind: "session",
			platform: "onebot",
			scope: "group",
			enabled: true,
			address: "114514",
		} as unknown as PushTarget;

		renderPage([ONEBOT_CONNECTION], [onebotTarget]);

		expect(await screen.findByText("→ 群 114514")).toBeTruthy();
		expect(screen.queryByText(/webhook 终点/)).toBeNull();
	});
});

describe("托管目标不给用户改", () => {
	it("点它的行不会打开编辑弹窗,只弹一句提示", async () => {
		renderPage([WEBHOOK_CONNECTION], [MANAGED_TARGET]);
		const panel = await endpointPanel();
		// 托管卡是 readOnly —— 连「配置」「删除」都不渲染,只剩「测试」。
		expect(within(panel).queryByRole("button", { name: "配置" })).toBeNull();
		await waitFor(() => expect(within(panel).getByRole("button", { name: "测试" })).toBeTruthy());
	});

	it("webhook 连接下不给「+ 新建推送目标」入口", async () => {
		renderPage([WEBHOOK_CONNECTION], [MANAGED_TARGET]);
		const panel = await endpointPanel();
		expect(within(panel).queryByRole("button", { name: /新建推送目标/ })).toBeNull();
	});
});

describe("没有托管目标时的空态", () => {
	it("找不到托管目标就退成那句提示 —— 这正是判据恒假时会看到的样子", async () => {
		renderPage([WEBHOOK_CONNECTION], []);
		const panel = await endpointPanel();
		expect(within(panel).getByText(/保存 Webhook 后系统会自动创建默认投递目标/)).toBeTruthy();
	});
});

describe("未托管的 webhook 目标(历史数据)", () => {
	it("摘要写「webhook 终点」,不带「系统托管」", async () => {
		const loose = { ...MANAGED_TARGET, managedBy: undefined } as unknown as PushTarget;
		renderPage([WEBHOOK_CONNECTION], [loose]);
		const panel = await endpointPanel();
		expect(within(panel).getByText("→ webhook 终点")).toBeTruthy();
	});
});
