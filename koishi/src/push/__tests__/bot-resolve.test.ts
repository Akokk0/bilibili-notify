/**
 * 单元测试 — `resolveKoishiBot` 平台容错解析(master 私聊「目标不可达」根因修复)。
 *
 * 背景:master 私聊用的 `botPlatform` 来自 master 配置里单独的下拉框,群推送用的
 * 来自订阅项 `item.platform`。两者是不同配置源,一旦用户在 master 里选了 `qq` 但
 * 实际跑的是 onebot(NapCat 等),群能发、私聊主人却永远「目标不可达」。本解析器在
 * 精确匹配失败时按「唯一在线平台」回退,消除这个陷阱;无法唯一确定时不瞎猜。
 *
 * 契约:
 *   - 精确(平台 + selfId)匹配到 → reason "exact",即便离线也返回(不回退到别的平台)
 *   - 配置平台无任何对应 bot,但在线 bot 只有唯一平台 → reason "fallback",用它
 *   - 配置平台无对应 bot,在线平台有多个 → reason "ambiguous",不给 bot
 *   - 没有任何在线 bot → reason "none"
 */

import { describe, expect, it } from "vite-plus/test";
import { type BotLike, botResolutionWarning, resolveKoishiBot } from "../bot-resolve";

const ONLINE = 1;
const OFFLINE = 0;

const bot = (platform: string, selfId: string, status = ONLINE): BotLike => ({
	platform,
	selfId,
	status,
});

describe("resolveKoishiBot — 平台容错解析", () => {
	it("配置平台无对应 bot,在线 bot 只有唯一平台 → 回退到该 bot", () => {
		// 用户在 master 里选了 "qq",但实际只跑了一个在线的 onebot(NapCat)。
		const bots = [bot("onebot", "10086")];
		const res = resolveKoishiBot(bots, { botPlatform: "qq" }, ONLINE);
		expect(res.reason).toBe("fallback");
		expect(res.bot).toBe(bots[0]);
		expect(res.onlinePlatforms).toEqual(["onebot"]);
	});

	it("配置平台有对应 bot 但离线,且另有别平台在线 → exact 返回离线 bot,不回退", () => {
		// 平台选对了、只是 bot 暂时离线,绝不能把私聊导向别平台账号(userId 命名空间不同)。
		const offlineOnebot = bot("onebot", "10086", OFFLINE);
		const onlineDiscord = bot("discord", "d1", ONLINE);
		const res = resolveKoishiBot([offlineOnebot, onlineDiscord], { botPlatform: "onebot" }, ONLINE);
		expect(res.reason).toBe("exact");
		expect(res.bot).toBe(offlineOnebot);
	});

	it("配置平台无对应 bot,在线平台有多个 → ambiguous,不瞎猜,列出可用平台", () => {
		const bots = [bot("onebot", "10086"), bot("discord", "d1")];
		const res = resolveKoishiBot(bots, { botPlatform: "telegram" }, ONLINE);
		expect(res.reason).toBe("ambiguous");
		expect(res.bot).toBeUndefined();
		expect(res.onlinePlatforms.sort()).toEqual(["discord", "onebot"]);
	});

	it("没有任何在线 bot → none", () => {
		const bots = [bot("onebot", "10086", OFFLINE)];
		const res = resolveKoishiBot(bots, { botPlatform: "qq" }, ONLINE);
		expect(res.reason).toBe("none");
		expect(res.bot).toBeUndefined();
		expect(res.onlinePlatforms).toEqual([]);
	});

	it("exact 匹配优先返回在线的同平台 bot(首个离线、次个在线 → 不误判不可达)", () => {
		// 多 bot 部署:同平台两个 bot,排在前面的离线、后面的在线。旧 .find 只取首个
		// → isAvailable 误判离线。应优先挑在线的那个。
		const offline = bot("onebot", "111", OFFLINE);
		const online = bot("onebot", "222", ONLINE);
		const res = resolveKoishiBot([offline, online], { botPlatform: "onebot" }, ONLINE);
		expect(res.reason).toBe("exact");
		expect(res.bot).toBe(online);
	});

	it("selfId 为空匹配任意 selfId;指定 selfId 时要求相等", () => {
		const bots = [bot("onebot", "111"), bot("onebot", "222")];
		// selfId 不指定:精确匹配到该平台的第一个 bot。
		expect(resolveKoishiBot(bots, { botPlatform: "onebot" }, ONLINE).bot).toBe(bots[0]);
		// selfId 指定且存在:命中对应 selfId。
		const r = resolveKoishiBot(bots, { botPlatform: "onebot", selfId: "222" }, ONLINE);
		expect(r.reason).toBe("exact");
		expect(r.bot).toBe(bots[1]);
	});
});

