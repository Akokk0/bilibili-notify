/**
 * 「拓展有更新」—— 让一张已装卡片上出现「有新版 vX · 更新」,而且按得下去。
 *
 * 钉三件事:
 * ① 列表里那一条被改成 `updatable`、版本是**装着那份**的下一个补丁号(不是索引里写的那版 ——
 *   主人要看的是「比我装着的新一格」);索引里压根没有这个 id 时现造一条,而且造成**官方**的
 *   (面板上官方一键装,第三方要先过确认框 —— 造第三方的等于多弹一个框);
 * ② 按「更新」**假装成功**:回一个与真装同形状的成功,盘上一个字节都不动,真装那条路一次都
 *   不走;装成之后注入自己撤掉 —— 现实里更新完那张卡就不再提示了;
 * ③ 别的 id 原样过真市场;收摊之后列表回到真的。
 */

import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MarketplaceEntryDTO, MarketplaceResponse } from "@bilibili-notify/contract";
import type { Logger } from "@bilibili-notify/internal";
import { describe, expect, it, vi } from "vite-plus/test";
import { createMarketplace, type Marketplace } from "../../extensions/marketplace.js";
import { type InstalledExtension, injectableMarketplace } from "../marketplace-injection.js";
import { createDevRegistry, DevParamError } from "../registry.js";
import { marketplaceUpdateScenario } from "../scenarios/marketplace.js";

function entry(over: Partial<MarketplaceEntryDTO> & { id: string }): MarketplaceEntryDTO {
	return {
		source: "official",
		official: true,
		name: `名叫 ${over.id}`,
		description: "索引里的那条",
		version: "1.0.0",
		apiVersion: 1,
		prerelease: false,
		size: 1234,
		state: "installable",
		...over,
	};
}

/** 一个假的真市场:列表每次给一份新拷贝(真的那份也是每次现算),装只记账。 */
function fakeMarket(entries: MarketplaceEntryDTO[]) {
	const install = vi.fn<Marketplace["install"]>(async (_source, id) => ({
		ok: true,
		id,
		name: "真装的",
		version: "9.9.9",
		docs: { readme: true, changelog: true },
	}));
	const list = vi.fn<Marketplace["list"]>(
		async (): Promise<MarketplaceResponse> => ({
			available: true,
			sources: [{ id: "official", name: "官方源", official: true, ok: true }],
			extensions: entries.map((one) => ({ ...one })),
			fetchedAt: 1,
		}),
	);
	return { list, install };
}

function setup(entries: MarketplaceEntryDTO[], installed: InstalledExtension[]) {
	const real = fakeMarket(entries);
	const injectable = injectableMarketplace(real, () => installed);
	const reg = createDevRegistry([marketplaceUpdateScenario(injectable)]);
	return { reg, real, market: injectable.marketplace };
}

const BRIDGE_ELSEWHERE = entry({
	id: "bridge",
	version: "1.1.0",
	state: "installed-elsewhere",
	installed: { version: "1.2.3" },
});
const OTHER = entry({ id: "other", version: "2.0.0" });

