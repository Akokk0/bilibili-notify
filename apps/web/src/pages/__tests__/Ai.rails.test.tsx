// @vitest-environment jsdom

/**
 * AI 页两层 Tab 的交互 —— 左栏「点添加才出现」这套。
 *
 * 逐条守的都是**只在界面上才现形**的坑:哪几家该列在左栏、切一家右侧字段有没有真的
 * 换桶、编辑某份性格会不会顺手改了全局那一份、删掉一家之后保存条亮不亮。
 * 纯变换本身另有单测(`pages/ai/__tests__/model-ops.test.ts`),这里只管接线接对没有。
 */

import { DEFAULT_AI, makeDefaultGlobalConfig } from "@bilibili-notify/internal";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { Icon } from "../../components/icons";
import { useDraftStore } from "../../store/draft";
import { formatDiffValue } from "../../utils/formatDiffValue";
import Ai from "../Ai";
import { personaIconKey } from "../ai/persona-icons";

vi.mock("../../services/api", () => ({
	api: { get: vi.fn(), patch: vi.fn(), post: vi.fn() },
	ApiError: class extends Error {},
}));

import { api } from "../../services/api";

type Globals = ReturnType<typeof makeDefaultGlobalConfig>;
type Bucket = NonNullable<Globals["defaults"]["ai"]["providers"]["deepseek"]>;

function bucket(over: Partial<Bucket> = {}): Bucket {
	return {
		apiKey: "sk-x",
		baseUrl: "",
		model: "m-1",
		temperature: 0.7,
		enableThinking: false,
		thinkingLevel: "medium",
		extraParams: "",
		enableVision: false,
		vision: { baseUrl: "", apiKey: "", model: "" },
		...over,
	};
}

/** 造一份 globals;`mutate` 里改 `defaults.ai`。 */
function globalsWith(mutate: (g: Globals) => void): Globals {
	const g = makeDefaultGlobalConfig();
	g.defaults.ai.enabled = true;
	mutate(g);
	return JSON.parse(JSON.stringify(g));
}

function mount(g: Globals) {
	vi.mocked(api.get).mockImplementation(async (path: string) =>
		path === "/api/targets" ? [] : JSON.parse(JSON.stringify(g)),
	);
	vi.mocked(api.patch).mockImplementation(async () => JSON.parse(JSON.stringify(g)));
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<Ai />
		</QueryClientProvider>,
	);
}

/**
 * 左栏里挂着小圆点的那几项的名字(去重)。
 *
 * `SectionNav` 竖栏与窄视口横条各渲染一份同样的项,所以按按钮找再去重 ——
 * 直接数指示器个数会把同一项数两遍。
 */
function inUseRailLabels(): string[] {
	const hit = Array.from(document.querySelectorAll("button")).filter((b) =>
		b.querySelector("[data-rail-dot]"),
	);
	return [...new Set(hit.map((b) => (b.textContent ?? "").trim()))];
}

