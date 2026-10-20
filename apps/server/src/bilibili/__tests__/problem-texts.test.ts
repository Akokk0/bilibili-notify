/**
 * B 站问题句的字面量:平实、只说事,不称呼主人、不自称女仆、不写宿主的界面与操作。
 * 期望值是写死的字面量(不从被测的同一张表现算),别的测试用 `PROBLEM_TEXTS` 取期望值时,这里钉着字本身。
 */

import { describe, expect, it } from "vite-plus/test";
import { PROBLEM_TEXTS } from "../problem-texts.js";

describe("PROBLEM_TEXTS · 句子", () => {
	it("风控:进表的话、恢复句;私聊只看动态那一路", () => {
		expect(PROBLEM_TEXTS.riskControlled.text()).toBe("账号被风控，暂时访问不了，会隔一阵自动再试");
		expect(PROBLEM_TEXTS.riskControlled.recovery()).toBe("风控已解除");
		expect(PROBLEM_TEXTS.riskControlled.notify).toEqual({ dynamic: true, live: false });
	});

	it("拉动态失败:只带错误码,不带原话;只进表", () => {
		expect(PROBLEM_TEXTS.dynamicFetchFailed.text(4101132)).toBe(
			"拉取动态失败（错误码 4101132），每 5 分钟会自动重试一次",
		);
		expect(PROBLEM_TEXTS.dynamicFetchFailed.notify).toBe(false);
	});

	it("直播间停止监听:点明不会自动重连;恢复句", () => {
		expect(PROBLEM_TEXTS.liveMonitorStopped.text("100", "取直播间信息失败")).toBe(
			"直播间 100 停止监听：取直播间信息失败；不会自动重连",
		);
		expect(PROBLEM_TEXTS.liveMonitorStopped.recovery("100")).toBe("直播间 100 的监听已恢复");
		expect(PROBLEM_TEXTS.liveMonitorStopped.notify).toBe(true);
	});

	it("停止监听的三个原因", () => {
		expect(PROBLEM_TEXTS.liveStopReasons.roomInfo()).toBe("取直播间信息失败");
		expect(PROBLEM_TEXTS.liveStopReasons.danmakuConnect()).toBe("弹幕连接建立失败");
		expect(PROBLEM_TEXTS.liveStopReasons.gaveUp()).toBe("连接持续失败，重试 5 次后放弃");
	});

	it("直播间受限:原因 + 可能的缘由 + 这个房间先不再监听;恢复句", () => {
		expect(PROBLEM_TEXTS.liveRoomRestricted.text("100", "该房间加密")).toBe(
			"直播间 100 的弹幕连不上：该房间加密（可能是加密、付费、测试房，或这个账号没有权限），这个房间先不再监听",
		);
		expect(PROBLEM_TEXTS.liveRoomRestricted.recovery("100")).toBe("直播间 100 的弹幕已连上");
		expect(PROBLEM_TEXTS.liveRoomRestricted.notify).toBe(true);
	});

	it("这一轮没取到直播状态", () => {
		expect(PROBLEM_TEXTS.liveStatusUnavailable.text("100")).toBe(
			"直播间 100 这一轮没取到直播状态，下一轮再取",
		);
		expect(PROBLEM_TEXTS.liveStatusUnavailable.notify).toBe(false);
	});

	it("设置读不懂的原因:一格坏了 / 整个文件读不懂;不带「B 站」、不带文件路径", () => {
		expect(PROBLEM_TEXTS.settingsCause.cell("动态检查频率", "dynamicCron", "格式不对")).toBe(
			"设置「动态检查频率」（dynamicCron）读不懂：格式不对",
		);
		expect(PROBLEM_TEXTS.settingsCause.file("Unexpected end")).toBe(
			"设置文件不是合法的 JSON：Unexpected end",
		);
	});

	it("两条设置问题:不指路、不提面板上显示的值;只进表", () => {
		expect(PROBLEM_TEXTS.dynamicSettingsInvalid.text("原因")).toBe(
			"原因，动态先停着没在拉；登录、登录检查和直播照常",
		);
		expect(PROBLEM_TEXTS.loginCheckSettingsInvalid.text("原因")).toBe(
			"原因，定时的登录检查先停着；登录本身、动态和直播照常，登录失效了照样会发现",
		);
		expect(PROBLEM_TEXTS.dynamicSettingsInvalid.notify).toBe(false);
		expect(PROBLEM_TEXTS.loginCheckSettingsInvalid.notify).toBe(false);
	});
});