/**
 * 指定了发送账号(高级订阅 target 项里的 selfId)之后的语义。
 *
 * 关键点:**指定了就绝不回退**。回退的存在理由是「用户可能把平台名填错了」,而一旦
 * 用户明确写下某个账号,再把消息从别的号发出去就是南辕北辙 —— 群里看到的是个可能
 * 根本不该在场的机器人,@全体的权限也未必一样。发错号比没发出去更难收场。
 */
describe("resolveKoishiBot — 指定了发送账号(selfId)", () => {
	it("指定的号存在但离线 → 返回它,不换成同平台在线的另一个号", () => {
		// 「不发、如实报不可达」由调用方(sink)判 status 得出;解析器的责任是别改口。
		const offline = bot("onebot", "111", OFFLINE);
		const onlineSibling = bot("onebot", "222", ONLINE);
		const res = resolveKoishiBot(
			[offline, onlineSibling],
			{ botPlatform: "onebot", selfId: "111" },
			ONLINE,
		);
		expect(res.reason).toBe("exact");
		expect(res.bot).toBe(offline);
	});

	it("指定的号根本不存在(填错一位数)→ 不给 bot,更不回退到唯一在线平台", () => {
		// 不加这条判断的话会落进 fallback 分支:只有一个在线平台时,消息会静静地从
		// 另一个号发出去 —— 恰恰是指定账号想避免的事。
		const bots = [bot("onebot", "111"), bot("onebot", "222")];
		const res = resolveKoishiBot(bots, { botPlatform: "onebot", selfId: "1111" }, ONLINE);
		expect(res.reason).toBe("selfId-miss");
		expect(res.bot).toBeUndefined();
	});

	it("指定的号不存在,且该平台一个 bot 都没有 → 同样不回退", () => {
		const bots = [bot("discord", "d1")];
		const res = resolveKoishiBot(bots, { botPlatform: "onebot", selfId: "111" }, ONLINE);
		expect(res.reason).toBe("selfId-miss");
		expect(res.bot).toBeUndefined();
	});

	it("带回该平台当前在线的 selfId 列表 —— 告警要说得出「那你有哪些号」", () => {
		// 只说「没找到 1111」帮不上忙,主人还得自己去翻。列出可用的号才是可操作的。
		const bots = [bot("onebot", "111"), bot("onebot", "222", OFFLINE), bot("discord", "d1")];
		const res = resolveKoishiBot(bots, { botPlatform: "onebot", selfId: "1111" }, ONLINE);
		// 只列配置平台的、且在线的:离线的 222 帮不上忙,别的平台的 d1 更是误导。
		expect(res.onlineSelfIds).toEqual(["111"]);
	});

	it("没填 selfId 时行为一字不变 —— 这条分支对普通订阅与 master 不可达", () => {
		// 普通订阅和主人私聊永远不填 selfId,回退语义必须原样保留。
		const bots = [bot("onebot", "10086")];
		const res = resolveKoishiBot(bots, { botPlatform: "qq" }, ONLINE);
		expect(res.reason).toBe("fallback");
		expect(res.bot).toBe(bots[0]);
	});
});

describe("botResolutionWarning — 可操作告警文案", () => {
	const res = (reason: string, onlinePlatforms: string[]) =>
		({ reason, onlinePlatforms }) as Parameters<typeof botResolutionWarning>[2];

	it("exact → 无需告警(返回 null)", () => {
		expect(botResolutionWarning("master", "onebot", res("exact", ["onebot"]))).toBeNull();
	});

	it("fallback → 指出配置平台、实际在线平台与改配建议", () => {
		const msg = botResolutionWarning("master", "qq", res("fallback", ["onebot"]));
		expect(msg).not.toBeNull();
		expect(msg).toContain("master");
		expect(msg).toContain("qq"); // 配置选错的平台
		expect(msg).toContain("onebot"); // 实际在线、已回退使用的平台
	});

	it("ambiguous → 列出全部在线平台,提示无法自动确定", () => {
		const msg = botResolutionWarning("master", "telegram", res("ambiguous", ["onebot", "discord"]));
		expect(msg).toContain("onebot");
		expect(msg).toContain("discord");
	});

	it("none → 提示当前无在线机器人", () => {
		const msg = botResolutionWarning("master", "qq", res("none", []));
		expect(msg).not.toBeNull();
		expect(msg).toContain("qq");
	});

	it("selfId-miss → 说清找不到哪个号,并列出该平台当前可用的号", () => {
		const msg = botResolutionWarning("UP的群", "onebot", {
			reason: "selfId-miss",
			onlinePlatforms: ["onebot"],
			onlineSelfIds: ["111", "222"],
			selfId: "1111",
		} as Parameters<typeof botResolutionWarning>[2]);
		expect(msg).not.toBeNull();
		expect(msg).toContain("1111"); // 填错的那个
		expect(msg).toContain("111");
		expect(msg).toContain("222"); // 实际可用的
		// 不能把主人往「改平台名」上引 —— 平台名是对的,错的是账号。
		expect(msg).not.toContain("平台改成");
	});
});