describe("ext.updatable · 列表", () => {
	it("声明:拓展组、拓展 id(默认 bridge)与假装下载几秒(默认 2)", () => {
		const { reg } = setup([], []);
		const [decl] = reg.list();
		expect(decl).toMatchObject({ id: "ext.updatable", group: "ext", title: "拓展有更新" });
		expect(decl?.params).toEqual([
			expect.objectContaining({ key: "ext", kind: "text", default: "bridge" }),
			expect.objectContaining({ key: "download", kind: "number", default: 2 }),
		]);
	});

	/**
	 * 真更新要先下载,面板那段换装一直「蓄」到装完才画勾。假更新一按就成的话,那一段蓄力根本
	 * 看不见 —— 所以假装下载一会儿,再回成功。
	 */
	it("假装下载:等够了那几秒才回成功", async () => {
		const { reg, market } = setup(
			[BRIDGE_ELSEWHERE],
			[{ id: "bridge", name: "机器人桥", version: "1.2.3" }],
		);
		await reg.run("ext.updatable", { ext: "bridge", download: 0.2 });

		const started = Date.now();
		const outcome = await market.install("official", "bridge");
		expect(Date.now() - started).toBeGreaterThanOrEqual(180);
		expect(outcome).toMatchObject({ ok: true, version: "1.2.4" });
	});

	it("索引里有这一条:改成 updatable,版本是装着那份的下一个补丁号,来源认成这条的源", async () => {
		const { reg, market } = setup(
			[BRIDGE_ELSEWHERE, OTHER],
			[{ id: "bridge", name: "机器人桥", version: "1.2.3" }],
		);
		const res = await reg.run("ext.updatable", { ext: "bridge", download: 0 });

		const view = await market.list();
		expect(view.extensions).toEqual([
			{
				...BRIDGE_ELSEWHERE,
				version: "1.2.4",
				state: "updatable",
				installed: { version: "1.2.3", source: "official" },
			},
			OTHER,
		]);
		expect(res.active).toEqual([
			{ scenarioId: "ext.updatable", label: "拓展有更新 → bridge v1.2.4" },
		]);
	});

	it.each([
		["1.2.3", "1.2.4"],
		// 预发布:最后一段是数就把它加一(下一个预发布长这样)……
		["1.0.0-alpha.1", "1.0.0-alpha.2"],
		// ……不是数就在后面补一段 `.1`(按 semver,多一段的预发布排在后面)。
		["1.0.0-beta", "1.0.0-beta.1"],
	])("装着 %s → 假新版 %s", async (installedVersion, next) => {
		const { reg, market } = setup(
			[BRIDGE_ELSEWHERE],
			[{ id: "bridge", version: installedVersion }],
		);
		await reg.run("ext.updatable", { ext: "bridge", download: 0 });
		const [promoted] = (await market.list()).extensions;
		expect(promoted?.version).toBe(next);
		expect(promoted?.prerelease).toBe(next.includes("-"));
	});

	it("同一个 id 两个源都列着:改的是**装着那份的来源**那一条,另一条不动", async () => {
		const third = entry({
			id: "bridge",
			source: "src-3",
			official: false,
			version: "1.2.3",
			state: "installed",
			installed: { version: "1.2.3", source: "src-3" },
		});
		const { reg, market } = setup([BRIDGE_ELSEWHERE, third], [{ id: "bridge", version: "1.2.3" }]);
		await reg.run("ext.updatable", { ext: "bridge", download: 0 });

		const view = await market.list();
		expect(view.extensions).toEqual([
			BRIDGE_ELSEWHERE,
			{ ...third, version: "1.2.4", state: "updatable" },
		]);
	});

	/**
	 * 索引拿不到(断网)或这个拓展根本不在任何索引里 —— 开发版装的桥常是这样。
	 * 现造一条**官方**的:面板对官方一键装,第三方要先弹确认框。
	 */
	it("索引里没有这个 id:现造一条官方的 updatable,别的条目不动", async () => {
		const { reg, market } = setup([OTHER], [{ id: "bridge", name: "机器人桥", version: "0.3.0" }]);
		await reg.run("ext.updatable", { ext: "bridge", download: 0 });

		const view = await market.list();
		expect(view.extensions[0]).toEqual(OTHER);
		expect(view.extensions[1]).toMatchObject({
			source: "official",
			official: true,
			id: "bridge",
			name: "机器人桥",
			version: "0.3.1",
			prerelease: false,
			installed: { version: "0.3.0", source: "official" },
			state: "updatable",
		});
		expect(view.extensions).toHaveLength(2);
	});
});

