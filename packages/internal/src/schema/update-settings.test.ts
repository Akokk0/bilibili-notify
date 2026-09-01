/**
 * `update` —— 应用内自主升级的用户可调项。
 *
 * 这里守的是配置层的老规矩:**老 globals.json 缺这一段照样开得了机**(独立端启动
 * 时 `GlobalConfigSchema.parse` 失败是直接挂掉的),外加三条产品定案不能被悄悄
 * 改掉 —— 预发布默认关、自动下载默认开、加速前缀默认空。
 */

import { describe, expect, it } from "vite-plus/test";
import { GlobalConfigSchema, makeDefaultGlobalConfig } from "./globals";

describe("update 设置", () => {
	it("老 globals.json 没有 update 段 → 解析成功并补上默认值", () => {
		const g = makeDefaultGlobalConfig() as unknown as Record<string, unknown>;
		delete g.update;

		const parsed = GlobalConfigSchema.safeParse(g);

		expect(parsed.success).toBe(true);
		expect(parsed.data?.update).toBeDefined();
	});

	it("默认走正式版渠道 —— 预发布是用户主动选的,不能默认推给所有人", () => {
		// 预发布版按定义就是没验够的版本。自主升级把「发了个坏版本」的爆炸半径放大
		// 到全体,默认把人放进预发布渠道等于把这个半径再乘一次。
		expect(makeDefaultGlobalConfig().update.channel).toBe("stable");
	});

	it("默认自动下载、但从不自动应用", () => {
		// 定案:下载是无副作用的(装进一个新目录,不碰正在跑的那份),可以自动;
		// 应用要重启服务,那一刻推送会断、直播监听会掉,必须是用户按下去的。
		expect(makeDefaultGlobalConfig().update.autoDownload).toBe(true);
	});

	it("加速前缀默认为空 —— 不替用户选一个第三方代理站", () => {
		// 硬编码一个第三方域名当默认值,等于让每一个安装都去和它说话;它哪天挂了
		// 或者易主,我们只能靠发新版本来收回这个默认值。签名保证了代理站最多只能
		// 拒绝服务,但「默认和谁说话」仍然该是用户的决定。
		expect(makeDefaultGlobalConfig().update.mirrors).toEqual([]);
	});

	it("用户填的加速前缀原样保留,顺序也保留 —— 顺序就是优先级", () => {
		const g = makeDefaultGlobalConfig() as unknown as Record<string, unknown>;
		g.update = {
			channel: "prerelease",
			autoDownload: false,
			mirrors: ["https://a/", "https://b/"],
		};

		const parsed = GlobalConfigSchema.parse(g);

		expect(parsed.update).toEqual({
			channel: "prerelease",
			autoDownload: false,
			mirrors: ["https://a/", "https://b/"],
		});
	});

	it("渠道只认这两个值,别的一律拒", () => {
		const g = makeDefaultGlobalConfig() as unknown as Record<string, unknown>;
		g.update = { channel: "nightly", autoDownload: true, mirrors: [] };

		expect(GlobalConfigSchema.safeParse(g).success).toBe(false);
	});
});
