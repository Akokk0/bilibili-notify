import { describe, expect, it, vi } from "vite-plus/test";
import { createMyselfCache } from "../self-info-cache";

const ok = (mid: number) => ({ code: 0, data: { mid, uname: "me", face: "f" } });

describe("createMyselfCache", () => {
	it("并发调用合流为一次请求(重连风暴只打一次)", async () => {
		const fetchMyselfInfo = vi.fn(async () => ok(1));
		const cache = createMyselfCache({ fetchMyselfInfo } as never);
		const [a, b, c] = await Promise.all([cache.get(), cache.get(), cache.get()]);
		expect(fetchMyselfInfo).toHaveBeenCalledTimes(1);
		expect(a).toBe(b);
		expect(b).toBe(c);
	});

	it("TTL 窗口内命中缓存;过期后重新请求", async () => {
		let t = 1000;
		const fetchMyselfInfo = vi.fn(async () => ok(1));
		const cache = createMyselfCache({ fetchMyselfInfo } as never, { ttlMs: 60_000, now: () => t });
		await cache.get();
		t = 1000 + 59_000; // 仍在 TTL 内
		await cache.get();
		expect(fetchMyselfInfo).toHaveBeenCalledTimes(1);
		t = 1000 + 61_000; // 过期
		await cache.get();
		expect(fetchMyselfInfo).toHaveBeenCalledTimes(2);
	});

	it("失败响应不写缓存:下次仍真调", async () => {
		let n = 0;
		const fetchMyselfInfo = vi.fn(async () => {
			n++;
			return n === 1 ? { code: -101, data: null } : ok(1);
		});
		const cache = createMyselfCache({ fetchMyselfInfo } as never);
		const first = await cache.get();
		expect(first.code).toBe(-101);
		const second = await cache.get();
		expect(second.code).toBe(0);
		expect(fetchMyselfInfo).toHaveBeenCalledTimes(2);
	});

	it("invalidate 清缓存(换号/登出),后续重新请求", async () => {
		const fetchMyselfInfo = vi.fn(async () => ok(1));
		const cache = createMyselfCache({ fetchMyselfInfo } as never);
		await cache.get();
		cache.invalidate();
		await cache.get();
		expect(fetchMyselfInfo).toHaveBeenCalledTimes(2);
	});
});
