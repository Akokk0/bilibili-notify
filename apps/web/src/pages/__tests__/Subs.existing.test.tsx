// @vitest-environment jsdom

/**
 * 「添加 UP 主」判「已订阅」—— 按订阅的身份(来源 + 来源那头的 id)。
 *
 * 订阅这一侧按身份建索引;B 站的输入 / 查到的 / 搜到的 uid 换成「B 站来源 + uid」去查,拓展的
 * 候选换成「那个拓展 + 候选 id」去查。三处 B 站入口(输入框的重复提示、UID 预览、搜索结果行)
 * 与拓展候选行(`Subs.platform.test.tsx` 已钉)说的是同一个「已订阅」。
 *
 * **绝不跨来源**:拓展订阅的外部 id 恰好等于某个 uid、或 B 站订阅的 uid 恰好等于某个拓展候选
 * 的 id,都不算已订阅 —— 那是另一个平台上的另一个人。
 */

import type { ExtensionDTO } from "@bilibili-notify/contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
	makeEmptyExtensionSubscription,
	makeEmptySubscription,
	type Subscription,
} from "../../types/domain";
import Subs from "../Subs";

vi.mock("../../services/api", () => ({
	api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
	ApiError: class ApiError extends Error {},
}));

import { api } from "../../services/api";

const profileOf = (uid: string, name: string) => ({ uid, name, avatar: "", sign: "", fans: 5 });

/** 列表里那张订阅卡的名字,换掉默认的「UID xxx」,好认。 */
const named = (sub: Subscription, name: string): Subscription => ({
	...sub,
	cachedProfile: { name, avatar: "", sign: "", fans: 0, lastRefreshedAt: "t" },
});

const BILI = named(makeEmptySubscription("111"), "UP甲");

function douyin(): ExtensionDTO {
	return {
		id: "douyin",
		name: "抖音订阅",
		dir: "/data/extensions/douyin",
		enabled: true,
		state: "running",
		apiVersion: 2,
		provides: ["subscription"],
		subscription: {
			display: { label: "抖音", shortLabel: "抖音", color: "#161823", postNoun: "作品" },
			events: ["post", "liveStart"],
		},
	};
}

let subs: Subscription[];
let extensions: ExtensionDTO[];

