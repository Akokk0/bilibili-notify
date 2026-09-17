/**
 * `POST /api/card-skins/:id/ai-css` —— CSS 框旁那颗「请女仆帮忙写」的 wire(ADR-0015 决策 3–10)。
 *
 * 提示词怎么拼、一轮怎么跑归 `card-skins/ai-css.ts`(那边有自己的测试);这一层钉的是:
 * - 开流**之前**把能拒的都拒掉(没配模型、默认皮肤、草稿不合法、块不存在),回普通 JSON;
 * - 流上的事件顺序与载荷;
 * - 客户端断开 = 用户点了「停」,到模型的请求跟着被掐。
 */

// biome-ignore-all lint/suspicious/noExplicitAny: 断言 JSON / SSE 载荷,不为测试再造一遍 wire 类型

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CARD_SKIN_AI_INSTRUCTION_MAX } from "@bilibili-notify/contract";
import { DEFAULT_CARD_SKIN_ID } from "@bilibili-notify/internal";
import { strToU8, zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { CARD_SKIN_MANIFEST_FILE } from "../../card-skins/package.js";
import { CardSkinStore } from "../../card-skins/store.js";
import type { ConfigStore } from "../../config/store.js";
import { createCardSkinsRoute } from "../card-skins.js";

function manifest(): Record<string, any> {
	return {
		schemaVersion: 1,
		dataVersion: 1,
		name: "测试卡片皮肤",
		cards: {
			live: {
				width: 600,
				css: '[data-bn="frame"]{padding:3px}',
				blocks: [
					{ id: "cover", kind: "builtin", builtin: "cover", grid: { row: 1, column: 1, span: 12 } },
				],
			},
		},
	};
}

type Stream = { onText: (t: string) => void; signal?: AbortSignal };
type GenerateRaw = (
	system: string,
	user: string,
	onProgress: undefined,
	stream: Stream,
) => Promise<string>;

let dir: string;
let store: CardSkinStore;
let generateRaw: ReturnType<typeof vi.fn<GenerateRaw>>;
/** `null` = 没配模型。 */
let engine: { generateRaw: GenerateRaw } | null;
let app: ReturnType<typeof createCardSkinsRoute>;
let skinId: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "bn-card-skin-ai-"));
	store = new CardSkinStore({ dir });
	generateRaw = vi.fn<GenerateRaw>(async (_s, _u, _p, stream) => {
		stream.onText('[data-bn="self"]{border-radius:16px}');
		return '[data-bn="self"]{border-radius:16px}';
	});
	engine = { generateRaw: (...args) => generateRaw(...args) };
	const config = {
		getGlobals: () => ({ defaults: { cardSkin: DEFAULT_CARD_SKIN_ID, cardSkinKnobs: {} } }),
		getSubscriptions: () => [],
		patchGlobals: vi.fn(),
	} as unknown as ConfigStore;
	app = createCardSkinsRoute({ store, config, commentary: () => engine });

	const form = new FormData();
	const zip = zipSync({ [CARD_SKIN_MANIFEST_FILE]: strToU8(JSON.stringify(manifest())) });
	form.append("file", new File([zip], "skin.zip", { type: "application/zip" }));
	const res = await app.request("/", { method: "POST", body: form });
	expect(res.status).toBe(201);
	skinId = ((await res.json()) as any).id;
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

function post(body: unknown, id = skinId, init: RequestInit = {}): Promise<Response> {
	return Promise.resolve(
		app.request(`/${id}/ai-css`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
			...init,
		}),
	);
}

const BLOCK = () => ({
	kind: "live",
	blockId: "cover",
	instruction: "圆角大一点",
	manifest: manifest(),
});

interface SseEvent {
	event: string;
	data: any;
}

/** 线格式就是「空行分帧、event: / data: 两个字段」—— 手解,盯住的正是它。 */
function parseSse(text: string): SseEvent[] {
	const out: SseEvent[] = [];
	for (const frame of text.split("\n\n")) {
		let event = "message";
		const data: string[] = [];
		for (const line of frame.split("\n")) {
			if (line.startsWith("event:")) event = line.slice(6).trim();
			else if (line.startsWith("data:")) data.push(line.slice(5).trim());
		}
		if (data.length > 0) out.push({ event, data: JSON.parse(data.join("\n")) });
	}
	return out;
}

