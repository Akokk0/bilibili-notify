/**
 * 审批指令 —— 独立端的**第一条入站链路**。
 *
 * 在此之前 OneBot 通道是纯 push-only,所有无 echo 的帧一律丢弃。现在开了一道口子,
 * 所以这里守的重点是「口子有多窄」:群消息不算、别人发的不算、话里带个 y 不算。
 * 放宽任何一条,后果都是把一份没人审过的锐评发进群里 —— 恰恰是审批要防的事。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
	createRoastCommandHandler,
	extractPrivateMessage,
	parseRoastCommand,
} from "../roast-command.js";
import { createRoastDraftStore, type RoastDraftStore } from "../roast-draft-store.js";

/** 测试替身收口 —— 只填被读到的字段。 */
// biome-ignore lint/suspicious/noExplicitAny: 见上
type Any = any;

const logger = { debug() {}, info() {}, warn() {}, error() {} } as Any;

const MASTER = "10001";

function privateFrame(text: string, userId = MASTER) {
	return { post_type: "message", message_type: "private", user_id: userId, raw_message: text };
}

let dir: string;
let drafts: RoastDraftStore;
let deliver: ReturnType<typeof vi.fn>;
let reply: ReturnType<typeof vi.fn>;

/** `null` = 主人私聊 user_id 没配上(不能用 undefined:默认参数会把它换成 MASTER)。 */
function makeHandler(master: string | null = MASTER) {
	deliver = vi.fn(async () => {});
	reply = vi.fn(async () => {});
	return createRoastCommandHandler({
		drafts,
		logger,
		masterUserId: () => master ?? undefined,
		deliver: deliver as Any,
		reply: reply as Any,
	});
}

async function seedDraft(kind: "board" | "solo" = "board") {
	return drafts.add({ kind, days: 7, targets: ["t1"], result: { pushText: "x" } });
}

