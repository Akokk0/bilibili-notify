import { describe, expect, it } from "vite-plus/test";
import { BilibiliAPI } from "../bilibili-api";
import { GET_RELATION_STAT, GET_USER_CARDS_BATCH } from "../endpoints";

/**
 * ⑥ 粉丝计数换轻接口 + 批量 name/avatar。
 * 守护:relation/stat 的 URL 形状(vmid);批量 user/cards 的 uids 逗号拼接 +
 * 空列表短路不发请求。
 */
function makeApi() {
	const logger = { info() {}, warn() {}, error() {}, debug() {} };
	const api = new BilibiliAPI({
		serviceCtx: { logger } as never,
		config: {} as never,
		callbacks: {},
	});
	const calls: string[] = [];
	(api as unknown as { client: { get(url: string): Promise<unknown> } }).client = {
		get: async (url: string) => {
			calls.push(url);
			return { code: 0, data: {} };
		},
	};
	return { api, calls };
}

describe("getRelationStat", () => {
	it("打到 relation/stat 且带 vmid", async () => {
		const { api, calls } = makeApi();
		await api.getRelationStat("332704117");
		expect(calls).toHaveLength(1);
		expect(calls[0]).toContain(GET_RELATION_STAT);
		expect(calls[0]).toContain("vmid=332704117");
	});
});

describe("getUserCardsBatch", () => {
	it("uids 以逗号拼接打到批量端点", async () => {
		const { api, calls } = makeApi();
		await api.getUserCardsBatch(["1", "2", "3"]);
		expect(calls).toHaveLength(1);
		expect(calls[0]).toContain(GET_USER_CARDS_BATCH);
		// B 站契约:逗号分隔(字面逗号,不 encode)。
		expect(calls[0]).toContain("uids=1,2,3");
	});

	it("空列表短路:不发请求,回 code=0 空 data", async () => {
		const { api, calls } = makeApi();
		const res = await api.getUserCardsBatch([]);
		expect(calls).toHaveLength(0);
		expect(res).toEqual({ code: 0, data: {} });
	});
});