describe("ext.updatable · 按「更新」", () => {
	it("那个 id:回与真装同形状的成功(版本 = 假新版),真装一次都不走;装成后注入自己撤掉", async () => {
		const { reg, real, market } = setup(
			[BRIDGE_ELSEWHERE, OTHER],
			[{ id: "bridge", name: "机器人桥", version: "1.2.3" }],
		);
		await reg.run("ext.updatable", { ext: "bridge", download: 0 });

		const outcome = await market.install("official", "bridge");
		expect(outcome).toEqual({
			ok: true,
			id: "bridge",
			name: "机器人桥",
			version: "1.2.4",
			// 包是假的,哪来的说明 —— 报「有」的话「看看更新日志」会领人去读盘上那份旧的。
			docs: { readme: false, changelog: false },
		});
		expect(real.install).not.toHaveBeenCalled();
		// 现实里更新完那张卡就不再提示了。
		expect(reg.active()).toEqual([]);
		expect((await market.list()).extensions).toEqual([BRIDGE_ELSEWHERE, OTHER]);
	});

	/**
	 * 用**真市场**摆一次:没有官方源、没有第三方源(= 断网 / 索引里没有它),装载根是个空的
	 * 临时目录。按下「更新」之后那个目录里什么都不许多出来 —— 真装会落包、会写来源记录。
	 */
	it("盘上一个字节都不动(真市场、现造的那条)", async () => {
		const root = await mkdtemp(join(tmpdir(), "bn-dev-market-"));
		try {
			const logger: Logger = { info() {}, warn() {}, error() {}, debug() {} };
			let diskChanges = 0;
			const changeDisk = async <T>(write: () => Promise<T>): Promise<T> => {
				diskChanges += 1;
				return write();
			};
			const realMarket = createMarketplace({
				root,
				sources: () => [],
				mirrors: () => [],
				prerelease: () => false,
				installed: () => [{ id: "bridge", version: "0.3.0" }],
				changeDisk,
				logger,
			});
			const injectable = injectableMarketplace(realMarket, () => [
				{ id: "bridge", name: "机器人桥", version: "0.3.0" },
			]);
			const reg = createDevRegistry([marketplaceUpdateScenario(injectable)]);
			await reg.run("ext.updatable", { ext: "bridge", download: 0 });

			const [made] = (await injectable.marketplace.list()).extensions;
			expect(made).toMatchObject({ source: "official", state: "updatable", version: "0.3.1" });
			const outcome = await injectable.marketplace.install("official", "bridge");
			expect(outcome).toMatchObject({ ok: true, version: "0.3.1" });

			expect(await readdir(root)).toEqual([]);
			expect(diskChanges).toBe(0);
			// 撤掉之后就是真市场自己的话:这台机器上没有任何源列着它。
			expect((await injectable.marketplace.list()).extensions).toEqual([]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("别的 id 原样过真市场,注入不受影响", async () => {
		const { reg, real, market } = setup(
			[BRIDGE_ELSEWHERE, OTHER],
			[{ id: "bridge", version: "1.2.3" }],
		);
		await reg.run("ext.updatable", { ext: "bridge", download: 0 });

		const outcome = await market.install("src-3", "other");
		expect(real.install).toHaveBeenCalledWith("src-3", "other");
		expect(outcome).toMatchObject({ ok: true, name: "真装的", version: "9.9.9" });
		expect(reg.active()).toHaveLength(1);
	});
});

describe("ext.updatable · 收摊与挡板", () => {
	it("收摊(单收 / 一键全收)之后列表回到真的", async () => {
		for (const id of ["ext.updatable", undefined]) {
			const { reg, market } = setup(
				[BRIDGE_ELSEWHERE, OTHER],
				[{ id: "bridge", version: "1.2.3" }],
			);
			await reg.run("ext.updatable", { ext: "bridge", download: 0 });
			expect(await reg.reset(id)).toEqual([]);
			expect((await market.list()).extensions).toEqual([BRIDGE_ELSEWHERE, OTHER]);
		}
	});

	it("没装的 id / 空 id:当场拒,什么都不注入", async () => {
		const { reg, market } = setup([BRIDGE_ELSEWHERE], [{ id: "bridge", version: "1.2.3" }]);
		await expect(reg.run("ext.updatable", { ext: "ghost" })).rejects.toBeInstanceOf(DevParamError);
		await expect(reg.run("ext.updatable", { ext: " " })).rejects.toBeInstanceOf(DevParamError);
		expect(reg.active()).toEqual([]);
		expect((await market.list()).extensions).toEqual([BRIDGE_ELSEWHERE]);
	});

	/** 装载器名单是现取的:注入之后卸掉了,列表不改(改了也没卡可画),装原样过真市场。 */
	it("注入之后卸掉了:列表不改、装走真的,生效条照实说不生效", async () => {
		const installed: InstalledExtension[] = [{ id: "bridge", version: "1.2.3" }];
		const real = fakeMarket([BRIDGE_ELSEWHERE]);
		const injectable = injectableMarketplace(real, () => installed);
		const reg = createDevRegistry([marketplaceUpdateScenario(injectable)]);
		await reg.run("ext.updatable", { ext: "bridge", download: 0 });
		installed.length = 0;

		expect((await injectable.marketplace.list()).extensions).toEqual([BRIDGE_ELSEWHERE]);
		expect(reg.active()).toEqual([
			{ scenarioId: "ext.updatable", label: "拓展有更新 → bridge(现在没装,不生效)" },
		]);
		await injectable.marketplace.install("official", "bridge");
		expect(real.install).toHaveBeenCalledWith("official", "bridge");
	});
});