describe("开流之前的拒绝", () => {
	it("没配模型 → 503,按钮那头本该先禁用,这是兜底", async () => {
		engine = null;
		const res = await post(BLOCK());
		expect(res.status).toBe(503);
		expect(((await res.json()) as any).errors[0]).toMatch(/模型/);
		expect(generateRaw).not.toHaveBeenCalled();
	});

	it("默认皮肤 → 400:它的草稿存不下来,写了白烧 key", async () => {
		const res = await post(BLOCK(), DEFAULT_CARD_SKIN_ID);
		expect(res.status).toBe(400);
		expect(generateRaw).not.toHaveBeenCalled();
	});

	it("没这套皮肤 → 404;id 不合形 → 400", async () => {
		expect((await post(BLOCK(), "nope")).status).toBe(404);
		expect((await post(BLOCK(), "Bad.Id")).status).toBe(400);
	});

	it("那句话是空的或太长 → 400", async () => {
		expect((await post({ ...BLOCK(), instruction: "   " })).status).toBe(400);
		const long = "字".repeat(CARD_SKIN_AI_INSTRUCTION_MAX + 1);
		expect((await post({ ...BLOCK(), instruction: long })).status).toBe(400);
		expect(generateRaw).not.toHaveBeenCalled();
	});

	it("草稿过不了形状门 → 400 带原因", async () => {
		const bad = manifest();
		bad.cards.live.width = "宽";
		const res = await post({ ...BLOCK(), manifest: bad });
		expect(res.status).toBe(400);
		expect(((await res.json()) as any).errors.length).toBeGreaterThan(0);
	});

	it("块不存在 → 400 说清楚", async () => {
		const res = await post({ ...BLOCK(), blockId: "ghost" });
		expect(res.status).toBe(400);
		expect(((await res.json()) as any).errors[0]).toContain("ghost");
		expect(generateRaw).not.toHaveBeenCalled();
	});
});

describe("流", () => {
	it("规则逐条到,最后 done 带框里该留的内容;模型看到的是草稿与那句话", async () => {
		const res = await post(BLOCK());
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/event-stream");
		const events = parseSse(await res.text());
		expect(events).toEqual([
			{ event: "rule", data: { text: '[data-bn="self"]{border-radius:16px}' } },
			{ event: "done", data: { css: '[data-bn="self"]{border-radius:16px}', warnings: [] } },
		]);
		const [system, user, progress, stream] = generateRaw.mock.calls[0] ?? [];
		expect(system).toMatch(/只输出 CSS/);
		expect(user).toContain("圆角大一点");
		expect(user).toContain('[data-bn="frame"]{padding:3px}');
		expect(progress).toBeUndefined();
		expect(stream?.signal).toBeInstanceOf(AbortSignal);
	});

	it("外框也写得了:不给 blockId 就是外框", async () => {
		generateRaw.mockImplementation(async (_s, _u, _p, stream) => {
			stream.onText('[data-bn="glass"]{border-radius:20px}');
			return '[data-bn="glass"]{border-radius:20px}';
		});
		const { blockId: _, ...frame } = BLOCK();
		const events = parseSse(await (await post(frame)).text());
		expect(events.at(-1)).toEqual({
			event: "done",
			data: { css: '[data-bn="glass"]{border-radius:20px}', warnings: [] },
		});
	});

	it("清洗器削掉的照说", async () => {
		generateRaw.mockImplementation(async (_s, _u, _p, stream) => {
			stream.onText('[data-bn="self"]{behavior:x;color:red}');
			return '[data-bn="self"]{behavior:x;color:red}';
		});
		const done = parseSse(await (await post(BLOCK())).text()).at(-1);
		expect(done?.event).toBe("done");
		expect(done?.data.warnings.length).toBeGreaterThan(0);
	});

	it("两趟都被整份拒收 → retry 再 error", async () => {
		const huge = `[data-bn="self"]{content:"${"x".repeat(20_000)}"}`;
		generateRaw.mockImplementation(async (_s, _u, _p, stream) => {
			stream.onText(huge);
			return huge;
		});
		const events = parseSse(await (await post(BLOCK())).text());
		expect(events.map((e) => e.event)).toEqual(["rule", "retry", "rule", "error"]);
		expect(events.at(-1)?.data.errors.length).toBeGreaterThan(0);
		expect(generateRaw).toHaveBeenCalledTimes(2);
	});

	it("生成本身失败 → error 带原因", async () => {
		generateRaw.mockRejectedValue(new Error("AI 网关超时"));
		const events = parseSse(await (await post(BLOCK())).text());
		expect(events).toEqual([{ event: "error", data: { errors: ["AI 网关超时"] } }]);
	});

	it("客户端断开 → 到模型的请求被掐", async () => {
		let seen: AbortSignal | undefined;
		generateRaw.mockImplementation(async (_s, _u, _p, stream) => {
			seen = stream.signal;
			stream.onText('[data-bn="self"]{color:red}');
			return new Promise<string>((_, reject) => {
				stream.signal?.addEventListener("abort", () =>
					reject(Object.assign(new Error("已取消"), { cancelled: true })),
				);
			});
		});
		const res = await post(BLOCK());
		const reader = res.body?.getReader();
		const first = await reader?.read();
		expect(new TextDecoder().decode(first?.value)).toContain("event: rule");
		await reader?.cancel();
		await vi.waitFor(() => expect(seen?.aborted).toBe(true));
	});
});
