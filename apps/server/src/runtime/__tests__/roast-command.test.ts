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

	it("一份待审都没有 → 告诉主人,不静默", async () => {
		await makeHandler().handle(privateFrame("y"));
		expect(String(reply.mock.calls[0]?.[0])).toContain("没有");
	});

	it("同一份连批两次 → 第二次落空,不重复发送", async () => {
		await seedDraft();
		const h = makeHandler();
		await h.handle(privateFrame("y"));
		await h.handle(privateFrame("y"));
		expect(deliver).toHaveBeenCalledTimes(1);
	});

	it("发送本身抛错 → 不把异常抛回 WS 通道(它还担着推送)", async () => {
		await seedDraft();
		const h = makeHandler();
		deliver.mockRejectedValue(new Error("推送炸了"));
		await expect(h.handle(privateFrame("y"))).resolves.not.toThrow();
	});
});
