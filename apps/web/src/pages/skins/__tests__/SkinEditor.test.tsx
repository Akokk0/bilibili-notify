// @vitest-environment jsdom

/**
 * 皮肤编辑抽屉:挂载即借 preview 通道做整页实时预览(editing 标记压住试穿浮条),
 * 每次改动立即写 preview;保存 = PUT /api/skins/:id/manifest(就地更新),
 * 取消丢弃;有脏改动时取消要过确认框。
 */

import type { SkinManifest } from "@bilibili-notify/contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EMPTY_SLOTS, useSkinStore } from "../../../store/skin";
import { SkinEditor } from "../SkinEditor";

const H = vi.hoisted(() => ({
	putCalls: [] as Array<{ path: string; body: unknown }>,
	postCalls: [] as Array<{ path: string; body: unknown }>,
	uploadCalls: [] as Array<{ path: string; name: string }>,
	getCalls: [] as string[],
	/** 出厂快照;null = 没钉过(GET /default 404)。 */
	defaultManifest: null as unknown,
	/** 下一次传图要不要失败。 */
	uploadFails: false,
}));

vi.mock("../../../services/api", () => ({
	api: {
		get: vi.fn(async (path: string) => {
			H.getCalls.push(path);
			if (path === "/api/skins/s1/default") {
				if (H.defaultManifest === null) throw new Error("该皮肤还没有钉过默认值");
				return { manifest: H.defaultManifest };
			}
			throw new Error(`unexpected GET ${path}`);
		}),
		put: vi.fn(async (path: string, body: unknown) => {
			H.putCalls.push({ path, body });
			return { ok: true, warnings: [] };
		}),
		post: vi.fn(async (path: string, body: unknown) => {
			H.postCalls.push({ path, body });
			return {
				ok: true,
				manifest: { schemaVersion: 1, name: "AI 皮肤", modes: { light: {} } },
				warnings: ["texts.foo: 不认识的文案槽位,已忽略"],
			};
		}),
		upload: vi.fn(async (path: string, form: FormData) => {
			H.uploadCalls.push({ path, name: (form.get("file") as File | null)?.name ?? "" });
			if (H.uploadFails) throw new Error("图片过大(上限 5MB)");
			// 落盘名由服务端按类型生成(img- / font- 前缀),这里照着仿。
			const name = (form.get("file") as File | null)?.name ?? "";
			return name.endsWith(".woff2")
				? { ok: true, name: "assets/font-99887766.woff2" }
				: { ok: true, name: "assets/img-abcd1234.png" };
		}),
	},
}));

function makeManifest(): SkinManifest {
	return {
		schemaVersion: 1,
		name: "樱花夜",
		modes: {
			light: {
				wallpaper: { image: "assets/bg.png", overlay: 0.2 },
				glass: { blur: 16 },
			},
		},
	};
}

const ASSETS = ["assets/bg.png", "assets/deco.webp", "assets/font-a1b2c3d4.woff2"];
/** 只覆盖一部分 —— 没登记的那两个必须回落成生成名,不能空着。 */
const ASSET_NAMES = { "assets/font-a1b2c3d4.woff2": "霞鹜文楷 Light.woff2" };

/** 「字体」是折叠段,收起时子节点根本不进 DOM —— 查控件之前先摊开。 */
function openFontFold(): void {
	fireEvent.click(screen.getByText("字体").closest("button") as HTMLButtonElement);
}

function renderEditor(overrides?: {
	manifest?: SkinManifest;
	assetNames?: Record<string, string>;
	onClose?: () => void;
}) {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const onClose = overrides?.onClose ?? vi.fn();
	const utils = render(
		<QueryClientProvider client={qc}>
			<SkinEditor
				id="s1"
				manifest={overrides?.manifest ?? makeManifest()}
				assets={ASSETS}
				assetNames={overrides?.assetNames ?? ASSET_NAMES}
				onClose={onClose}
			/>
		</QueryClientProvider>,
	);
	return { ...utils, onClose };
}

beforeEach(() => {
	H.putCalls = [];
	H.postCalls = [];
	H.uploadCalls = [];
	H.getCalls = [];
	H.uploadFails = false;
	H.defaultManifest = { schemaVersion: 1, name: "出厂樱花", modes: { light: {} } };
	useSkinStore.setState({
		active: EMPTY_SLOTS,
		preview: null,
		killSwitch: false,
		lockedTheme: null,
		editing: false,
	});
});

