/**
 * 单元测试 —— 主人上传的字体文件落盘。
 *
 * 与卡片背景图同一套形态(`<dataDir>/assets/…`、资产 id = 文件名、id 正则是防穿越
 * 的唯一闸门、渲染期解析成 data URL 内联),两处差别是刻意的:
 *
 * 1. **后缀取自文件名,不看浏览器给的 mime**。图片的 mime 各家浏览器都给得准,字体
 *    不然:同一个 .ttf 可能是 `font/ttf`、`application/x-font-ttf`、
 *    `application/octet-stream`,甚至空串。照 mime 判会把一堆正常字体拒在门外。
 * 2. **要记住原始文件名**。背景图有缩略图可看,字体没有 —— 列表里只剩一串 hex 的话
 *    主人根本认不出哪个是哪个。名字存在同目录的 `index.json` 里,而**目录才是真相**:
 *    清单丢了照样列得出字体,只是名字回落成 id。
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import {
	createFontAssetReader,
	deleteFontAsset,
	fontAssetDir,
	isValidFontAssetId,
	listFontAssets,
	MAX_FONT_ASSET_BYTES,
	readFontAsset,
	readFontAssetDataUrl,
	saveFontAsset,
} from "../font-assets";

let dir: string;
/** woff2 magic(`wOF2`)+ 几个字节 —— 这一组只关心字节能不能原样回来。 */
const WOFF2 = new Uint8Array([0x77, 0x4f, 0x46, 0x32, 0x00, 0x01, 0x02, 0x03]);

beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "font-assets-"));
});
afterAll(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("落盘与读回", () => {
	it("存一款 woff2 → id 合法,字节与 mime 都原样回来", async () => {
		const id = await saveFontAsset(dir, WOFF2, "思源黑体.woff2");
		expect(isValidFontAssetId(id)).toBe(true);
		expect(id.endsWith(".woff2")).toBe(true);
		const read = await readFontAsset(dir, id);
		expect(read?.mime).toBe("font/woff2");
		expect(read?.bytes.equals(Buffer.from(WOFF2))).toBe(true);
	});

	it("四种字体后缀都收 —— woff2 / woff / ttf / otf", async () => {
		expect(await saveFontAsset(dir, WOFF2, "a.woff")).toMatch(/\.woff$/);
		expect(await saveFontAsset(dir, WOFF2, "b.ttf")).toMatch(/\.ttf$/);
		expect(await saveFontAsset(dir, WOFF2, "c.otf")).toMatch(/\.otf$/);
	});

	it("后缀认**文件名**,不看 mime —— 浏览器给字体的 mime 一塌糊涂", async () => {
		// 同一个 .ttf 在各家浏览器里可能是 font/ttf、application/x-font-ttf、
		// application/octet-stream 甚至空串。照 mime 判会把正常字体拒在门外。
		const id = await saveFontAsset(dir, WOFF2, "MyFont.TTF");
		expect(id.endsWith(".ttf")).toBe(true);
	});

	it("不认的后缀一律拒 —— 上传目录不是随便放文件的地方", async () => {
		await expect(saveFontAsset(dir, WOFF2, "malware.exe")).rejects.toThrow();
		await expect(saveFontAsset(dir, WOFF2, "无后缀")).rejects.toThrow();
	});

	it("超上限拒掉,报错说得出上限是多少", async () => {
		const tooBig = new Uint8Array(MAX_FONT_ASSET_BYTES + 1);
		await expect(saveFontAsset(dir, tooBig, "huge.ttf")).rejects.toThrow(/20/);
	});
});

describe("id 校验是唯一的防穿越闸门", () => {
	it("挡掉路径穿越与花样 id", () => {
		expect(isValidFontAssetId("../../bn.config.yaml")).toBe(false);
		expect(isValidFontAssetId("/etc/passwd")).toBe(false);
		expect(isValidFontAssetId("abc.woff2")).toBe(false); // 不是 32 位 hex
		expect(isValidFontAssetId(`${"a".repeat(32)}.exe`)).toBe(false);
		expect(isValidFontAssetId(`${"a".repeat(32)}.woff2`)).toBe(true);
	});

	it("非法 id 读不到、删不动(幂等返回 false)", async () => {
		expect(await readFontAsset(dir, "../x")).toBeNull();
		expect(await deleteFontAsset(dir, "../x")).toBe(false);
	});
});

describe("列表带得出原始文件名", () => {
	it("列出来的每一款都带上传时那个名字,中文名也不丢", async () => {
		const fresh = await mkdtemp(join(tmpdir(), "font-list-"));
		const id = await saveFontAsset(fresh, WOFF2, "霞鹜文楷.ttf");
		expect(await listFontAssets(fresh)).toEqual([
			{ id, name: "霞鹜文楷.ttf", size: WOFF2.byteLength },
		]);
		await rm(fresh, { recursive: true, force: true });
	});

	it("清单丢了照样列得出字体,名字回落成 id —— **目录才是真相**", async () => {
		const fresh = await mkdtemp(join(tmpdir(), "font-noman-"));
		const id = await saveFontAsset(fresh, WOFF2, "某字体.otf");
		// 模拟清单被手删 / 卷丢失。
		await rm(join(fontAssetDir(fresh), "index.json"), { force: true });
		expect(await listFontAssets(fresh)).toEqual([{ id, name: id, size: WOFF2.byteLength }]);
		await rm(fresh, { recursive: true, force: true });
	});

	it("清单里躺着一条盘上已经没有的记录 → 不列它,免得选了个不存在的字体", async () => {
		const fresh = await mkdtemp(join(tmpdir(), "font-ghost-"));
		await saveFontAsset(fresh, WOFF2, "在的.ttf");
		const ghost = `${"f".repeat(32)}.ttf`;
		await writeFile(
			join(fontAssetDir(fresh), "index.json"),
			JSON.stringify({ [ghost]: "不在的.ttf" }),
		);
		const listed = await listFontAssets(fresh);
		expect(listed.some((f: { id: string }) => f.id === ghost)).toBe(false);
		await rm(fresh, { recursive: true, force: true });
	});

	it("带上文件大小 —— 设置页据它提醒「这款大到会把出图撑爆」,而不是只在上传那一下说一次", async () => {
		const fresh = await mkdtemp(join(tmpdir(), "font-size-"));
		const id = await saveFontAsset(fresh, WOFF2, "霞鹜文楷.ttf");
		expect(await listFontAssets(fresh)).toEqual([
			{ id, name: "霞鹜文楷.ttf", size: WOFF2.byteLength },
		]);
		await rm(fresh, { recursive: true, force: true });
	});

	it("目录不存在 → 空列表,不抛", async () => {
		expect(await listFontAssets(join(tmpdir(), "font-nope-does-not-exist"))).toEqual([]);
	});
});

/**
 * 名字是**不可信输入**:上传时那一串来自浏览器,清单文件本身也可能被手改或从别处
 * 拷来。皮肤包的原名清单早就按这条线加固过(`skins/asset-names.ts`,当初正是照着
 * 这里的图廊写的),只是没回喂 —— 这一组把两处对齐。
 *
 * 名字唯一的去处是 React 里的一段文本,不进路径也不进 URL,所以这不是注入面;
 * 它守的是**这个功能存在的理由**:让主人认得出哪个是哪个。
 */
describe("清单里的名字是不可信输入", () => {
	it("双向覆盖符剥掉 —— 不然 gnp.exe 能显示成 exe.png", async () => {
		const fresh = await mkdtemp(join(tmpdir(), "font-bidi-"));
		const id = await saveFontAsset(fresh, WOFF2, "bad\u202E2ffow.ttf");
		const [listed] = await listFontAssets(fresh);
		expect(listed?.name).not.toMatch(/[\u202a-\u202e\u2066-\u2069]/);
		expect(listed?.id).toBe(id);
		await rm(fresh, { recursive: true, force: true });
	});

	it("控制字符剥掉", async () => {
		const fresh = await mkdtemp(join(tmpdir(), "font-ctrl-"));
		await saveFontAsset(fresh, WOFF2, "a\u0000b\nc.ttf");
		const [listed] = await listFontAssets(fresh);
		expect(listed?.name).toBe("abc.ttf");
		await rm(fresh, { recursive: true, force: true });
	});

	it("整条路径只留最后一截 —— 主人要看的是文件名,不是他的桌面路径", async () => {
		const fresh = await mkdtemp(join(tmpdir(), "font-path-"));
		await saveFontAsset(fresh, WOFF2, "C:\\Users\\akokko\\Desktop\\wenkai.ttf");
		const [listed] = await listFontAssets(fresh);
		expect(listed?.name).toBe("wenkai.ttf");
		await rm(fresh, { recursive: true, force: true });
	});

	it("超长名字截断 —— 下拉框里没人读得完一百多个字", async () => {
		const fresh = await mkdtemp(join(tmpdir(), "font-long-"));
		await saveFontAsset(fresh, WOFF2, `${"字".repeat(300)}.ttf`);
		const [listed] = await listFontAssets(fresh);
		expect(listed?.name.length).toBeLessThanOrEqual(120);
		await rm(fresh, { recursive: true, force: true });
	});

	it("清单里的值不是字符串 → 丢掉那条,名字回落成 id(而不是让 name 撒谎)", async () => {
		const fresh = await mkdtemp(join(tmpdir(), "font-badval-"));
		const id = await saveFontAsset(fresh, WOFF2, "好.ttf");
		await writeFile(join(fontAssetDir(fresh), "index.json"), JSON.stringify({ [id]: 42 }));
		const [listed] = await listFontAssets(fresh);
		expect(listed?.name).toBe(id);
		await rm(fresh, { recursive: true, force: true });
	});

	it("清单是数组 / 是标量 → 当空表,不抛", async () => {
		for (const bad of ["[]", '"x"', "42", "null"]) {
			const fresh = await mkdtemp(join(tmpdir(), "font-badman-"));
			const id = await saveFontAsset(fresh, WOFF2, "好.ttf");
			await writeFile(join(fontAssetDir(fresh), "index.json"), bad);
			const [listed] = await listFontAssets(fresh);
			expect(listed?.name, bad).toBe(id);
			await rm(fresh, { recursive: true, force: true });
		}
	});
});

describe("删除", () => {
	it("删掉之后文件、列表、清单里都不剩", async () => {
		const fresh = await mkdtemp(join(tmpdir(), "font-del-"));
		const id = await saveFontAsset(fresh, WOFF2, "待删.woff2");
		expect(await deleteFontAsset(fresh, id)).toBe(true);
		expect(await readFontAsset(fresh, id)).toBeNull();
		expect(await listFontAssets(fresh)).toEqual([]);
		// 清单里那条也得抹掉 —— 留着就是个永远对不上的名字,日后 id 复用还会串台。
		const manifest = JSON.parse(await readFile(join(fontAssetDir(fresh), "index.json"), "utf8"));
		expect(manifest).toEqual({});
		await rm(fresh, { recursive: true, force: true });
	});

	it("删一个不存在的 → false,不抛(幂等)", async () => {
		expect(await deleteFontAsset(dir, `${"e".repeat(32)}.woff2`)).toBe(false);
	});
});

describe("渲染期解析成 data URL", () => {
	it("解析得出 data URL,mime 与后缀对得上", async () => {
		const id = await saveFontAsset(dir, WOFF2, "ok.woff2");
		expect(await readFontAssetDataUrl(dir, id)).toMatch(/^data:font\/woff2;base64,/);
	});

	it("空 id / 悬空 id → 空串,让渲染静静回落到家族名那条路", async () => {
		// 出图不该因为「主人把字体删了」而崩 —— 与背景图同一条纪律。
		expect(await readFontAssetDataUrl(dir, "")).toBe("");
		expect(await readFontAssetDataUrl(dir, `${"d".repeat(32)}.woff2`)).toBe("");
		expect(await readFontAssetDataUrl(dir, "../../secret")).toBe("");
	});
});

/**
 * 带缓存的读取器。
 *
 * 一款完整中文字库十几到几十兆,转成 base64 还要再涨三分之一。预览路由那条 mock 路径
 * (live / dyn 用示例数据出图)每来一个请求就从头读一遍盘、再搓一个 26MB 的字符串,而
 * Docker 镜像里 V8 的 old-space 上限被压到 512MB —— 一屏几张卡就能把堆顶起来。
 *
 * 按 **id** 缓存是安全的:资产 id 是随机 32 位 hex,换字体必然换 id,删了再传也是新 id,
 * 所以缓存永远不会喂出过期的内容。只留一条 —— 同一时刻真正在用的通常就一款。
 */
describe("带缓存的字体资产读取器", () => {
	it("同一款字体只读一次盘", async () => {
		let reads = 0;
		const read = async (_d: string, id: string) => {
			reads += 1;
			return `data:font/woff2;base64,${id}`;
		};
		const load = createFontAssetReader(dir, { read });

		expect(await load(`${"a".repeat(32)}.woff2`)).toMatch(/^data:font\/woff2;base64,/);
		await load(`${"a".repeat(32)}.woff2`);
		await load(`${"a".repeat(32)}.woff2`);
		expect(reads).toBe(1);
	});

	it("并发同一款也只读一次 —— 缓存存的是那次读取本身,不是它的结果", async () => {
		let reads = 0;
		const read = async (_d: string, id: string) => {
			reads += 1;
			// 慢一点,让第二个调用一定落在第一个还没读完的窗口里。
			await new Promise((r) => setTimeout(r, 20));
			return `data:font/woff2;base64,${id}`;
		};
		const load = createFontAssetReader(dir, { read });

		const both = await Promise.all([
			load(`${"b".repeat(32)}.woff2`),
			load(`${"b".repeat(32)}.woff2`),
		]);
		expect(reads).toBe(1);
		expect(both[0]).toBe(both[1]);
	});

	it("换一款就换掉缓存,不攒着已经不用的那几十兆", async () => {
		const seen: string[] = [];
		const read = async (_d: string, id: string) => {
			seen.push(id);
			return `data:font/woff2;base64,${id}`;
		};
		const load = createFontAssetReader(dir, { read });

		await load(`${"c".repeat(32)}.woff2`);
		await load(`${"d".repeat(32)}.woff2`);
		// 切回去要重读 —— 只留一条,旧的已经被顶掉了。
		await load(`${"c".repeat(32)}.woff2`);
		expect(seen).toHaveLength(3);
	});

	it("空 id 直接返回空串,连读都不读", async () => {
		let reads = 0;
		const load = createFontAssetReader(dir, {
			read: async () => {
				reads += 1;
				return "x";
			},
		});
		expect(await load("")).toBe("");
		expect(reads).toBe(0);
	});

	it("解析不出来的不进缓存 —— 否则重新传一份同名字体也永远拿不回来", async () => {
		let reads = 0;
		const read = async () => {
			reads += 1;
			// 资产悬空(被删了)时 readFontAssetDataUrl 的约定返回值。
			return "";
		};
		const load = createFontAssetReader(dir, { read });

		expect(await load(`${"e".repeat(32)}.woff2`)).toBe("");
		expect(await load(`${"e".repeat(32)}.woff2`)).toBe("");
		expect(reads).toBe(2);
	});

	it("transform 决定缓存里留什么 —— 渲染那条路留的是拼好的 @font-face", async () => {
		const load = createFontAssetReader(dir, {
			read: async () => "data:font/woff2;base64,AAAA",
			transform: (v) => `@font-face{src:url("${v}")}`,
		});
		expect(await load(`${"g".repeat(32)}.woff2`)).toBe(
			'@font-face{src:url("data:font/woff2;base64,AAAA")}',
		);
	});

	it("transform 只跑一次 —— 这才是它存在的理由,不然每张卡重拼一份几十兆", async () => {
		let transforms = 0;
		const load = createFontAssetReader(dir, {
			read: async () => "data:font/woff2;base64,AAAA",
			transform: (v) => {
				transforms += 1;
				return `@font-face{${v}}`;
			},
		});
		const id = `${"h".repeat(32)}.woff2`;
		await load(id);
		await load(id);
		await load(id);
		expect(transforms).toBe(1);
	});

	it("资产悬空时不跑 transform —— 别拼出一条 src 为空的规则", async () => {
		let transforms = 0;
		const load = createFontAssetReader(dir, {
			read: async () => "",
			transform: (v) => {
				transforms += 1;
				return `@font-face{${v}}`;
			},
		});
		// 空串要原样传下去,渲染器据此回落家族名。
		expect(await load(`${"i".repeat(32)}.woff2`)).toBe("");
		expect(transforms).toBe(0);
	});

	it("闲置超过上限就放掉 —— 主人切回默认字体后,那几十兆不该一直占着堆", async () => {
		let reads = 0;
		let now = 1_000_000;
		const read = async (_d: string, id: string) => {
			reads += 1;
			return `data:font/woff2;base64,${id}`;
		};
		const load = createFontAssetReader(dir, { read, idleMs: 60_000, now: () => now });
		const id = `${"j".repeat(32)}.woff2`;

		await load(id);
		expect(reads).toBe(1);

		// 窗口内:照常命中,别为了省内存把热路径变成每次读盘。
		now += 59_000;
		await load(id);
		expect(reads).toBe(1);

		// 没人再用它了(主人切回默认字体 / 那个 UP 不再推送)。到点就该放掉,
		// 于是下一次要它得重新读 —— 这正是「上一份已经不在堆里」的证据。
		now += 61_000;
		await load(id);
		expect(reads).toBe(2);
	});

	it("不带字体的卡不冲掉缓存 —— 混用时每交替一次就重读一份几十兆更糟", async () => {
		// fontAsset 能按 UP 覆盖,「这个 UP 有字体、那个用默认」是常态。若照
		// 「load('') 就释放」去改,交替渲染就会反复读盘 + 重搓 base64,在 512MB
		// 的堆里是拿一个 OOM 换另一个。释放的触发点是闲置,不是「这张卡没字体」。
		let reads = 0;
		let now = 1_000_000;
		const load = createFontAssetReader(dir, {
			read: async (_d: string, id: string) => {
				reads += 1;
				return `data:font/woff2;base64,${id}`;
			},
			idleMs: 60_000,
			now: () => now,
		});
		const id = `${"k".repeat(32)}.woff2`;

		await load(id);
		now += 1_000;
		expect(await load("")).toBe("");
		now += 1_000;
		await load(id);
		expect(reads).toBe(1);
	});

	it("读盘抛错时不把坏结果焊死在缓存里", async () => {
		let attempt = 0;
		const read = async () => {
			attempt += 1;
			if (attempt === 1) throw new Error("EIO");
			return "data:font/woff2;base64,ok";
		};
		const load = createFontAssetReader(dir, { read });

		await expect(load(`${"f".repeat(32)}.woff2`)).rejects.toThrow("EIO");
		// 下一次要真的重试,而不是把那个 rejected promise 一直抛出来。
		expect(await load(`${"f".repeat(32)}.woff2`)).toBe("data:font/woff2;base64,ok");
	});
});
