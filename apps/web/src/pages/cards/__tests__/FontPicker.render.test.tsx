// @vitest-environment jsdom

/**
 * 字体选择器接线 —— 纯变换另有单测(`font-ops.test.ts`),这里只管界面接对没有。
 *
 * 盯的是三件在界面上才现形的事:选中态落在哪一档、切档时 `fontAsset` 有没有真被清掉
 * (留着的话选的是内置、出图却还是上传那款)、以及删掉正被别处用着的字体时那句 409
 * 提示有没有露出来。
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { FontPicker } from "../FontPicker";
import type { FontChoice } from "../font-ops";

vi.mock("../../../services/api", () => ({
	api: { get: vi.fn(), upload: vi.fn(), delete: vi.fn() },
	ApiError: class extends Error {
		status: number;
		body: unknown;
		constructor(status: number, body: unknown) {
			super("api error");
			this.status = status;
			this.body = body;
		}
	},
}));

import { ApiError, api } from "../../../services/api";

const UPLOADED = `${"a".repeat(32)}.woff2`;

function mount(value: FontChoice, fonts: Array<{ id: string; name: string; size?: number }> = []) {
	vi.mocked(api.get).mockResolvedValue({ ok: true, fonts } as never);
	const onChange = vi.fn();
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(
		<QueryClientProvider client={qc}>
			<FontPicker value={value} onChange={onChange} />
		</QueryClientProvider>,
	);
	return onChange;
}

/** 当前被按下的那一档的文字。 */
function picked(): string | undefined {
	return screen.getAllByRole("button", { pressed: true })[0]?.textContent ?? undefined;
}

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("选中态落在哪一档", () => {
	it("空配置 → 落在「默认」", async () => {
		mount({ font: "" });
		await waitFor(() => expect(picked()).toContain("默认"));
	});

	it("选着上传的那款 → 落在那一款上,不是「默认」", async () => {
		mount({ font: "兜底", fontAsset: UPLOADED }, [{ id: UPLOADED, name: "霞鹜文楷.ttf" }]);
		await waitFor(() => expect(picked()).toContain("霞鹜文楷.ttf"));
	});

	it("选着一款已经不在字体库里的 → 明说它失效了,而不是悄悄显示成「默认」", async () => {
		// 悄悄回落的话主人只会觉得「我选的字体自己变回去了」,界面上没有任何线索。
		mount({ font: "", fontAsset: UPLOADED }, []);
		expect(await screen.findByText(/已不在字体库里/)).toBeTruthy();
	});

	it("不摆「内置字体」行 —— 镜像自带的那两款在桌面版根本不一定装了", async () => {
		// 单列它们等于替主人保证「一定渲染得出来」,可桌面版出图用的是他自己机器上的
		// Chrome,Windows / macOS 默认没有 Noto CJK,选了只会静静回落兜底链。
		mount({ font: "" }, [{ id: UPLOADED, name: "某字体.ttf" }]);
		// 先等列表到位,否则「查无此行」在加载态下必然成立,这条断言就是空的。
		expect(await screen.findByText("某字体.ttf")).toBeTruthy();
		// 数**可选项行**(带 aria-pressed 的那些)。按文字查是不行的:默认行和手填那档的
		// 说明里都提着思源黑/宋 —— 那是在讲各环境挑得到什么,不是一档可以选的东西。
		const rows = screen.getAllByRole("button").filter((b) => b.hasAttribute("aria-pressed"));
		expect(rows.map((b) => b.textContent?.slice(0, 2))).toEqual(["默认", "某字"]);
	});
});

describe("切档", () => {
	it("手填一个家族名 → 清掉资产", async () => {
		const onChange = mount({ font: "", fontAsset: UPLOADED }, [
			{ id: UPLOADED, name: "某字体.ttf" },
		]);
		fireEvent.change(await screen.findByLabelText("手填字体名"), {
			target: { value: "PingFang SC" },
		});
		expect(onChange).toHaveBeenCalledWith({ font: "PingFang SC", fontAsset: undefined });
	});

	it("选上传的那款 → 家族名留着当兜底,不清空", async () => {
		const onChange = mount({ font: "兜底那款" }, [{ id: UPLOADED, name: "某字体.ttf" }]);
		fireEvent.click(await screen.findByText("某字体.ttf"));
		expect(onChange).toHaveBeenCalledWith({ font: "兜底那款", fontAsset: UPLOADED });
	});
});

