/**
 * 路由测试 — 锐评是怎么调 AI 的:哪个入口,以及带上谁的人格。
 *
 * 单独成文件是因为要 `vi.mock` 整个 `@bilibili-notify/ai`,别的 stats 用例不该
 * 被这个 mock 波及。
 *
 * 守的是一条容易在 review 里滑过去的语义差别:`CommentaryGenerator` 有两个入口,
 * `chat()` 自动挂上 B 站只读工具、system 里带工具铁律,`comment()` 不带工具,但
 * **两者都会前置人格 system prompt**。锐评是一次性、要回 JSON 的任务,必须走后者 ——
 * 工具能力对锐评毫无用处,却多出一条「模型中途发起 tool call 而不是回 JSON」的
 * 失败路径。
 *
 * 早先 `chat()` 还按 sessionId 保存多轮历史时,误用它的代价更大:sessionId 固定 ⇒
 * 评完 A 再评 B,B 的上下文里坐着 A;「重新生成」时模型看得见自己上次的答案。那套
 * 会话记忆已经删了,这条守卫仍然成立。
 *
 * 后半段守的是 `comment()` 的**第四个参数** —— per-UP 人格覆盖。
 */

import { makeDefaultGlobalConfig } from "@bilibili-notify/internal";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createStatsRoute } from "../routes/stats.js";
import type { RouteDeps } from "../routes/types.js";

// biome-ignore lint/suspicious/noExplicitAny: 断言 mock 收到的 override 参数,不为测试再造一遍类型
const comment = vi.fn(async (_p: string, _scene?: unknown, _img?: unknown, _ov?: any) => "{}");
const chat = vi.fn(async (_prompt: string) => "{}");

vi.mock("@bilibili-notify/ai", () => ({
	// class 而不是箭头函数 —— 路由是 `new CommentaryGenerator(...)`,
	// 箭头函数不能当构造器。
	CommentaryGenerator: class {
		comment = comment;
		chat = chat;
		// 锐评生成器构造后会接联网搜索的执行器热读口,替身少了它当场抛。
		setWebSearchSource = vi.fn();
	},
	webSearchExecutorFromSettings: () => null,
}));

const AI_SETTINGS = {
	enabled: true,
	apiKey: "k",
	baseUrl: "https://example.invalid/v1",
	model: "m",
	persona: {
		name: "伦伦",
		addressUser: "主人",
		addressSelf: "我",
		traits: "毒舌",
		catchphrase: "~",
		baseRole: "女仆",
		extraSystemPrompt: "",
	},
	dynamicPrompt: "",
	liveSummaryPrompt: "",
	search: {
		backend: "bocha" as const,
		keys: { bocha: "", tavily: "" },
		engines: { dynamic: false, live: false, roast: false },
	},
};

/** 一份挂在某位 UP 头上的人格,用来认出「这次用的是他那份」。 */
const PER_UP_ROLE = "你是一只只会喵喵叫的猫";

/** per-UP 覆盖指向的那份人格在人设库里的 id。 */
const PER_UP_PRESET_ID = "preset-cat";

/** 人设库里的那一份 —— per-UP 覆盖只存 id,内容在这里。 */
const PER_UP_PRESET = {
	id: PER_UP_PRESET_ID,
	label: "猫",
	persona: {
		name: "喵喵",
		addressUser: "铲屎官",
		addressSelf: "喵",
		traits: "只会喵喵叫",
		catchphrase: "喵",
		baseRole: PER_UP_ROLE,
		extraSystemPrompt: "",
	},
	dynamicPrompt: "",
	liveSummaryPrompt: "",
};

/**
 * `overrides` 必须显式给 —— schema 上它是必填字段(空覆盖也是 `{}`),
 * `resolve()` / `resolveAiOverride()` 都直接读 `sub.overrides`。
 *
 * per-UP 人格是**一个指向人设库的 id**,不是就地写死的一份:设置页当年那档
 * 「完全自定义」已经撤掉(见 `resolve.ts` 的 `resolveSubscriptionPersona`),per-UP 只能从库里挑。
 */
