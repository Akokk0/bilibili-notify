// @vitest-environment jsdom
/**
 * 周报排程表单的「发送到」—— 与链接解析白名单共用同一个目标选择器、同一条规矩:
 * 停用的目标**照列照勾**并标「已停用」(主人定的:两处行为一致,停用是暂停不是消失)。
 * 以前这里把停用的目标过滤掉,用户看不出它还勾在配置里。
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	act,
	cleanup,
	fireEvent,
	render,
	renderHook,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { i18n } from "../../../i18n";
import type { Connection, PushTarget } from "../../../types/domain";
import {
	RoastScheduleFields,
	type RoastScheduleValue,
	useApprovalReachability,
} from "../RoastScheduleFields";

vi.mock("../../../services/api", () => ({
	api: { get: vi.fn(), post: vi.fn(), patch: vi.fn() },
	ApiError: class extends Error {},
}));

import { api } from "../../../services/api";

const T_ON = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const T_OFF = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function target(id: string, name: string, enabled: boolean): PushTarget {
	return {
		id,
		name,
		connectionId: "11111111-1111-4111-8111-111111111111",
		scope: "group",
		enabled,
		kind: "session",
		address: "123",
	} as PushTarget;
}

/** 目标的平台取自这条连接(目标都挂在它上面)。 */
const connections = [
	{
		id: "11111111-1111-4111-8111-111111111111",
		adapterKey: "onebot",
		platform: "onebot",
		enabled: true,
	},
] as Connection[];

const VALUE: RoastScheduleValue = {
	enabled: true,
	cron: "0 9 * * 1",
	days: 7,
	targets: [T_ON],
	approval: false,
	notifyOnError: true,
};

function renderFields(onChange = vi.fn(), masterTargetId?: string) {
	vi.mocked(api.get).mockImplementation(async (path: string) => {
		if (path === "/api/targets") return [target(T_ON, "群 A", true), target(T_OFF, "群 B", false)];
		if (path === "/api/settings") return { core: { master: { targetId: masterTargetId } } };
		if (path === "/api/connections") return connections;
		if (path === "/api/connections/capabilities") return {};
		throw new Error(`unexpected GET ${path}`);
	});
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(
		<QueryClientProvider client={qc}>
			<RoastScheduleFields value={VALUE} onChange={onChange} noun="周报" />
		</QueryClientProvider>,
	);
	return onChange;
}

beforeEach(() => {
	vi.clearAllMocks();
	i18n.set({ locale: "zh-CN", voice: "plain" });
});

afterEach(cleanup);

describe("RoastScheduleFields — 发送到", () => {
	it("停用的目标也列出来并标「已停用」,点它照样勾进 targets", async () => {
		const onChange = renderFields();
		const chip = await screen.findByRole("button", { name: /群 B/ });
		expect(within(chip).getByText("已停用")).toBeTruthy();
		fireEvent.click(chip);
		expect(onChange).toHaveBeenCalledWith({ ...VALUE, targets: [T_ON, T_OFF] });
	});

	it("再点已勾的目标 → 从 targets 里去掉", async () => {
		const onChange = renderFields();
		fireEvent.click(await screen.findByRole("button", { name: /群 A/ }));
		expect(onChange).toHaveBeenCalledWith({ ...VALUE, targets: [] });
	});
});

