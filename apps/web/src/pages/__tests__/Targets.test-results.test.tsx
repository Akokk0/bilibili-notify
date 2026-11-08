// @vitest-environment jsdom
import {
	builtinAdapters,
	builtinCandidatesResponse,
} from "../../types/__tests__/connection-fixtures";

/**
 * 「测试连通 / 测试推送」的结果怎么显示(ADR-0026)。
 *
 * 这两个接口都是「试一次、回报结果」:照旧回 200,体是 `Result<{ latencyMs }>` ——
 * 通了带 `latencyMs`;没通带 `code` + `message`,面板读 `message` 显示(不再读 `err`)。
 * 「这个平台没有探测协议」(如 webhook)是失败那一支的 `unsupported`:既不是通、也不是不通,
 * 面板清掉进行中的状态、只提示一句,不打红叉。
 *
 * 只钉线上的形状。盘上存的 `probeState.message`(连接卡上「上次测试失败 — …」那一句)不在这里。
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { snapshotFor } from "../../__tests__/platform-snapshot";
import type { Connection, PushTarget } from "../../types/domain";
import Targets from "../Targets";

vi.mock("../../services/api", () => ({
	api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
	ApiError: class extends Error {},
}));

import { i18n } from "../../i18n";
import { api } from "../../services/api";

beforeEach(() => i18n.set({ locale: "zh-CN", voice: "plain" }));

const ONEBOT_ID = "11111111-1111-4111-8111-111111111111";
const WEBHOOK_ID = "33333333-3333-4333-8333-333333333333";

const ONEBOT_CONNECTION = {
	id: ONEBOT_ID,
	name: "家里那台 OneBot",
	enabled: true,
	adapterKey: "onebot",
	platform: "onebot",
	platformSnapshot: snapshotFor("onebot"),
	settings: { transport: "http", baseUrl: "http://127.0.0.1:5700", accessToken: "" },
} as unknown as Connection;

const WEBHOOK_CONNECTION = {
	id: WEBHOOK_ID,
	name: "飞书群机器人",
	enabled: true,
	adapterKey: "webhook",
	platform: "feishu",
	platformSnapshot: snapshotFor("feishu"),
	settings: { url: "https://open.feishu.cn/hook/abcdef", provider: "feishu", headers: {} },
} as unknown as Connection;

const MANAGED_TARGET = {
	id: "44444444-4444-4444-8444-444444444444",
	name: "飞书群机器人 · 投递",
	connectionId: WEBHOOK_ID,
	kind: "endpoint",
	enabled: true,
	managedBy: "connection",
	session: {},
} as unknown as PushTarget;

function renderPage(connections: Connection[], targets: PushTarget[]) {
	vi.mocked(api.get).mockImplementation(async (url: string) => {
		if (url === "/api/adapters") return { adapters: builtinAdapters };
		const candidates = builtinCandidatesResponse(url);
		if (candidates) return candidates;
		if (url === "/api/connections") return connections;
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

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("测试连通(连接自己的探测)", () => {
	async function clickTest(): Promise<void> {
		fireEvent.click(await screen.findByRole("button", { name: "测试" }));
	}

	it("通了 → 「连通 · 耗时」", async () => {
		renderPage([ONEBOT_CONNECTION], []);
		vi.mocked(api.post).mockResolvedValueOnce({ ok: true, latencyMs: 12 });
		await clickTest();
		expect(await screen.findByText("连通 · 12ms")).toBeTruthy();
		expect(api.post).toHaveBeenCalledWith(`/api/connections/${ONEBOT_ID}/probe`, {});
	});

	it("没通 → 「失败:」加服务端的 message(读 message、不再读 err)", async () => {
		renderPage([ONEBOT_CONNECTION], []);
		vi.mocked(api.post).mockResolvedValueOnce({
			ok: false,
			code: "unavailable",
			message: "拒绝连接",
		});
		await clickTest();
		expect(await screen.findByText("失败:拒绝连接")).toBeTruthy();
	});

	it("这个平台没有探测协议(unsupported)→ 只提示一句,进行中的状态清掉、不打红叉", async () => {
		renderPage([ONEBOT_CONNECTION], []);
		vi.mocked(api.post).mockResolvedValueOnce({
			ok: false,
			code: "unsupported",
			message: "该平台不支持连接探测",
		});
		await clickTest();
		expect(await screen.findByText("该平台不支持连接探测")).toBeTruthy();
		// 按钮回到「测试」,不是「失败」/「测试中…」。
		expect(screen.getByRole("button", { name: "测试" })).toBeTruthy();
		expect(screen.queryByRole("button", { name: "失败" })).toBeNull();
	});
});

describe("测试推送(webhook 连接的「发送测试」)", () => {
	it("送达 → 「已送达 · 耗时」", async () => {
		renderPage([WEBHOOK_CONNECTION], [MANAGED_TARGET]);
		vi.mocked(api.post).mockResolvedValueOnce({ ok: true, latencyMs: 34 });
		fireEvent.click(await screen.findByRole("button", { name: "发送测试" }));
		expect(await screen.findByText("已送达 · 34ms")).toBeTruthy();
		// 目标 id 在路径里,体里只剩 kind(ADR-0036)。
		expect(api.post).toHaveBeenCalledWith(`/api/targets/${MANAGED_TARGET.id}/test`, {
			kind: "text",
		});
	});

	it("没送达 → 「失败:」加服务端的 message", async () => {
		renderPage([WEBHOOK_CONNECTION], [MANAGED_TARGET]);
		vi.mocked(api.post).mockResolvedValueOnce({
			ok: false,
			code: "unavailable",
			message: "群不存在",
		});
		fireEvent.click(await screen.findByRole("button", { name: "发送测试" }));
		await waitFor(() => expect(screen.getByText("失败:群不存在")).toBeTruthy());
	});
});

it.each([
	[
		{ ok: true, latencyMs: 12 },
		"Connected · 12ms",
		"接続できました · 12ms",
		"已連通 · 12ms",
		"Connected",
		"接続済み",
		"已連通",
	],
	[
		{ ok: false, code: "unavailable", message: "原始诊断" },
		"Failed: 原始诊断",
		"失敗: 原始诊断",
		"失敗：原始诊断",
		"Failed",
		"失敗",
		"失敗",
	],
] as const)(
	"connection test feedback follows the current language without probing again (%s)",
	async (response, en, ja, tw, enButton, jaButton, twButton) => {
		i18n.set({ locale: "en", voice: "plain" });
		renderPage([ONEBOT_CONNECTION], []);
		vi.mocked(api.post).mockResolvedValueOnce(response);
		fireEvent.click(await screen.findByRole("button", { name: "Test" }));
		await screen.findByText(en);
		for (const [locale, text, button] of [
			["ja", ja, jaButton],
			["zh-TW", tw, twButton],
			["en", en, enButton],
		] as const) {
			act(() => i18n.set({ locale }));
			expect(screen.getByText(text)).toBeTruthy();
			expect(screen.getByRole("button", { name: button })).toBeTruthy();
			expect(screen.getByRole("region", { name: "家里那台 OneBot" })).toBeTruthy();
		}
		expect(api.post).toHaveBeenCalledOnce();
		expect(api.post).toHaveBeenCalledWith(`/api/connections/${ONEBOT_ID}/probe`, {});
		expect(api.put).not.toHaveBeenCalled();
		expect(api.delete).not.toHaveBeenCalled();
	},
);

it("endpoint delivery feedback translates while retaining the managed target and sending only once", async () => {
	i18n.set({ locale: "en", voice: "plain" });
	renderPage([WEBHOOK_CONNECTION], [MANAGED_TARGET]);
	vi.mocked(api.post).mockResolvedValueOnce({ ok: true, latencyMs: 34 });
	fireEvent.click(await screen.findByRole("button", { name: "Send test" }));
	await screen.findByText("Delivered · 34ms");
	for (const [locale, text, button] of [
		["ja", "配信できました · 34ms", "配信済み"],
		["zh-TW", "已送達 · 34ms", "已送達"],
		["en", "Delivered · 34ms", "Delivered"],
	] as const) {
		act(() => i18n.set({ locale }));
		expect(screen.getByText(text)).toBeTruthy();
		expect(screen.getAllByRole("button", { name: button }).length).toBeGreaterThan(0);
		expect(screen.getByRole("region", { name: "飞书群机器人" })).toBeTruthy();
	}
	expect(api.post).toHaveBeenCalledOnce();
	expect(api.post).toHaveBeenCalledWith(`/api/targets/${MANAGED_TARGET.id}/test`, { kind: "text" });
});

it("connection lists and stored target status translate without changing the selected connection or raw addresses", async () => {
	i18n.set({ locale: "en", voice: "plain" });
	const second = {
		...ONEBOT_CONNECTION,
		id: WEBHOOK_ID,
		name: "原连接乙",
		probeState: { status: "unreachable", message: "原连接诊断" },
	} as Connection;
	const target = (
		id: string,
		connectionId: string,
		name: string,
		address: string,
		reachability: unknown,
	) =>
		({
			id,
			connectionId,
			name,
			address,
			kind: "session",
			scope: "group",
			enabled: true,
			reachability,
		}) as PushTarget;
	renderPage(
		[ONEBOT_CONNECTION, second],
		[
			target("t1", ONEBOT_ID, "原目标甲", "raw-group-one", { status: "reachable", latencyMs: 3 }),
			target("t2", WEBHOOK_ID, "原目标乙", "raw-group-two", {
				status: "unreachable",
				message: "原目标诊断",
			}),
			target("t3", WEBHOOK_ID, "原目标丙", "raw-group-three", {
				status: "reachable",
				latencyMs: 17,
			}),
		],
	);
	await screen.findByText("Push connections");
	expect(await screen.findByText(/ · 1 target$/)).toBeTruthy();
	expect(await screen.findByText(/ · 2 targets$/)).toBeTruthy();
	const connectionButton = screen.getAllByRole("button", { name: /原连接乙/ })[0];
	if (!connectionButton) throw new Error("The second connection is missing");
	fireEvent.click(connectionButton);
	const selected = screen.getByRole("region", { name: "原连接乙" });
	for (const [locale, title, lastProbe, lastFailure, lastSuccess, group] of [
		[
			"ja",
			"プッシュ接続",
			"前回の接続テスト失敗 — 原连接诊断",
			"前回の配信失敗 — 原目标诊断",
			"前回の配信成功 · 17ms",
			"グループ",
		],
		[
			"zh-TW",
			"推播連線",
			"上次測試失敗 — 原连接诊断",
			"上次推播失敗 — 原目标诊断",
			"上次推播成功 · 17ms",
			"群組",
		],
		[
			"en",
			"Push connections",
			"Last test failed — 原连接诊断",
			"Last push failed — 原目标诊断",
			"Last push succeeded · 17ms",
			"Group",
		],
	] as const) {
		act(() => i18n.set({ locale }));
		expect(screen.getByText(title)).toBeTruthy();
		expect(screen.getByRole("region", { name: "原连接乙" })).toBe(selected);
		expect(screen.getByText(lastProbe)).toBeTruthy();
		expect(screen.getByText(lastFailure)).toBeTruthy();
		expect(screen.getByText(lastSuccess)).toBeTruthy();
		expect(screen.getAllByText(group).length).toBeGreaterThan(0);
		expect(screen.getByText(/raw-group-two/)).toBeTruthy();
		expect(screen.getByText("原目标乙")).toBeTruthy();
	}
	expect(api.post).not.toHaveBeenCalled();
	expect(api.put).not.toHaveBeenCalled();
	expect(api.delete).not.toHaveBeenCalled();
});

it("a managed endpoint without its target translates its guidance and does not send a test to an absent target", async () => {
	i18n.set({ locale: "en", voice: "plain" });
	renderPage([WEBHOOK_CONNECTION], []);
	fireEvent.click(await screen.findByRole("button", { name: "Send test" }));
	for (const [locale, title, empty, warning] of [
		[
			"en",
			"One-way delivery target",
			"Saving the connection creates its default delivery target automatically.",
			"Save the connection first; the system will create a default delivery target automatically.",
		],
		[
			"ja",
			"一方向の送信先",
			"接続を保存すると、標準の送信先が自動作成されます。",
			"先に接続を保存してください。標準の送信先が自動作成されます。",
		],
		[
			"zh-TW",
			"單向投遞目標",
			"儲存連線後，系統會自動建立預設投遞目標。",
			"請先儲存連線，系統會自動建立預設投遞目標。",
		],
	] as const) {
		act(() => i18n.set({ locale }));
		expect(await screen.findByText(warning)).toBeTruthy();
		expect(screen.getByText(title)).toBeTruthy();
		expect(screen.getByText(empty)).toBeTruthy();
		expect(screen.getByRole("region", { name: "飞书群机器人" })).toBeTruthy();
	}
	expect(api.post).not.toHaveBeenCalled();
	expect(api.delete).not.toHaveBeenCalled();
});

it("empty connection guidance follows the language without creating resources", async () => {
	i18n.set({ locale: "en", voice: "plain" });
	renderPage([], []);
	for (const [locale, title, hint, button] of [
		[
			"en",
			"No connections",
			"Create a connection, then configure push targets for it.",
			"+ New connection",
		],
		[
			"ja",
			"接続がありません",
			"先に接続を作成してから、送信先を設定してください。",
			"+ 接続を追加",
		],
		["zh-TW", "尚無連線", "請先新增連線，再設定它的推播目標。", "+ 新增連線"],
	] as const) {
		act(() => i18n.set({ locale }));
		expect(await screen.findByText(title)).toBeTruthy();
		expect(screen.getByText(hint)).toBeTruthy();
		expect(screen.getByRole("button", { name: button })).toBeTruthy();
	}
	expect(api.post).not.toHaveBeenCalled();
	expect(api.put).not.toHaveBeenCalled();
});

it.each(["connection", "target", "managed"] as const)(
	"translated %s removal confirmation preserves its subject and cancellation sends no request",
	async (kind) => {
		i18n.set({ locale: "en", voice: "plain" });
		const target = {
			id: MANAGED_TARGET.id,
			name: "原目标甲",
			connectionId: ONEBOT_ID,
			kind: "session",
			scope: "group",
			address: "10001",
			enabled: true,
		} as PushTarget;
		const managed = kind === "managed";
		renderPage(
			managed ? [WEBHOOK_CONNECTION] : [ONEBOT_CONNECTION],
			managed ? [MANAGED_TARGET] : [target],
		);
		const subject =
			kind === "target" ? "原目标甲" : managed ? WEBHOOK_CONNECTION.name : ONEBOT_CONNECTION.name;
		const header = await screen.findByRole("region", {
			name: managed ? WEBHOOK_CONNECTION.name : ONEBOT_CONNECTION.name,
		});
		const headerDelete = within(header).getByRole("button", { name: "Delete" });
		const button =
			kind === "target"
				? screen.getAllByRole("button", { name: "Delete" }).find((b) => b !== headerDelete)
				: headerDelete;
		if (!button) throw new Error("Removal button missing");
		fireEvent.click(button);
		const dialog = await screen.findByRole("dialog");

		const hints = {
			en: {
				managed:
					"This connection’s managed targets will also be deleted, and subscription references will be cleared.",
				connection:
					"Deletion fails while push targets reference this connection. Delete those targets first.",
				target:
					"References in subscription routes will become empty, so pushes will skip this target.",
			},
			ja: {
				managed: "この接続が管理する送信先も削除され、購読側の参照も解除されます。",
				connection:
					"送信先から参照されている接続は削除できません。先に該当する送信先を削除してください。",
				target: "購読ルートの参照先が空になり、この送信先への配信はスキップされます。",
			},
			"zh-TW": {
				managed: "此連線的系統管理目標也會一併刪除，並清除訂閱中的引用。",
				connection: "此連線仍被推播目標使用時無法刪除，請先刪除那些目標。",
				target: "訂閱路由中對此目標的引用將變成空引用，推播會略過它。",
			},
		};

		for (const [locale, connectionTitle, targetTitle, confirm, cancel] of [
			["en", "Delete connection", "Delete push target", "Confirm removal", "Cancel"],
			["ja", "接続を削除", "送信先を削除", "削除を確認", "キャンセル"],
			["zh-TW", "刪除連線", "刪除推播目標", "確認移除", "取消"],
		] as const) {
			act(() => i18n.set({ locale }));
			expect(
				within(dialog).getByText(kind === "target" ? targetTitle : connectionTitle),
			).toBeTruthy();
			expect(within(dialog).getByText(subject)).toBeTruthy();
			expect(dialog.textContent).toContain(hints[locale][kind]);
			expect(within(dialog).getByRole("button", { name: confirm })).toBeTruthy();
			expect(within(dialog).getByRole("button", { name: cancel })).toBeTruthy();
			expect(api.delete).not.toHaveBeenCalled();
		}
		fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(api.delete).not.toHaveBeenCalled();
	},
);

it("translated test confirmation keeps raw recipients and sends only after explicit confirmation", async () => {
	i18n.set({ locale: "en", voice: "plain" });
	const target = {
		id: MANAGED_TARGET.id,
		name: "原目标甲",
		connectionId: ONEBOT_ID,
		kind: "session",
		scope: "group",
		address: "10001",
		enabled: true,
	} as PushTarget;
	renderPage([ONEBOT_CONNECTION], [target]);
	vi.mocked(api.post).mockResolvedValueOnce({ ok: true, latencyMs: 7 });
	fireEvent.click(await screen.findByTitle("Send a real test message to this target"));
	const dialog = await screen.findByRole("dialog");
	for (const [locale, title, sample, send] of [
		["en", "Send a test push?", "[bilibili-notify] Test push delivered ✓", "Send"],
		["ja", "テスト通知を送信しますか？", "[bilibili-notify] テスト通知が届きました ✓", "送信"],
		["zh-TW", "傳送測試推播？", "[bilibili-notify] 測試推播已送達 ✓", "傳送"],
	] as const) {
		act(() => i18n.set({ locale }));
		expect(within(dialog).getByText(title)).toBeTruthy();
		expect(within(dialog).getByText(sample)).toBeTruthy();
		expect(within(dialog).getByText("原目标甲")).toBeTruthy();
		expect(within(dialog).getByText("家里那台 OneBot")).toBeTruthy();
		expect(within(dialog).getByRole("button", { name: send })).toBeTruthy();
		expect(api.post).not.toHaveBeenCalled();
	}
	fireEvent.click(within(dialog).getByRole("button", { name: "傳送" }));
	await screen.findByText("已送達 · 7ms");
	expect(api.post).toHaveBeenCalledOnce();
	expect(api.post).toHaveBeenCalledWith(`/api/targets/${target.id}/test`, { kind: "text" });
});

it("a connection without session types translates the refusal and never creates a target", async () => {
	i18n.set({ locale: "en", voice: "plain" });
	const connection = {
		...ONEBOT_CONNECTION,
		platformSnapshot: { ...ONEBOT_CONNECTION.platformSnapshot, scopes: [] },
	};
	renderPage([connection], []);
	fireEvent.click(
		(await screen.findAllByRole("button", { name: "+ New push target" }))[0] as HTMLElement,
	);
	for (const [locale, message] of [
		[
			"en",
			"This connection declares no available session types, so a target cannot be created yet.",
		],
		["ja", "この接続には利用可能なセッション種別が宣言されていないため、送信先を作成できません。"],
		["zh-TW", "此連線未宣告可用的會話類型，目前無法新增目標。"],
	] as const) {
		act(() => i18n.set({ locale }));
		expect(await screen.findByText(message)).toBeTruthy();
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(api.post).not.toHaveBeenCalled();
	}
});
