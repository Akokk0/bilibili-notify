import type { Logger } from "@bilibili-notify/internal";
import { describe, expect, it, vi } from "vite-plus/test";
import { RiskControlError } from "../risk-control";
import { createWbiBreaker } from "../wbi-breaker";

const silentLogger = (): Logger => ({ info() {}, warn() {}, error() {}, debug() {} });

function setup() {
	let now = 1_000;
	const breaker = createWbiBreaker({ now: () => now, logger: silentLogger() });
	return {
		breaker,
		advance(ms: number) {
			now += ms;
		},
	};
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

describe("wbi 熔断", () => {
	it("关着时照常调用并原样返回", async () => {
		const { breaker } = setup();
		const call = vi.fn(async () => "reply");

		await expect(breaker.run(call)).resolves.toBe("reply");
		expect(call).toHaveBeenCalledTimes(1);
	});

	it("风控错误后 60 秒内直接拒绝，并带着上一次原话与原码", async () => {
		const { breaker } = setup();
		const risk = new RiskControlError("upstream blocked", -352);
		const call = vi.fn(async () => {
			throw risk;
		});

		await expect(breaker.run(call)).rejects.toBe(risk);
		const rejected = await breaker.run(call).catch((error: unknown) => error);

		expect(rejected).toBeInstanceOf(RiskControlError);
		expect(rejected).toMatchObject({
			message: expect.stringContaining("upstream blocked"),
			upstreamCode: -352,
		});
		expect(call).toHaveBeenCalledTimes(1);
	});

	it("试探持续撞风控时按 60s、5m、15m、30m 逐级升级，封顶 30m", async () => {
		const { breaker, advance } = setup();
		const call = vi.fn(async () => {
			throw new RiskControlError("still blocked", -352);
		});
		const trip = async () => {
			const error = await breaker.run(call).catch((reason: unknown) => reason);
			expect(error).toBeInstanceOf(RiskControlError);
		};

		await trip();
		advance(60_000);
		await trip();

		advance(300_000 - 1);
		await trip();
		expect(call).toHaveBeenCalledTimes(2);
		advance(1);
		await trip();

		advance(900_000 - 1);
		await trip();
		expect(call).toHaveBeenCalledTimes(3);
		advance(1);
		await trip();

		advance(1_800_000 - 1);
		await trip();
		expect(call).toHaveBeenCalledTimes(4);
		advance(1);
		await trip();

		advance(1_800_000 - 1);
		await trip();
		expect(call).toHaveBeenCalledTimes(5);
		advance(1);
		await trip();

		advance(1_800_000 - 1);
		await trip();
		expect(call).toHaveBeenCalledTimes(6);
		advance(1);
		await trip();
		expect(call).toHaveBeenCalledTimes(7);
	});

	it("试探成功后关闸，再撞风控从 60 秒重新起算", async () => {
		const { breaker, advance } = setup();
		const firstRisk = new RiskControlError("first block", -352);
		const secondRisk = new RiskControlError("second block", -352);
		const call = vi
			.fn<() => Promise<string>>()
			.mockRejectedValueOnce(firstRisk)
			.mockResolvedValueOnce("probe ok")
			.mockResolvedValueOnce("closed ok")
			.mockRejectedValueOnce(secondRisk)
			.mockResolvedValueOnce("after 60s");

		await expect(breaker.run(call)).rejects.toBe(firstRisk);
		advance(60_000);
		await expect(breaker.run(call)).resolves.toBe("probe ok");
		await expect(breaker.run(call)).resolves.toBe("closed ok");
		await expect(breaker.run(call)).rejects.toBe(secondRisk);

		advance(59_999);
		await expect(breaker.run(call)).rejects.toBeInstanceOf(RiskControlError);
		expect(call).toHaveBeenCalledTimes(4);
		advance(1);
		await expect(breaker.run(call)).resolves.toBe("after 60s");
	});

	it("到期时并发调用只放一个试探；试探失败后另一个直接拒绝", async () => {
		const { breaker, advance } = setup();
		const firstRisk = new RiskControlError("initial block", -352);
		const probeRisk = new RiskControlError("probe block", -352);
		await expect(
			breaker.run(async () => {
				throw firstRisk;
			}),
		).rejects.toBe(firstRisk);
		advance(60_000);

		const probe = deferred<string>();
		const first = breaker.run(() => probe.promise);
		const secondCall = vi.fn(async () => "second");
		const second = breaker.run(secondCall);
		const firstOutcome = first.then(
			(value) => value,
			(error: unknown) => error,
		);
		const secondOutcome = second.then(
			(value) => value,
			(error: unknown) => error,
		);
		probe.reject(probeRisk);

		expect(await firstOutcome).toBe(probeRisk);
		expect(await secondOutcome).toBeInstanceOf(RiskControlError);
		expect(secondCall).not.toHaveBeenCalled();
	});

	it("到期时并发调用只放一个试探；试探成功后另一个再执行自己的调用", async () => {
		const { breaker, advance } = setup();
		const risk = new RiskControlError("initial block", -352);
		await expect(
			breaker.run(async () => {
				throw risk;
			}),
		).rejects.toBe(risk);
		advance(60_000);

		const probe = deferred<string>();
		const first = breaker.run(() => probe.promise);
		const secondCall = vi.fn(async () => "second");
		const second = breaker.run(secondCall);

		probe.resolve("probe");
		await expect(first).resolves.toBe("probe");
		await expect(second).resolves.toBe("second");
		expect(secondCall).toHaveBeenCalledTimes(1);
	});

	it("试探抛普通错误时原样抛出，下一次仍可当试探", async () => {
		const { breaker, advance } = setup();
		const risk = new RiskControlError("blocked", -352);
		const networkError = new Error("network down");
		const call = vi
			.fn<() => Promise<string>>()
			.mockRejectedValueOnce(risk)
			.mockRejectedValueOnce(networkError)
			.mockResolvedValueOnce("recovered");

		await expect(breaker.run(call)).rejects.toBe(risk);
		advance(60_000);
		await expect(breaker.run(call)).rejects.toBe(networkError);
		await expect(breaker.run(call)).resolves.toBe("recovered");
		expect(call).toHaveBeenCalledTimes(3);
	});

	it("reset 后关闭熔断并忘掉上一次", async () => {
		const { breaker } = setup();
		const risk = new RiskControlError("blocked", -352);
		const call = vi
			.fn<() => Promise<string>>()
			.mockRejectedValueOnce(risk)
			.mockResolvedValueOnce("after reset");

		await expect(breaker.run(call)).rejects.toBe(risk);
		breaker.reset();
		await expect(breaker.run(call)).resolves.toBe("after reset");
		expect(call).toHaveBeenCalledTimes(2);
	});
});