function makeSub(id: string, uid: string, perUpPersona?: boolean) {
	return {
		id,
		identity: { sourceKey: "bilibili", externalId: uid },
		overrides: perUpPersona ? { ai: { preset: PER_UP_PRESET_ID } } : {},
	};
}

/** 一条拓展订阅(ADR-0020:单人锐评两支都有)。id 带着要转义的字符,验路由按编码后的订阅 id 认。 */
function makeExtSub(id: string, perUpPersona?: boolean) {
	return {
		id,
		identity: { sourceKey: "douyin", externalId: "sec-1" },
		enabled: true,
		overrides: perUpPersona ? { ai: { preset: PER_UP_PRESET_ID } } : {},
	};
}

function makeDeps(
	subs: Array<ReturnType<typeof makeSub> | ReturnType<typeof makeExtSub>>,
): RouteDeps {
	// 全局 defaults 取默认整份再覆盖 ai:resolve() 会读 features / cardStyle /
	// presets 等一系列字段,只喂 { ai } 的话 per-UP 覆盖那条路径会当场炸。
	const globals = makeDefaultGlobalConfig();
	globals.ai = { ...globals.ai, ...AI_SETTINGS };
	// per-UP 覆盖只认人设库里的 id,所以那一份得先在库里躺着。
	globals.ai.presets = [...globals.ai.presets, PER_UP_PRESET];
	return {
		runtime: {
			fansStore: { listSamplesSince: async () => [], findNearestBefore: async () => undefined },
			statsStore: {
				listPosts: async () => [],
				listLiveSessions: async () => [],
				listRecording: async () => [],
			},
			engines: {
				api: {},
				liveSession: () => undefined,
				extensionPlatformLabel: () => "抖音",
			},
			fansPoller: null,
			subRuntimeStore: { get: () => ({ cachedProfile: { name: "老番茄" } }) },
			// 「平台」一列读来源登记表的 label(拓展不在表里,问装载器)。
			sourceRegistry: {
				get: (key: string) => (key === "bilibili" ? { descriptor: { label: "B 站" } } : undefined),
			},
			serviceCtx: {},
		},
		store: {
			getSubscriptions: () => subs,
			getGlobals: () => globals,
		},
	} as unknown as RouteDeps;
}

beforeEach(() => {
	comment.mockClear();
	chat.mockClear();
});

describe("锐评的 AI 调用方式", () => {
	it("单人锐评走一次性的 comment(),不碰会话历史", async () => {
		const deps = makeDeps([makeSub("s1", "1")]);
		await createStatsRoute(deps).request("/roast/s1", { method: "POST" });
		expect(comment).toHaveBeenCalledTimes(1);
		expect(chat).not.toHaveBeenCalled();
	});

	it("榜单锐评同样走 comment()", async () => {
		const deps = makeDeps([makeSub("s1", "1"), makeSub("s2", "2")]);
		await createStatsRoute(deps).request("/roast", { method: "POST" });
		expect(comment).toHaveBeenCalledTimes(1);
		expect(chat).not.toHaveBeenCalled();
	});

	it("提示词照常带着这位 UP 的数据过去", async () => {
		const deps = makeDeps([makeSub("s1", "1")]);
		await createStatsRoute(deps).request("/roast/s1", { method: "POST" });
		expect(String(comment.mock.calls[0]?.[0])).toContain("老番茄");
	});

	it("不传 scene —— 动态/下播总结的场景补充提示词与锐评无关", async () => {
		const deps = makeDeps([makeSub("s1", "1")]);
		await createStatsRoute(deps).request("/roast/s1", { method: "POST" });
		expect(comment.mock.calls[0]?.[1]).toBeUndefined();
	});
});

