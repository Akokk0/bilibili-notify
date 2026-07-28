/**
 * 路由测试 — 锐评是怎么调 AI 的:哪个入口,以及带上谁的人格。
 *
 * 单独成文件是因为要 `vi.mock` 整个 `@bilibili-notify/ai`,别的 stats 用例不该
 * 被这个 mock 波及。
 *
 * 守的是一条容易在 review 里滑过去的语义差别:`CommentaryGenerator` 有两个入口,
 * `chat()` 按 sessionId **保存多轮历史**并自动挂上工具,`comment()` 是单次调用、
 * 不存历史、不带工具,但**两者都会前置人格 system prompt**。锐评是一次性任务,
 * 必须走后者 —— 走前者会有三个后果:
 *
 * 1. sessionId 固定 ⇒ 评完 A 再评 B,B 的上下文里坐着 A 的数据和上一次回复,
 *    而提示词明写着「只针对这一位」;
 * 2. 「重新生成」时模型看得见自己上次的答案,倾向照抄;
 * 3. 工具能力对锐评毫无用处,却多出一条「模型中途发起 tool call 而不是回 JSON」
 *    的失败路径。
 *
 * 后半段守的是 `comment()` 的**第四个参数** —— per-UP 人格覆盖。
 */

import { makeDefaultGlobalConfig } from "@bilibili-notify/internal";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createStatsRoute } from "../routes/stats.js";
import type { RouteDeps } from "../routes/types.js";

// biome-ignore lint/suspicious/noExplicitAny: 断言 mock 收到的 override 参数,不为测试再造一遍类型
const comment = vi.fn(async (_p: string, _scene?: unknown, _img?: unknown, _ov?: any) => "{}");
const chat = vi.fn(async (_prompt: string, _sessionId: string) => "{}");

vi.mock("@bilibili-notify/ai", () => ({
	// class 而不是箭头函数 —— 路由是 `new CommentaryGenerator(...)`,
	// 箭头函数不能当构造器。
	CommentaryGenerator: class {
		comment = comment;
		chat = chat;
	},
}));

const AI_SETTINGS = {
	enabled: true,
	apiKey: "k",
	baseUrl: "https://example.invalid/v1",
	model: "m",
	temperature: 0.7,
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
 * 「完全自定义」已经撤掉(见 `resolve.ts` 的 `resolveAI`),per-UP 只能从库里挑。
 */
function makeSub(id: string, uid: string, perUpPersona?: boolean) {
	return {
		id,
		uid,
		overrides: perUpPersona ? { ai: { preset: PER_UP_PRESET_ID } } : {},
	};
}

function makeDeps(subs: Array<ReturnType<typeof makeSub>>): RouteDeps {
	// 全局 defaults 取默认整份再覆盖 ai:resolve() 会读 features / cardStyle /
	// presets 等一系列字段,只喂 { ai } 的话 per-UP 覆盖那条路径会当场炸。
	const globals = makeDefaultGlobalConfig();
	globals.defaults.ai = { ...globals.defaults.ai, ...AI_SETTINGS };
	// per-UP 覆盖只认人设库里的 id,所以那一份得先在库里躺着。
	globals.defaults.ai.presets = [...globals.defaults.ai.presets, PER_UP_PRESET];
	return {
		runtime: {
			fansStore: { listSamplesSince: async () => [] },
			statsStore: {
				listDynamics: async () => [],
				listLiveSessions: async () => [],
				recordingSince: async () => "1970-01-01T00:00:00.000Z",
			},
			engines: { api: {}, listLiveRooms: () => [] },
			fansPoller: null,
			subRuntimeStore: { get: () => ({ cachedProfile: { name: "老番茄" } }) },
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
		await createStatsRoute(deps).request("/roast/1", { method: "POST" });
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
		await createStatsRoute(deps).request("/roast/1", { method: "POST" });
		expect(String(comment.mock.calls[0]?.[0])).toContain("老番茄");
	});

	it("不传 scene —— 动态/下播总结的场景补充提示词与锐评无关", async () => {
		const deps = makeDeps([makeSub("s1", "1")]);
		await createStatsRoute(deps).request("/roast/1", { method: "POST" });
		expect(comment.mock.calls[0]?.[1]).toBeUndefined();
	});
});

