/**
 * 会员文案的取法(㉓d):按档的 key 取那一档自己的文案与图片,档里没填(缺、或空串)的格用体系默认。
 * 取法是中立的 —— 它不认识任何平台的档怎么叫,所以用例里除了 B 站的 `guard`,还有一个任意 id、任意档 key 的体系
 * (`custom` 体系的地基:档位由主播自定,事件到了才知道有哪一档)。
 * 期望值都是手写的字面量,不照着实现再算一遍。
 */

import { describe, expect, it } from "vite-plus/test";
import { membershipTemplateOf } from "../membership";

const DEFAULT = { template: "{viewer} 成为了 {name} 的{tier}！", imageUrl: "" };

describe("membershipTemplateOf —— 一档的文案与图片", () => {
	it("这一档两格都填了:用它自己的文案与图片", () => {
		const bundle = {
			default: DEFAULT,
			tiers: { captain: { template: "欢迎舰长 {viewer}", imageUrl: "https://img.test/c.png" } },
		};
		expect(membershipTemplateOf(bundle, "captain")).toEqual({
			template: "欢迎舰长 {viewer}",
			imageUrl: "https://img.test/c.png",
		});
	});

	it("这一档没配:整条用体系默认", () => {
		const bundle = { default: DEFAULT, tiers: {} };
		expect(membershipTemplateOf(bundle, "captain")).toEqual(DEFAULT);
	});

	it("只填了文案:图片跟默认;只填了图片:文案跟默认", () => {
		const bundle = {
			default: { template: "默认文案", imageUrl: "https://img.test/default.png" },
			tiers: {
				commander: { template: "提督专属" },
				governor: { imageUrl: "https://img.test/g.png" },
			},
		};
		expect(membershipTemplateOf(bundle, "commander")).toEqual({
			template: "提督专属",
			imageUrl: "https://img.test/default.png",
		});
		expect(membershipTemplateOf(bundle, "governor")).toEqual({
			template: "默认文案",
			imageUrl: "https://img.test/g.png",
		});
	});

	it("空串算没填(跟默认):清空输入框之后不会留下一条空文案", () => {
		const bundle = {
			default: { template: "默认文案", imageUrl: "https://img.test/default.png" },
			tiers: { captain: { template: "", imageUrl: "" } },
		};
		expect(membershipTemplateOf(bundle, "captain")).toEqual({
			template: "默认文案",
			imageUrl: "https://img.test/default.png",
		});
	});

	it("默认的图片也是空串:回空串,由调用方回落该档的徽章", () => {
		const bundle = { default: DEFAULT, tiers: { captain: { template: "x" } } };
		expect(membershipTemplateOf(bundle, "captain").imageUrl).toBe("");
	});

	it("不是 guard 的体系、任意字符串当档 key:按 key 取,取不到用默认", () => {
		// 一个主播自定的体系:档名就是 key,里面什么字符都可能有。
		const bundle = {
			default: { template: "{viewer} 加入了 {name} 的{tier}", imageUrl: "" },
			tiers: {
				"铁粉·月度 2": { template: "铁粉来了:{viewer}", imageUrl: "https://img.test/iron.png" },
			},
		};
		expect(membershipTemplateOf(bundle, "铁粉·月度 2")).toEqual({
			template: "铁粉来了:{viewer}",
			imageUrl: "https://img.test/iron.png",
		});
		expect(membershipTemplateOf(bundle, "没配过的档")).toEqual({
			template: "{viewer} 加入了 {name} 的{tier}",
			imageUrl: "",
		});
	});

	it("档 key 撞上对象原型上的名字(constructor / toString / __proto__):不会取到原型上的东西,按没配处理", () => {
		const bundle = { default: DEFAULT, tiers: { own: { template: "自己的" } } };
		for (const key of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
			expect(membershipTemplateOf(bundle, key), key).toEqual(DEFAULT);
		}
	});

	it("只认档自己的键:原型链上带着同名的一份也不取(档 key 来自事件,不能让原型上的东西顶替配置)", () => {
		const tiers = Object.create({ inherited: { template: "来自原型" } });
		expect(membershipTemplateOf({ default: DEFAULT, tiers }, "inherited")).toEqual(DEFAULT);
	});

	it("档 key 就叫 constructor、而且真配了:取它自己那一份", () => {
		const tiers = Object.fromEntries([["constructor", { template: "构造者专属" }]]);
		expect(membershipTemplateOf({ default: DEFAULT, tiers }, "constructor")).toEqual({
			template: "构造者专属",
			imageUrl: "",
		});
	});

	it("回的是新对象:改它不会改到配置", () => {
		const bundle = { default: DEFAULT, tiers: {} };
		const got = membershipTemplateOf(bundle, "captain");
		got.template = "被改了";
		expect(bundle.default.template).toBe("{viewer} 成为了 {name} 的{tier}！");
	});
});
