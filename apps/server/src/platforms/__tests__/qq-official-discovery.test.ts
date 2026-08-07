import { describe, expect, it } from "vite-plus/test";
import {
	createQQSessionRegistry,
	extractQQDiscoveredSession,
	extractQQPrivateMessage,
} from "../qq-official";

describe("extractQQDiscoveredSession — 从入站事件捞 group/C2C openid", () => {
	it("GROUP_AT_MESSAGE_CREATE → group session(group_openid + 触发者用户名 hint)", () => {
		const data = {
			group_openid: "G_OPENID",
			author: { id: "x", member_openid: "M1", username: "阿绫" },
		};
		expect(extractQQDiscoveredSession("GROUP_AT_MESSAGE_CREATE", data)).toEqual({
			scope: "group",
			openid: "G_OPENID",
			displayHint: "阿绫",
		});
	});

	it("C2C_MESSAGE_CREATE → private session(author.user_openid)", () => {
		const data = { author: { id: "x", user_openid: "U_OPENID", username: "小明" } };
		expect(extractQQDiscoveredSession("C2C_MESSAGE_CREATE", data)).toEqual({
			scope: "private",
			openid: "U_OPENID",
			displayHint: "小明",
		});
	});

	it("GROUP_ADD_ROBOT → group session(无 author hint)", () => {
		expect(
			extractQQDiscoveredSession("GROUP_ADD_ROBOT", {
				group_openid: "G2",
				op_member_openid: "OP",
			}),
		).toEqual({ scope: "group", openid: "G2" });
	});

	it("FRIEND_ADD → private session(openid)", () => {
		expect(extractQQDiscoveredSession("FRIEND_ADD", { openid: "U2" })).toEqual({
			scope: "private",
			openid: "U2",
		});
	});

	it("group_openid 缺失时回退 group_id", () => {
		const data = { group_id: "GID_FALLBACK", author: { username: "甲" } };
		expect(extractQQDiscoveredSession("GROUP_AT_MESSAGE_CREATE", data)?.openid).toBe(
			"GID_FALLBACK",
		);
	});

	it("无关事件(READY)→ null", () => {
		expect(extractQQDiscoveredSession("READY", { session_id: "s" })).toBeNull();
	});

	it("群事件缺 openid → null", () => {
		expect(extractQQDiscoveredSession("GROUP_AT_MESSAGE_CREATE", { author: {} })).toBeNull();
	});
});

describe("createQQSessionRegistry — per-adapter 发现 ring buffer", () => {
	it("record 后 list 返回该会话(带 lastSeenMs)", () => {
		const reg = createQQSessionRegistry();
		reg.record("a1", { scope: "group", openid: "G1", displayHint: "群甲" }, 1000);
		expect(reg.list("a1")).toEqual([
			{ scope: "group", openid: "G1", displayHint: "群甲", lastSeenMs: 1000 },
		]);
	});

	it("同 scope+openid 去重并更新 hint/lastSeen,移到最前", () => {
		const reg = createQQSessionRegistry();
		reg.record("a1", { scope: "group", openid: "G1", displayHint: "旧名" }, 1000);
		reg.record("a1", { scope: "group", openid: "G2" }, 2000);
		reg.record("a1", { scope: "group", openid: "G1", displayHint: "新名" }, 3000);
		const list = reg.list("a1");
		expect(list).toHaveLength(2);
		expect(list[0]).toEqual({
			scope: "group",
			openid: "G1",
			displayHint: "新名",
			lastSeenMs: 3000,
		});
		expect(list[1]?.openid).toBe("G2");
	});

	it("最近优先:后 record 的在前", () => {
		const reg = createQQSessionRegistry();
		reg.record("a1", { scope: "group", openid: "G1" }, 1000);
		reg.record("a1", { scope: "private", openid: "U1" }, 2000);
		expect(reg.list("a1").map((e) => e.openid)).toEqual(["U1", "G1"]);
	});

	it("超容丢最旧", () => {
		const reg = createQQSessionRegistry({ maxPerAdapter: 2 });
		reg.record("a1", { scope: "group", openid: "G1" }, 1000);
		reg.record("a1", { scope: "group", openid: "G2" }, 2000);
		reg.record("a1", { scope: "group", openid: "G3" }, 3000);
		expect(reg.list("a1").map((e) => e.openid)).toEqual(["G3", "G2"]);
	});

	it("per-adapter 隔离 + clear", () => {
		const reg = createQQSessionRegistry();
		reg.record("a1", { scope: "group", openid: "G1" }, 1000);
		reg.record("a2", { scope: "group", openid: "G2" }, 1000);
		expect(reg.list("a1")).toHaveLength(1);
		reg.clear("a1");
		expect(reg.list("a1")).toEqual([]);
		expect(reg.list("a2")).toHaveLength(1);
	});

	it("scope 不同但 openid 同 → 不去重(群与私聊是两个会话)", () => {
		const reg = createQQSessionRegistry();
		reg.record("a1", { scope: "group", openid: "X" }, 1000);
		reg.record("a1", { scope: "private", openid: "X" }, 2000);
		expect(reg.list("a1")).toHaveLength(2);
	});
});

/**
 * C2C 私聊正文 —— 审批指令(主人回的 y/n)走这条路进来。
 *
 * 与 {@link extractQQDiscoveredSession} 是两件事:那个只要 openid(拿来当推送地址),
 * 这个要正文。守的重点和 onebot 那条一样 ——「口子有多窄」:群消息不算、别人发的不算。
 * 放宽任何一条,后果都是把一份没人审过的锐评发进群里。
 */
describe("extractQQPrivateMessage — 从 C2C 事件取私聊正文", () => {
	it("C2C_MESSAGE_CREATE → 取 user_openid + 正文 + msg_id", () => {
		expect(
			extractQQPrivateMessage("C2C_MESSAGE_CREATE", {
				author: { id: "x", user_openid: "U1" },
				content: "y a3",
				id: "ROBOT1.0_abc",
			}),
		).toEqual({ userOpenid: "U1", text: "y a3", msgId: "ROBOT1.0_abc" });
	});

	it("群消息不算 —— 群里有人打个 y 不该把待审的周报发出去", () => {
		expect(
			extractQQPrivateMessage("GROUP_AT_MESSAGE_CREATE", {
				group_openid: "G1",
				author: { member_openid: "M1" },
				content: "y",
			}),
		).toBeNull();
	});

	it("绝不回退 author.member_openid —— 那是群成员域的身份,与 C2C 用户 openid 是两个命名空间", () => {
		expect(
			extractQQPrivateMessage("C2C_MESSAGE_CREATE", {
				author: { member_openid: "M1" },
				content: "y",
			}),
		).toBeNull();
	});

	it("空正文 / 只有空白 → null(纯表情、纯图片消息都会走到这儿)", () => {
		const author = { user_openid: "U1" };
		expect(extractQQPrivateMessage("C2C_MESSAGE_CREATE", { author, content: "   " })).toBeNull();
		expect(extractQQPrivateMessage("C2C_MESSAGE_CREATE", { author })).toBeNull();
	});

	it("msg_id 缺了也认 —— 正文才是要紧的", () => {
		expect(
			extractQQPrivateMessage("C2C_MESSAGE_CREATE", {
				author: { user_openid: "U1" },
				content: "n",
			}),
		).toEqual({ userOpenid: "U1", text: "n" });
	});
});
