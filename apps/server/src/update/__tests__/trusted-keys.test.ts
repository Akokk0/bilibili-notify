import { describe, expect, it } from "vite-plus/test";
import { RELEASES_PAGE_URL, TRUSTED_UPDATE_KEYS, UPDATE_MANIFEST_URLS } from "../trusted-keys.js";

/**
 * 信任根与渠道地址。这两样写死在代码里、不给配置入口 —— 能被配置改掉的信任根不是
 * 信任根。
 */
describe("自主升级的信任根", () => {
	it("信任列表要么是空的(功能关掉),要么至少两把 —— 一把等于没有退路", () => {
		// 主用私钥泄露时,唯一的退路是用**从未进过 CI** 的备用私钥签一版、把主用公钥
		// 踢掉。而信任列表是冻在已发出的安装里的:事后再加公钥救不了存量用户。
		// 所以只带一把公钥发版 = 那一天到来时全体用户只能手动重装。
		if (TRUSTED_UPDATE_KEYS.length !== 0) {
			expect(TRUSTED_UPDATE_KEYS.length).toBeGreaterThanOrEqual(2);
		}
	});

	it("每一把都得是能解出来的 Ed25519 SPKI —— 填错一个字符就是全体升不上去", async () => {
		const { createPrivateKey, createPublicKey } = await import("node:crypto");
		for (const key of TRUSTED_UPDATE_KEYS) {
			const der = Buffer.from(key, "base64");

			// **贴成私钥是这里最容易犯、也最危险的错**:生成脚本会打印两串 base64,
			// 一串是公钥(贴进这个文件),另一串是 `base64 < A.pem`(进 CI secret),
			// 长得像、位置相邻。贴错的话私钥就进了一个要发给所有用户的源文件。
			//
			// 光靠下面的 SPKI 解析也能红,但它只会说一句 `Failed to read asymmetric key`
			// —— 那句话不会让任何人想到「我贴的是私钥」。所以先单独认一次。
			let looksPrivate = false;
			try {
				createPrivateKey({ key: der, format: "der", type: "pkcs8" });
				looksPrivate = true;
			} catch {
				// 不是私钥,正常往下走。
			}
			expect(
				looksPrivate,
				"TRUSTED_UPDATE_KEYS 里有一项是**私钥**(PKCS#8)。这个文件会发给所有用户 —— " +
					"这里要的是公钥(SPKI,以 MCowBQYDK2VwAyEA 开头)。私钥只进 CI secret。",
			).toBe(false);

			const parsed = createPublicKey({ key: der, format: "der", type: "spki" });
			expect(parsed.asymmetricKeyType).toBe("ed25519");
		}
	});

	it("两把公钥不能是同一把 —— 复制粘贴出来的『双密钥』是假的", () => {
		expect(new Set(TRUSTED_UPDATE_KEYS).size).toBe(TRUSTED_UPDATE_KEYS.length);
	});

	it("清单和发布页同源同前缀 —— 用户填一条加速前缀就该全管住", () => {
		// 清单在 A 域、载荷在 B 域的话,国内用户得配两条不同的加速规则,而他多半
		// 只会配一条,然后卡在一个「有时能查到、永远下不动」的半死状态里。
		for (const url of Object.values(UPDATE_MANIFEST_URLS)) {
			expect(url.startsWith(`${RELEASES_PAGE_URL}/`)).toBe(true);
		}
	});

	it("两个渠道取的不是同一份清单", () => {
		expect(UPDATE_MANIFEST_URLS.stable).not.toBe(UPDATE_MANIFEST_URLS.prerelease);
	});

	it("一律 https —— 客户端的 schema 也是这么要求载荷地址的", () => {
		for (const url of [...Object.values(UPDATE_MANIFEST_URLS), RELEASES_PAGE_URL]) {
			expect(url.startsWith("https://")).toBe(true);
		}
	});
});