/**
 * per-UP 人格。动态点评(`dynamic-poller.ts`)与下播总结(`live-summary-requester.ts`)
 * 早就把 `comment()` 的第四个参数接上了,锐评这条路径一直只传前两个 —— 主人给某位
 * UP 单配的人格,在评他自己的时候反而不算数。
 */
describe("锐评带谁的人格", () => {
	it("这位 UP 配了自己的人格时,单人锐评就用他那份", async () => {
		const deps = makeDeps([makeSub("s1", "1", true), makeSub("s2", "2")]);
		await createStatsRoute(deps).request("/roast/s1", { method: "POST" });
		// persona 已由 buildAiOverride 从 schema 的 baseRole 翻译成
		// CommentaryGenerator 的 customBase。
		expect(comment.mock.calls[0]?.[3]?.persona?.customBase).toBe(PER_UP_ROLE);
	});

	it("拿的是被评那位的人格,不是订阅列表里第一位的", async () => {
		// uid=2 配了人格、uid=1 没配。搞错主语就会拿 uid=1 的空覆盖去评 uid=2。
		const deps = makeDeps([makeSub("s1", "1"), makeSub("s2", "2", true)]);
		await createStatsRoute(deps).request("/roast/s2", { method: "POST" });
		expect(comment.mock.calls[0]?.[3]?.persona?.customBase).toBe(PER_UP_ROLE);
	});

	it("老配置里就地写死的那套人格不再生效,落回全局", async () => {
		// 设置页当年有一档「完全自定义」能就地写死一套人设,那一档撤掉了(人格一律
		// 在「智能女仆」页里写),但盘上还留着当年写下的 `persona` 字段。继续读它
		// 就成了界面上看不见、实际仍在生效的鬼配置 —— `resolveSubscriptionPersona` 刻意不读,于是
		// 老的 `'custom'`、老的 `'inherit'`、以及指向一份已被删掉的人格,三者殊途
		// 同归都落到全局。这不是回归,是迁移决定,别再「修」回去。
		const legacy = {
			id: "s1",
			identity: { sourceKey: "bilibili", externalId: "1" },
			overrides: { ai: { preset: "custom", persona: { baseRole: PER_UP_ROLE } } },
		} as unknown as ReturnType<typeof makeSub>;
		const deps = makeDeps([legacy]);
		await createStatsRoute(deps).request("/roast/s1", { method: "POST" });
		expect(comment.mock.calls[0]?.[3]?.persona?.customBase).not.toBe(PER_UP_ROLE);
	});

	it("没配 per-UP 人格时递 undefined,而不是把当时的全局值折进来", async () => {
		// undefined 与「折进全局值」**不是一回事**:留 undefined 时 CommentaryGenerator
		// 内部走 `?? this.config` 兜底,主人改了全局人格立刻生效;折进来则把当时的
		// 全局值冻成了这次调用的 per-UP 值。engines.ts 的 aiOverride 也是这条纪律。
		const deps = makeDeps([makeSub("s1", "1")]);
		await createStatsRoute(deps).request("/roast/s1", { method: "POST" });
		expect(comment.mock.calls[0]?.[3]).toBeUndefined();
	});

	it("拓展订阅的单人锐评:路由按(编码过的)订阅 id 认,带上它自己配的人格", async () => {
		const extId = "ext/抖音 1";
		const deps = makeDeps([makeSub("s1", "1"), makeExtSub(extId, true)]);
		const res = await createStatsRoute(deps).request(`/roast/${encodeURIComponent(extId)}`, {
			method: "POST",
		});
		expect(res.status).toBe(503); // 替身回的是 "{}",解析失败(unavailable)—— 但已经实打实调过模型。
		expect(comment).toHaveBeenCalledTimes(1);
		expect(String(comment.mock.calls[0]?.[0])).toContain("抖音");
		expect(comment.mock.calls[0]?.[3]?.persona?.customBase).toBe(PER_UP_ROLE);
	});

	it("榜单锐评恒走全局人格 —— 一张卡上好几位 UP,选谁的都是错的", async () => {
		// 人格是女仆的,只是按 UP 分别配置;而榜单卡不属于任何单个 UP
		// (同理它也不吃 per-kind 卡片样式)。
		const deps = makeDeps([makeSub("s1", "1", true), makeSub("s2", "2", true)]);
		await createStatsRoute(deps).request("/roast", { method: "POST" });
		expect(comment.mock.calls[0]?.[3]).toBeUndefined();
	});
});