beforeEach(() => {
	subs = [BILI];
	extensions = [];
	(api.get as ReturnType<typeof vi.fn>).mockImplementation((path: string) => {
		if (path.startsWith("/api/subs/lookup")) {
			// 不论查谁,都回那个 uid 的资料:名字与列表里那张卡不同,免得认混。
			const uid = new URL(path, "http://x").searchParams.get("uid") ?? "";
			return Promise.resolve(profileOf(uid, `查到的 ${uid}`));
		}
		if (path.startsWith("/api/subs/search")) {
			return Promise.resolve({
				results: [profileOf("111", "搜到的甲"), profileOf("222", "搜到的乙")],
				page: 1,
				pageSize: 5,
				total: 2,
			});
		}
		if (path.startsWith("/api/subs")) return Promise.resolve(subs);
		if (path === "/api/ext") return Promise.resolve({ extensions });
		if (path.startsWith("/api/ext/douyin/lookup")) {
			return Promise.resolve({
				candidates: [
					{ id: "111", name: "抖音同号" },
					{ id: "sec-9", name: "抖音别人" },
				],
			});
		}
		return Promise.resolve([]);
	});
	(api.post as ReturnType<typeof vi.fn>).mockResolvedValue([]);
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

/** 打开「添加 UP 主」,等拓展列表回来(平台选择要它)。 */
async function openNewDialog() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(
		<QueryClientProvider client={qc}>
			<MemoryRouter initialEntries={["/subs"]}>
				<Subs />
			</MemoryRouter>
		</QueryClientProvider>,
	);
	await screen.findByText("UP甲");
	await waitFor(() => expect(api.get).toHaveBeenCalledWith("/api/ext"));
	fireEvent.click(screen.getAllByText("添加")[0] as HTMLElement);
	await screen.findByText(/选定后进入配置表单/);
	return within(screen.getByRole("dialog"));
}

const DUPLICATE_WARNING = "该 UID 已经在订阅列表中,无需重复添加";

describe("B 站这一支:订阅过的 uid 是已订阅", () => {
	it("输入框里敲的 uid 订阅过了 → 提示重复;没订阅过的不提示", async () => {
		const dialog = await openNewDialog();
		const input = screen.getByPlaceholderText("搜索 UID 或 UP 主名字");
		fireEvent.change(input, { target: { value: "111" } });
		expect(dialog.getByText(DUPLICATE_WARNING)).toBeTruthy();
		fireEvent.change(input, { target: { value: "999" } });
		expect(dialog.queryByText(DUPLICATE_WARNING)).toBeNull();
	});

	it("按 UID 查到订阅过的人 → 预览标「已订阅」、「下一步」灰着;没订阅过的可以下一步", async () => {
		const dialog = await openNewDialog();
		const input = screen.getByPlaceholderText("搜索 UID 或 UP 主名字");

		fireEvent.change(input, { target: { value: "111" } });
		fireEvent.click(dialog.getByRole("button", { name: "查询" }));
		await dialog.findByText("查到的 111");
		expect(dialog.getByText("已订阅")).toBeTruthy();
		expect((dialog.getByRole("button", { name: "下一步" }) as HTMLButtonElement).disabled).toBe(
			true,
		);

		fireEvent.change(input, { target: { value: "999" } });
		fireEvent.click(dialog.getByRole("button", { name: "查询" }));
		await dialog.findByText("查到的 999");
		expect(dialog.queryByText("已订阅")).toBeNull();
		expect((dialog.getByRole("button", { name: "下一步" }) as HTMLButtonElement).disabled).toBe(
			false,
		);
	});

	it("按名字搜 → 订阅过的那一行标「已订阅」、点不了;别的行可以点", async () => {
		const dialog = await openNewDialog();
		fireEvent.change(screen.getByPlaceholderText("搜索 UID 或 UP 主名字"), {
			target: { value: "阿婆" },
		});
		fireEvent.click(dialog.getByRole("button", { name: "搜索" }));

		const taken = await dialog.findByRole("button", { name: /搜到的甲/ });
		expect((taken as HTMLButtonElement).disabled).toBe(true);
		expect(within(taken).getByText("已订阅")).toBeTruthy();
		const fresh = dialog.getByRole("button", { name: /搜到的乙/ });
		expect((fresh as HTMLButtonElement).disabled).toBe(false);
		expect(within(fresh).queryByText("已订阅")).toBeNull();
	});
});

describe("绝不跨来源", () => {
	it("拓展订阅的外部 id 恰好等于输入的 uid → 不算已订阅(输入框、搜索结果行都不拦)", async () => {
		subs = [BILI, named(makeEmptyExtensionSubscription("douyin", "222"), "抖音乙")];
		const dialog = await openNewDialog();
		const input = screen.getByPlaceholderText("搜索 UID 或 UP 主名字");

		fireEvent.change(input, { target: { value: "222" } });
		expect(dialog.queryByText(DUPLICATE_WARNING)).toBeNull();

		fireEvent.change(input, { target: { value: "阿婆" } });
		fireEvent.click(dialog.getByRole("button", { name: "搜索" }));
		const row = await dialog.findByRole("button", { name: /搜到的乙/ });
		expect((row as HTMLButtonElement).disabled).toBe(false);
		expect(within(row).queryByText("已订阅")).toBeNull();
	});

	it("B 站订阅的 uid 恰好等于拓展候选的 id → 候选不算已订阅", async () => {
		extensions = [douyin()];
		const dialog = await openNewDialog();
		fireEvent.click(await dialog.findByRole("button", { name: "抖音" }));
		fireEvent.change(screen.getByPlaceholderText("输入主页链接或账号 id"), {
			target: { value: "https://v.douyin.com/abc/" },
		});
		fireEvent.click(dialog.getByRole("button", { name: "查找" }));

		// 候选「抖音同号」的 id 是 111,与那条 B 站订阅的 uid 相同 —— 另一个平台上的另一个人。
		const sameNumber = await dialog.findByRole("button", { name: /抖音同号/ });
		expect((sameNumber as HTMLButtonElement).disabled).toBe(false);
		expect(within(sameNumber).queryByText("已订阅")).toBeNull();
	});
});
