import type { Logger } from "@bilibili-notify/internal";
import { describe, expect, it, vi } from "vite-plus/test";
import { makeApi, makeServiceContext } from "./support/make-api";

/**
 * 请求层把 B 站的数字码翻成标准码(ADR-0026 决策 4 下 10-14 的 🔗):经公开口 `fetchAllDynamic`,
 * 线是最底下的 `http.fetch` 替身,所以 `ApiClient` 的响应拦截器(-101 → auth-lost)也在路上。
 */
async function setup() {
	const warns: string[] = [];
	const logger: Logger = {
		info() {},
		debug() {},
		error() {},
		warn: (message: string) => void warns.push(message),
	};
	const onAuthLost = vi.fn();
	const w = await makeApi({
		serviceCtx: makeServiceContext(logger).serviceCtx,
		callbacks: { onAuthLost },
	});
	let reply: unknown = { code: 0, message: "0", data: { items: [] } };
	vi.spyOn(w.http, "fetch").mockImplementation(((target: string | URL) =>
		Promise.resolve({
			ok: true,
			url: String(target),
			status: 200,
			headers: new Headers(),
			isSuccess: true,
			text: () => (typeof reply === "string" ? reply : JSON.stringify(reply)),
		})) as never);
	return {
		api: w.api,
		warns,
		onAuthLost,
		answer(body: unknown) {
			reply = body;
		},
	};
}

describe("请求层的数字码翻译(fetchAllDynamic)", () => {
	it.each([-352, -412, -799, -509])("%i → rate_limited,原话与原码都带着", async (code) => {
		const w = await setup();
		w.answer({ code, message: "请求被拦截" });

		expect(await w.api.fetchAllDynamic()).toEqual({
			ok: false,
			code: "rate_limited",
			message: "请求被拦截",
			upstreamCode: code,
		});
	});

	it("-101 → unauthorized,拦截器那条路照旧叫一次 onAuthLost", async () => {
		const w = await setup();
		w.answer({ code: -101, message: "账号未登录" });

		expect(await w.api.fetchAllDynamic()).toEqual({
			ok: false,
			code: "unauthorized",
			message: "账号未登录",
			upstreamCode: -101,
		});
		expect(w.onAuthLost).toHaveBeenCalledTimes(1);
	});

	it("-403 不进共用表 → unknown,原码进 upstreamCode", async () => {
		const w = await setup();
		w.answer({ code: -403, message: "访问权限不足" });

		expect(await w.api.fetchAllDynamic()).toEqual({
			ok: false,
			code: "unknown",
			message: "访问权限不足",
			upstreamCode: -403,
		});
	});

	it("code 0 → ok,data 原样铺在 ok 旁", async () => {
		const w = await setup();
		w.answer({ code: 0, message: "0", data: { items: [{ id_str: "1" }], offset: "9" } });

		expect(await w.api.fetchAllDynamic()).toEqual({
			ok: true,
			data: { items: [{ id_str: "1" }], offset: "9" },
		});
	});

	it("回应不是对象、或没有数字 code → unavailable,不带 upstreamCode", async () => {
		const w = await setup();
		for (const body of ["<html>412</html>", null, { message: "无码" }, { code: "-352" }]) {
			w.answer(body);
			const result = await w.api.fetchAllDynamic();
			expect(result).toMatchObject({ ok: false, code: "unavailable" });
			expect(result).not.toHaveProperty("upstreamCode");
		}
	});

	it("没对照的码每个只 warn 一次(带码与原话);换一个没对照的码再 warn;有对照的码从不 warn", async () => {
		const w = await setup();

		w.answer({ code: 4101132, message: "没见过的错" });
		await w.api.fetchAllDynamic();
		await w.api.fetchAllDynamic();
		expect(w.warns).toHaveLength(1);
		expect(w.warns[0]).toContain("4101132");
		expect(w.warns[0]).toContain("没见过的错");

		w.answer({ code: -403, message: "访问权限不足" });
		await w.api.fetchAllDynamic();
		expect(w.warns).toHaveLength(2);
		expect(w.warns[1]).toContain("-403");

		for (const code of [-352, -412, -799, -509, -101]) {
			w.answer({ code, message: "x" });
			await w.api.fetchAllDynamic();
		}
		expect(w.warns).toHaveLength(2);
	});
});
