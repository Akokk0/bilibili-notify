import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";

/**
 * tauri.conf.json 的 before* 命令必须写死本仓那份 vp,不能写裸 `vp`。
 *
 * 裸名字会被 tauri 自己劫持:它解析 `beforeDevCommand` 时按目录逐级向上收集
 * `node_modules/.bin`,而本仓是**嵌在另一个项目里的**
 * (`bilibili-notify-dev/external/bilibili-notify`),外层那份 yarn 装的
 * vite-plus 0.2.1 排在本仓前面就被选中 —— 2026-08-31 实测祖先链:
 *   node <外层>/node_modules/.bin/vp run front:dev
 *
 * 症状是 `dev:desktop` 打出 `VITE+ v0.2.1`。**极难查**:脚本内 `which -a vp` 和
 * `vp --version` 都老老实实报 0.3.0(本仓 .bin 排第一),看着完全无辜 —— 中招的是
 * 「谁在跑这个脚本」,不是脚本里解析到谁。而且删 node_modules 重装治不了
 * (本仓根就摆着 0.3.0,任何经过仓库根的查找都会先撞到它),我在这上面误诊过两轮。
 * 影响面:0.2.1 只当任务运行器,真正编译的仍是本仓 0.3.0 的 core,所以**门禁全绿、
 * 产物也正常**,只有横幅和 `vp run` 那层的行为是旧的 —— 没有任何别的东西会报警。
 */

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = dirname(here);
const conf = JSON.parse(readFileSync(join(desktopRoot, "src-tauri", "tauri.conf.json"), "utf8"));

describe("tauri before* 命令", () => {
	const entries = [
		["beforeDevCommand", conf.build?.beforeDevCommand],
		["beforeBuildCommand", conf.build?.beforeBuildCommand],
	];

	for (const [key, command] of entries) {
		it(`${key} 不用裸 vp(会被外层项目的旧 vp 劫持)`, () => {
			expect(command).toBeTypeOf("string");
			expect(command).not.toMatch(/^\s*vpx?r?\s/);
		});

		it(`${key} 指到的是本仓的 vp,而且那个文件真的在`, () => {
			// tauri 实测以 apps/desktop 为 cwd 跑 before* 命令,相对路径按它解析。
			const bin = command.split(/\s+/)[0];
			expect(bin).toBe("../../node_modules/.bin/vp");
			expect(existsSync(resolve(desktopRoot, bin))).toBe(true);
		});
	}
});
