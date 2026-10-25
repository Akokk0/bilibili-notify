import type { CreatorProfileReport } from "@bilibili-notify/extension";
import { describe, expect, it } from "vite-plus/test";
import { bootFakeSource, type HarnessSub, IMAGE_REF_PATTERN } from "./harness.js";

const A = { sourceKey: "fake-source", externalId: "person-a" };

function sub(externalId: string, enabled = true): HarnessSub {
	return { externalId, enabled };
}

describe("拉取式资料(fetchProfile)", () => {
	it("按钮报过的人:交最后报的那一版,连对象里的引用也一样", async () => {
		const fake = bootFakeSource([sub(A.externalId)]);
		await fake.press("report.profile");
		await fake.press("report.profile");
		const reported = fake
			.reports()
			.filter((one) => one.kind === "profile")
			.at(-1)?.value as CreatorProfileReport;

		const fetched = await fake.fetchProfile(A);
		expect(fetched).toEqual({ ok: true, ...reported });
	});

	it("没报过的人:交确定的拉取版,名字看得出不是按钮的版次", async () => {
		const fake = bootFakeSource([sub(A.externalId)]);
		const fetched = await fake.fetchProfile(A);
		if (!fetched.ok) throw new Error(fetched.message);

		expect(fetched.name).toMatch(/^假名字 · 拉取版\([0-9a-f]{4}\)$/);
		expect(fetched.name).not.toContain("第");
		expect(fetched.avatar).toMatch(IMAGE_REF_PATTERN);
	});

	it("固定记号的人:回 not_found,给宿主记 creator_not_found", async () => {
		const fake = bootFakeSource([sub("fake-0000000000000000-z")]);
		expect(await fake.fetchProfile({ ...A, externalId: "fake-0000000000000000-z" })).toEqual({
			ok: false,
			code: "not_found",
			message: expect.any(String),
		});
	});
});

describe("健康(health)", () => {
	it("人数随来源名单现变:两人、一人、停下后零人", async () => {
		const fake = bootFakeSource([sub("person-a"), sub("person-b")]);
		expect(fake.health()).toEqual({ summary: "在跑 · 管着 2 个人" });

		fake.changeSubscriptions([sub("person-a"), sub("person-b", false)]);
		expect(fake.health()).toEqual({ summary: "在跑 · 管着 1 个人" });

		await fake.stop();
		expect(fake.health()).toEqual({ summary: "在跑 · 管着 0 个人" });
	});
});

it("注册的 def 上故意带着 auth 与 liveInteractions,交给宿主时才会被摘掉", () => {
	const fake = bootFakeSource();
	expect(fake.members()).toEqual(expect.arrayContaining(["auth", "liveInteractions"]));
});