/**
 * per-UP 人格。动态点评(`dynamic-engine.ts`)与下播总结(`live-summary-requester.ts`)
 * 早就把 `comment()` 的第四个参数接上了,锐评这条路径一直只传前两个 —— 主人给某位
 * UP 单配的人格,在评他自己的时候反而不算数。
 */
describe("锐评带谁的人格", () => {
	it("这位 UP 配了自己的人格时,单人锐评就用他那份", async () => {
		const deps = makeDeps([makeSub("s1", "1", true), makeSub("s2", "2")]);
		await createStatsRoute(deps).request("/roast/1", { method: "POST" });
		// persona 已由 buildAiOverride 从 schema 的 baseRole 翻译成
		// CommentaryGenerator 的 customBase。
		expect(comment.mock.calls[0]?.[3]?.persona?.customBase).toBe(PER_UP_ROLE);
	});

	it("拿的是被评那位的人格,不是订阅列表里第一位的", async () => {
		// uid=2 配了人格、uid=1 没配。搞错主语就会拿 uid=1 的空覆盖去评 uid=2。
		const deps = makeDeps([makeSub("s1", "1"), makeSub("s2", "2", true)]);
		await createStatsRoute(deps).request("/roast/2", { method: "POST" });
		expect(comment.mock.calls[0]?.[3]?.persona?.customBase).toBe(PER_UP_ROLE);
	});

	it("老配置里就地写死的那套人格不再生效,落回全局", async () => {
		// 设置页当年有一档「完全自定义」能就地写死一套人设,那一档撤掉了(人格一律
		// 在「智能女仆」页里写),但盘上还留着当年写下的 `persona` 字段。继续读它
		// 就成了界面上看不见、实际仍在生效的鬼配置 —— `resolveAI` 刻意不读,于是
		// 老的 `'custom'`、老的 `'inherit'`、以及指向一份已被删掉的人格,三者殊途
		// 同归都落到全局。这不是回归,是迁移决定,别再「修」回去。
		const legacy = {
			id: "s1",
			uid: "1",
			overrides: { ai: { preset: "custom", persona: { baseRole: PER_UP_ROLE } } },
		} as unknown as ReturnType<typeof makeSub>;
		const deps = makeDeps([legacy]);
		await createStatsRoute(deps).request("/roast/1", { method: "POST" });
		expect(comment.mock.calls[0]?.[3]?.persona?.customBase).not.toBe(PER_UP_ROLE);
	});

	it("没配 per-UP 人格时递 undefined,而不是把当时的全局值折进来", async () => {
		// undefined 与「折进全局值」**不是一回事**:留 undefined 时 CommentaryGenerator
		// 内部走 `?? this.config` 兜底,主人改了全局人格立刻生效;折进来则把当时的
		// 全局值冻成了这次调用的 per-UP 值。engines.ts 的 aiOverride 也是这条纪律。
		const deps = makeDeps([makeSub("s1", "1")]);
		await createStatsRoute(deps).request("/roast/1", { method: "POST" });
		expect(comment.mock.calls[0]?.[3]).toBeUndefined();
	});

	it("榜单锐评恒走全局人格 —— 一张卡上好几位 UP,选谁的都是错的", async () => {
		// 人格是女仆的,只是按 UP 分别配置;而榜单卡不属于任何单个 UP
		// (同理它也不吃 per-kind 卡片样式)。
		const deps = makeDeps([makeSub("s1", "1", true), makeSub("s2", "2", true)]);
		await createStatsRoute(deps).request("/roast", { method: "POST" });
		expect(comment.mock.calls[0]?.[3]).toBeUndefined();
	});
});
