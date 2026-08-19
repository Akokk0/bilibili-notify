// @vitest-environment jsdom

/**
 * 皮肤库 section 的行为:深浅两个换装 Picker(forms.tsx 的分段按钮组;
 * 各列具备该模式的皮肤+默认装,选中即 PUT 单槽)、试穿(只写 preview,注入由
 * SkinRoot 负责)、导出。上传/组包走 services 层已测的纯函数。
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EMPTY_SLOTS, useSkinStore } from "../../../store/skin";
import { SkinSection } from "../SkinSection";

const H = vi.hoisted(() => ({
	list: {
		list: [
			{
				id: "s1",
				name: "樱花夜",
				author: "测试",
				modes: ["light", "dark"],
				hasWallpaper: true,
			},
		],
		active: { light: null, dark: null } as { light: string | null; dark: string | null },
	},
	manifest: {
		schemaVersion: 1,
		name: "樱花夜",
		modes: { light: {}, dark: {} },
	},
	putCalls: [] as unknown[],
	/** 上传接口这一次要回的提示(清洗层摘了什么)。 */
	uploadWarnings: [] as string[],
}));

vi.mock("../../../services/api", () => ({
	api: {
		get: vi.fn(async (path: string) => {
			if (path === "/api/skins") return H.list;
			if (path === "/api/skins/active") {
				const slot = (id: string | null) => (id ? { id, manifest: H.manifest } : null);
				return { active: { light: slot(H.list.active.light), dark: slot(H.list.active.dark) } };
			}
			if (path === "/api/skins/s1/manifest") return { manifest: H.manifest, assets: [] };
			throw new Error(`unexpected GET ${path}`);
		}),
		put: vi.fn(async (_path: string, body: unknown) => {
			H.putCalls.push(body);
			// 模拟服务端落槽:整套启用按 modes 占槽;带 theme 的单槽设置;null 清两槽
			const req = body as { id: string | null; theme?: "light" | "dark" };
			if (req.theme) H.list.active[req.theme] = req.id;
			else if (req.id === null) H.list.active = { light: null, dark: null };
			else H.list.active = { light: req.id, dark: req.id };
			return { ok: true };
		}),
		delete: vi.fn(async () => ({ ok: true })),
		upload: vi.fn(async () => ({ ok: true, id: "s1", warnings: H.uploadWarnings })),
	},
}));

function renderSection() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<SkinSection />
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	H.putCalls = [];
	H.uploadWarnings = [];
	H.list.active = { light: null, dark: null };
	H.list.list[0].modes = ["light", "dark"];
	useSkinStore.setState({
		active: EMPTY_SLOTS,
		preview: null,
		killSwitch: false,
		lockedTheme: null,
		editing: false,
	});
});

afterEach(cleanup);

