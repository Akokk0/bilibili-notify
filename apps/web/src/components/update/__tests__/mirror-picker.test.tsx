// @vitest-environment jsdom
/**
 * 下载加速站的选择表 —— 照 OpenClash 的骨架:直连打头、内置几个候选、末尾一行自定义;
 * 每行能看到测出来的延迟与「通过它拿到的清单版本」,选一个用。
 *
 * 默认直连、只能选一个:选中的先试,直连永远垫底(链路那头没变)。
 */

import { BUILTIN_UPDATE_MIRRORS, type MirrorProbeResult } from "@bilibili-notify/contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { MirrorPicker } from "../mirror-picker";

vi.mock("../../../services/api", () => ({
	api: { get: vi.fn(), post: vi.fn(), patch: vi.fn() },
	ApiError: class extends Error {},
}));

import { api } from "../../../services/api";

function renderPicker(props: { active?: string; disabled?: boolean } = {}) {
	const onSelect = vi.fn();
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(
		<QueryClientProvider client={qc}>
			<MirrorPicker active={props.active ?? ""} onSelect={onSelect} disabled={props.disabled} />
		</QueryClientProvider>,
	);
	return { onSelect };
}

function row(prefix: string): HTMLElement {
	const el = document.querySelector(`[data-mirror="${prefix}"]`);
	if (!(el instanceof HTMLElement)) throw new Error(`没有这一行:${prefix || "(直连)"}`);
	return el;
}

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("内置名单", () => {
	it("五到六个、都是 https:// 前缀、不重复、不含直连 —— 直连是表里固定的第一行,不进名单", () => {
		expect(BUILTIN_UPDATE_MIRRORS.length).toBeGreaterThanOrEqual(5);
		expect(BUILTIN_UPDATE_MIRRORS.length).toBeLessThanOrEqual(6);
		expect(new Set(BUILTIN_UPDATE_MIRRORS).size).toBe(BUILTIN_UPDATE_MIRRORS.length);
		for (const p of BUILTIN_UPDATE_MIRRORS) expect(p).toMatch(/^https:\/\/[^/]+\/$/);
	});
});

describe("MirrorPicker", () => {
	it("直连打头、内置各一行、末尾自定义;默认直连「使用中」", () => {
		renderPicker();

		expect(within(row("")).getByText("直连")).toBeTruthy();
		expect(within(row("")).getByRole("button", { name: "使用中" })).toBeTruthy();
		for (const p of BUILTIN_UPDATE_MIRRORS) {
			expect(within(row(p)).getByText(new URL(p).host)).toBeTruthy();
			expect(within(row(p)).getByRole("button", { name: "选用" })).toBeTruthy();
		}
		expect(screen.getByPlaceholderText(/^https:\/\//)).toBeTruthy();
	});

	it("点某个内置站的「选用」→ 交出那个前缀", async () => {
		const { onSelect } = renderPicker();
		const target = BUILTIN_UPDATE_MIRRORS[1] as string;

		await userEvent.click(within(row(target)).getByRole("button", { name: "选用" }));

		expect(onSelect).toHaveBeenCalledWith(target);
	});

	it("在用的是内置站 → 那行「使用中」,直连那行退回「选用」;点直连交出空串", async () => {
		const target = BUILTIN_UPDATE_MIRRORS[0] as string;
		const { onSelect } = renderPicker({ active: target });

		expect(within(row(target)).getByRole("button", { name: "使用中" })).toBeTruthy();
		await userEvent.click(within(row("")).getByRole("button", { name: "选用" }));

		expect(onSelect).toHaveBeenCalledWith("");
	});

	it("「测一遍」把直连 + 内置 + 有效的自定义一起送去测,结果逐行落座", async () => {
		const results: MirrorProbeResult[] = [
			{ prefix: "", ok: true, ms: 406, version: "0.9.0" },
			{ prefix: BUILTIN_UPDATE_MIRRORS[0] as string, ok: false, ms: 10_000, reason: "unreachable" },
			{ prefix: BUILTIN_UPDATE_MIRRORS[1] as string, ok: false, ms: 300, reason: "untrusted" },
			{ prefix: "https://my.mirror.example/", ok: true, ms: 120, version: "0.8.0" },
		];
		vi.mocked(api.post).mockResolvedValue({ results });
		renderPicker();
		await userEvent.type(screen.getByPlaceholderText(/^https:\/\//), "https://my.mirror.example/");

		await userEvent.click(screen.getByRole("button", { name: "测一遍" }));

		await waitFor(() => expect(within(row("")).getByText("406 ms")).toBeTruthy());
		expect(api.post).toHaveBeenCalledWith("/api/update/mirrors/probe", {
			prefixes: ["", ...BUILTIN_UPDATE_MIRRORS, "https://my.mirror.example/"],
		});
		expect(within(row("")).getByText("0.9.0")).toBeTruthy();
		expect(within(row(BUILTIN_UPDATE_MIRRORS[0] as string)).getByText("无法访问")).toBeTruthy();
		// 改了内容的站不能和「连不上」混成一句 —— 这是唯一该让人警觉的一种。
		expect(within(row(BUILTIN_UPDATE_MIRRORS[1] as string)).getByText("签名验不过")).toBeTruthy();
		expect(within(row("https://my.mirror.example/")).getByText("120 ms")).toBeTruthy();
		expect(within(row("https://my.mirror.example/")).getByText("0.8.0")).toBeTruthy();
	});

	it("自定义:填了 https 前缀才能选,选了交出它;不是 https 的按不动", async () => {
		const { onSelect } = renderPicker();
		const input = screen.getByPlaceholderText(/^https:\/\//);

		await userEvent.type(input, "http://plain.example/");
		expect(
			within(row("http://plain.example/")).getByRole("button", { name: "选用" }),
		).toHaveProperty("disabled", true);

		await userEvent.clear(input);
		await userEvent.type(input, "https://my.mirror.example/");
		await userEvent.click(
			within(row("https://my.mirror.example/")).getByRole("button", { name: "选用" }),
		);

		expect(onSelect).toHaveBeenCalledWith("https://my.mirror.example/");
	});

	it("在用的是自定义前缀 → 输入框预填、那行「使用中」", () => {
		renderPicker({ active: "https://my.mirror.example/" });

		expect(screen.getByPlaceholderText(/^https:\/\//)).toHaveProperty(
			"value",
			"https://my.mirror.example/",
		);
		expect(
			within(row("https://my.mirror.example/")).getByRole("button", { name: "使用中" }),
		).toBeTruthy();
	});

	it("自定义还空着时,它的行身份不和直连撞车", () => {
		renderPicker();
		expect(document.querySelectorAll('[data-mirror=""]')).toHaveLength(1);
		expect(row("custom")).toBeTruthy();
	});

	it("功能关着 → 测不了也选不了", () => {
		renderPicker({ disabled: true });

		expect(screen.getByRole("button", { name: "测一遍" })).toHaveProperty("disabled", true);
		for (const b of screen.getAllByRole("button", { name: "选用" }))
			expect(b).toHaveProperty("disabled", true);
	});
});
