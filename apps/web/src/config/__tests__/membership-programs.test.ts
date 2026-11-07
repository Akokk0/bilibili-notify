/**
 * 面板读会员体系档位的那一扇门(㉓e)。
 *
 * 面板曾自己抄一张大航海三档的表(`guard-levels.ts`),与引擎、出图器各持一份。现在三处读同一张
 * `packages/internal` 里的档位表,面板这一头只有 `membership-programs.ts` 一个文件认得它;规则页、逐订阅编辑器、
 * 卡片预览都经它给的中立取数函数拿档。3a 由 `/api/sources` 下发 `descriptor.membershipPrograms` 之后,只换这一个文件。
 */

import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import { membershipTierOf, membershipTiersOf } from "../membership-programs";

const GUARD_PROGRAM_ID = "sample";
const PROGRAMS = [
	{
		id: GUARD_PROGRAM_ID,
		name: "Sample",
		tiers: [
			{ key: "captain", name: "舰长", rank: 1, color: "#4ebcec" },
			{ key: "commander", name: "提督", rank: 2, color: "#d8a0e6" },
			{ key: "governor", name: "总督", rank: 3, color: "#f2a053" },
		],
	},
];

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), "../..");

async function sourceFiles(dir: string): Promise<string[]> {
	const out: string[] = [];
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "__tests__") continue;
			out.push(...(await sourceFiles(full)));
		} else if (/\.(ts|tsx)$/.test(entry.name)) {
			out.push(full);
		}
	}
	return out;
}

function stripComments(raw: string): string {
	return raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

describe("公共描述符档位", () => {
	it("按实际rank排序且不同体系同key不串档", () => {
		const programs = [
			{
				id: "readers",
				name: "Readers",
				tiers: [
					{ key: "shared", name: "Gold", rank: 9 },
					{ key: "low", name: "Silver", rank: 4 },
				],
			},
			{ id: "other", name: "Other", tiers: [{ key: "shared", name: "Bronze", rank: 2 }] },
		];
		expect(membershipTiersOf(programs, "readers").map((t) => t.name)).toEqual(["Silver", "Gold"]);
		expect(programs[0]?.tiers[0]?.name).toBe("Gold");
		expect(membershipTierOf(programs, "other", "shared")?.name).toBe("Bronze");
	});
});

describe("membershipTiersOf", () => {
	it("大航海的档按 rank 由低到高:舰长 → 提督 → 总督", () => {
		const tiers = membershipTiersOf(PROGRAMS, GUARD_PROGRAM_ID);
		expect(tiers.map((t) => t.key)).toEqual(["captain", "commander", "governor"]);
		expect(tiers.map((t) => t.name)).toEqual(["舰长", "提督", "总督"]);
		expect(tiers.map((t) => t.rank)).toEqual([1, 2, 3]);
	});

	it("档色是卡片那一套:舰长 #4ebcec、提督 #d8a0e6、总督 #f2a053", () => {
		expect(membershipTiersOf(PROGRAMS, GUARD_PROGRAM_ID).map((t) => t.color)).toEqual([
			"#4ebcec",
			"#d8a0e6",
			"#f2a053",
		]);
	});

	it("不认识的体系回空表,不抛", () => {
		expect(membershipTiersOf(PROGRAMS, "nobody-has-this")).toEqual([]);
	});

	it("回的是副本:调用方排序、改动都碰不到共享的那张表", () => {
		const first = membershipTiersOf(PROGRAMS, GUARD_PROGRAM_ID);
		expect(membershipTiersOf(PROGRAMS, GUARD_PROGRAM_ID)).not.toBe(first);
		first.reverse();
		first.pop();
		expect(membershipTiersOf(PROGRAMS, GUARD_PROGRAM_ID).map((t) => t.rank)).toEqual([1, 2, 3]);
	});
});

describe("membershipTierOf", () => {
	it("按 key 找档", () => {
		expect(membershipTierOf(PROGRAMS, GUARD_PROGRAM_ID, "commander")?.name).toBe("提督");
	});

	it("体系或 key 不存在回 undefined", () => {
		expect(membershipTierOf(PROGRAMS, GUARD_PROGRAM_ID, "nope")).toBeUndefined();
		expect(membershipTierOf(PROGRAMS, "nobody-has-this", "captain")).toBeUndefined();
	});
});

describe("面板不再直读 B 站的档位表", () => {
	it("BILIBILI_GUARD_PROGRAM 不出现在面板生产代码", async () => {
		const hits: string[] = [];
		for (const file of await sourceFiles(SRC_DIR)) {
			if (stripComments(await readFile(file, "utf8")).includes("BILIBILI_GUARD_PROGRAM")) {
				hits.push(relative(SRC_DIR, file));
			}
		}
		expect(hits).toEqual([]);
	});

	it("旧的 guard-levels 没有人再引用", async () => {
		const hits: string[] = [];
		for (const file of await sourceFiles(SRC_DIR)) {
			if (stripComments(await readFile(file, "utf8")).includes("guard-levels")) {
				hits.push(relative(SRC_DIR, file));
			}
		}
		expect(hits).toEqual([]);
	});

	it("消费页里不再抄档色字面量,档的名字也不再逐个写死", async () => {
		const consumers = [
			"pages/Cards.tsx",
			"pages/rules/sections.tsx",
			"pages/rules/SubscriptionRulesEditor.tsx",
		];
		const colors = membershipTiersOf(PROGRAMS, GUARD_PROGRAM_ID).flatMap((t) =>
			t.color ? [t.color] : [],
		);
		const findings: string[] = [];
		for (const rel of consumers) {
			const src = stripComments(await readFile(join(SRC_DIR, rel), "utf8")).toLowerCase();
			for (const color of colors)
				if (src.includes(color.toLowerCase())) findings.push(`${rel}: ${color}`);
			for (const key of ["captain", "commander", "governor"]) {
				if (src.includes(`"${key}"`)) findings.push(`${rel}: "${key}"`);
			}
			expect(`${rel}: ${src.includes("config/membership-programs")}`).toBe(`${rel}: true`);
		}
		expect(findings).toEqual([]);
	});
});
