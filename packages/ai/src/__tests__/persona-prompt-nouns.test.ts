import { describe, expect, it } from "vite-plus/test";
import { buildSystemPrompt } from "../persona-presets";

const BILI_NOUNS = { creatorNoun: "UP主", postNoun: "动态", sources: "B 站" };
const NEUTRAL_NOUNS = { creatorNoun: "创作者", postNoun: "作品", sources: "各平台" };

describe("buildSystemPrompt —— 人格按这次涉及的来源叫", () => {
	it("一个来源时用它的平台与叫法", () => {
		const prompt = buildSystemPrompt({
			withTools: true,
			nouns: BILI_NOUNS,
		});

		expect(prompt).toContain("你的工作是帮用户关注B 站上的UP主");
		expect(prompt).toContain("他们有新动态或开播时");
		expect(prompt).toContain("UP主信息");
		expect(prompt).not.toContain("等平台");
	});

	it("混着多个来源时用中性叫法，不露平台专名", () => {
		const prompt = buildSystemPrompt({ nouns: NEUTRAL_NOUNS });

		expect(prompt).toContain("各平台上的创作者");
		expect(prompt).toContain("新作品");
		expect(prompt).not.toMatch(/UP|B 站/);
	});

	it("人格字段里的叫法也按来源填，未知花括号原样保留", () => {
		const prompt = buildSystemPrompt({
			nouns: BILI_NOUNS,
			customBase: "盯{creatorNoun}的{postNoun}。保留{未知}。",
			extraPrompt: "提醒{creatorNoun}。",
		});

		expect(prompt).toContain("盯UP主的动态。保留{未知}。");
		expect(prompt).toContain("提醒UP主。");
		expect(prompt).not.toContain("{creatorNoun}");
	});
});