describe("删除", () => {
	it("被别处用着 → 把服务端说的「谁在用」原样告诉主人", async () => {
		vi.mocked(api.delete).mockRejectedValue(
			new (ApiError as unknown as new (s: number, b: unknown) => Error)(409, {
				referencedBy: ["全局默认", "UP 12345"],
			}),
		);
		mount({ font: "" }, [{ id: UPLOADED, name: "在用的.ttf" }]);
		fireEvent.click(await screen.findByLabelText("删除 在用的.ttf"));
		expect(await screen.findByText(/全局默认、UP 12345/)).toBeTruthy();
	});

	it("删掉的正是当前选着的那款 → 当场落回默认,不留悬空 id", async () => {
		vi.mocked(api.delete).mockResolvedValue({ ok: true } as never);
		const onChange = mount({ font: "兜底", fontAsset: UPLOADED }, [
			{ id: UPLOADED, name: "待删.ttf" },
		]);
		fireEvent.click(await screen.findByLabelText("删除 待删.ttf"));
		await waitFor(() => expect(onChange).toHaveBeenCalledWith({ font: "" }));
	});
});

/**
 * 大字体的提醒。
 *
 * 20MB 的上限是按「文件本身多大」定的,没算出图开销 —— 字体会被 base64 内联进渲染
 * HTML(再涨三分之一),而镜像里 V8 堆上限只有 384MB。所以一款完全合法的大 ttf 照样
 * 能让卡片渲染不出来。**提醒而不是拒收**:降上限会把主人已经传上去的那款挡在门外。
 */
describe("传了一款很大的字体", () => {
	/** 造一个「看起来有这么大」的文件 —— 真造 12MB 内容只会让测试变慢。 */
	function bigFile(mb: number): File {
		const f = new File(["x"], "超大字体.ttf");
		Object.defineProperty(f, "size", { value: mb * 1024 * 1024 });
		return f;
	}

	async function upload(file: File) {
		mount({ font: "" });
		vi.mocked(api.upload).mockResolvedValue({ ok: true, id: UPLOADED } as never);
		const input = document.querySelector('input[type="file"]') as HTMLInputElement;
		Object.defineProperty(input, "files", { value: [file] });
		fireEvent.change(input);
	}

	it("照收不误 —— 拦下来只会让主人没法用自己的字体", async () => {
		await upload(bigFile(12));
		// 这条提醒的前提是「收下了」,不是「拦住了」:传上去、并且当场被选用。
		await waitFor(() => expect(api.upload).toHaveBeenCalled());
	});
});

/**
 * 提醒**按当前选中的那一款算**,不是上传那一下的一次性弹词。
 *
 * 从前它是个 state,只在 `onFile` 里赋值:切走不消(横幅还在说一款已经不用了的字体)、
 * 重载就没(而正被 OOM 折磨的主人恰恰是重载之后来看这块界面的)。派生出来之后两头
 * 都对上了 —— 列表接口现在带 size,选着哪款就说哪款。
 */
describe("大字体提醒随当前选中走", () => {
	const BIG = `${"b".repeat(32)}.ttf`;
	const SMALL = `${"c".repeat(32)}.woff2`;
	const LIB = [
		{ id: BIG, name: "超大字体.ttf", size: 12 * 1024 * 1024 },
		{ id: SMALL, name: "小字体.woff2", size: 3 * 1024 * 1024 },
	];

	it("一进页面就选着那款大的 → 提醒还在,不必重传一次才看得到", async () => {
		mount({ font: "", fontAsset: BIG }, LIB);
		// 按提醒块独有的说法查:「woff2」在上传说明那一行本来就有,拿它当特征串会白过。
		const warn = await screen.findByText(/会整份进内存/);
		expect(warn.textContent).toMatch(/12\.0 MB/);
		expect(warn.textContent).toMatch(/woff2/);
	});

	it("选的是正常大小那款 → 不吵,哪怕库里还躺着一款大的", async () => {
		mount({ font: "", fontAsset: SMALL }, LIB);
		expect(await screen.findByText("小字体.woff2")).toBeTruthy();
		expect(screen.queryByText(/会整份进内存/)).toBeNull();
	});

	it("切回默认 → 提醒跟着消失,不再说一款已经不用了的字体", async () => {
		mount({ font: "" }, LIB);
		expect(await screen.findByText("超大字体.ttf")).toBeTruthy();
		expect(screen.queryByText(/会整份进内存/)).toBeNull();
	});
});