beforeEach(async () => {
	dir = mkdtempSync(join(tmpdir(), "roast-cmd-"));
	drafts = createRoastDraftStore({ dataDir: dir, logger });
	await drafts.load();
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("parseRoastCommand", () => {
	it("认 y / yes / n / no,大小写与空格都宽松", () => {
		expect(parseRoastCommand("y")).toEqual({ kind: "approve", id: undefined });
		expect(parseRoastCommand("  YES  ")).toEqual({ kind: "approve", id: undefined });
		expect(parseRoastCommand("N")).toEqual({ kind: "reject", id: undefined });
		expect(parseRoastCommand("no")).toEqual({ kind: "reject", id: undefined });
	});

	it("带草稿编号", () => {
		expect(parseRoastCommand("y a3")).toEqual({ kind: "approve", id: "a3" });
		expect(parseRoastCommand("n  a3")).toEqual({ kind: "reject", id: "a3" });
	});

	it("整句必须只有指令 —— 「今天不想发 y」不该发出一份周报", () => {
		expect(parseRoastCommand("今天不想发 y").kind).toBe("none");
		expect(parseRoastCommand("y 因为我觉得不错").kind).toBe("none");
		expect(parseRoastCommand("yeah").kind).toBe("none");
		expect(parseRoastCommand("").kind).toBe("none");
	});
});

describe("extractPrivateMessage", () => {
	it("群消息不算 —— 群里有人打个 y 不该把待审的周报发出去", () => {
		expect(
			extractPrivateMessage({
				post_type: "message",
				message_type: "group",
				user_id: MASTER,
				raw_message: "y",
			}),
		).toBeNull();
	});

	it("非消息事件(心跳 / 通知)不算", () => {
		expect(
			extractPrivateMessage({ post_type: "meta_event", meta_event_type: "heartbeat" }),
		).toBeNull();
	});

	it("段数组只取 text 段拼起来 —— 客户端可能捎带别的段", () => {
		const got = extractPrivateMessage({
			post_type: "message",
			message_type: "private",
			user_id: 10001,
			message: [
				{ type: "reply", data: { id: "1" } },
				{ type: "text", data: { text: "y a3" } },
			],
		});
		expect(got).toEqual({ userId: "10001", text: "y a3" });
	});
});

describe("审批指令处理", () => {
	it("主人回 y(只有一份待审)→ 发出去", async () => {
		const d = await seedDraft();
		await makeHandler().handle(privateFrame("y"));
		expect(deliver).toHaveBeenCalledTimes(1);
		expect(deliver.mock.calls[0]?.[0].id).toBe(d.id);
		// 批过的草稿要消失,不能再批第二次。
		expect(drafts.list()).toHaveLength(0);
	});

	it("主人回 n → 丢弃,不发", async () => {
		await seedDraft();
		await makeHandler().handle(privateFrame("n"));
		expect(deliver).not.toHaveBeenCalled();
		expect(drafts.list()).toHaveLength(0);
	});

	it("别人发的 y → 当没看见,连回复都不给", async () => {
		await seedDraft();
		const h = makeHandler();
		await h.handle(privateFrame("y", "99999"));
		expect(deliver).not.toHaveBeenCalled();
		// 回一句「你没权限」等于告诉对方这里有个接口可以试探。
		expect(reply).not.toHaveBeenCalled();
		expect(drafts.list()).toHaveLength(1);
	});

	it("没配主人 user_id → 谁都不认", async () => {
		await seedDraft();
		await makeHandler(null).handle(privateFrame("y"));
		expect(deliver).not.toHaveBeenCalled();
	});

	it("多份待审又没带编号 → 要求指明,绝不替主人猜", async () => {
		await seedDraft();
		await seedDraft("solo");
		await makeHandler().handle(privateFrame("y"));
		expect(deliver).not.toHaveBeenCalled();
		expect(String(reply.mock.calls[0]?.[0])).toContain("编号");
		// 两份都还在,一份都没被误发。
		expect(drafts.list()).toHaveLength(2);
	});

	it("多份待审、带对编号 → 只发那一份", async () => {
		const a = await seedDraft();
		await seedDraft("solo");
		await makeHandler().handle(privateFrame(`y ${a.id}`));
		expect(deliver.mock.calls[0]?.[0].id).toBe(a.id);
		expect(drafts.list()).toHaveLength(1);
	});

	it("编号不存在 → 说清楚,不误发别的那份", async () => {
		await seedDraft();
		await makeHandler().handle(privateFrame("y zz"));
		expect(deliver).not.toHaveBeenCalled();
		expect(String(reply.mock.calls[0]?.[0])).toContain("zz");
	});

	// **规格变更**(2026-08-11):以前这里回一句「现在没有等待审批的锐评哦～」,于是主人
	// 在私聊里随口打个 y(英文聊天里很常见)就收到这句莫名其妙的话。收编进指令系统的
	// 确认流之后,监听窗口有状态了:没待审时 y 只是个普通字母。
	//
	// 敢这么改是因为草稿 TTL 有 48 小时 —— 主人要等超过两天才回 y 才会撞上「想批准
	// 却没反应」,概率极低;而聊天里打 y 是日常。
	it("一份待审都没有 → 静默,不拿这句去打扰主人", async () => {
		await makeHandler().handle(privateFrame("y"));
		expect(reply).not.toHaveBeenCalled();
	});

	it("同一份连批两次 → 第二次落空,不重复发送", async () => {
		await seedDraft();
		const h = makeHandler();
		await h.handle(privateFrame("y"));
		await h.handle(privateFrame("y"));
		expect(deliver).toHaveBeenCalledTimes(1);
	});

	it("平台中立入口:qq-official 那边送来的 {userId,text} 同样认", async () => {
		// onebot 送的是一整帧 OneBot 事件,qq-official 送的是网关那边解析好的
		// {userOpenid, text}。两条路在这里汇合成同一个身份判定与同一套指令语义 ——
		// 各写一份鉴权迟早有一边把「不是主人也放行」写漏。
		const d = await seedDraft();
		const h = makeHandler();
		await h.handleMessage({ userId: MASTER, text: "y" });
		expect(deliver).toHaveBeenCalledTimes(1);
		expect(deliver.mock.calls[0]?.[0].id).toBe(d.id);
	});

	it("平台中立入口同样只认主人 —— 别人的 y 当没看见", async () => {
		await seedDraft();
		const h = makeHandler();
		await h.handleMessage({ userId: "99999", text: "y" });
		expect(deliver).not.toHaveBeenCalled();
		expect(reply).not.toHaveBeenCalled();
	});

	it("发送本身抛错 → 不把异常抛回 WS 通道(它还担着推送)", async () => {
		await seedDraft();
		const h = makeHandler();
		deliver.mockRejectedValue(new Error("推送炸了"));
		await expect(h.handle(privateFrame("y"))).resolves.not.toThrow();
	});
});

describe("作为 dispatcher 的确认流窗口", () => {
	it("有待审时 isWaiting 为真,没有时为假", async () => {
		const h = makeHandler();
		expect(h.confirmation.isWaiting()).toBe(false);
		await seedDraft();
		expect(h.confirmation.isWaiting()).toBe(true);
	});

	it("认得出 y → 消费掉(返回 true)并真的发出去", async () => {
		await seedDraft();
		const h = makeHandler();

		await expect(h.confirmation.tryHandle({ userId: MASTER, text: "y" })).resolves.toBe(true);

		expect(deliver).toHaveBeenCalledOnce();
	});

	// 返回 false 是让 dispatcher 继续往下走指令表 —— 否则有待审的时候
	// 主人就一条指令都敲不了了。
	it("认不出的输入 → 返回 false,把机会让回给指令表", async () => {
		await seedDraft();
		const h = makeHandler();

		await expect(h.confirmation.tryHandle({ userId: MASTER, text: "/状态" })).resolves.toBe(false);
	});

	// dispatcher 那边已经鉴过一道了,这里再鉴一次是防御:两条路各写一份的话,
	// 迟早有一边把「不是主人也放行」写漏。
	it("也鉴权 —— 别人的 y 不消费、不执行", async () => {
		await seedDraft();
		const h = makeHandler();

		await expect(h.confirmation.tryHandle({ userId: "99999", text: "y" })).resolves.toBe(false);

		expect(deliver).not.toHaveBeenCalled();
	});
});
