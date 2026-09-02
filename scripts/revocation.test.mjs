import { createHash } from "node:crypto";
import { describe, expect, it } from "vite-plus/test";
import { fetchPayloadDigest, planRevocation } from "./revocation.mjs";

/**
 * 撤回一个坏版本 —— 发版链上唯一一件「出事那天才跑」的事。
 *
 * 它以前只有一段写在文档里的手抄步骤:去坏版本该被换成的那一版的 release 页上抄
 * sha256 和字节数,拼一条很长的命令。出事那天手抖抄错一位的下场是:签出来的清单
 * 指着一个校验和对不上的包,所有人的「更新」从此报 `checksum-mismatch` ——
 * 而那正是我们教用户「可能有人在中间改包」的那一档。所以这两件事必须是代码:
 * 规矩(谁能撤、刷哪条渠道)和取数(sha256/size 从真的那份包上算)。
 */

const REPO = "Akokk0/bilibili-notify";

describe("planRevocation", () => {
	it("撤回 0.9.1、让用户回到 0.9.0 → 清单指向 0.9.0 的包,revoked 列着 0.9.1", () => {
		const plan = planRevocation({ repo: REPO, target: "0.9.0", revoked: "0.9.1", channel: "both" });

		expect(plan).toMatchObject({
			ok: true,
			version: "0.9.0",
			revoked: ["0.9.1"],
			payloadUrl: `https://github.com/${REPO}/releases/download/v0.9.0/bilibili-notify-payload-0.9.0.zip`,
			releaseUrl: `https://github.com/${REPO}/releases/tag/v0.9.0`,
		});
	});

	it("一次撤回多版 —— 逗号分隔,顺手去掉空白", () => {
		const plan = planRevocation({
			repo: REPO,
			target: "0.9.0",
			revoked: "0.9.1, 0.9.2 ,",
			channel: "stable",
		});

		expect(plan.ok).toBe(true);
		expect(plan.revoked).toEqual(["0.9.1", "0.9.2"]);
	});

	it("both → 两条渠道都刷;单选只刷那一条", () => {
		const both = planRevocation({ repo: REPO, target: "0.9.0", revoked: "0.9.1", channel: "both" });
		expect(both.channels).toEqual(["stable", "alpha"]);

		const alpha = planRevocation({
			repo: REPO,
			target: "0.9.0",
			revoked: "0.9.1",
			channel: "alpha",
		});
		expect(alpha.channels).toEqual(["alpha"]);
	});

	// 下面几条是这个函数存在的**全部理由** —— 出事那天没人有心思复核参数。
	it("把用户要去的那一版自己也撤回了 → 拒绝", () => {
		const plan = planRevocation({
			repo: REPO,
			target: "0.9.0",
			revoked: "0.9.0,0.9.1",
			channel: "both",
		});

		expect(plan.ok).toBe(false);
		expect(plan.error).toMatch(/0\.9\.0/);
	});

	it("一个都没撤 → 拒绝(那就不是撤回,是重发一遍清单)", () => {
		expect(planRevocation({ repo: REPO, target: "0.9.0", revoked: "  ", channel: "both" }).ok).toBe(
			false,
		);
	});

	it("版本号不成形 → 拒绝,别把 `v0.9.0` / 分支名拼进下载地址", () => {
		expect(
			planRevocation({ repo: REPO, target: "v0.9.0", revoked: "0.9.1", channel: "both" }).ok,
		).toBe(false);
		expect(
			planRevocation({ repo: REPO, target: "0.9.0", revoked: "main", channel: "both" }).ok,
		).toBe(false);
	});

	it("渠道只认 stable / alpha / both", () => {
		expect(
			planRevocation({ repo: REPO, target: "0.9.0", revoked: "0.9.1", channel: "beta" }).ok,
		).toBe(false);
	});
});

describe("fetchPayloadDigest", () => {
	it("从真的那份包上算 sha256 与字节数 —— 手抄的那一步就是这么被去掉的", async () => {
		const bytes = new TextEncoder().encode("payload bytes");
		const stub = async () => new Response(bytes, { status: 200 });

		const digest = await fetchPayloadDigest("https://example.invalid/payload.zip", stub);

		expect(digest).toEqual({
			sha256: createHash("sha256").update(bytes).digest("hex"),
			size: bytes.byteLength,
		});
	});

	it("那一版的包根本不在 → 抛,而不是签一份指着 404 的清单", async () => {
		const stub = async () => new Response("Not Found", { status: 404 });

		await expect(fetchPayloadDigest("https://example.invalid/missing.zip", stub)).rejects.toThrow(
			/404/,
		);
	});
});
