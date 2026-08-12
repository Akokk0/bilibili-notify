/**
 * AI 测试推送 —— `POST /api/ai/test-push`。
 *
 * 智能女仆的「试一句」:拿 AI 页**当前草稿**的人格(可能还没保存)当 system prompt,
 * 用户递一句话 / 一个问题,让她回一句,把回复真实推到指定的 PushTarget,同时把回复
 * 文本带回页面 —— 调人格时不必跑去 QQ 里翻。
 *
 * 与 `/api/cards/test-push`(草稿样式 + 真实推送)同形,只是把「渲染卡片」换成
 * 「问一句 AI」。OpenAI 那一跳是外部边界,mock 掉。
 */
import type { GlobalConfig } from "@bilibili-notify/internal";
import { makeDefaultGlobalConfig } from "@bilibili-notify/internal";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createAiRoute } from "../ai.js";
import { REDACTED_API_KEY } from "../globals.js";
import type { RouteDeps } from "../types.js";

const TARGET_ID = "11111111-1111-4111-8111-111111111111";

/** CommentaryGenerator 是外部 LLM 的门面 —— spy 掉,别真打网络。 */
const H = vi.hoisted(() => ({
	instances: [] as Array<{ config: unknown }>,
	reply: "在的主人~有什么可以为您效劳的呢 (*´ω`*)",
	/** 置上就让下一次 chat() 抛 —— 模拟 401 / 模型不存在 / 网络断。 */
	chatError: null as Error | null,
}));

vi.mock("@bilibili-notify/ai", () => ({
	CommentaryGenerator: class {
		config: unknown;
		chat = vi.fn(async () => {
			if (H.chatError) throw H.chatError;
			return H.reply;
		});
		stop = vi.fn();
		clearSession = vi.fn();
		constructor(opts: { config: unknown }) {
			this.config = opts.config;
			H.instances.push(this);
		}
	},
}));

beforeEach(() => {
	H.instances.length = 0;
	H.chatError = null;
});

/**
 * 造一份「AI 页草稿」。连接字段住在服务商桶里(各家一套配置),`bucket` 用来覆盖
 * 桶内字段(apiKey / model …),`over` 覆盖 ai 顶层字段。
 *
 * 人格走**指针**:设置页改人格改的是 `presets[i]`,`activePreset` 指着当前那份 ——
 * `ai.persona` 自指针上线就没有界面入口了。所以草稿里「主人现在用的那份」得这么造,
 * 照老样子直接改 `ai.persona` 是造不出来的形状。
 */
function draftAi(
	bucket: Partial<GlobalConfig["defaults"]["ai"]["providers"]["deepseek"]> = {},
	over: Partial<GlobalConfig["defaults"]["ai"]> = {},
) {
	const ai = makeDefaultGlobalConfig().defaults.ai;
	return {
		...ai,
		enabled: true,
		activeProfile: "deepseek",
		providers: {
			deepseek: {
				provider: "deepseek" as const,
				apiFlavor: "chat",
				label: "",
				apiKey: "sk-draft",
				baseUrl: "https://api.example.com/v1",
				model: "test-model",
				temperature: 0.7,
				enableThinking: false,
				thinkingLevel: "medium" as const,
				extraParams: "",
				enableVision: false,
				vision: { baseUrl: "", apiKey: "", model: "" },
				...bucket,
			},
		},
		presets: [
			...ai.presets,
			{
				id: "demon-bunny",
				label: "恶魔兔",
				persona: { ...ai.persona, name: "恶魔兔", traits: "调皮，会整活" },
				dynamicPrompt: "用恶魔兔的口气讲",
			},
		],
		activePreset: "demon-bunny",
		...over,
	};
}

function makeDeps() {
	const sendToTarget = vi.fn(async () => ({ ok: true, latencyMs: 12 }));
	const globals = makeDefaultGlobalConfig();
	// store 里已存的那把 —— 必须与草稿选中的**同一个桶**,否则会拿 A 家的 key
	// 去打 B 家的接口。
	globals.defaults.ai.activeProfile = "deepseek";
	globals.defaults.ai.providers = {
		deepseek: {
			provider: "deepseek",
			apiFlavor: "chat",
			label: "",
			apiKey: "sk-stored",
			baseUrl: "https://api.example.com/v1",
			model: "test-model",
			temperature: 0.7,
			enableThinking: false,
			thinkingLevel: "medium",
			extraParams: "",
			enableVision: false,
			vision: { baseUrl: "", apiKey: "", model: "" },
		},
	};
	return {
		deps: {
			runtime: {
				serviceCtx: {
					logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
					forSubsystem: () => ({
						logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
					}),
				},
				engines: { push: { sendToTarget }, api: {} },
			},
			store: {
				getTargets: () => [{ id: TARGET_ID, name: "我的私聊", platform: "onebot" }],
				getGlobals: () => globals,
			},
		} as unknown as RouteDeps,
		sendToTarget,
	};
}

