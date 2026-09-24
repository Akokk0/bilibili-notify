/**
 * 单元测试 — `executeTool` 的 `get_user_stats`(P2-G)。
 *
 * 报告 #P2:get_user_stats 此前只校验 upstat.code,不校验 navnum.code。navnum
 * 接口报错时 navnum.data 为空 → 视频/动态数静默落 "?",把"接口错误"伪装成
 * "数据为空"误导 LLM。修复后 navnum.code !== 0 显式返回失败串。
 *
 * 这是 tools.ts 的首份独立测试(报告点名"tools.ts 无独立测试,建议补")。
 */

import type { BilibiliAPI } from "@bilibili-notify/api";
import { describe, expect, it, vi } from "vite-plus/test";
import { executeTool } from "../tools";

function fakeApi(over: Partial<Record<"getUserUpstat" | "getUserNavnum", unknown>>): BilibiliAPI {
	return {
		getUserUpstat: vi.fn(async () => over.getUserUpstat),
		getUserNavnum: vi.fn(async () => over.getUserNavnum),
	} as unknown as BilibiliAPI;
}

const run = (api: BilibiliAPI) => executeTool("get_user_stats", { uid: "123" }, api, () => null);

describe("executeTool get_user_stats — navnum.code 校验 (P2-G)", () => {
	it("navnum.code !== 0(接口错误)→ 显式失败,不伪装成数据空", async () => {
		const api = fakeApi({
			getUserUpstat: { code: 0, data: { archive: { view: 100 }, likes: 9 } },
			getUserNavnum: { code: -404, message: "啥也没有" },
		});
		const out = await run(api);
		expect(out).toContain("获取数据失败");
		expect(out).toContain("啥也没有");
		expect(out).not.toContain("视频数: ?");
	});

	it("upstat.code !== 0 → 显式失败(既有行为回归)", async () => {
		const api = fakeApi({
			getUserUpstat: { code: -403, message: "权限不足" },
			getUserNavnum: { code: 0, data: { video: 5, upos: 3 } },
		});
		expect(await run(api)).toContain("获取数据失败");
	});

	it("两接口皆 code=0 → 正常返回完整统计串(回归)", async () => {
		const api = fakeApi({
			getUserUpstat: { code: 0, data: { archive: { view: 12345 }, likes: 678 } },
			getUserNavnum: { code: 0, data: { video: 42, upos: 99 } },
		});
		const out = await run(api);
		expect(out).toContain("总播放量: 12345");
		expect(out).toContain("总获赞: 678");
		expect(out).toContain("视频数: 42");
		expect(out).toContain("动态数: 99");
	});
});

/**
 * 发布时间带上「距今多久」。模型手上没有当前时间,技能里「已经 N 天」「最近一天」
 * 「从新到旧」全靠这一格 —— 只给裸日期,它只能拿训练截止前后的某一天去猜。
 */
describe("executeTool 的发布时间 —— 距今多久在代码里算好", () => {
	const nowS = () => Math.floor(Date.now() / 1000);

	it("get_user_videos:超过一天的按天报", async () => {
		const api = {
			getUserVideos: vi.fn(async () => ({
				code: 0,
				data: { list: { vlist: [{ title: "新曲", play: 10, created: nowS() - 3 * 86_400 }] } },
			})),
		} as unknown as BilibiliAPI;
		const out = await executeTool("get_user_videos", { uid: "123" }, api, () => null);
		expect(out).toContain("3 天前");
		expect(out).toContain("新曲");
	});

	it("get_user_dynamics:一天之内的按小时报", async () => {
		const api = {
			getUserSpaceDynamic: vi.fn(async () => ({
				code: 0,
				data: {
					items: [
						{
							modules: {
								module_author: { pub_ts: nowS() - 5 * 3_600 },
								module_dynamic: { desc: { text: "今晚八点开播" } },
							},
						},
					],
				},
			})),
		} as unknown as BilibiliAPI;
		const out = await executeTool("get_user_dynamics", { uid: "123" }, api, () => null);
		expect(out).toContain("5 小时前");
		expect(out).toContain("今晚八点开播");
	});

	it("时间戳缺失 → 「未知时间」,不拼出 Invalid Date / NaN", async () => {
		const api = {
			getUserVideos: vi.fn(async () => ({
				code: 0,
				data: { list: { vlist: [{ title: "旧作", play: 1 }] } },
			})),
		} as unknown as BilibiliAPI;
		const out = await executeTool("get_user_videos", { uid: "123" }, api, () => null);
		expect(out).toContain("未知时间");
		expect(out).not.toMatch(/Invalid Date|NaN/);
	});
});
