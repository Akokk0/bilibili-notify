/**
 * 入站能力门 —— 审批开关能不能开,以及开不了时那句理由。
 *
 * 这道门守的是一个很容易造出来的死局:在一个收不到回复的通道上开了审批,每期锐评
 * 都会生成、私聊、然后超时作废,一份也发不出去。
 *
 * 但**理由必须说对**。除 webhook 外,别的平台协议上都收得到,收不到只是因为我们
 * 还没接 —— qq-official 的 WS 网关和 USER_MESSAGE intent 甚至一直在跑,只差把
 * C2C 正文接出来。把这个实现缺口写成「这个通道只能发不能收」,主人会对着一个明明
 * 能收的通道反复怀疑自己配错了(这一条就是这么被主人当场抓到的)。
 */

import { describe, expect, it } from "vite-plus/test";
import { INBOUND_CAPABLE_PLATFORMS, inboundGapReason, platformCanReceiveReply } from "./constants";

describe("platformCanReceiveReply", () => {
	it("列进表里的平台放行", () => {
		for (const p of INBOUND_CAPABLE_PLATFORMS) {
			expect(platformCanReceiveReply(p)).toBe(true);
		}
	});

	it("onebot 与 qq-official 都已接入站", () => {
		expect(platformCanReceiveReply("onebot")).toBe(true);
		expect(platformCanReceiveReply("qq-official")).toBe(true);
	});

	it("没实现入站的平台一律拦下 —— 宁可少列", () => {
		for (const p of ["webhook", "koishi-bot", "astrbot", ""]) {
			expect(platformCanReceiveReply(p)).toBe(false);
		}
	});
});

describe("inboundGapReason", () => {
	it("webhook:说的是它天生没有回程", () => {
		expect(inboundGapReason("webhook")).toMatch(/没有回程|出站/);
	});

	it("还没接的平台:说的是我们还没接,不能说成通道收不到", () => {
		const why = inboundGapReason("koishi-bot");
		// 这两句是这条测试的全部意义 —— 反过来写就是主人当初抓到的那个错:
		// 把「女仆没实现」写成「这个通道只能发不能收」,主人会去查自己的配置。
		expect(why).toMatch(/还没/);
		expect(why).not.toMatch(/只能发不能收|收不到消息|不支持接收/);
	});

	it("理由里带上平台名 —— 主人得知道说的是哪条通道", () => {
		expect(inboundGapReason("koishi-bot")).toContain("koishi-bot");
	});
});