/**
 * 响应的形状(ADR-0026):生成成功是 200 + `{ ok: true, result }`;生成没成一律是非 2xx 的
 * `{ code, message }`(状态码从码推),`message` 就是面板要显示的那句原因。
 */
describe("锐评生成的响应形状", () => {
	const SOLO_REPLY = JSON.stringify({ verdict: "还行", score: 60, highlights: [], pushText: "" });

	it("单人锐评成功 → 200 + { ok: true, result },订阅 id 由服务端带出", async () => {
		comment.mockResolvedValueOnce(SOLO_REPLY);
		const deps = makeDeps([makeSub("s1", "1")]);
		const res = await createStatsRoute(deps).request("/roast/s1", { method: "POST" });
		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok: boolean; result: { subscriptionId: string } };
		expect(body.ok).toBe(true);
		expect(body.result.subscriptionId).toBe("s1");
	});

	it("模型抛错 → 503 unavailable,模型给的原因原样进 message(面板据此判断是限流还是没配对)", async () => {
		comment.mockRejectedValueOnce(new Error("429 rate limited"));
		const deps = makeDeps([makeSub("s1", "1")]);
		const res = await createStatsRoute(deps).request("/roast/s1", { method: "POST" });
		expect(res.status).toBe(503);
		expect(await res.json()).toEqual({ code: "unavailable", message: "429 rate limited" });
	});

	it("模型回的读不懂 → 503 unavailable + 一句话,不把半截结构当成功", async () => {
		comment.mockResolvedValueOnce("我今天不想输出 JSON");
		const deps = makeDeps([makeSub("s1", "1")]);
		const res = await createStatsRoute(deps).request("/roast/s1", { method: "POST" });
		expect(res.status).toBe(503);
		const body = (await res.json()) as { code: string; message: string };
		expect(body.code).toBe("unavailable");
		expect(body.message).toContain("解析失败");
	});

	it("智能女仆没开 → 409 not_configured(要主人去开;不是 400,也不是「稍后再试」)", async () => {
		const deps = makeDeps([makeSub("s1", "1"), makeSub("s2", "2")]);
		(deps.store.getGlobals().ai as { enabled: boolean }).enabled = false;
		const single = await createStatsRoute(deps).request("/roast/s1", { method: "POST" });
		const board = await createStatsRoute(deps).request("/roast", { method: "POST" });
		for (const res of [single, board]) {
			expect(res.status).toBe(409);
			expect(((await res.json()) as { code: string }).code).toBe("not_configured");
		}
		expect(comment).not.toHaveBeenCalled();
	});

	it("榜单只订阅了 1 位 → 409 not_configured,话里说清要 2 位(先去订阅够)", async () => {
		const deps = makeDeps([makeSub("s1", "1")]);
		const res = await createStatsRoute(deps).request("/roast", { method: "POST" });
		expect(res.status).toBe(409);
		const body = (await res.json()) as { code: string; message: string };
		expect(body.code).toBe("not_configured");
		expect(body.message).toContain("2 位");
		expect(comment).not.toHaveBeenCalled();
	});

	it("引擎还没起 → 503 unavailable", async () => {
		const deps = makeDeps([makeSub("s1", "1")]);
		(deps.runtime as unknown as { engines: unknown }).engines = null;
		const res = await createStatsRoute(deps).request("/roast/s1", { method: "POST" });
		expect(res.status).toBe(503);
		expect(((await res.json()) as { code: string }).code).toBe("unavailable");
	});
});
