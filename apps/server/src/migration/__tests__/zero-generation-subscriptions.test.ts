/**
 * 0.x 的两份订阅文件 → 新代里的一个 `config/subscriptions.json`(ADR-0021 决策 14、15)。
 *
 * 0.x 把订阅放在两个文件里:`state/subscriptions.json`(B 站,身份在顶层 `uid`、没有 `kind`)与
 * `state/extension-subscriptions.json`(拓展,`kind: "extension"` + `extensionId` + `externalId`)。迁移器
 * 把两份各自迁成 0.x 最新的形状(推送特性的老形状归 `./zero-generation-features.test.ts`),再合成新代里
 * 的一个文件:**B 站的在前、拓展的在后**,每行 `{ id, identity, ...其余 }`;拓展那份只作输入、自己不进新代。
 * 新代里的文件是 `{ tags, subscriptions }`:0.x 每行的分组(一串名字 `groups`)换成标签表与 `tagIds`(ADR-0034)。
 *
 * 接缝是「第 0 代 → `migrateZeroGeneration` → 读新代里的文件 / 在新代上开配置仓」。拓展那份读不懂就抛
 * (原样留着的话配置仓看不见它,拓展订阅会悄悄全丢);B 站那份读不懂照旧原样留着、由配置仓开机时报出来。
 */

import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { CONFIG_DIR, ConfigValidationError } from "../../config/store.js";
import { migrateSubscriptionFiles } from "../subscriptions.js";
import { migrateZeroGeneration } from "../zero-generation.js";
import { SANDBOX_NOW, useZeroSandbox } from "./support.js";
import { zeroBiliRow, zeroExtensionRow } from "./zero-fixtures.js";

const sandbox = useZeroSandbox("bn-zero-subscriptions-");

const B1 = "11111111-1111-4111-8111-111111111111";
const B2 = "22222222-2222-4222-8222-222222222222";
const E1 = "33333333-3333-4333-8333-333333333333";
const E2 = "44444444-4444-4444-8444-444444444444";

type Row = Record<string, unknown>;

/** 0.x 的行可能带着主人起的别名 `name`(1.0 退役,ADR-0021 决策 16)。 */
const named = (name: string | undefined) => (name === undefined ? {} : { name });
const bili = (
	id: string,
	uid: string,
	over: Record<string, unknown> = {},
	name?: string,
	groups: string[] = [],
) => zeroBiliRow({ id, uid, groups }, { ...over, ...named(name) });
const ext = (
	id: string,
	extensionId: string,
	externalId: string,
	name?: string,
	groups: string[] = [],
) => zeroExtensionRow({ id, extensionId, externalId, groups }, named(name));

/** 新代里的订阅文件:标签表 + 订阅(ADR-0034)。 */
interface NewFile<R = Row> {
	tags: Array<{ id: string; name: string }>;
	subscriptions: R[];
}
const readRows = async <R = Row>(): Promise<R[]> =>
	(await sandbox.readConfig<NewFile<R>>("subscriptions.json")).subscriptions;

/** 老键:合出来的行上一个都不许留。`name` 是退役的别名,也丢。 */
const OLD_KEYS = ["kind", "uid", "extensionId", "externalId", "name"] as const;

const ZERO_BILI = "state/subscriptions.json";
const ZERO_EXT = "state/extension-subscriptions.json";

