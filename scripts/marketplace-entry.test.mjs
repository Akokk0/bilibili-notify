import { describe, expect, it } from "vite-plus/test";
import { marketplaceEntryOf, releaseFromEnv } from "./marketplace-entry.mjs";
import { assertEntryShape, mergeMarketplaceEntry } from "./marketplace-index.mjs";

/**
 * 这一条以前是 workflow 里一段 `node -e`,于是从来没被测过 —— 而它写的是**客户端 zod 的
 * 对家**:少一格、类型错一格、URL 里那个 tag 忘了转义,流水线照样全绿,坏掉的是用户那头
 * 的「拉不到索引 / 下载失败」。搬出来就是为了能在这儿钉住。
 */

const manifest = {
	id: "bridge",
	name: "机器人框架桥接",
	description: "把 koishi / AstrBot 里配好的机器人借给 BN 用。",
	version: "0.0.2",
	apiVersion: 1,
	provides: ["push"],
};

const release = {
	version: "0.0.2",
	prerelease: false,
	repo: "Akokk0/bilibili-notify",
	sha256: "a".repeat(64),
	size: 292_400,
	notes: "第一版。",
};

describe("marketplaceEntryOf", () => {
	it("并得进索引 —— 形状就是客户端认的那一份", () => {
		const entry = marketplaceEntryOf(manifest, release);
		expect(() => assertEntryShape(entry)).not.toThrow();
		const index = mergeMarketplaceEntry(undefined, entry, { issuedAt: 100 });
		expect(index.extensions).toHaveLength(1);
	});

	it("tag 里的 `/` 与 `@` 整段转义 —— 不转的话那条下载链接指着 404", () => {
		const entry = marketplaceEntryOf(manifest, release);
		expect(entry.package.url).toBe(
			"https://github.com/Akokk0/bilibili-notify/releases/download/extension%2Fbridge%400.0.2/bridge-0.0.2.zip",
		);
		expect(entry.releaseUrl).toBe(
			"https://github.com/Akokk0/bilibili-notify/releases/tag/extension%2Fbridge%400.0.2",
		);
	});

	it("清单没写 description 时给空串,不是 undefined", () => {
		const { description, ...bare } = manifest;
		expect(marketplaceEntryOf(bare, release).description).toBe("");
	});

	it("版本取的是这一趟发布的那个,不是清单里那个", () => {
		// 两者由 assert-extension-tag.sh 保证一致;这一条只是钉住「谁说了算」。
		expect(marketplaceEntryOf(manifest, { ...release, version: "0.1.0" })).toMatchObject({
			version: "0.1.0",
			releaseUrl: expect.stringContaining("%400.1.0"),
		});
	});
});

describe("releaseFromEnv", () => {
	const env = {
		VERSION: "0.0.2",
		PRERELEASE: "false",
		REPO: "Akokk0/bilibili-notify",
		SHA256: "a".repeat(64),
		SIZE: "292400",
		NOTES: "第一版。",
	};

	it("SIZE 从 env 来是字符串,转成数 —— 留着字符串的话客户端判 malformed", () => {
		expect(releaseFromEnv(env).size).toBe(292_400);
	});

	it("PRERELEASE 只有字面 'true' 算预发布", () => {
		expect(releaseFromEnv(env).prerelease).toBe(false);
		expect(releaseFromEnv({ ...env, PRERELEASE: "true" }).prerelease).toBe(true);
	});

	it("缺一格当场抛,别打出一份半截的条目", () => {
		expect(() => releaseFromEnv({ ...env, SHA256: "" })).toThrow(/SHA256/);
		expect(() => releaseFromEnv({ ...env, SIZE: "0" })).toThrow(/SIZE/);
		expect(() => releaseFromEnv({ ...env, SIZE: "不是数" })).toThrow(/SIZE/);
	});
});
