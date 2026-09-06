import { describe, expect, it } from "vite-plus/test";
import { overridableApi } from "../api-overrides.js";

/**
 * 传给引擎的 `api` 外面套一层:平时原样透传(连 `this` 都保住 —— BilibiliAPI 是个类,方法里
 * 到处是 `this.`),devtools 想让某个方法说谎时按方法名盖一下,收摊就摘掉。引擎拿到的是
 * 同一个对象,从头到尾不知道有这一层。
 */

class FakeApi {
	private secret = "real";
	async getLiveRoomInfo(roomId: string) {
		return { code: 0, data: { room_id: Number(roomId), live_status: 0, from: this.secret } };
	}
	getUserAgent() {
		return `UA/${this.secret}`;
	}
}

describe("overridableApi", () => {
	it("没盖的时候原样透传,this 也保住", async () => {
		const { api } = overridableApi(new FakeApi());
		expect(api.getUserAgent()).toBe("UA/real");
		expect(await api.getLiveRoomInfo("1")).toMatchObject({
			data: { live_status: 0, from: "real" },
		});
	});

	it("盖上之后走假的,假的还能拿到真的(往真结果上打补丁)", async () => {
		const { api, override } = overridableApi(new FakeApi());
		override("getLiveRoomInfo", async (real, roomId) => {
			const res = await real(roomId);
			return { ...res, data: { ...res.data, live_status: 1 } };
		});
		expect(await api.getLiveRoomInfo("7")).toMatchObject({
			data: { room_id: 7, live_status: 1, from: "real" },
		});
		// 没盖的方法不受影响。
		expect(api.getUserAgent()).toBe("UA/real");
	});

	it("摘掉就回真的;盖两次以后来的为准", async () => {
		const { api, override, clear } = overridableApi(new FakeApi());
		override("getLiveRoomInfo", async () => ({
			code: 0,
			data: { room_id: 1, live_status: 1, from: "a" },
		}));
		override("getLiveRoomInfo", async () => ({
			code: 0,
			data: { room_id: 1, live_status: 2, from: "b" },
		}));
		expect((await api.getLiveRoomInfo("1")).data.live_status).toBe(2);
		clear("getLiveRoomInfo");
		expect((await api.getLiveRoomInfo("1")).data.live_status).toBe(0);
	});

	it("引擎拿到的就是同一个对象:两次取同名方法是同一个函数(有人拿它当 key 也不炸)", () => {
		const { api } = overridableApi(new FakeApi());
		expect(api.getUserAgent).toBe(api.getUserAgent);
	});

	it("身份在**盖着的时候**也不变:盖之前、盖着、摘掉之后取到的是同一个函数", () => {
		// 缓存存在的全部理由就是这条不变式。只在没盖的时候成立等于只保了本来就不出事的那一半 ——
		// 恰恰是装了覆盖的那段时间,引擎里拿方法当 key 的地方会炸。
		const { api, override, clear } = overridableApi(new FakeApi());
		const before = api.getUserAgent;
		override("getUserAgent", () => "UA/fake");
		expect(api.getUserAgent).toBe(before);
		expect(api.getUserAgent).toBe(api.getUserAgent);
		clear("getUserAgent");
		expect(api.getUserAgent).toBe(before);
	});

	it("覆盖在**调用时**生效:先把方法引用取走,之后再盖 / 再摘,那个引用照样跟着走", () => {
		// 引擎多半在构造时就把方法存下来了(`this.api.getLiveRoomInfo` 之类),devtools 是后来才
		// 盖的。覆盖要是烤在取出来的那一刻,存好的引用永远是真的,场景就白跑了。
		const { api, override, clear } = overridableApi(new FakeApi());
		const ref = api.getUserAgent;
		override("getUserAgent", () => "UA/fake");
		expect(ref()).toBe("UA/fake");
		clear("getUserAgent");
		expect(ref()).toBe("UA/real");
	});

	it("真对象上的方法被换掉了 → 不再回旧的那份绑定", () => {
		const raw = new FakeApi();
		const { api } = overridableApi(raw);
		const first = api.getUserAgent;
		expect(first()).toBe("UA/real");
		(raw as { getUserAgent: () => string }).getUserAgent = () => "UA/swapped";
		expect(api.getUserAgent()).toBe("UA/swapped");
		expect(api.getUserAgent).not.toBe(first);
	});
});