describe("两份合成一个文件", () => {
	const biliRows = () => [bili(B1, "101", {}, "B 站甲"), bili(B2, "102")];
	const extRows = () => [ext(E1, "douyin", "sec-a", "抖音甲"), ext(E2, "kuaishou", "sec-b")];

	async function placeBoth(): Promise<{ biliText: string; extText: string }> {
		const biliText = JSON.stringify(biliRows());
		const extText = JSON.stringify(extRows());
		await sandbox.placeZeroText(ZERO_BILI, biliText);
		await sandbox.placeZeroText(ZERO_EXT, extText);
		return { biliText, extText };
	}

	it("B 站的在前、拓展的在后,各按原来的顺序;每行 identity 对得上", async () => {
		await placeBoth();

		await sandbox.migrate();

		const rows = await readRows<{ id: string; identity: unknown }>();
		// 钉的是顺序、不是集合:谁在前谁在后调换了就红。
		expect(rows.map((r) => r.id)).toEqual([B1, B2, E1, E2]);
		expect(rows.map((r) => r.identity)).toEqual([
			{ sourceKey: "bilibili", externalId: "101" },
			{ sourceKey: "bilibili", externalId: "102" },
			{ sourceKey: "douyin", externalId: "sec-a" },
			{ sourceKey: "kuaishou", externalId: "sec-b" },
		]);
	});

	it("行是 { id, identity, ...其余 }:老身份键与退役的别名一个不留,别的格原样带过来", async () => {
		await placeBoth();

		await sandbox.migrate();

		const rows = await readRows();
		// 摆进去的确实带着别名(B 站与拓展各一行),下面那句「不许留」才不是空话。
		expect([...biliRows(), ...extRows()].filter((r) => "name" in r)).toHaveLength(2);
		for (const row of rows) {
			expect(Object.keys(row).slice(0, 2), String(row.id)).toEqual(["id", "identity"]);
			for (const key of OLD_KEYS) expect(row, `${row.id} 上还留着 ${key}`).not.toHaveProperty(key);
		}
		// 别的格:覆盖、锐评……与摆进去的一模一样(摆进去的就是 0.x 最新形状,没有要迁的)。
		// 0.x 的 `groups` 在原位换成 `tagIds`(这几行没有分组,所以是空的),见下面「分组换成标签」。
		// 唯一的变化是 1.0 的改名(逐键的用例在 `./feature-renames.test.ts`)与直播拆键(`./live-split.test.ts`):`routing` 换成 1.0 的特性键、多一把 `liveStreaming`,顶层的 `extras`
		// 叫 `extraTargets`、里面是 1.0 的附加项键 —— 摆进去的两张表都是空的,所以期望值是字面量的空表。
		const strip = (row: Row) => {
			const {
				uid: _u,
				kind: _k,
				extensionId: _e,
				externalId: _x,
				name: _n,
				routing: _r,
				extras: _ex,
				...rest
			} = row;
			return {
				...Object.fromEntries(
					Object.entries(rest).map(([k, v]) =>
						k === "groups" ? ["tagIds", []] : k === "specialUsers" ? ["specialViewers", v] : [k, v],
					),
				),
				routing: {
					post: [],
					liveStart: [],
					liveStreaming: [],
					liveEnd: [],
					membership: [],
					superchat: [],
					viewerChat: [],
					viewerEnter: [],
				},
				extraTargets: { atAllPost: {}, atAllLiveStart: {}, wordcloud: {}, liveSummary: {} },
			};
		};
		const expected = [...biliRows(), ...extRows()].map(strip);
		expect(rows.map(({ identity: _identity, ...rest }) => rest)).toEqual(expected);
	});

	it("新代里没有 extension-subscriptions.json(只作输入);订阅文件记进 rewritten,那份记进 skipped", async () => {
		await placeBoth();

		const report = await sandbox.migrate();

		await expect(stat(sandbox.configPath("extension-subscriptions.json"))).rejects.toMatchObject({
			code: "ENOENT",
		});
		expect(report.rewritten).toContain("config/subscriptions.json");
		expect(report.rewritten).not.toContain("config/extension-subscriptions.json");
		expect(report.transfers.map((t) => t.from)).not.toContain(ZERO_EXT);
		expect(report.skipped.map((s) => s.path)).toContain(ZERO_EXT);
	});

	it("第 0 代那两份一个字节没变(写的是新代里的文件)", async () => {
		const { biliText, extText } = await placeBoth();

		await sandbox.migrate();

		expect(await readFile(join(sandbox.zero, ZERO_BILI), "utf8")).toBe(biliText);
		expect(await readFile(join(sandbox.zero, ZERO_EXT), "utf8")).toBe(extText);
	});

	it("配置仓在新代上开机读得进:身份原样,顺序同文件", async () => {
		await placeBoth();

		const store = await sandbox.migrateAndLoad();

		expect(store.getSubscriptions().map((s) => `${s.id}@${s.identity.sourceKey}`)).toEqual([
			`${B1}@bilibili`,
			`${B2}@bilibili`,
			`${E1}@douyin`,
			`${E2}@kuaishou`,
		]);
	});
});

