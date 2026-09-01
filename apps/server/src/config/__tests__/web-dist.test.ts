import { describe, expect, it } from "vite-plus/test";
import { dropLegacyWebDistDir, resolveWebDistDir } from "../web-dist.js";

/**
 * dashboard 静态资源在哪。
 *
 * 规矩:**属于载荷的东西相对 `index.mjs` 解析,属于用户的东西用固定绝对路径。**
 * web-dist 是载荷的一部分(它和服务端代码是同一次发布的两半),所以必须跟着当前
 * 跑的那份载荷走 —— 否则在线升级之后会变成「新服务端配旧前端」,而且不报错,
 * 直到某个改过的接口对不上才炸。AstrBot 的 core/dashboard 错配就是这个形态。
 */
describe("resolveWebDistDir", () => {
	it("没配过 → 跟着当前载荷走,而不是镜像里那份", () => {
		const dir = resolveWebDistDir({
			configured: undefined,
			envValue: undefined,
			bundleUrl: "file:///data/versions/0.9.0/index.mjs",
		});

		expect(dir).toBe("/data/versions/0.9.0/web-dist");
	});

	it("用户自己填了别的路径 → 完全照听,不替他做主", () => {
		const dir = resolveWebDistDir({
			configured: "/srv/my-dashboard",
			envValue: undefined,
			bundleUrl: "file:///data/versions/0.9.0/index.mjs",
		});

		expect(dir).toBe("/srv/my-dashboard");
	});

	it("yaml 里那个机器种的 /app/web-dist 表示「跟着载荷」,不是字面路径", () => {
		// 这个值从来不是用户的决定 —— 是首启动时 BN_WEB_DIST 被 seed 进去的,
		// 界面上根本没有这个字段。正常路径下它会被一次性迁移删掉;这里是兜底:
		// /config 只读挂载时迁移写不进去,那条路上也不能让用户坏掉。
		const dir = resolveWebDistDir({
			configured: "/app/web-dist",
			envValue: undefined,
			bundleUrl: "file:///data/versions/0.9.0/index.mjs",
		});

		expect(dir).toBe("/data/versions/0.9.0/web-dist");
	});

	it("环境变量里的哨兵值同样处理 —— 规则只有一条", () => {
		// 有人可能从旧文档抄了 BN_WEB_DIST=/app/web-dist 进 compose。只管 yaml 不管
		// env 的话,这批人升完照样坏,而且症状一模一样、更难查。
		const dir = resolveWebDistDir({
			configured: undefined,
			envValue: "/app/web-dist",
			bundleUrl: "file:///data/versions/0.9.0/index.mjs",
		});

		expect(dir).toBe("/data/versions/0.9.0/web-dist");
	});

	it("跑镜像自带那份时,行为和今天一模一样", () => {
		// 这条是回归护栏:上面那些改动**不能**动到现有部署的行为。
		const dir = resolveWebDistDir({
			configured: "/app/web-dist",
			envValue: undefined,
			bundleUrl: "file:///app/index.mjs",
		});

		expect(dir).toBe("/app/web-dist");
	});
});

describe("dropLegacyWebDistDir", () => {
	it("删掉那行,但用户自己的注释和排版一个字不动", () => {
		// 这份 yaml 是用户手上那份、他可能编辑过。整份重新序列化会把注释全洗掉 ——
		// 所以只能走文档级编辑,逐行改。
		const original = [
			"# bilibili-notify bootstrap config",
			"dataDir: /data",
			"",
			"# 我自己加的注释,别给我洗掉",
			"logLevel: debug",
			"",
			"# Dashboard 静态资源目录。Docker 镜像固定为 /app/web-dist;",
			"webDistDir: /app/web-dist",
			"",
			"server:",
			"  host: 0.0.0.0",
			"  port: 8787",
			"",
		].join("\n");

		const result = dropLegacyWebDistDir(original);

		expect(result.changed).toBe(true);
		expect(result.text).not.toContain("webDistDir");
		// 连它自己那条说明注释也要带走 —— 留一条描述已删字段的注释,就是新的僵尸。
		// (按行粗暴过滤能通过上面那条断言,但会把这条注释留下。)
		expect(result.text).not.toContain("Dashboard 静态资源目录");
		expect(result.text).toContain("# 我自己加的注释,别给我洗掉");
		expect(result.text).toContain("logLevel: debug");
		expect(result.text).toContain("  port: 8787");
	});

	it("用户填的是别的路径 → 一个字不动", () => {
		const original = ["dataDir: /data", "webDistDir: /srv/my-dashboard", ""].join("\n");

		const result = dropLegacyWebDistDir(original);

		expect(result.changed).toBe(false);
		expect(result.text).toBe(original);
	});

	it("根本没这个字段 → 不去碰用户的文件", () => {
		const original = ["dataDir: /data", "logLevel: info", ""].join("\n");

		const result = dropLegacyWebDistDir(original);

		expect(result.changed).toBe(false);
		expect(result.text).toBe(original);
	});
});
