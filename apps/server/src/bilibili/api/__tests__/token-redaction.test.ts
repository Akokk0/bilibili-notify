/**
 * 新到手的续期令牌:从拿到它到它存进 `secrets`(落盘成功后宿主才按 `secrets` 登记)之间有一段空档,
 * 这段里它必须已经登记成要在日志里遮掉的值 —— 核心里写死 `refresh_token` 的正则删掉以后,只有登记在守着它。
 *
 * 落盘用 `holdNext()` 按在半路,按住的时候读登记册:要看到令牌已经被遮。
 * 令牌是一眼看得出的假值。续期的新令牌在刷新 POST 的回应里一到手就登记(不等确认那一步与提交);
 * 扫码登录拿到的令牌进 `commitScannedLogin`、续期提交进 `commitLogin`,都在提交入口同步登记。
 */

import { describe, expect, it, vi } from "vite-plus/test";
import { createValueRedactor } from "../../../logs/value-redactor";
import { makeApi } from "./support/make-api";

const FAKE_TOKEN = "FAKE-NEW-REFRESH-TOKEN-0001";

function redactorWorld() {
	const redactor = createValueRedactor();
	return {
		redactor,
		redact: (kind: string, values: Iterable<string>) => redactor.replace("bilibili", kind, values),
	};
}

type Client = {
	get: (url: string) => Promise<unknown>;
	postForm: (url: string, body: Record<string, string>) => Promise<unknown>;
};

describe("新令牌在存盘之前就已登记要遮", () => {
	it("commitLogin:落盘按在半路时,令牌已经被遮", async () => {
		const { redactor, redact } = redactorWorld();
		const world = await makeApi({ redact });
		const release = world.secrets.holdNext();

		const committing = world.api.commitLogin(FAKE_TOKEN);
		expect(world.secrets.persists).toHaveLength(0);
		expect(redactor.scrub(`token=${FAKE_TOKEN}`)).toBe("token=***");

		release();
		expect((await committing).ok).toBe(true);
	});

	it("扫码登录拿到的令牌(commitScannedLogin):落盘按在半路时,令牌已经被遮", async () => {
		const { redactor, redact } = redactorWorld();
		const world = await makeApi({ redact });
		const release = world.secrets.holdNext();

		const committing = world.api.commitScannedLogin(FAKE_TOKEN);
		expect(world.secrets.persists).toHaveLength(0);
		expect(redactor.scrub(`token=${FAKE_TOKEN}`)).toBe("token=***");

		release();
		expect((await committing).ok).toBe(true);
	});

	it("没有令牌(undefined):不登记任何东西,也不抛", async () => {
		const { redactor, redact } = redactorWorld();
		const world = await makeApi({ redact });
		expect((await world.api.commitScannedLogin(undefined)).ok).toBe(true);
		expect(redactor.scrub("no token here")).toBe("no token here");
	});

	it("续期:刷新 POST 的回应一到手令牌就被遮 —— 确认那一步还没回来、也没提交", async () => {
		const { redactor, redact } = redactorWorld();
		const world = await makeApi({ redact });
		world.jar.load([
			{ key: "bili_jct", value: "jct-old", domain: "bilibili.com", path: "/" },
			{ key: "SESSDATA", value: "sess-old", domain: "bilibili.com", path: "/" },
		]);
		vi.spyOn(
			world.api as unknown as { fetchCookieInfo: () => Promise<unknown> },
			"fetchCookieInfo",
		).mockResolvedValue({ code: 0, data: { refresh: true, timestamp: Date.now() } });
		const client = (world.api as unknown as { client: Client }).client;
		vi.spyOn(client, "get").mockResolvedValue('<div id="1-name">rc</div>');
		let confirmReached!: () => void;
		const reached = new Promise<void>((resolve) => {
			confirmReached = resolve;
		});
		let answerConfirm!: (reply: unknown) => void;
		const confirmReply = new Promise<unknown>((resolve) => {
			answerConfirm = resolve;
		});
		let posts = 0;
		vi.spyOn(client, "postForm").mockImplementation(async () => {
			posts += 1;
			if (posts === 1) {
				// 刷新 POST:罐子收到新 bili_jct、回应体里带着新令牌。
				world.jar.setFromSetCookie(
					"bili_jct=jct-new; Domain=bilibili.com; Path=/",
					"https://www.bilibili.com",
				);
				return { code: 0, message: "0", data: { refresh_token: FAKE_TOKEN } };
			}
			confirmReached();
			return confirmReply;
		});

		const running = world.api.checkIfTokenNeedRefresh("FAKE-OLD-REFRESH-TOKEN", "jct-old");
		await reached;
		// 确认 POST 还悬着:没提交、没落盘,令牌却已经被遮。
		expect(world.secrets.persists).toHaveLength(0);
		expect(redactor.scrub(`token=${FAKE_TOKEN}`)).toBe("token=***");

		answerConfirm({ code: 0 });
		await running;
	});

	it("续期:回应里没有令牌字段(风控 / 终态码)也不抛", async () => {
		const { redact } = redactorWorld();
		const world = await makeApi({ redact });
		world.jar.load([{ key: "bili_jct", value: "jct-old", domain: "bilibili.com", path: "/" }]);
		vi.spyOn(
			world.api as unknown as { fetchCookieInfo: () => Promise<unknown> },
			"fetchCookieInfo",
		).mockResolvedValue({ code: 0, data: { refresh: true, timestamp: Date.now() } });
		const client = (world.api as unknown as { client: Client }).client;
		vi.spyOn(client, "get").mockResolvedValue('<div id="1-name">rc</div>');
		vi.spyOn(client, "postForm").mockResolvedValue({ code: -352, message: "risk" });

		await expect(
			world.api.checkIfTokenNeedRefresh("FAKE-OLD-REFRESH-TOKEN", "jct-old"),
		).rejects.toThrow();
	});
});