describe("0.x 的分组换成标签(ADR-0034)", () => {
	const GAME = " 游戏 ";
	async function placeGrouped(): Promise<void> {
		await sandbox.placeZeroText(
			ZERO_BILI,
			JSON.stringify([
				bili(B1, "101", {}, undefined, [GAME, "杂谈", ""]),
				bili(B2, "102", {}, undefined, ["杂谈", "游戏", "游戏"]),
			]),
		);
		await sandbox.placeZeroText(
			ZERO_EXT,
			JSON.stringify([
				ext(E1, "douyin", "sec-a", undefined, ["阿婆主"]),
				ext(E2, "kuaishou", "sec-b"),
			]),
		);
	}

	it("标签表:去掉首尾空白、丢掉空的、同名只留一个,按中文排序", async () => {
		await placeGrouped();

		await sandbox.migrate();

		const file = await sandbox.readConfig<NewFile>("subscriptions.json");
		expect(file.tags.map((t) => t.name)).toEqual(["阿婆主", "游戏", "杂谈"]);
		for (const t of file.tags)
			expect(t.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
	});

	it("每行的 tagIds 按行里的顺序对上标签,行内同名只挂一次;groups 一行都不留", async () => {
		await placeGrouped();

		await sandbox.migrate();

		const file = await sandbox.readConfig<NewFile>("subscriptions.json");
		const idOf = (name: string) => file.tags.find((t) => t.name === name)?.id;
		expect(file.subscriptions.map((r) => r.tagIds)).toEqual([
			[idOf("游戏"), idOf("杂谈")],
			[idOf("杂谈"), idOf("游戏")],
			[idOf("阿婆主")],
			[],
		]);
		for (const row of file.subscriptions) expect(row).not.toHaveProperty("groups");
	});

	it("标签的 id 迁两遍一样(重迁拆出同一批 id,订阅上挂的才对得上)", async () => {
		await placeGrouped();

		await sandbox.migrate();
		const first = (await sandbox.readConfig<NewFile>("subscriptions.json")).tags;
		const again = join(sandbox.target, "..", "generation-again");
		await migrateZeroGeneration({ zeroRoot: sandbox.zero, targetDir: again, now: SANDBOX_NOW });
		const second = JSON.parse(
			await readFile(join(again, ...CONFIG_DIR, "subscriptions.json"), "utf8"),
		) as NewFile;

		expect(second.tags).toEqual(first);
	});

	it("名字里带中文逗号的照原样成一个标签,不拆(主人 10-02 定)", async () => {
		// 0.x 订阅详情那个文本框每敲一个字就按英文逗号拆开再拼回去,英文逗号敲不进去,写不出多个分组;
		// 名字里的「，」是主人有意起的。
		await sandbox.placeZeroText(
			ZERO_BILI,
			JSON.stringify([bili(B1, "101", {}, undefined, ["家人，同事"])]),
		);

		await sandbox.migrate();

		const file = await sandbox.readConfig<NewFile>("subscriptions.json");
		expect(file.tags.map((t) => t.name)).toEqual(["家人，同事"]);
		expect(file.subscriptions[0]?.tagIds).toEqual([file.tags[0]?.id]);
	});

	it("配置仓开机读得进:标签表与各行挂的标签原样", async () => {
		await placeGrouped();

		const store = await sandbox.migrateAndLoad();

		const tags = store.getSubscriptionTags();
		expect(tags.map((t) => t.name)).toEqual(["阿婆主", "游戏", "杂谈"]);
		const nameOf = (id: string) => tags.find((t) => t.id === id)?.name;
		expect(store.getSubscriptions().map((s) => s.tagIds.map(nameOf))).toEqual([
			["游戏", "杂谈"],
			["杂谈", "游戏"],
			["阿婆主"],
			[],
		]);
	});
});

describe("只有一份的时候", () => {
	it("只有拓展那份(B 站那份不存在)也合得出来,新代里的订阅文件就是它们", async () => {
		await sandbox.placeZero(ZERO_EXT, [ext(E1, "douyin", "sec-a"), ext(E2, "kuaishou", "sec-b")]);

		const report = await sandbox.migrate();

		const rows = await readRows();
		expect(rows.map((r) => r.id)).toEqual([E1, E2]);
		expect(rows.map((r) => r.identity)).toEqual([
			{ sourceKey: "douyin", externalId: "sec-a" },
			{ sourceKey: "kuaishou", externalId: "sec-b" },
		]);
		for (const row of rows) for (const key of OLD_KEYS) expect(row).not.toHaveProperty(key);
		expect(report.rewritten).toContain("config/subscriptions.json");
		expect((await sandbox.load()).getSubscriptions().map((s) => s.id)).toEqual([E1, E2]);
	});

	it("只有 B 站那份(拓展那份不存在):行换成 identity,新代里照样没有拓展那份", async () => {
		await sandbox.placeZero(ZERO_BILI, [bili(B1, "101")]);

		await sandbox.migrate();

		expect(await readRows()).toEqual([
			expect.objectContaining({ id: B1, identity: { sourceKey: "bilibili", externalId: "101" } }),
		]);
		await expect(stat(sandbox.configPath("extension-subscriptions.json"))).rejects.toMatchObject({
			code: "ENOENT",
		});
	});

	it("拓展那份是空数组:只剩 B 站的", async () => {
		await sandbox.placeZero(ZERO_BILI, [bili(B1, "101")]);
		await sandbox.placeZero(ZERO_EXT, []);

		await sandbox.migrate();

		expect((await readRows()).map((r) => r.id)).toEqual([B1]);
	});

	it("两份都没有 → 什么都不写;配置仓开机当空表", async () => {
		// 第 0 代里别的东西在(只是没有订阅),迁移才有得迁。
		await sandbox.placeZero("state/sub-runtime.json", {});
		const report = await sandbox.migrate();

		expect(report.rewritten).not.toContain("config/subscriptions.json");
		await expect(stat(sandbox.configPath("subscriptions.json"))).rejects.toMatchObject({
			code: "ENOENT",
		});
		expect((await sandbox.load()).getSubscriptions()).toEqual([]);
	});
});

describe("读不懂的那几种", () => {
	it.each([
		["不是 JSON 数组(是对象)", JSON.stringify({ not: "an array" })],
		["不是 JSON", "{这不是 JSON"],
	])("第 0 代的拓展那份%s → 迁移抛,点名是哪个文件;第 0 代没动", async (_label, text) => {
		await sandbox.placeZero(ZERO_BILI, [bili(B1, "101")]);
		await sandbox.placeZeroText(ZERO_EXT, text);

		await expect(sandbox.migrate()).rejects.toThrow(/extension-subscriptions\.json/);

		expect(await readFile(join(sandbox.zero, ZERO_EXT), "utf8")).toBe(text);
	});

	it("B 站那份读不懂:不抛,原样留着,由配置仓开机时拒收(跳过坏行下次写回就永久没了)", async () => {
		const text = "{这不是 JSON";
		await sandbox.placeZeroText(ZERO_BILI, text);
		await sandbox.placeZero(ZERO_EXT, [ext(E1, "douyin", "sec-a")]);

		await sandbox.migrate();

		expect(await readFile(sandbox.configPath("subscriptions.json"), "utf8")).toBe(text);
		await expect(sandbox.load()).rejects.toBeInstanceOf(Error);
	});

	it("认不出身份的行(没有 uid、也没有 extensionId + externalId)原样留着,由配置仓开机报出来", async () => {
		const odd = { id: B2, enabled: true };
		await sandbox.placeZero(ZERO_BILI, [bili(B1, "101"), odd]);

		await sandbox.migrate();

		const rows = await readRows();
		expect(rows[1]).toEqual(odd);
		await expect(sandbox.load()).rejects.toBeInstanceOf(ConfigValidationError);
	});
});

describe("迁两遍和迁一遍一样", () => {
	it("同一个第 0 代迁进两个新的目标,订阅文件字节一致", async () => {
		await sandbox.placeZero(ZERO_BILI, [bili(B1, "101"), bili(B2, "102")]);
		await sandbox.placeZero(ZERO_EXT, [ext(E1, "douyin", "sec-a"), ext(E2, "kuaishou", "sec-b")]);

		await sandbox.migrate();
		const first = await readFile(sandbox.configPath("subscriptions.json"), "utf8");
		// 第 0 代没动,所以再往一个新目标迁一遍(下次开机按修订号重迁就是这么来的)产出完全一样。
		const again = join(sandbox.target, "..", "generation-again");
		await migrateZeroGeneration({ zeroRoot: sandbox.zero, targetDir: again, now: SANDBOX_NOW });
		expect(await readFile(join(again, ...CONFIG_DIR, "subscriptions.json"), "utf8")).toBe(first);
	});

	it("对新代再迁一次订阅这一步回 [],文件字节不变 —— 第 0 代的拓展那份还在,也不追加第二份", async () => {
		await sandbox.placeZero(ZERO_BILI, [bili(B1, "101")]);
		await sandbox.placeZero(ZERO_EXT, [ext(E1, "douyin", "sec-a")]);
		await sandbox.migrate();
		const before = await readFile(sandbox.configPath("subscriptions.json"), "utf8");

		const rewritten = await migrateSubscriptionFiles({
			configDir: join(sandbox.target, ...CONFIG_DIR),
			extensionSubscriptionsPath: join(sandbox.zero, ZERO_EXT),
			globalLive: { liveStart: true, pushTime: 0 },
		});

		expect(rewritten).toEqual([]);
		expect(await readFile(sandbox.configPath("subscriptions.json"), "utf8")).toBe(before);
	});
});
