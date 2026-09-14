// @vitest-environment jsdom

/**
 * 编辑器的**皮肤这一档**:名字 / 作者 / 说明的接线(ADR-0014 第二步续)。
 *
 * 从前皮肤装进来叫什么名字就再也改不了 —— 编辑器与皮肤库都没有入口。补上这一档时最容易
 * 留下的是静默失败:框敲得动、头部那行也跟着变,**存出去的清单里却还是旧名**(改的是草稿
 * 的副本)。所以这里只看两样东西:`PUT` 出去的那份 payload,以及只读皮肤上这几个口在不在。
 *
 * 另钉「存不下去就把保存钮灰掉」:不拦的话按下去吃的是装包门一句「name: 太短」或
 * 「knobs[3]: 旋钮 key「accent」重复」—— 皮肤里带名字的东西有好几样(块有 id、字体有
 * family),那个 3 也对不上界面上第几行,主人根本不知道说的是哪一个。
 *
 * 下半场是**旋钮声明**:皮肤声明几枚,卡片页那个旋钮区就画几个控件。编辑器从前一枚都编
 * 不了,自制皮肤的旋钮区于是永远是空的。
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../../services/api", () => ({
	api: { get: vi.fn(), post: vi.fn(), put: vi.fn() },
	ApiError: class extends Error {},
}));

import { api } from "../../services/api";
import CardSkinEditor from "../CardSkinEditor";

const MANIFEST = {
	schemaVersion: 1,
	name: "霓虹",
	author: "阿绫",
	cards: {
		live: {
			width: 600,
			css: "",
			blocks: [
				{ id: "cover", kind: "builtin", builtin: "cover", grid: { row: 1, column: 1, span: 12 } },
			],
		},
	},
};

function mockApi({ builtin = false, knobs }: { builtin?: boolean; knobs?: unknown[] } = {}): void {
	vi.mocked(api.get).mockImplementation((url: string) => {
		if (url === "/api/card-skins") {
			return Promise.resolve({
				skins: [
					{ id: "default", name: "默认", builtin: true, updatedAt: 0, knobs: [] },
					{ id: "neon", name: "霓虹", builtin, updatedAt: 0, knobs: [] },
				],
				active: "neon",
				fallbacks: [],
			});
		}
		if (url === "/api/card-skins/neon") {
			const manifest = structuredClone(MANIFEST) as Record<string, unknown>;
			if (knobs) manifest.knobs = structuredClone(knobs);
			return Promise.resolve({ manifest });
		}
		return Promise.resolve({});
	});
	vi.mocked(api.post).mockResolvedValue({
		html: "<html><body></body></html>",
		width: 600,
		warnings: [],
		scene: "streaming",
	});
	vi.mocked(api.put).mockResolvedValue({ ok: true, warnings: [] });
}

function renderEditor() {
	const qc = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	return render(
		<QueryClientProvider client={qc}>
			<MemoryRouter initialEntries={["/cards/skins/neon"]}>
				<Routes>
					<Route path="/cards/skins/:id" element={<CardSkinEditor />} />
				</Routes>
			</MemoryRouter>
		</QueryClientProvider>,
	);
}

/** 最近一次 `PUT` 出去的那份清单。 */
const saved = () =>
	vi.mocked(api.put).mock.calls.at(-1)?.[1] as {
		name: string;
		author?: string;
		description?: string;
	};

/** 最近一次 `PUT` 出去那份清单里的旋钮表。 */
const savedKnobs = (): Array<Record<string, unknown>> =>
	(saved() as unknown as { knobs?: Array<Record<string, unknown>> }).knobs ?? [];

const saveBtn = () => screen.getByRole("button", { name: "保存" });
const save = () => fireEvent.click(saveBtn());

/** 点头部那行皮肤名 —— 它就是进这一档的门。 */
async function openSkinTab(name = "霓虹"): Promise<void> {
	fireEvent.click(await screen.findByRole("button", { name: new RegExp(name) }));
}

beforeEach(() => {
	vi.clearAllMocks();
});
afterEach(() => cleanup());