beforeEach(() => {
	useDraftStore.setState({
		current: null,
		uiState: "idle",
		errorMessage: null,
		panelLocked: false,
	});
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("模型配置 · 服务商左栏", () => {
	/** 落地页是「全局配置」,先切到模型那一页。 */
	async function gotoModel() {
		fireEvent.click(await screen.findByRole("tab", { name: /模型配置/ }));
	}

	it("一家都没添加 → 出空态引导与添加面板,而不是一堆空输入框", async () => {
		mount(
			globalsWith((g) => {
				g.defaults.ai.providers = {};
			}),
		);
		await gotoModel();
		expect(await screen.findByText("添加服务商")).toBeTruthy();
		expect(screen.getByText(/还没添加任何服务商/)).toBeTruthy();
		// 没有选中任何一家,连接表单不该出现 —— 摆一组空框子只会让人以为配好了。
		expect(screen.queryByText("模型连接")).toBeNull();
	});

	it("总开关开着却一家都没配 → 明确说清此刻不工作(而不是偷偷把开关关掉)", async () => {
		mount(
			globalsWith((g) => {
				g.defaults.ai.enabled = true;
				g.defaults.ai.providers = {};
			}),
		);
		expect(await screen.findByText(/一家服务商都还没添加/)).toBeTruthy();
	});

	it("左栏只列已添加的那几家,没添加的一家都不露", async () => {
		mount(
			globalsWith((g) => {
				g.defaults.ai.provider = "deepseek";
				g.defaults.ai.providers = { deepseek: bucket(), openrouter: bucket() };
			}),
		);
		await gotoModel();
		await screen.findByText("模型连接");
		expect(screen.queryAllByText("DeepSeek").length).toBeGreaterThan(0);
		expect(screen.queryAllByText("OpenRouter").length).toBeGreaterThan(0);
		// 没添加过的三家不该出现在左栏(添加面板此刻是收起的)。
		expect(screen.queryByText("硅基流动")).toBeNull();
		expect(screen.queryByText("火山方舟")).toBeNull();
	});

	it("点左栏另一家 → 右侧字段跟着换那家的桶", async () => {
		mount(
			globalsWith((g) => {
				g.defaults.ai.provider = "deepseek";
				g.defaults.ai.providers = {
					deepseek: bucket({ model: "ds-model" }),
					openrouter: bucket({ model: "or-model" }),
				};
			}),
		);
		await gotoModel();
		expect(await screen.findByDisplayValue("ds-model")).toBeTruthy();
		// 左栏的 OpenRouter 有竖栏与窄视口两处渲染,点第一个即可。
		fireEvent.click(screen.getAllByText("OpenRouter")[0] as HTMLElement);
		await waitFor(() => expect(screen.getByDisplayValue("or-model")).toBeTruthy());
		expect(screen.queryByDisplayValue("ds-model")).toBeNull();
	});

	it("按能力门控:DeepSeek 不摆「主模型支持看图」,OpenRouter 摆", async () => {
		mount(
			globalsWith((g) => {
				g.defaults.ai.provider = "deepseek";
				g.defaults.ai.providers = { deepseek: bucket(), openrouter: bucket() };
			}),
		);
		await gotoModel();
		await screen.findByText("模型连接");
		expect(screen.queryByLabelText("主模型支持看图")).toBeNull();
		expect(screen.getByText(/没有能看图的模型/)).toBeTruthy();

		fireEvent.click(screen.getAllByText("OpenRouter")[0] as HTMLElement);
		await waitFor(() => expect(screen.getByLabelText("主模型支持看图")).toBeTruthy());
	});

	it("删掉唯一一家(且那家还是一片默认值)→ 灵动岛仍必须亮起来", async () => {
		// 这是**唯一**靠合成字段才看得见的情形,也是最容易漏的:
		// 灵动岛只认得「摊平后的当前那一家」。桶里全是默认值时,删掉它以后
		// resolveAIProfile 兜回来的空档案与删之前**逐字段完全相同**,指针也没得可换
		// (没有下一家),于是摊平结果一字不差 → 保存条不亮 → 主人一走,删除就没了,
		// 刷新回来那家还列在左栏(「我明明删了它」)。packIsland 里那条
		// providerList 就是为这一刻。
		mount(
			globalsWith((g) => {
				g.defaults.ai.provider = "custom";
				g.defaults.ai.providers = {
					custom: bucket({ apiKey: "", model: "", temperature: 0.7 }),
				};
			}),
		);
		await gotoModel();
		await screen.findByText("模型连接");
		fireEvent.click(screen.getByText(/删除 自定义/));
		await waitFor(() => {
			expect(useDraftStore.getState().current?.diff.length ?? 0).toBeGreaterThan(0);
		});
	});

	it("删掉正在用的那家 → 指针落到剩下的一家,右侧跟着换过去", async () => {
		mount(
			globalsWith((g) => {
				g.defaults.ai.provider = "deepseek";
				g.defaults.ai.providers = {
					deepseek: bucket({ model: "ds-model" }),
					openrouter: bucket({ model: "or-model" }),
				};
			}),
		);
		await gotoModel();
		expect(await screen.findByDisplayValue("ds-model")).toBeTruthy();
		fireEvent.click(screen.getByText(/删除 DeepSeek/));
		await waitFor(() => expect(screen.getByDisplayValue("or-model")).toBeTruthy());
		// 被删那家从左栏消失。
		expect(screen.queryByText("DeepSeek")).toBeNull();
	});
});

/**
 * 「在看哪一家」与「在用哪一家」是两件事。
 *
 * 曾经它们共用 `ai.provider`:点左栏想看看另一家的配置 = 当场换掉了女仆在用的那家,
 * 界面上没有任何提示。人格那半边早就拆开了(左栏 = 编辑谁,`activePreset` = 用谁),
 * 服务商这半边补上同一套语义。
 *
 * 观察点是**头图那颗 model 药丸** —— 它显示的是女仆真正在用的那家的模型,与右侧
 * 正在编辑的那家无关。用它来区分两个概念,比读内部状态更贴近主人看到的东西。
 */
describe("在用哪一家 vs 在看哪一家", () => {
	function twoProviders() {
		return globalsWith((g) => {
			g.defaults.ai.provider = "deepseek";
			g.defaults.ai.providers = {
				deepseek: bucket({ model: "ds-model" }),
				openrouter: bucket({ model: "or-model" }),
			};
		});
	}

	/** 头图药丸上的模型名 —— 女仆此刻真正在用的那家。 */
	function heroModel(): string {
		const pill = document.querySelector("[data-hero-model]");
		return pill?.textContent ?? "";
	}

	async function gotoModel() {
		fireEvent.click(await screen.findByRole("tab", { name: /模型配置/ }));
		await screen.findByText("模型连接");
	}

	it("点左栏另一家 → 只换在编辑谁,女仆在用的还是原来那家", async () => {
		mount(twoProviders());
		await gotoModel();
		expect(heroModel()).toBe("ds-model");
		fireEvent.click(screen.getAllByText("OpenRouter")[0] as HTMLElement);
		await waitFor(() => expect(screen.getByDisplayValue("or-model")).toBeTruthy());
		expect(heroModel()).toBe("ds-model");
	});

	it("左栏用指示器标出在用的那家,不写「在用」二字", async () => {
		// 左栏一栏里有两个概念:高亮 = 在看谁,指示器 = 在用哪家。写成文字角标会跟
		// 底下那行模型名挤在一起,读起来像是模型的一部分。
		mount(twoProviders());
		await gotoModel();
		expect(inUseRailLabels().every((t) => t.includes("DeepSeek"))).toBe(true);
		expect(inUseRailLabels().length).toBeGreaterThan(0);
		expect(screen.queryByText("在用")).toBeNull();
	});

	it("在看的不是在用的那家 → 右上角摆「设为默认」,点了才真换", async () => {
		mount(twoProviders());
		await gotoModel();
		fireEvent.click(screen.getAllByText("OpenRouter")[0] as HTMLElement);
		await waitFor(() => expect(screen.getByDisplayValue("or-model")).toBeTruthy());
		fireEvent.click(screen.getByText("设为默认"));
		await waitFor(() => expect(heroModel()).toBe("or-model"));
	});

	it("在看的就是在用的那家 → 不摆「设为默认」,而是说明白它就是在用的那家", async () => {
		// 摆一个点了等于没点的按钮,比不摆还糟。
		mount(twoProviders());
		await gotoModel();
		expect(screen.queryByText("设为默认")).toBeNull();
		expect(screen.getByText(/女仆平时用的就是这家/)).toBeTruthy();
	});

	it("「全局配置」里能直接选用哪一家 —— 和选人格同一个地方", async () => {
		mount(twoProviders());
		// 落地页就是「全局配置」。
		await screen.findByText("全局服务商 · provider");
		fireEvent.click(screen.getByText("OpenRouter"));
		await waitFor(() => expect(heroModel()).toBe("or-model"));
	});

	it("添加第二家**不**抢走在用的那家,只是切过去编辑", async () => {
		mount(twoProviders());
		await gotoModel();
		fireEvent.click(screen.getAllByText("+ 添加")[0] as HTMLElement);
		fireEvent.click(await screen.findByText("硅基流动"));
		await waitFor(() => expect(screen.getByText(/删除 硅基流动/)).toBeTruthy());
		expect(heroModel()).toBe("ds-model");
	});

	it("删掉一家填了密钥的 → 灵动岛面板上不该出现明文密钥", async () => {
		// 逐家摊平时若让没添加过的那家**整个缺席**,walkTreeDiff 碰上「一侧是对象、
		// 另一侧 undefined」会把整只桶当**一个叶子**吐出来 —— 那一行的值就是桶的
		// JSON,脱敏位挂在字段级、管不到整只桶,于是密钥明文直接摊在面板上。
		mount(
			globalsWith((g) => {
				g.defaults.ai.provider = "deepseek";
				g.defaults.ai.providers = {
					deepseek: bucket({ model: "ds-model" }),
					openrouter: bucket({ apiKey: "sk-super-secret", model: "or-model" }),
				};
			}),
		);
		await gotoModel();
		fireEvent.click(screen.getAllByText("OpenRouter")[0] as HTMLElement);
		await waitFor(() => expect(screen.getByDisplayValue("or-model")).toBeTruthy());
		fireEvent.click(screen.getByText(/删除 OpenRouter/));
		await waitFor(() => {
			expect(useDraftStore.getState().current?.diff.length ?? 0).toBeGreaterThan(0);
		});
		// 断言的是**面板上真会显示的东西**(diff 里存的本就是原值,脱敏发生在渲染)。
		const shown = (useDraftStore.getState().current?.diff ?? [])
			.flatMap((d) => [formatDiffValue(d.code, d.oldValue), formatDiffValue(d.code, d.newValue)])
			.map((v) => v.display)
			.join("\n");
		expect(shown).not.toContain("sk-super-secret");
	});

	it("编辑**不在用**的那家 → 改在它自己的桶上,不是写回在用那家", async () => {
		// 写错桶的后果有两层:输入框显示的还是旧值(「我改了没反应」),而**在用的那家**
		// 被悄悄改坏了 —— 那才是真正生效的配置。
		mount(twoProviders());
		await gotoModel();
		fireEvent.click(screen.getAllByText("OpenRouter")[0] as HTMLElement);
		await waitFor(() => expect(screen.getByDisplayValue("or-model")).toBeTruthy());
		fireEvent.change(screen.getByDisplayValue("or-model"), { target: { value: "or-model-2" } });
		await waitFor(() => expect(screen.getByDisplayValue("or-model-2")).toBeTruthy());
		// 在用的那家一个字没动。
		expect(heroModel()).toBe("ds-model");
	});

	it("编辑**不在用**的那家 → 灵动岛照样亮,否则一离开页面就白改了", async () => {
		// 灵动岛此前只摊平「在用的那家」。左栏改成编辑器之后,改别家的桶在它眼里
		// 毫无变化 —— 保存条不亮,主人一走改动就没了。
		mount(twoProviders());
		await gotoModel();
		fireEvent.click(screen.getAllByText("OpenRouter")[0] as HTMLElement);
		await waitFor(() => expect(screen.getByDisplayValue("or-model")).toBeTruthy());
		fireEvent.change(screen.getByDisplayValue("or-model"), { target: { value: "or-model-2" } });
		await waitFor(() => {
			expect(useDraftStore.getState().current?.diff.length ?? 0).toBeGreaterThan(0);
		});
	});
});

describe("女仆性格左栏", () => {
	/** 切到「女仆性格」Tab。 */
	async function gotoPersona() {
		fireEvent.click(await screen.findByRole("tab", { name: /女仆性格/ }));
		await screen.findByText(/人格塑造/);
	}

	it("左栏就是人格清单本身,没有多余的「默认」项", async () => {
		// 「默认」曾经是 ai.persona 的入口,而它与 presets[0]「温柔女仆」本就是同一份 ——
		// 同一份东西摆两遍还得解释哪个算数。schema 迁移保证清单恒非空。
		mount(globalsWith(() => {}));
		await gotoPersona();
		expect(screen.queryByText("默认")).toBeNull();
		expect(screen.getAllByText("温柔女仆").length).toBeGreaterThan(0);
	});

	it("点另一份 → 右侧换成它自己的字段", async () => {
		mount(
			globalsWith((g) => {
				g.defaults.ai.presets = [
					{ id: "a", label: "甲", persona: { ...g.defaults.ai.persona, name: "甲的名" } },
					{ id: "b", label: "乙", persona: { ...g.defaults.ai.persona, name: "乙的名" } },
				];
				g.defaults.ai.activePreset = "a";
			}),
		);
		await gotoPersona();
		expect(screen.getByDisplayValue("甲的名")).toBeTruthy();
		fireEvent.click(screen.getAllByText("乙")[0] as HTMLElement);
		await waitFor(() => expect(screen.getByDisplayValue("乙的名")).toBeTruthy());
		expect(screen.queryByDisplayValue("甲的名")).toBeNull();
	});

	it("改一份预设不会顺手改掉全局那一份 —— 这正是旧界面的毛病", async () => {
		// 旧界面里点一下预设就把它**复制进** ai.persona,主人手写的全局人格当场被覆盖。
		mount(
			globalsWith((g) => {
				g.defaults.ai.persona.name = "梦梦";
				g.defaults.ai.presets = [
					{
						id: "tsundere",
						label: "傲娇",
						persona: { ...g.defaults.ai.persona, name: "傲娇娘" },
					},
				];
			}),
		);
		await gotoPersona();
		fireEvent.click(screen.getAllByText("傲娇")[0] as HTMLElement);
		const nameInput = await screen.findByDisplayValue("傲娇娘");
		fireEvent.change(nameInput, { target: { value: "超傲娇" } });

		await act(async () => {
			useDraftStore.getState().current?.onSave();
		});
		await waitFor(() => expect(api.patch).toHaveBeenCalled());
		const [, body] = vi.mocked(api.patch).mock.calls.at(-1) as [
			string,
			{ defaults: { ai: { persona?: { name?: string }; presets?: unknown } } },
		];
		// 预设改了、全局人格没被碰(没进 patch,或进了但名字还是梦梦)。
		expect(body.defaults.ai.persona?.name ?? "梦梦").toBe("梦梦");
	});

	it("「+ 添加」建出一份新性格并当场切过去(否则看起来像没反应)", async () => {
		mount(
			globalsWith((g) => {
				g.defaults.ai.presets = [];
			}),
		);
		await gotoPersona();
		// 「+ 添加」开的是面板(新建空白 / 从内置恢复),再点「+ 空白性格」才真建。
		fireEvent.click(screen.getAllByText("+ 添加")[0] as HTMLElement);
		fireEvent.click(await screen.findByText("+ 空白性格"));
		await waitFor(() => expect(screen.getByDisplayValue("新性格")).toBeTruthy());
	});

	it("左栏用指示器标出在用的那份,不写字", async () => {
		mount(
			globalsWith((g) => {
				g.defaults.ai.presets = [
					{ id: "a", label: "甲", persona: g.defaults.ai.persona },
					{ id: "b", label: "乙", persona: g.defaults.ai.persona },
				];
				g.defaults.ai.activePreset = "b";
			}),
		);
		await gotoPersona();
		expect(inUseRailLabels()).toEqual(["乙"]);
	});

	it("正在用的那份不摆「设为默认」,别的才摆", async () => {
		mount(
			globalsWith((g) => {
				g.defaults.ai.presets = [
					{ id: "a", label: "甲", persona: g.defaults.ai.persona },
					{ id: "b", label: "乙", persona: g.defaults.ai.persona },
				];
				g.defaults.ai.activePreset = "a";
			}),
		);
		await gotoPersona();
		expect(screen.queryByText("设为默认")).toBeNull();
		fireEvent.click(screen.getAllByText("乙")[0] as HTMLElement);
		await waitFor(() => expect(screen.getByText("设为默认")).toBeTruthy());
	});

	it("只剩一份时不摆删除按钮 —— 摆一个点了没反应的比没有还糟", async () => {
		mount(
			globalsWith((g) => {
				g.defaults.ai.presets = [{ id: "only", label: "唯一", persona: g.defaults.ai.persona }];
				g.defaults.ai.activePreset = "only";
			}),
		);
		await gotoPersona();
		expect(screen.queryByText("删除")).toBeNull();
	});
});

describe("全局配置 Tab", () => {
	async function gotoGlobal() {
		fireEvent.click(await screen.findByRole("tab", { name: /全局配置/ }));
		await screen.findByText("全局人格 · persona");
	}

	it("日志等级与「试一句」都在这里 —— 它们不属于某一家服务商也不属于某一份性格", async () => {
		mount(globalsWith(() => {}));
		await gotoGlobal();
		expect(screen.getByText("跟随全局")).toBeTruthy();
		expect(screen.getByText("诊断 · logging")).toBeTruthy();
	});

	/** 选择器里当前被按下的那一项的文字。 */
	function pickedPersona(): string | undefined {
		return screen
			.getAllByRole("button", { pressed: true })
			.map((b) => b.textContent ?? "")
			.find((t) => t === "温柔女仆" || t === "傲娇");
	}

	it("没设指针时选中第一份「温柔女仆」", async () => {
		mount(globalsWith(() => {}));
		await gotoGlobal();
		expect(pickedPersona()).toBe("温柔女仆");
	});

	it("设了指针时选中的是那一份 —— 而不是永远停在「默认」", async () => {
		mount(
			globalsWith((g) => {
				g.defaults.ai.presets = [
					{ id: "m", label: "温柔女仆", persona: g.defaults.ai.persona },
					{ id: "t", label: "傲娇", persona: g.defaults.ai.persona },
				];
				g.defaults.ai.activePreset = "t";
			}),
		);
		await gotoGlobal();
		expect(pickedPersona()).toBe("傲娇");
	});

	it("选一份预设 → 存的是指针,**不覆盖**主人手写的全局人格", async () => {
		// 这是加 ai.activePreset 的全部理由:旧做法是把预设复制进 ai.persona,
		// 一下盖掉主人手写的那份且换不回来。
		mount(
			globalsWith((g) => {
				g.defaults.ai.persona.name = "梦梦";
				g.defaults.ai.presets = [
					{
						id: "tsundere",
						label: "傲娇",
						persona: { ...g.defaults.ai.persona, name: "傲娇娘" },
					},
				];
			}),
		);
		await gotoGlobal();
		fireEvent.click(screen.getAllByText("傲娇")[0] as HTMLElement);

		await act(async () => {
			useDraftStore.getState().current?.onSave();
		});
		await waitFor(() => expect(api.patch).toHaveBeenCalled());
		const [, body] = vi.mocked(api.patch).mock.calls.at(-1) as [
			string,
			{ defaults: { ai: { activePreset?: string; persona?: { name?: string } } } },
		];
		expect(body.defaults.ai.activePreset).toBe("tsundere");
		// 手写的那份原封不动(没进 patch,或进了名字还是梦梦)。
		expect(body.defaults.ai.persona?.name ?? "梦梦").toBe("梦梦");
	});

	/**
	 * 头图那行名字得跟着**指针**走。
	 *
	 * `ai.persona` 自指针上线就没有界面入口了,永远冻在老值上。头图直读它的话,主人
	 * 在这一页把人格换成谁,标题都还写着原来那位 —— 而下面的选择器、左栏指示器全都
	 * 指着新那份。这正是「换了人格没反应」看起来的样子。
	 */
	it("换全局人格 → 头图那行名字跟着换,不是冻着的 ai.persona", async () => {
		mount(
			globalsWith((g) => {
				g.defaults.ai.persona.name = "小绫";
				g.defaults.ai.presets = [
					{ id: "m", label: "温柔女仆", persona: { ...g.defaults.ai.persona } },
					{ id: "t", label: "傲娇", persona: { ...g.defaults.ai.persona, name: "凛子" } },
				];
				g.defaults.ai.activePreset = "t";
			}),
		);
		await gotoGlobal();
		expect(screen.getByText(/智能女仆 · 凛子/)).toBeTruthy();
	});

	it("换全局人格 → 灵动岛亮起来", async () => {
		mount(
			globalsWith((g) => {
				g.defaults.ai.presets = [{ id: "t", label: "傲娇", persona: g.defaults.ai.persona }];
			}),
		);
		await gotoGlobal();
		fireEvent.click(screen.getAllByText("傲娇")[0] as HTMLElement);
		await waitFor(() => {
			expect(useDraftStore.getState().current?.diff.length ?? 0).toBeGreaterThan(0);
		});
	});
});

describe("内置人格的图标", () => {
	/** 左栏里某一项(竖栏那份)所带的 svg 标记。 */
	function railGlyph(label: string): string | undefined {
		const btn = screen
			.getAllByText(label)
			.map((el) => el.closest("button"))
			.find((b): b is HTMLButtonElement => b !== null);
		return btn?.querySelector("svg")?.outerHTML;
	}

	async function mountBuiltins() {
		mount(globalsWith(() => {}));
		fireEvent.click(await screen.findByRole("tab", { name: /女仆性格/ }));
		await screen.findByText(/人格塑造/);
	}

	it("四份内置各用各的图标,不是清一色一个样", async () => {
		// 最容易犯的接线错:拿带前缀的左栏 id 去查表 → 全部落到兜底的小人像,
		// 而界面上「都有个图标」看着并不像坏了。
		await mountBuiltins();
		// 标签从注册表取,不写死 —— 改人格名字不该把这条测试也带红。
		const glyphs = DEFAULT_AI.presets.map((p) => railGlyph(p.label));
		expect(glyphs.every((g) => g !== undefined)).toBe(true);
		expect(new Set(glyphs).size).toBe(DEFAULT_AI.presets.length);
	});

	it("每一份内置用的正是映射表里那个 —— 表与界面对得上", async () => {
		// 拿另行渲染的同一个 Icon 做对照,不写死 svg 路径数据(图标重画时不该红)。
		await mountBuiltins();
		for (const p of DEFAULT_AI.presets) {
			const Glyph = Icon[personaIconKey(p.id)];
			const { container, unmount } = render(<Glyph size={14} />);
			expect(railGlyph(p.label)).toBe(container.querySelector("svg")?.outerHTML);
			unmount();
		}
	});

	it("主人新加的那份用通用小人像", async () => {
		await mountBuiltins();
		fireEvent.click(screen.getAllByText("+ 添加")[0] as HTMLElement);
		fireEvent.click(await screen.findByText("+ 空白性格"));
		await waitFor(() => expect(screen.getByDisplayValue("新性格")).toBeTruthy());

		const { container } = render(<Icon.user size={14} />);
		expect(railGlyph("新性格")).toBe(container.querySelector("svg")?.outerHTML);
	});
});

describe("内置性格:锁死、可删、可恢复、可另存", () => {
	async function gotoPersona2() {
		fireEvent.click(await screen.findByRole("tab", { name: /女仆性格/ }));
		await screen.findByText(/人格塑造/);
	}

	/** 按 `<Field code>` 精确取输入框 —— 同一份人格里 name 与 addressSelf 可能同值。 */
	function fieldInput(code: string): HTMLInputElement {
		const el = document.querySelector<HTMLInputElement>(`[data-code="${code}"] input`);
		if (!el) throw new Error(`找不到字段 ${code}`);
		return el;
	}

	it("选中内置那份 → 字段全禁用,并说清为什么", async () => {
		mount(globalsWith(() => {}));
		await gotoPersona2();
		// 落地选中第一份「温柔女仆」,它是内置的。
		expect(screen.getByText(/内置性格/)).toBeTruthy();
		expect(fieldInput("persona.name").value).toBe("小绫");
		expect(fieldInput("persona.name").disabled).toBe(true);
		expect(fieldInput("persona.traits").disabled).toBe(true);
	});

	it("内置那份摆「从内置修改」,自建的不摆", async () => {
		mount(globalsWith(() => {}));
		await gotoPersona2();
		expect(screen.getByText("从内置修改")).toBeTruthy();

		fireEvent.click(screen.getAllByText("+ 添加")[0] as HTMLElement);
		fireEvent.click(await screen.findByText("+ 空白性格"));
		await waitFor(() => expect(screen.getByDisplayValue("新性格")).toBeTruthy());
		expect(screen.queryByText("从内置修改")).toBeNull();
	});

	it("「从内置修改」另存一份可改的,原件不动", async () => {
		mount(globalsWith(() => {}));
		await gotoPersona2();
		fireEvent.click(screen.getByText("从内置修改"));

		// 切到副本:名称格出现且可改。
		const nameInput = await screen.findByDisplayValue("温柔女仆 副本");
		expect((nameInput as HTMLInputElement).disabled).toBe(false);
		// 副本内容照抄原件,且可改。
		expect(fieldInput("persona.name").value).toBe("小绫");
		expect(fieldInput("persona.name").disabled).toBe(false);
		// 原件仍在清单里,且仍是锁着的。
		fireEvent.click(screen.getAllByText("温柔女仆")[0] as HTMLElement);
		await waitFor(() => expect(fieldInput("persona.name").disabled).toBe(true));
	});

	it("删掉一份内置 → 「从内置恢复」里列得出来,点一下回来", async () => {
		mount(globalsWith(() => {}));
		await gotoPersona2();
		// 选中傲娇毒舌并删掉。
		fireEvent.click(screen.getAllByText("傲娇毒舌")[0] as HTMLElement);
		await waitFor(() => expect(screen.getByDisplayValue("凛子")).toBeTruthy());
		fireEvent.click(screen.getByText("删除"));
		await waitFor(() => expect(screen.queryByText("傲娇毒舌")).toBeNull());

		// 从添加面板恢复。
		fireEvent.click(screen.getAllByText("+ 添加")[0] as HTMLElement);
		fireEvent.click(await screen.findByText("傲娇毒舌"));
		await waitFor(() => expect(screen.getByDisplayValue("凛子")).toBeTruthy());
	});

	it("一份内置都没删时,面板明说没得恢复", async () => {
		mount(globalsWith(() => {}));
		await gotoPersona2();
		fireEvent.click(screen.getAllByText("+ 添加")[0] as HTMLElement);
		expect(await screen.findByText(/都在清单里/)).toBeTruthy();
	});
});
