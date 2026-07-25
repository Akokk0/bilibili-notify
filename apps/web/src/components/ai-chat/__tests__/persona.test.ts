/**
 * 单元测试 — 聊天界面称呼的取值与兜底。
 *
 * 主人换人格预设是运行期的事,而界面上散着七八处称呼;哪一处忘了跟着变,
 * 表现都是「侧栏写着 A、她自己开口自称 B」。兜底规则钉在这里。
 */

import { describe, expect, it } from "vite-plus/test";
import { resolveChatPersona } from "../persona";

describe("resolveChatPersona", () => {
	it("三栏都填了就照用", () => {
		expect(
			resolveChatPersona({ name: "凛子", addressSelf: "本小姐", addressUser: "笨蛋" }),
		).toEqual({ name: "凛子", self: "本小姐", user: "笨蛋" });
	});

	it("配置还没加载(undefined)→ 通用兜底,不显示空白", () => {
		expect(resolveChatPersona()).toEqual({ name: "女仆", self: "女仆", user: "主人" });
	});

	it("自称留空 → 回落到名字,而不是通用兜底", () => {
		// 名字都有了,自称却写「女仆」很怪。
		expect(resolveChatPersona({ name: "小绫" }).self).toBe("小绫");
	});

	it("空串与 undefined 一视同仁 —— 主人把那栏清空了也得有话可说", () => {
		expect(resolveChatPersona({ name: "", addressSelf: "", addressUser: "" })).toEqual({
			name: "女仆",
			self: "女仆",
			user: "主人",
		});
	});

	it("只有空白的字段也算没填", () => {
		expect(resolveChatPersona({ name: "   " }).name).toBe("女仆");
	});

	it("前后空白会被裁掉,不带进界面", () => {
		expect(resolveChatPersona({ name: " 小绫 " }).name).toBe("小绫");
	});

	it("不写死设计稿里的「小铃」—— 那只是画稿时的临时名字", () => {
		expect(Object.values(resolveChatPersona())).not.toContain("小铃");
		expect(resolveChatPersona({ name: "小绫" }).name).not.toBe("小铃");
	});
});