afterEach(cleanup);

describe("SkinEditor", () => {
	it("挂载:editing=true 且 preview=当前 draft;卸载:两者复位", () => {
		const { unmount } = renderEditor();
		expect(useSkinStore.getState().editing).toBe(true);
		expect(useSkinStore.getState().preview?.id).toBe("s1");
		expect(useSkinStore.getState().preview?.manifest.name).toBe("樱花夜");
		unmount();
		expect(useSkinStore.getState().editing).toBe(false);
		expect(useSkinStore.getState().preview).toBeNull();
	});

	it("玻璃片透明度滑杆(与推送卡片同名同义):保色相只调 alpha", async () => {
		renderEditor();
		fireEvent.change(screen.getByLabelText("玻璃片透明度"), { target: { value: "0.3" } });
		await waitFor(() =>
			expect(useSkinStore.getState().preview?.manifest.modes.light?.glass?.background).toBe(
				"rgba(255, 255, 255, 0.3)",
			),
		);
	});

	it("完全透明开关:开 = 透明度与模糊一起归零;关 = 清字段回默认", async () => {
		renderEditor();
		fireEvent.click(screen.getByLabelText("完全透明(去磨砂模糊)"));
		await waitFor(() => {
			const g = useSkinStore.getState().preview?.manifest.modes.light?.glass;
			expect(g?.background).toBe("rgba(255, 255, 255, 0)");
			expect(g?.blur).toBe(0);
		});
		expect((screen.getByLabelText("玻璃片透明度") as HTMLInputElement).disabled).toBe(true);

		fireEvent.click(screen.getByLabelText("完全透明(去磨砂模糊)"));
		await waitFor(() => {
			const g = useSkinStore.getState().preview?.manifest.modes.light?.glass;
			expect(g?.background).toBeUndefined();
			expect(g?.blur).toBeUndefined();
		});
	});

	it("玻璃高级字段(能力对齐):色相/描边/双档模糊都有编辑口", async () => {
		renderEditor();
		fireEvent.change(screen.getByLabelText("玻璃描边"), {
			target: { value: "rgba(57, 197, 187, 0.3)" },
		});
		fireEvent.change(screen.getByLabelText("玻璃模糊"), { target: { value: "32" } });
		fireEvent.change(screen.getByLabelText("强玻璃模糊"), { target: { value: "28" } });
		await waitFor(() => {
			const g = useSkinStore.getState().preview?.manifest.modes.light?.glass;
			expect(g?.border).toBe("rgba(57, 197, 187, 0.3)");
			expect(g?.blur).toBe(32);
			expect(g?.strongBlur).toBe(28);
		});
		expect(screen.getByLabelText("玻璃底色")).toBeTruthy();
		expect(screen.getByLabelText("强玻璃底色")).toBeTruthy();
		expect(screen.getByLabelText("强玻璃描边")).toBeTruthy();
	});

	it("拖壁纸模糊滑杆 → preview 的 wallpaper.blur 实时反映", async () => {
		renderEditor();
		fireEvent.change(screen.getByLabelText("壁纸模糊"), { target: { value: "12" } });
		await waitFor(() =>
			expect(useSkinStore.getState().preview?.manifest.modes.light?.wallpaper?.blur).toBe(12),
		);
	});

	it("壁纸下拉列出包内资产;选「(不用壁纸)」→ wallpaper 从 draft 消失", async () => {
		renderEditor();
		const select = screen.getByLabelText("壁纸图片") as HTMLSelectElement;
		const options = [...select.options].map((o) => o.textContent);
		expect(options).toContain("assets/bg.png");
		expect(options).toContain("assets/deco.webp");
		fireEvent.change(select, { target: { value: "" } });
		await waitFor(() =>
			expect(useSkinStore.getState().preview?.manifest.modes.light?.wallpaper).toBeUndefined(),
		);
	});

	it("保存 → PUT 当前 draft;该皮肤正占着槽时同步转正(只动占用的槽)", async () => {
		useSkinStore
			.getState()
			.setActive({ light: { id: "s1", manifest: makeManifest() }, dark: null });
		const { onClose } = renderEditor();
		fireEvent.change(screen.getByLabelText("玻璃片透明度"), { target: { value: "0.8" } });
		fireEvent.click(screen.getByText("保存"));
		await waitFor(() => expect(H.putCalls).toHaveLength(1));
		expect(H.putCalls[0].path).toBe("/api/skins/s1/manifest");
		const sent = H.putCalls[0].body as SkinManifest;
		expect(sent.modes.light?.glass?.background).toBe("rgba(255, 255, 255, 0.8)");
		await waitFor(() =>
			expect(useSkinStore.getState().active.light?.manifest.modes.light?.glass?.background).toBe(
				"rgba(255, 255, 255, 0.8)",
			),
		);
		expect(useSkinStore.getState().active.dark).toBeNull();
		expect(onClose).toHaveBeenCalled();
	});

	it("有脏改动时点取消 → 确认框;确认丢弃 → 不发 PUT 直接关", async () => {
		const { onClose } = renderEditor();
		fireEvent.change(screen.getByLabelText("玻璃片透明度"), { target: { value: "0.4" } });
		fireEvent.click(screen.getByText("取消"));
		expect(onClose).not.toHaveBeenCalled();
		fireEvent.click(await screen.findByText("丢弃"));
		expect(onClose).toHaveBeenCalled();
		expect(H.putCalls).toEqual([]);
	});

	it("没有改动时点取消 → 直接关,不弹确认", () => {
		const { onClose } = renderEditor();
		fireEvent.click(screen.getByText("取消"));
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it("自定义 CSS:共用/本模式两个编辑区,输入即进 preview(实时生效)", async () => {
		renderEditor();
		fireEvent.click(screen.getByText("自定义 CSS"));
		fireEvent.change(screen.getByLabelText("共用 CSS"), {
			target: { value: '[data-bn="glass"]{border-width:2px}' },
		});
		fireEvent.change(screen.getByLabelText("本模式 CSS"), {
			target: { value: '[data-bn="btn"]{opacity:0.9}' },
		});
		await waitFor(() => {
			const m = useSkinStore.getState().preview?.manifest;
			expect(m?.css).toBe('[data-bn="glass"]{border-width:2px}');
			expect(m?.modes.light?.css).toBe('[data-bn="btn"]{opacity:0.9}');
		});
		// 清空 = 字段消失
		fireEvent.change(screen.getByLabelText("共用 CSS"), { target: { value: "" } });
		await waitFor(() => expect(useSkinStore.getState().preview?.manifest.css).toBeUndefined());
	});

	it("让女仆改:发 POST ai-edit 带当前 draft;返回的 manifest 直接进 draft 实时预览", async () => {
		renderEditor();
		// 先手调一个值,验证发出去的 draft 是当前草稿而非初始 manifest
		fireEvent.change(screen.getByLabelText("玻璃片透明度"), { target: { value: "0.25" } });
		fireEvent.change(screen.getByLabelText("修改要求"), {
			target: { value: "换成赛博朋克风" },
		});
		fireEvent.click(screen.getByText("让女仆改"));
		await waitFor(() => expect(H.postCalls).toHaveLength(1));
		expect(H.postCalls[0].path).toBe("/api/skins/s1/ai-edit");
		const sent = H.postCalls[0].body as { instruction: string; draft: SkinManifest };
		expect(sent.instruction).toBe("换成赛博朋克风");
		expect(sent.draft.modes.light?.glass?.background).toBe("rgba(255, 255, 255, 0.25)");
		// 产物进 draft → 实时预览;要求框清空
		await waitFor(() => expect(useSkinStore.getState().preview?.manifest.name).toBe("AI 皮肤"));
		expect(H.putCalls).toEqual([]); // 不落盘
	});

	it("动效预设:流光/光斑两道都能开关,改动实时进 preview", async () => {
		renderEditor();
		fireEvent.click(screen.getByText("动效"));

		fireEvent.click(screen.getByLabelText("玻璃流光"));
		fireEvent.change(screen.getByLabelText("光斑颜色"), {
			target: { value: "#fb7299, #00aeec" },
		});
		await waitFor(() => {
			const fx = useSkinStore.getState().preview?.manifest.modes.light?.effects;
			expect(fx?.glassShine).toEqual({});
			expect(fx?.bokeh?.colors).toEqual(["#fb7299", "#00aeec"]);
		});

		// 全关 → effects 字段整个消失
		fireEvent.click(screen.getByLabelText("玻璃流光"));
		fireEvent.change(screen.getByLabelText("光斑颜色"), { target: { value: "" } });
		await waitFor(() =>
			expect(useSkinStore.getState().preview?.manifest.modes.light?.effects).toBeUndefined(),
		);
	});

	it("换一套模式 → 光斑颜色框跟着换成那一套的,不留上一套的残影", async () => {
		// 这个框存的是主人正在敲的原文(受控 join 回去会吃掉逗号),所以每一条
		// 「整份换掉 draft」的路径都得让它回到派生态 —— 漏一条的症状就是切过去
		// 之后框里还挂着另一套的颜色,而 draft 里根本没有。
		renderEditor({
			manifest: {
				schemaVersion: 1,
				name: "双套",
				modes: {
					light: {},
					dark: { effects: { bokeh: { colors: ["#123456"] } } },
				},
			},
		});
		fireEvent.click(screen.getByText("动效"));
		expect((screen.getByLabelText("光斑颜色") as HTMLInputElement).value).toBe("");

		fireEvent.click(screen.getByRole("button", { name: "深色" }));
		await waitFor(() =>
			expect((screen.getByLabelText("光斑颜色") as HTMLInputElement).value).toBe("#123456"),
		);
	});

	it("底栏至多挂一条反馈 —— 传图失败要把上一条绿字顶掉", async () => {
		// 红绿分成两个 state 时,互斥全靠每个写点自己记得清对方;传图那条就没清,
		// 于是「已钉为默认值」和「图片过大」会一起挂在底栏上。
		renderEditor();
		fireEvent.click(screen.getByText("设为默认值").closest("button") as HTMLButtonElement);
		await waitFor(() => expect(screen.getByText(/已把当前状态钉为/)).toBeTruthy());

		H.uploadFails = true;
		const file = new File([new Uint8Array([1])], "big.png", { type: "image/png" });
		fireEvent.change(screen.getByLabelText("上传图片"), { target: { files: [file] } });

		await waitFor(() => expect(screen.getByText(/图片过大/)).toBeTruthy());
		expect(screen.queryByText(/已把当前状态钉为/)).toBeNull();
	});

	it("壁纸下拉**不列字体** —— 资产清单是图与字体的全集,不分流就会选出个 woff2 当壁纸", async () => {
		renderEditor();
		const options = [...(screen.getByLabelText("壁纸图片") as HTMLSelectElement).options].map(
			(o) => o.value,
		);
		expect(options).not.toContain("assets/font-a1b2c3d4.woff2");
	});

	it("自带字体下拉列出包内字体;选中 → draft.fonts.asset,选「不用」→ 字段消失", async () => {
		renderEditor();
		openFontFold();
		const select = screen.getByLabelText("自带字体") as HTMLSelectElement;
		expect([...select.options].map((o) => o.value)).toContain("assets/font-a1b2c3d4.woff2");
		// 图不许混进来:选了图当字体,保存时才被服务端拒收,而主人已经调了半天。
		expect([...select.options].map((o) => o.value)).not.toContain("assets/bg.png");

		fireEvent.change(select, { target: { value: "assets/font-a1b2c3d4.woff2" } });
		await waitFor(() =>
			expect(useSkinStore.getState().preview?.manifest.modes.light?.fonts?.asset).toBe(
				"assets/font-a1b2c3d4.woff2",
			),
		);
		fireEvent.change(screen.getByLabelText("自带字体"), { target: { value: "" } });
		await waitFor(() =>
			expect(useSkinStore.getState().preview?.manifest.modes.light?.fonts?.asset).toBeUndefined(),
		);
	});

	it("下拉显示主人上传时的原名,没登记的回落成生成名", async () => {
		// 盘上是随机 hex(那是安全边界:名字不进路径/URL/CSS),所以界面这一层
		// 必须把原名端出来 —— 否则主人看到的只有一串认不出的 font-a1b2c3d4。
		renderEditor();
		openFontFold();
		const font = [...(screen.getByLabelText("自带字体") as HTMLSelectElement).options];
		expect(font.find((o) => o.value === "assets/font-a1b2c3d4.woff2")?.textContent).toBe(
			"霞鹜文楷 Light.woff2",
		);

		const image = [...(screen.getByLabelText("壁纸图片") as HTMLSelectElement).options];
		expect(image.find((o) => o.value === "assets/bg.png")?.textContent).toBe("assets/bg.png");
	});

	it("传完之后下拉上立刻是刚传那个文件的名字,不用等重开抽屉", async () => {
		renderEditor();
		openFontFold();
		fireEvent.change(screen.getByLabelText("上传字体"), {
			target: { files: [new File([new Uint8Array([1])], "思源宋体.woff2", { type: "" })] },
		});
		await waitFor(() => {
			const opts = [...(screen.getByLabelText("自带字体") as HTMLSelectElement).options];
			expect(opts.find((o) => o.value === "assets/font-99887766.woff2")?.textContent).toBe(
				"思源宋体.woff2",
			);
		});
	});

	it("传一款字体 → 立刻选成自带字体(会来传字体的人正是想换字体)", async () => {
		renderEditor();
		openFontFold();
		const file = new File([new Uint8Array([1])], "霞鹜文楷.woff2", { type: "" });
		fireEvent.change(screen.getByLabelText("上传字体"), { target: { files: [file] } });

		await waitFor(() =>
			expect(useSkinStore.getState().preview?.manifest.modes.light?.fonts?.asset).toBe(
				"assets/font-99887766.woff2",
			),
		);
		expect(H.uploadCalls.at(-1)?.path).toBe("/api/skins/s1/assets");
	});

	it("传字体不动字体栈 —— 两栏各管各的,拉不下来还有家族名兜着", async () => {
		renderEditor({
			manifest: {
				schemaVersion: 1,
				name: "樱花夜",
				modes: { light: { fonts: { body: ["霞鹜文楷"] } } },
			},
		});
		openFontFold();
		const file = new File([new Uint8Array([1])], "f.woff2", { type: "" });
		fireEvent.change(screen.getByLabelText("上传字体"), { target: { files: [file] } });

		await waitFor(() =>
			expect(useSkinStore.getState().preview?.manifest.modes.light?.fonts?.asset).toBeTruthy(),
		);
		expect(useSkinStore.getState().preview?.manifest.modes.light?.fonts?.body).toEqual([
			"霞鹜文楷",
		]);
	});

	it("单套皮肤:点「补一套深色」→ draft 长出 dark 套(复制自浅色)", async () => {
		renderEditor();
		fireEvent.click(screen.getByText("补一套深色"));
		await waitFor(() => {
			const dark = useSkinStore.getState().preview?.manifest.modes.dark;
			expect(dark?.glass?.blur).toBe(16);
		});
	});

	it("恢复默认值:用挂载时拉好的快照回填 draft 实时预览,不发落盘请求", async () => {
		renderEditor();
		const btn = screen.getByText("恢复默认值").closest("button") as HTMLButtonElement;
		await waitFor(() => expect(btn.disabled).toBe(false));
		fireEvent.click(btn);
		await waitFor(() => expect(useSkinStore.getState().preview?.manifest.name).toBe("出厂樱花"));
		// 快照在挂载时拉过一次,点击复用,不再发第二次
		expect(H.getCalls).toEqual(["/api/skins/s1/default"]);
		expect(H.putCalls).toEqual([]);
	});

	it("与出厂快照一致:数值类内嵌「数值(默认)」,字符串类尾标「默认」;改动后消失", async () => {
		H.defaultManifest = {
			schemaVersion: 1,
			name: "樱花夜",
			modes: { light: { glass: { blur: 16 } } },
		};
		renderEditor();
		// 皮肤名与快照一致 → 输入框尾标「默认」(不带括号);等它出现 = 快照已到位
		const nameRow = screen.getByLabelText("皮肤名").parentElement as HTMLElement;
		await waitFor(() => expect(within(nameRow).getByText("默认")).toBeTruthy());
		expect(within(nameRow).queryByText("(默认)")).toBeNull();
		// 玻璃模糊 16 与快照一致(内嵌标注);强玻璃模糊未配置回落 16px 同形态 → 共 2 处
		expect(screen.getAllByText("16px(默认)")).toHaveLength(2);
		// 未配置的滑杆(数值类)也给数值:玻璃透明度显示原版回落 0.7(默认)
		expect(screen.getByText("0.7(默认)")).toBeTruthy();

		fireEvent.change(screen.getByLabelText("玻璃模糊"), { target: { value: "20" } });
		await waitFor(() => expect(screen.getByText("20px")).toBeTruthy());
		expect(screen.queryByText("20px(默认)")).toBeNull();
	});

	it("没钉过默认值:恢复按钮禁用、快照匹配标注不出现", async () => {
		H.defaultManifest = null;
		renderEditor();
		const btn = screen.getByText("恢复默认值").closest("button") as HTMLButtonElement;
		await waitFor(() => expect(btn.title).toContain("还没有钉过"));
		expect(btn.disabled).toBe(true);
		// 有值的字段(玻璃模糊 16)不再标 —— 无快照没有比较基准
		expect(screen.getByText("16px")).toBeTruthy();
		const nameRow = screen.getByLabelText("皮肤名").parentElement as HTMLElement;
		expect(within(nameRow).queryByText("默认")).toBeNull();
		// 未配置滑杆的回落显示与快照无关,照常给「数值(默认)」
		expect(screen.getByText("0.7(默认)")).toBeTruthy();
	});

	it("设为默认值:干净状态发 PUT /default;有未保存改动时禁用(先保存)", async () => {
		renderEditor();
		const btn = screen.getByText("设为默认值").closest("button") as HTMLButtonElement;
		expect(btn.disabled).toBe(false);
		fireEvent.click(btn);
		await waitFor(() => expect(H.putCalls.map((c) => c.path)).toEqual(["/api/skins/s1/default"]));

		fireEvent.change(screen.getByLabelText("玻璃片透明度"), { target: { value: "0.3" } });
		await waitFor(() => expect(btn.disabled).toBe(true));
	});

	it("传张图进来 → 进包、进下拉、并当场选成壁纸", async () => {
		// 没有这个入口时,给一套皮肤换壁纸只能导出 zip、塞图、改 JSON、再传回来;
		// 而聊天里做出来的皮肤天生零资产,等于压根没有壁纸这回事。
		renderEditor();
		const input = screen.getByLabelText("上传图片") as HTMLInputElement;
		const file = new File([new Uint8Array([1, 2, 3])], "rem.png", { type: "image/png" });
		fireEvent.change(input, { target: { files: [file] } });

		await waitFor(() =>
			expect(H.uploadCalls).toEqual([{ path: "/api/skins/s1/assets", name: "rem.png" }]),
		);
		// 传完立刻用上 —— 传图的人正是想换壁纸,还要再点一次下拉是多余的一步。
		await waitFor(() =>
			expect(useSkinStore.getState().preview?.manifest.modes.light?.wallpaper?.image).toBe(
				"assets/img-abcd1234.png",
			),
		);
		const options = within(screen.getByLabelText("壁纸图片")).getAllByRole("option");
		expect(options.map((o) => o.getAttribute("value"))).toContain("assets/img-abcd1234.png");
	});

	it("「AI 聊天」节只管背景(能力全集=schema 全集):改背景/壁纸落 draft,没有强调色入口", async () => {
		renderEditor();
		fireEvent.click(screen.getByText("AI 聊天"));
		// 颜色全部派生自主强调色、玻璃直用「玻璃」节 —— chat 段不另设一套参数
		expect(screen.queryByLabelText("聊天强调色")).toBeNull();
		expect(screen.queryByLabelText("聊天渐变次色")).toBeNull();
		fireEvent.change(screen.getByLabelText("聊天页背景"), { target: { value: "#0e1c2c" } });
		await waitFor(() =>
			expect(useSkinStore.getState().preview?.manifest.modes.light?.chat?.background).toBe(
				"#0e1c2c",
			),
		);
		// 聊天壁纸选包内资产 → chat.wallpaper.image 落 draft
		fireEvent.change(screen.getByLabelText("聊天壁纸"), { target: { value: "assets/deco.webp" } });
		await waitFor(() =>
			expect(useSkinStore.getState().preview?.manifest.modes.light?.chat?.wallpaper?.image).toBe(
				"assets/deco.webp",
			),
		);
	});
});