describe("useApprovalReachability — 主人目标得是私聊才能开审批", () => {
	function reachability(masterTargetId: string, targets: PushTarget[]) {
		vi.mocked(api.get).mockImplementation(async (path: string) => {
			if (path === "/api/targets") return targets;
			if (path === "/api/connections") return connections;
			if (path === "/api/settings") return { core: { master: { targetId: masterTargetId } } };
			// 能力表:这条 onebot 连接收得到主人的回复。
			if (path === "/api/connections/capabilities") {
				const supported = { state: "supported", checkedAt: "2026-10-26T00:00:00.000Z" };
				return {
					"11111111-1111-4111-8111-111111111111": {
						atAll: supported,
						inbound: supported,
						nativeShare: { state: "unknown" },
					},
				};
			}
			throw new Error(`unexpected GET ${path}`);
		});
		const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		return renderHook(() => useApprovalReachability(), {
			wrapper: ({ children }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>,
		});
	}

	it("主人目标是私聊的 onebot 目标 → 能开", async () => {
		const priv = { ...target(T_ON, "主人", true), scope: "private" } as PushTarget;
		const { result } = reachability(T_ON, [priv]);
		await waitFor(() => expect(result.current.canApprove).toBe(true));
	});

	it("主人目标指向群(存量遗留)→ 不能开,理由是「不是私聊」", async () => {
		const { result } = reachability(T_ON, [target(T_ON, "群 A", true)]);
		await waitFor(() => expect(result.current.hint).toMatch(/不是私聊/));
		expect(result.current.canApprove).toBe(false);
	});
});

it("schedule labels change language without resetting an edited cron, custom window or selected disabled target", async () => {
	i18n.set({ locale: "en", voice: "plain" });
	vi.mocked(api.get).mockImplementation(async (path) => {
		if (path === "/api/targets")
			return [target(T_ON, "原群甲", true), target(T_OFF, "原群乙", false)];
		if (path === "/api/settings") return { core: { master: {} } };
		if (path === "/api/connections") return connections;
		if (path === "/api/connections/capabilities") return {};
		throw new Error(`unexpected GET ${path}`);
	});
	const onChange = vi.fn();
	function Draft() {
		const [value, setValue] = useState({ ...VALUE, days: 14, targets: [T_ON, T_OFF] });
		return (
			<RoastScheduleFields
				value={value}
				noun="raw-report"
				onChange={(next) => {
					setValue(next);
					onChange(next);
				}}
			/>
		);
	}
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(
		<QueryClientProvider client={qc}>
			<Draft />
		</QueryClientProvider>,
	);
	expect(screen.getByText("Send time")).toBeTruthy();
	const cron = screen.getByRole("textbox");
	fireEvent.change(cron, { target: { value: "0 10 * * 2" } });
	await screen.findByRole("button", { name: /原群乙/ });
	onChange.mockClear();
	for (const [locale, label, custom, approval, errorHint] of [
		[
			"ja",
			"送信時刻",
			"過去14日間",
			"送信前に承認する",
			"先に「システム」で管理者の個別チャット送信先を設定してください。",
		],
		["zh-TW", "發送時間", "近14日", "發送前先給我確認", "請先在「系統」設定主人的私訊目標"],
		[
			"en",
			"Send time",
			"Past 14 days",
			"Approve before sending",
			"Configure the owner’s private-message target in System first.",
		],
	] as const) {
		act(() => i18n.set({ locale }));
		expect(screen.getByText(label)).toBeTruthy();
		expect(screen.getByRole("button", { name: custom })).toBeTruthy();
		expect(screen.getByRole("button", { name: approval }).hasAttribute("disabled")).toBe(true);
		expect(screen.getByText(errorHint)).toBeTruthy();
		expect(screen.getByRole("textbox")).toBe(cron);
		expect((cron as HTMLInputElement).value).toBe("0 10 * * 2");
		expect(screen.getByRole("button", { name: /原群乙/ })).toBeTruthy();
		expect(onChange).not.toHaveBeenCalled();
	}
	fireEvent.click(screen.getByRole("button", { name: /原群乙/ }));
	expect(onChange).toHaveBeenLastCalledWith({
		...VALUE,
		cron: "0 10 * * 2",
		days: 14,
		targets: [T_ON],
	});
	expect(api.post).not.toHaveBeenCalled();
	expect(api.patch).not.toHaveBeenCalled();
});

it.each([
	[
		"ja",
		"ご主人様、この送信先は個別チャットではないので、メイドからこっそりお知らせできません。個別チャットの送信先を選んでくださいね。",
		"ご主人様、複数のグループを選べますよ。1件の送信に失敗しても、ほかのグループへの送信は続けます。選択済みでも無効な送信先には送らず、再び有効にしたら自動で対象に戻ります。",
		"ご主人様、生成に失敗したとき、送信先が未設定のとき、グループへ送れなかったときは、個別チャットで理由をお伝えしますね。",
	],
	[
		"zh-TW",
		"這個目標不是私訊，女僕沒辦法悄悄告訴主人喔，請換成私訊目標。",
		"主人，可以選好幾個群組喔；一個群組傳送失敗，不影響其他群組。已停用的目標就算勾著也不會傳送，重新啟用後會自動生效。",
		"主人，產生失敗、沒有設定目標，或群組傳送失敗時，都會私訊告訴您原因喔。",
	],
] as const)(
	"%s 女仆排程提示保留原目标和时间，群目标不能开启私聊审批",
	async (locale, privateHint, targetsHint, errorsHint) => {
		const onChange = renderFields(vi.fn(), T_ON);
		await screen.findByText(/不是私聊/);
		act(() => i18n.set({ locale, voice: "maid" }));
		for (const hint of [privateHint, targetsHint, errorsHint])
			expect(screen.getByText(hint)).toBeTruthy();
		const approval = screen.getByRole("button", {
			name: locale === "ja" ? "送信前に承認する" : "發送前先給我確認",
		}) as HTMLButtonElement;
		expect(approval.disabled).toBe(true);
		expect(approval.getAttribute("aria-pressed")).toBe("false");
		fireEvent.click(approval);
		expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("0 9 * * 1");
		expect(screen.getByRole("button", { name: /群 A/ })).toBeTruthy();
		expect(screen.getByRole("button", { name: /群 B/ })).toBeTruthy();
		expect(onChange).not.toHaveBeenCalled();
		expect(api.post).not.toHaveBeenCalled();
		expect(api.patch).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: /群 B/ }));
		expect(onChange).toHaveBeenCalledExactlyOnceWith({ ...VALUE, targets: [T_ON, T_OFF] });
	},
);
