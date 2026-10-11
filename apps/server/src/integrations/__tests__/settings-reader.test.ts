import { type Disposable, fail, ok, type Result } from "@bilibili-notify/internal";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";
import { makeLogger } from "../../subscriptions/__tests__/fixtures.js";
import { createSettingsReader } from "../settings-reader.js";

const Schema = z.object({ cron: z.string(), minutes: z.number().int().min(0) });
type Raw = Result<{ settings: unknown }>;

/** 假宿主:盘上那一份可以随手换,换完叫一声「可能变了」;数得出挂着几个监听。 */
function makeHost(initial: Raw) {
	let current: Raw = initial;
	const listeners = new Set<() => void>();
	return {
		read: (): Raw => current,
		onChanged(fn: () => void): Disposable {
			listeners.add(fn);
			return { dispose: () => void listeners.delete(fn) };
		},
		/** 换成新值并通知。 */
		set(next: Raw) {
			current = next;
			for (const fn of [...listeners]) fn();
		},
		/** 不换值、只通知(别的集成变了的样子)。 */
		poke() {
			for (const fn of [...listeners]) fn();
		},
		listenerCount: () => listeners.size,
	};
}

const good = (cron = "*/3 * * * *", minutes = 30): Raw => ok({ settings: { cron, minutes } });
const setup = (initial: Raw = good()) => {
	const host = makeHost(initial);
	const logger = makeLogger();
	const made = createSettingsReader({
		schema: Schema,
		read: host.read,
		onChanged: host.onChanged,
		logger,
	});
	return { host, logger, ...made };
};

describe("createSettingsReader · get()", () => {
	it("自己那格好:回过了 zod 的值(zod 剥掉不认识的键)", () => {
		const { reader } = setup(ok({ settings: { cron: "a", minutes: 1, extra: true } }));
		expect(reader.get()).toEqual({ ok: true, settings: { cron: "a", minutes: 1 } });
	});

	it("自己那格坏:invalid,issues[0].path 是那一格", () => {
		const { reader } = setup(ok({ settings: { cron: 5, minutes: 1 } }));
		const r = reader.get();
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.code).toBe("invalid");
		expect(r.issues?.[0]?.path).toEqual(["cron"]);
	});

	it("读口回失败(整个文件读不懂):原样回,不带 path", () => {
		const failure = fail("invalid", "文件不是合法 JSON", {
			issues: [{ message: "文件不是合法 JSON" }],
		});
		const { reader } = setup(failure);
		const r = reader.get();
		expect(r).toEqual(failure);
		if (!r.ok) expect(r.issues?.[0]?.path).toBeUndefined();
	});

	it("三种情况下 get() 都不抛(zod 的 parse 会抛,safeParse 不会)", () => {
		for (const initial of [
			good(),
			ok({ settings: { cron: 5 } }),
			ok({ settings: null }),
			fail("invalid", "坏"),
		]) {
			const { reader } = setup(initial);
			expect(() => reader.get()).not.toThrow();
		}
	});

	it("每次现读现判:盘上变了、get() 立刻跟着变(没有缓存)", () => {
		const { reader, host } = setup();
		host.set(good("new", 7));
		expect(reader.get()).toEqual({ ok: true, settings: { cron: "new", minutes: 7 } });
	});
});