describe("SkinSection", () => {
	function pickerGroup(name: string): HTMLElement {
		return screen.getByRole("group", { name });
	}

	it("制作引导先指路聊天页 —— 女仆自己会做,粘 JSON 那条路已经不是唯一的了", async () => {
		renderSection();
		await waitFor(() => expect(screen.getAllByText("樱花夜").length).toBeGreaterThan(0));
		fireEvent.click(screen.getByText("制作皮肤"));

		await waitFor(() => expect(screen.getByText(/皮肤工坊/)).toBeTruthy());
		// 外部 AI 那条路还在,只是退到了后面。
		expect(screen.getByText("复制提示词")).toBeTruthy();
	});

	it("粘 JSON 传完 → 清洗层的提示落在皮肤库这一页上", async () => {
		// 提示曾经画在弹窗里,而传完那一刻弹窗就关了 —— 那块跟着卸载,主人一个字
		// 也看不到。「哪几句被摘了」正是这条路上最该让人看见的东西。
		H.uploadWarnings = ["属性 pointer-events 不在白名单"];
		renderSection();
		await waitFor(() => expect(screen.getAllByText("樱花夜").length).toBeGreaterThan(0));
		fireEvent.click(screen.getByText("制作皮肤"));

		const ta = await screen.findByPlaceholderText(/skin\.json/);
		fireEvent.change(ta, {
			target: { value: '{"schemaVersion":1,"name":"手工","modes":{"light":{}}}' },
		});
		fireEvent.click(screen.getByText("打包上传"));

		await waitFor(() => expect(screen.getByText(/pointer-events/)).toBeTruthy());
		// 窗确实关了 —— 提示不是靠「没关成」才看得见的。
		expect(screen.queryByText("打包上传")).toBeNull();
	});

	it("列表:皮肤条目带模式/壁纸标签与导出入口;深浅两个 Picker 按钮组在场", async () => {
		renderSection();
		await waitFor(() => expect(screen.getAllByText("樱花夜").length).toBeGreaterThan(0));
		expect(pickerGroup("浅色模式皮肤")).toBeTruthy();
		expect(pickerGroup("深色模式皮肤")).toBeTruthy();
		expect(screen.getByText("浅色")).toBeTruthy();
		expect(screen.getByText("深色")).toBeTruthy();
		expect(screen.getByText("壁纸")).toBeTruthy();
		expect(screen.getAllByText("导出")).toHaveLength(1);
	});

	it("Picker 只列具备该模式的皮肤 + 默认装", async () => {
		H.list.list[0].modes = ["light"];
		renderSection();
		await waitFor(() => expect(screen.getAllByText("樱花夜").length).toBeGreaterThan(0));
		const light = within(pickerGroup("浅色模式皮肤")).getAllByRole("button");
		expect(light.map((el) => el.textContent)).toEqual(["默认装", "樱花夜"]);
		const dark = within(pickerGroup("深色模式皮肤")).getAllByRole("button");
		expect(dark.map((el) => el.textContent)).toEqual(["默认装"]);
		// 未换装:两组的「默认装」都是选中态
		expect(light[0].getAttribute("aria-pressed")).toBe("true");
		expect(dark[0].getAttribute("aria-pressed")).toBe("true");
	});

	it("浅色 Picker 点皮肤 → PUT {theme:'light', id} 且选中态切换", async () => {
		renderSection();
		await waitFor(() => expect(screen.getAllByText("樱花夜").length).toBeGreaterThan(0));
		fireEvent.click(within(pickerGroup("浅色模式皮肤")).getByText("樱花夜"));
		await waitFor(() => expect(H.putCalls).toEqual([{ theme: "light", id: "s1" }]));
		await waitFor(() => expect(useSkinStore.getState().active.light?.id).toBe("s1"));
		expect(useSkinStore.getState().active.dark).toBeNull();
		await waitFor(() =>
			expect(
				within(pickerGroup("浅色模式皮肤")).getByText("樱花夜").getAttribute("aria-pressed"),
			).toBe("true"),
		);
	});

	it("Picker 点「默认装」→ PUT {theme, id:null} 卸下该槽;点已选中的不重复发", async () => {
		H.list.list[0].modes = ["light"];
		H.list.active = { light: "s1", dark: null };
		renderSection();
		await waitFor(() => expect(screen.getByText("浅色·使用中")).toBeTruthy());

		// 点已选中的皮肤:不发请求
		fireEvent.click(within(pickerGroup("浅色模式皮肤")).getByText("樱花夜"));
		expect(H.putCalls).toEqual([]);

		fireEvent.click(within(pickerGroup("浅色模式皮肤")).getByText("默认装"));
		await waitFor(() => expect(H.putCalls).toEqual([{ theme: "light", id: null }]));
		await waitFor(() => expect(useSkinStore.getState().active.light).toBeNull());
	});

	it("点「试穿」→ 只写 preview,不动 active、不发 PUT", async () => {
		renderSection();
		await waitFor(() => expect(screen.getByText("试穿")).toBeTruthy());
		fireEvent.click(screen.getByText("试穿"));
		await waitFor(() => expect(useSkinStore.getState().preview?.id).toBe("s1"));
		expect(useSkinStore.getState().active).toEqual(EMPTY_SLOTS);
		expect(H.putCalls).toEqual([]);
	});

	it("点「调整」→ 拉 manifest+assets 打开编辑抽屉;默认装行没有这个入口", async () => {
		renderSection();
		await waitFor(() => expect(screen.getAllByText("樱花夜").length).toBeGreaterThan(0));
		// 只有皮肤行有「调整」;默认装行没有 → 恰好一个
		const editButtons = screen.getAllByText("调整");
		expect(editButtons).toHaveLength(1);
		fireEvent.click(editButtons[0]);
		await waitFor(() => expect(screen.getByText("调整皮肤")).toBeTruthy());
		// 编辑器已接管 preview 通道
		expect(useSkinStore.getState().editing).toBe(true);
		expect(useSkinStore.getState().preview?.id).toBe("s1");
	});

	it("双模皮肤占两槽时:两个 Picker 都选中它,皮肤行标「使用中」", async () => {
		H.list.active = { light: "s1", dark: "s1" };
		renderSection();
		await waitFor(() => expect(screen.getByText("使用中")).toBeTruthy());
		expect(
			within(pickerGroup("浅色模式皮肤")).getByText("樱花夜").getAttribute("aria-pressed"),
		).toBe("true");
		expect(
			within(pickerGroup("深色模式皮肤")).getByText("樱花夜").getAttribute("aria-pressed"),
		).toBe("true");
	});
});