describe("编辑器 · 皮肤这一档的接线", () => {
	it("点头部皮肤名 → 检查器换成皮肤那一档;改名存出去真的是新名", async () => {
		mockApi();
		renderEditor();
		await screen.findByText("封面图");
		await openSkinTab();

		fireEvent.change(screen.getByLabelText("皮肤名"), { target: { value: "青柠" } });
		save();

		await waitFor(() => expect(api.put).toHaveBeenCalled());
		expect(saved().name).toBe("青柠");
	});

	it("作者与说明同一根线;清空的那个是**删键**,不是空串", async () => {
		mockApi();
		renderEditor();
		await screen.findByText("封面图");
		await openSkinTab();

		fireEvent.change(screen.getByLabelText("说明"), { target: { value: "夜里好看" } });
		fireEvent.change(screen.getByLabelText("作者"), { target: { value: "" } });
		save();

		await waitFor(() => expect(api.put).toHaveBeenCalled());
		expect(saved().description).toBe("夜里好看");
		expect("author" in saved()).toBe(false);
	});

	it("名字空了 → 保存钮变灰,并且说出是哪儿不对", async () => {
		mockApi();
		renderEditor();
		await screen.findByText("封面图");
		await openSkinTab();

		fireEvent.change(screen.getByLabelText("皮肤名"), { target: { value: "  " } });

		expect((saveBtn() as HTMLButtonElement).disabled).toBe(true);
		expect(screen.getByText("皮肤得有个名字")).toBeTruthy();
	});

	it("内置皮肤是只读的 —— 这三个框一个都不给编", async () => {
		mockApi({ builtin: true });
		renderEditor();
		await screen.findByText("封面图");
		await openSkinTab();

		for (const label of ["皮肤名", "作者", "说明"]) {
			expect((screen.getByLabelText(label) as HTMLInputElement).disabled).toBe(true);
		}
	});
});

/**
 * 旋钮声明的接线。皮肤声明几枚旋钮,卡片页那个旋钮区就画几个控件 —— 编辑器从前一枚都
 * 编不了,所以**自制皮肤的旋钮区永远是空的**。
 *
 * 同样只看 `PUT` 出去那份 payload:面板上加得出一行、改得动档位,而清单里一个字没变,
 * 是这条线最像成功的失败形态。
 */
describe("编辑器 · 旋钮声明的接线", () => {
	it("加一枚 → 存出去的清单里真的有 knobs", async () => {
		mockApi();
		renderEditor();
		await screen.findByText("封面图");
		await openSkinTab();

		fireEvent.click(screen.getByRole("button", { name: /添加旋钮/ }));
		save();

		await waitFor(() => expect(api.put).toHaveBeenCalled());
		expect(savedKnobs()).toHaveLength(1);
		expect(savedKnobs()[0]).toMatchObject({ type: "color" });
	});

	it("改 key / 名字 / 档位 → 三样都存得出去,改档时值跟着换形状", async () => {
		mockApi();
		renderEditor();
		await screen.findByText("封面图");
		await openSkinTab();
		fireEvent.click(screen.getByRole("button", { name: /添加旋钮/ }));

		fireEvent.change(screen.getByLabelText("旋钮 key"), { target: { value: "glass-opacity" } });
		fireEvent.change(screen.getByLabelText("旋钮名字"), { target: { value: "玻璃白纱" } });
		fireEvent.change(screen.getByLabelText("旋钮档位"), { target: { value: "number" } });
		save();

		await waitFor(() => expect(api.put).toHaveBeenCalled());
		expect(savedKnobs()[0]).toMatchObject({
			key: "glass-opacity",
			label: "玻璃白纱",
			type: "number",
		});
		// 档位换了,起手位置得是那一档的形状 —— 留着 `"#ffffff"` 的话装包门当场拒。
		expect(typeof (savedKnobs()[0] as { default: unknown }).default).toBe("number");
	});

	it("删掉唯一那一枚 → 存出去的清单里连 knobs 键都没了(不是留个空数组)", async () => {
		// 夹具自带一枚:加完再删是净零,草稿不脏、保存钮本来就该灰着,那样测不到这根线。
		mockApi({ knobs: [{ key: "accent", label: "主色", type: "color", default: "#e0c3fc" }] });
		renderEditor();
		await screen.findByText("封面图");
		await openSkinTab();

		fireEvent.click(screen.getByRole("button", { name: /删掉这枚旋钮/ }));
		save();

		await waitFor(() => expect(api.put).toHaveBeenCalled());
		expect("knobs" in (saved() as object)).toBe(false);
	});

	it("key 撞了 → 保存钮变灰,并且说出是哪个 key", async () => {
		mockApi();
		renderEditor();
		await screen.findByText("封面图");
		await openSkinTab();
		fireEvent.click(screen.getByRole("button", { name: /添加旋钮/ }));
		fireEvent.click(screen.getByRole("button", { name: /添加旋钮/ }));

		// 读 DOM 属性不保险(受控件的 `value` 属性未必跟着走),取的是元素的属性值。
		const keys = screen.getAllByLabelText("旋钮 key") as HTMLInputElement[];
		fireEvent.change(keys[1], { target: { value: keys[0].value } });

		expect((saveBtn() as HTMLButtonElement).disabled).toBe(true);
		expect(screen.getByText(/重复了/)).toBeTruthy();
	});

	it("内置皮肤是只读的 —— 加不了也删不掉", async () => {
		mockApi({ builtin: true });
		renderEditor();
		await screen.findByText("封面图");
		await openSkinTab();

		expect(screen.queryByRole("button", { name: /添加旋钮/ })).toBeNull();
	});
});