describe("createSettingsReader · onChange", () => {
	it("运行中自己那格的值变了:叫一次", () => {
		const { reader, host } = setup();
		const fn = vi.fn();
		reader.onChange(fn);
		host.set(good("changed"));
		expect(fn).toHaveBeenCalledTimes(1);
	});

	it("同值再写不叫", () => {
		const { reader, host } = setup();
		const fn = vi.fn();
		reader.onChange(fn);
		host.set(good());
		host.poke();
		expect(fn).not.toHaveBeenCalled();
	});

	it("别的格、别的集成变了(宿主通知了、可这一份读出来没变):不叫", () => {
		const { reader, host } = setup(ok({ settings: { cron: "a", minutes: 1, other: 1 } }));
		const fn = vi.fn();
		reader.onChange(fn);
		host.set(ok({ settings: { cron: "a", minutes: 1, other: 2 } }));
		expect(fn).not.toHaveBeenCalled();
	});

	it("读不懂 -> 读得懂:叫一次", () => {
		const { reader, host } = setup(ok({ settings: { cron: 5, minutes: 1 } }));
		const fn = vi.fn();
		reader.onChange(fn);
		host.set(good());
		expect(fn).toHaveBeenCalledTimes(1);
		expect(reader.get().ok).toBe(true);
	});

	it("读得懂 -> 读不懂:叫一次", () => {
		const { reader, host } = setup();
		const fn = vi.fn();
		reader.onChange(fn);
		host.set(ok({ settings: { cron: 5, minutes: 1 } }));
		expect(fn).toHaveBeenCalledTimes(1);
		expect(reader.get().ok).toBe(false);
	});

	it("原因变了、仍读不懂:叫一次", () => {
		const { reader, host } = setup(ok({ settings: { cron: 5, minutes: 1 } }));
		const fn = vi.fn();
		reader.onChange(fn);
		host.set(ok({ settings: { cron: "a", minutes: -1 } }));
		expect(fn).toHaveBeenCalledTimes(1);
		host.set(ok({ settings: { cron: "a", minutes: -1 } }));
		expect(fn).toHaveBeenCalledTimes(1);
	});

	it("两个订阅者都收得到同一次变化(游标只有一个、不是每个订阅者一个)", () => {
		const { reader, host } = setup();
		const a = vi.fn();
		const b = vi.fn();
		reader.onChange(a);
		reader.onChange(b);
		host.set(good("changed"));
		expect(a).toHaveBeenCalledTimes(1);
		expect(b).toHaveBeenCalledTimes(1);
	});

	it("一个订阅者抛错:另一个照样被叫、错不往外传、记一行 error", () => {
		const { reader, host, logger } = setup();
		const b = vi.fn();
		reader.onChange(() => {
			throw new Error("boom");
		});
		reader.onChange(b);
		expect(() => host.set(good("changed"))).not.toThrow();
		expect(b).toHaveBeenCalledTimes(1);
		expect(logger.error).toHaveBeenCalledTimes(1);
	});

	it("订阅者的 Disposable 摘掉之后不再被叫", () => {
		const { reader, host } = setup();
		const fn = vi.fn();
		reader.onChange(fn).dispose();
		host.set(good("changed"));
		expect(fn).not.toHaveBeenCalled();
	});
});

describe("createSettingsReader · dispose", () => {
	it("建把手时只挂一次宿主订阅(与订阅者个数无关),dispose() 摘掉", () => {
		const { reader, host, dispose } = setup();
		expect(host.listenerCount()).toBe(1);
		reader.onChange(() => {});
		reader.onChange(() => {});
		expect(host.listenerCount()).toBe(1);
		dispose();
		expect(host.listenerCount()).toBe(0);
	});

	it("收掉之后设置再变:订阅者不叫,get() 照常能读", () => {
		const { reader, host, dispose } = setup();
		const fn = vi.fn();
		reader.onChange(fn);
		dispose();
		host.set(good("after", 9));
		expect(fn).not.toHaveBeenCalled();
		expect(reader.get()).toEqual({ ok: true, settings: { cron: "after", minutes: 9 } });
	});

	it("收掉之后 onChange 回空把手(不登记订阅者);dispose 幂等", () => {
		const { reader, host, dispose } = setup();
		dispose();
		const fn = vi.fn();
		const handle = reader.onChange(fn);
		expect(() => handle.dispose()).not.toThrow();
		host.set(good("after"));
		expect(fn).not.toHaveBeenCalled();
		expect(() => dispose()).not.toThrow();
	});
});