function post(app: ReturnType<typeof createAiRoute>, body: unknown) {
	return app.request("/test-push", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

describe("POST /api/ai/test-push", () => {
	it("草稿人格 + 一句话 → 回复推到指定目标,并把回复带回页面", async () => {
		const { deps, sendToTarget } = makeDeps();
		const app = createAiRoute(deps);

		const res = await post(app, {
			targetId: TARGET_ID,
			message: "在吗?",
			ai: draftAi(),
		});

		expect(res.status).toBe(200);
		const json = (await res.json()) as { ok: boolean; reply?: string; latencyMs: number };
		expect(json.ok).toBe(true);
		// 页面要能就地看到女仆回了什么。
		expect(json.reply).toBe(H.reply);

		// 而且是真的推出去了 —— 推的正是那段回复。
		expect(sendToTarget).toHaveBeenCalledTimes(1);
		const [targetId, payload] = sendToTarget.mock.calls[0] as unknown as [
			string,
			{ kind: string; text: string },
		];
		expect(targetId).toBe(TARGET_ID);
		expect(payload.kind).toBe("text");
		expect(payload.text).toContain(H.reply);
	});

	it("草稿人格真的喂进了 generator —— 未保存的改动也生效", async () => {
		const { deps } = makeDeps();
		const app = createAiRoute(deps);

		await post(app, {
			targetId: TARGET_ID,
			message: "在吗?",
			ai: draftAi({ model: "draft-only-model" }),
		});

		// 用草稿**临时**造实例,而不是复用正在跑的 commentary —— 否则「试一句」会把
		// 未保存的人格泄进真实推送。
		expect(H.instances).toHaveLength(1);
		const cfg = H.instances[0]?.config as { model: string; persona: { name: string } };
		expect(cfg.model).toBe("draft-only-model");
		expect(cfg.persona.name).toBe("恶魔兔");
	});

	/**
	 * 「换了人格没反应」那个 bug 的现场之一。
	 *
	 * `ai.persona` 自指针上线就没有界面入口,永远冻在老值上(全新配置里是「小绫」)。
	 * 这里直读它的话,主人在设置页把人格换成谁都白换 —— 试出来的还是原来那位,
	 * 而界面上左栏高亮、指示器全都指着新那份,看不出哪里不对。
	 */
	it("指针指向别的人格 → 试的就是那份,不是冻在 ai.persona 的老值", async () => {
		const { deps } = makeDeps();
		const app = createAiRoute(deps);

		await post(app, { targetId: TARGET_ID, message: "在吗?", ai: draftAi() });

		const cfg = H.instances[0]?.config as {
			persona: { name: string; traits: string };
			dynamicPrompt: string;
		};
		// 草稿的 ai.persona 还是默认那份「小绫」,指针指着「恶魔兔」。
		expect(cfg.persona.name).not.toBe("小绫");
		expect(cfg.persona.traits).toBe("调皮，会整活");
		// 口吻那两段同理 —— 只换人格不换 prompt 等于只换了一半。
		expect(cfg.dynamicPrompt).toBe("用恶魔兔的口气讲");
	});

	// 前端 GET /api/globals 拿到的 apiKey 是 REDACTED 占位。用户只要没动过那一栏,
	// 草稿里带回来的就是占位串本身 —— 直接拿它当 key 去调 OpenAI 必然 401。
	it("草稿的 apiKey 是脱敏占位 → 回落到已存的真 key", async () => {
		const { deps } = makeDeps(); // store 里存着 sk-stored
		const app = createAiRoute(deps);

		await post(app, {
			targetId: TARGET_ID,
			message: "在吗?",
			ai: draftAi({ apiKey: REDACTED_API_KEY }),
		});

		const cfg = H.instances[0]?.config as { apiKey: string };
		expect(cfg.apiKey).toBe("sk-stored");
	});

	it("草稿的 apiKey 是新填的 → 用新的(还没保存也能先试)", async () => {
		const { deps } = makeDeps();
		const app = createAiRoute(deps);

		await post(app, {
			targetId: TARGET_ID,
			message: "在吗?",
			ai: draftAi({ apiKey: "sk-brand-new" }),
		});

		const cfg = H.instances[0]?.config as { apiKey: string };
		expect(cfg.apiKey).toBe("sk-brand-new");
	});

	it("目标不存在 → 404,不问 AI 也不推送", async () => {
		const { deps, sendToTarget } = makeDeps();
		const app = createAiRoute(deps);

		const res = await post(app, {
			targetId: "22222222-2222-4222-8222-222222222222",
			message: "在吗?",
			ai: draftAi(),
		});

		expect(res.status).toBe(404);
		expect(H.instances).toHaveLength(0); // 白问一次 AI 是要花钱的
		expect(sendToTarget).not.toHaveBeenCalled();
	});

	it("空消息 → 400", async () => {
		const { deps, sendToTarget } = makeDeps();
		const app = createAiRoute(deps);

		const res = await post(app, { targetId: TARGET_ID, message: "", ai: draftAi() });

		expect(res.status).toBe(400);
		expect(sendToTarget).not.toHaveBeenCalled();
	});

	it("engines 未挂载 → 503", async () => {
		const { deps, sendToTarget } = makeDeps();
		(deps.runtime as { engines?: unknown }).engines = undefined;
		const app = createAiRoute(deps);

		const res = await post(app, { targetId: TARGET_ID, message: "在吗?", ai: draftAi() });

		expect(res.status).toBe(503);
		expect(sendToTarget).not.toHaveBeenCalled();
	});

	it("AI 调用失败 → 500 带错因,且不推送半条消息", async () => {
		const { deps, sendToTarget } = makeDeps();
		const app = createAiRoute(deps);
		H.chatError = new Error("401 Incorrect API key provided");

		const res = await post(app, { targetId: TARGET_ID, message: "在吗?", ai: draftAi() });

		expect(res.status).toBe(500);
		const json = (await res.json()) as { ok: boolean; err?: string };
		expect(json.ok).toBe(false);
		expect(json.err).toContain("401");
		// AI 都没答上来,别推一条空消息去骚扰主人。
		expect(sendToTarget).not.toHaveBeenCalled();
	});
});