/**
 * 三档自己那几项的接线。这一段最像成功的失败形态是**改得动、存不出去**:数值那一行的
 * 取值域框敲得动,而 `PUT` 里还是 0~100。
 */
describe("编辑器 · 三档附加字段的接线", () => {
	const numberKnob = [{ key: "blur", label: "糊化", type: "number", default: 8, min: 0, max: 40 }];
	const selectKnob = [
		{
			key: "corner",
			label: "圆角",
			type: "select",
			default: "12px",
			options: [{ value: "12px", label: "圆" }],
		},
	];
	const switchKnob = [
		{ key: "badge", label: "徽章", type: "switch", default: true, on: "block", off: "none" },
	];

	it("数值:取值域 / 步长 / 单位都存得出去", async () => {
		mockApi({ knobs: numberKnob });
		renderEditor();
		await screen.findByText("封面图");
		await openSkinTab();

		fireEvent.change(screen.getByLabelText("取值上限"), { target: { value: "24" } });
		fireEvent.change(screen.getByLabelText("步长"), { target: { value: "2" } });
		fireEvent.change(screen.getByLabelText("单位"), { target: { value: "px" } });
		save();

		await waitFor(() => expect(api.put).toHaveBeenCalled());
		expect(savedKnobs()[0]).toMatchObject({ min: 0, max: 24, step: 2, unit: "px" });
	});

	it("数值:单位选回「无单位」→ 键删掉,不是存个空串", async () => {
		mockApi({ knobs: [{ ...numberKnob[0], unit: "px" }] });
		renderEditor();
		await screen.findByText("封面图");
		await openSkinTab();

		fireEvent.change(screen.getByLabelText("单位"), { target: { value: "" } });
		save();

		await waitFor(() => expect(api.put).toHaveBeenCalled());
		expect("unit" in (savedKnobs()[0] ?? {})).toBe(false);
	});

	it("开关:两端的字面量存得出去", async () => {
		mockApi({ knobs: switchKnob });
		renderEditor();
		await screen.findByText("封面图");
		await openSkinTab();

		fireEvent.change(screen.getByLabelText("开的时候注什么"), { target: { value: "flex" } });
		save();

		await waitFor(() => expect(api.put).toHaveBeenCalled());
		expect(savedKnobs()[0]).toMatchObject({ on: "flex", off: "none" });
	});

	it("下拉:加一个候选、把它设成起手位置 —— 两样都存得出去", async () => {
		mockApi({ knobs: selectKnob });
		renderEditor();
		await screen.findByText("封面图");
		await openSkinTab();

		fireEvent.click(screen.getByRole("button", { name: /添加候选/ }));
		fireEvent.change(screen.getAllByLabelText("候选注什么")[1] as HTMLInputElement, {
			target: { value: "0px" },
		});
		fireEvent.click(screen.getAllByRole("button", { name: "起手" })[1] as HTMLElement);
		save();

		await waitFor(() => expect(api.put).toHaveBeenCalled());
		expect(savedKnobs()[0]).toMatchObject({
			default: "0px",
			options: [
				{ value: "12px", label: "圆" },
				{ value: "0px", label: "候选 2" },
			],
		});
	});

	it("下拉:起手位置被改得不在候选里 → 保存钮变灰并说清楚", async () => {
		mockApi({ knobs: selectKnob });
		renderEditor();
		await screen.findByText("封面图");
		await openSkinTab();

		// 只有一个候选时它就是起手位置;把它的值改掉,起手位置立刻悬空。
		fireEvent.change(screen.getByLabelText("候选注什么"), { target: { value: "0px" } });

		expect((saveBtn() as HTMLButtonElement).disabled).toBe(true);
		expect(screen.getByText(/不在候选里/)).toBeTruthy();
	});

	it("下拉:只剩一个候选时删不掉 —— 那颗钮压根不出现", async () => {
		mockApi({ knobs: selectKnob });
		renderEditor();
		await screen.findByText("封面图");
		await openSkinTab();

		expect(screen.queryByRole("button", { name: /删掉这个候选/ })).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: /添加候选/ }));
		expect(screen.getAllByRole("button", { name: /删掉这个候选/ })).toHaveLength(2);
	});
});
