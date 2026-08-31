/// <reference types="node" />
/**
 * 字号 conformance —— 扫 web 与 ui 全部组件源码,拦裸 Tailwind 字号档
 * (`text-xs` / `text-sm` / `text-base` / `text-lg` / `text-xl` …)。
 *
 * 站里的字号阶是 `--text-bn-*`(theme.css),皮肤与主题能碰到的只有这一套;
 * 裸档编译成静态 rem,整站换字号时唯独这些地方钉在原地。收编前逃逸了 43 处
 * (Stats 系重灾,连 `Btn` 的 sm/lg 两档都是裸的),grep 还会被「同一行里有
 * bn 色类」这种过滤误伤 —— 静态守卫不会。
 *
 * 像素对照(替换时按**等值**归档,别按名字直译):裸 `text-xs` 12px = `bn-sm`,
 * 裸 `text-sm` 14px ≈ `bn-base` 13(或 `bn-md` 15,看档位阶梯),裸 `text-xl`
 * 20px = `bn-xl`。任意值档(`text-[0.88em]` 这类)不在射程内 —— 那是刻意的
 * 相对字号,不是漂移。
 */

import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import { listSources } from "./walk.js";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = join(TEST_DIR, "..");
const UI_SRC_DIR = join(SRC_DIR, "../../../packages/ui/src");
const REPO_RELATIVE_BASE = join(SRC_DIR, "../../..");

/**
 * Tailwind 默认字号档的完整名单。前后都不许贴字母或 `-`(所以 `text-bn-sm`、
 * `text-smth` 都不会误中),后面也不许贴 `[`(任意值档不归这条管)。
 */
const RAW_SIZE_RE =
	/(?<![-a-zA-Z])text-(2xs|xs|sm|base|md|lg|xl|2xl|3xl|4xl|5xl|6xl|7xl|8xl|9xl)(?![-a-zA-Z[])/g;

/** 测试目录/文件跳过 —— 守卫守的是产品源码;测试里引用旧类名是断言不是漂移。 */
const listTsx = (dir: string) => listSources(dir, { skipTestDirs: true, skipTestFiles: true });

describe("字号走 bn 阶,不许裸 Tailwind 档", () => {
	it("web 与 ui 的组件源码里没有裸字号", () => {
		const offenders: string[] = [];
		for (const file of [...listTsx(SRC_DIR), ...listTsx(UI_SRC_DIR)]) {
			const src = readFileSync(file, "utf8");
			const lines = src.split("\n");
			for (let i = 0; i < lines.length; i++) {
				const line = lines[i] ?? "";
				for (const m of line.matchAll(RAW_SIZE_RE)) {
					offenders.push(`${relative(REPO_RELATIVE_BASE, file)}:${i + 1} → ${m[0]}`);
				}
			}
		}
		expect(offenders, `裸 Tailwind 字号档(改用 text-bn-*):\n${offenders.join("\n")}`).toEqual([]);
	});
});
