/**
 * 聊天里的 `create_skin` 工具 —— 女仆把「做一套皮肤」真的做出来的那一步。
 *
 * 这是**唯一**一个带写能力的聊天工具,所以它的边界都得钉死:一轮对话最多做几套、
 * 入参空了怎么办、生成失败怎么向主人交代、什么时候才允许直接给主人换上。
 *
 * 失败一律 **throw**:执行层会把它翻成 ok:false,界面上那一格就是叉而不是对勾 ——
 * 回一句「失败了」的成功结果,会让主人看着对勾却什么都没多出来。
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtraTool } from "@bilibili-notify/ai";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { type ChatSkinImage, createSkinChatTools, SKIN_MODE_SYSTEM_PROMPT } from "../chat-tool.js";
import { SkinStore } from "../store.js";

const DARK_SKIN = {
	schemaVersion: 1,
	name: "夜航灯",
	description: "青色霓虹的暗色终端",
	modes: { dark: { colors: { accent: "#00e5ff" } } },
};

function genOf(...answers: string[]) {
	let i = 0;
	return vi.fn(async (_s: string, _u: string) => answers[i++] ?? answers.at(-1) ?? "");
}

let store: SkinStore;

beforeEach(async () => {
	store = new SkinStore({ skinsDir: await mkdtemp(join(tmpdir(), "bn-skintool-")) });
	await store.init();
});

/** 数组里的第一把永远是 create_skin;取不到就是装配错了,当场炸给写测试的人看。 */
function firstOf(tools: readonly ExtraTool[]): ExtraTool {
	const [tool] = tools;
	if (!tool) throw new Error("一把工具都没挂上");
	return tool;
}

/** 一次聊天请求配一套工具(预算跟着这一套走)。 */
function toolWith(generateRaw: ReturnType<typeof genOf>) {
	return firstOf(createSkinChatTools({ skinStore: store, generator: () => ({ generateRaw }) }));
}

describe("create_skin 的进度", () => {
	it("设计师吐的字数一路报到执行层 —— 那几分钟里唯一的活口", async () => {
		// 生成一份 skin.json 要几分钟,而工具轮不产生正文:没有这条通道,界面上
		// 那几分钟跟「卡死了」长得一模一样。
		const generateRaw = vi.fn(
			async (_s: string, _u: string, onProgress?: (chars: number) => void) => {
				onProgress?.(120);
				onProgress?.(860);
				return JSON.stringify(DARK_SKIN);
			},
		);
		const tool = firstOf(
			createSkinChatTools({ skinStore: store, generator: () => ({ generateRaw }) }),
		);
		const seen: number[] = [];
		await tool.execute({ brief: "暗色霓虹" }, (chars) => seen.push(chars));
		expect(seen).toEqual([120, 860]);
	});

	it("没人听进度也照做 —— onProgress 是可选的", async () => {
		const tool = toolWith(genOf(JSON.stringify(DARK_SKIN)));
		await expect(tool.execute({ brief: "暗色霓虹" })).resolves.toContain("夜航灯");
	});
});

describe("create_skin 工具定义", () => {
	it("叫 create_skin,收 brief(必填)与 wallpaper / activate(可选)", () => {
		const def = toolWith(genOf()).definition;
		expect(def.function.name).toBe("create_skin");
		const params = def.function.parameters as {
			properties: Record<string, unknown>;
			required: string[];
		};
		expect(Object.keys(params.properties)).toEqual(["brief", "wallpaper", "activate"]);
		expect(params.required).toEqual(["brief"]);
	});

	it("描述里写明「生成要等一会儿」与「一轮最多两套」—— 模型据此收敛", () => {
		const desc = toolWith(genOf()).definition.function.description ?? "";
		expect(desc).toContain("皮肤");
		expect(desc).toMatch(/两套|2 套/);
	});
});

describe("皮肤工坊的 system", () => {
	it("教会模型先查资料再动手 —— 「某部作品风格」靠猜配色做不出来", () => {
		expect(SKIN_MODE_SYSTEM_PROMPT).toContain("web_search");
	});

	it("明说查到的色值要写进 brief —— 设计师那一跳看不见搜索结果", () => {
		// create_skin 内部是**另一趟**无状态调用,只拿到 brief 这一个字符串。
		// 不把这条讲清,模型会「搜完就当自己记住了」,brief 里仍是一句空泛的风格词。
		expect(SKIN_MODE_SYSTEM_PROMPT).toMatch(/写进 brief|填进 brief/);
	});

	it("壁纸只有主人贴图这一条来路 —— 没图就请他贴,别编一张", () => {
		// 真机踩过(2026-08-18):主人要「加雷姆的壁纸」,女仆把它写进 brief 就当
		// 做成了,回话里报了一张根本不存在的壁纸。找图那条路后来整个撤了(主人
		// 拍板:壁纸必须自己上传),所以「我去找一张」同样是编。
		expect(SKIN_MODE_SYSTEM_PROMPT).toContain("壁纸");
		expect(SKIN_MODE_SYSTEM_PROMPT).toMatch(/贴|发给我|发过来/);
		expect(SKIN_MODE_SYSTEM_PROMPT).not.toContain("find_wallpaper");
		expect(SKIN_MODE_SYSTEM_PROMPT).toMatch(/没有.*找图|别去找|不要自己去找/);
	});

	it("交代「你看得见那张图」—— 配色得跟壁纸搭,取色只能靠她自己看", () => {
		// 外层聊天本来就把附件喂给了模型(imageUrls),而嵌套的设计师只看得到
		// brief。她不把图里的主色写下来,壁纸和配色就会各走各的。
		expect(SKIN_MODE_SYSTEM_PROMPT).toMatch(/图里.*色|从图.*取/);
	});

	it("只转述工具返回的东西 —— brief 里写了不等于做出来了", () => {
		expect(SKIN_MODE_SYSTEM_PROMPT).toMatch(/工具没(说|返回)|返回.*之外/);
	});

	it("网页内容只当资料 —— 搜索结果里的指令不作数", () => {
		// 接搜索就是把外部可控文本请进这个窗口,而这里唯一的写工具就是 create_skin。
		// 这条是提示层那道防线,别在重写 system 时顺手删掉。
		expect(SKIN_MODE_SYSTEM_PROMPT).toMatch(/不作数|不要照做|不执行/);
	});
});

describe("create_skin × 主人贴的图", () => {
	const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
	const WALLPAPER_SKIN = {
		schemaVersion: 1,
		name: "夜航灯",
		modes: { dark: { wallpaper: { image: "assets/wallpaper.png", overlay: 0.35 } } },
	};

	function toolWithImage(generateRaw: ReturnType<typeof genOf>, images: ChatSkinImage[]) {
		return firstOf(
			createSkinChatTools({
				skinStore: store,
				generator: () => ({ generateRaw }),
				attachedImages: async () => images,
			}),
		);
	}

	it("wallpaper=true → 主人贴的图进包,设计师也知道有这张图可用", async () => {
		const g = genOf(JSON.stringify(WALLPAPER_SKIN));
		const out = await toolWithImage(g, [{ bytes: PNG, ext: "png" }]).execute({
			brief: "暗色,配这张图",
			wallpaper: "true",
		});

		const [skin] = await store.list();
		expect(skin?.hasWallpaper).toBe(true);
		expect(await store.listAssets(skin?.id ?? "")).toEqual(["assets/wallpaper.png"]);
		// 包里有图这件事必须进 system —— 不说,设计师按「零资产」那条规矩绕开壁纸。
		expect(g.mock.calls[0]?.[0] ?? "").toContain("assets/wallpaper.png");
		expect(out).toMatch(/壁纸/);
	});

	it("没贴图却要壁纸 → 当场拒,别白烧一趟生成", async () => {
		const g = genOf(JSON.stringify(WALLPAPER_SKIN));
		await expect(
			toolWithImage(g, []).execute({ brief: "暗色", wallpaper: "true" }),
		).rejects.toThrow(/贴|发|图/);
		expect(g).not.toHaveBeenCalled();
	});

	it("贴了图但没要壁纸 → 不塞进去(贴图也可能只是给她看看风格)", async () => {
		const g = genOf(JSON.stringify(DARK_SKIN));
		await toolWithImage(g, [{ bytes: PNG, ext: "png" }]).execute({ brief: "暗色" });

		const [skin] = await store.list();
		expect(await store.listAssets(skin?.id ?? "")).toEqual([]);
	});

	it("brief 提了图、又真做了壁纸 → 不再念叨「图没做进去」", async () => {
		const out = await toolWithImage(genOf(JSON.stringify(WALLPAPER_SKIN)), [
			{ bytes: PNG, ext: "png" },
		]).execute({ brief: "暗色,用这张壁纸", wallpaper: "true" });

		expect(out).not.toMatch(/没有做进去|没做进去/);
	});
});

describe("create_skin 执行", () => {
	it("生成成功 → 皮肤真进了库,回话里带皮肤名", async () => {
		const tool = toolWith(genOf(JSON.stringify(DARK_SKIN)));
		const out = await tool.execute({ brief: "赛博朋克,暗色" });

		const list = await store.list();
		expect(list).toHaveLength(1);
		expect(list[0]?.name).toBe("夜航灯");
		expect(out).toContain("夜航灯");
	});

	it("brief 里点了壁纸 → 回话里当场说清「图没做进去」", async () => {
		// 提示层那条纪律靠不住(真机上女仆照样报了一张不存在的壁纸),所以把话
		// 写进**工具返回值** —— 那段文本模型一定会读,也一定会转述给主人。
		const out = await toolWith(genOf(JSON.stringify(DARK_SKIN))).execute({
			brief: "暗色,叠一张雷姆的壁纸做背景",
		});

		expect(out).toMatch(/壁纸|图片/);
		expect(out).toMatch(/没有|做不了|不带/);
	});

	it("brief 没提图片 → 回话不念叨壁纸这回事", async () => {
		const out = await toolWith(genOf(JSON.stringify(DARK_SKIN))).execute({
			brief: "赛博朋克,暗色",
		});

		expect(out).not.toMatch(/壁纸/);
	});

	it("默认**不**替主人换上,回话指路皮肤页", async () => {
		const out = await toolWith(genOf(JSON.stringify(DARK_SKIN))).execute({ brief: "暗色" });

		expect(store.getActive()).toEqual({ light: null, dark: null });
		expect(out).toContain("皮肤");
		expect(out).toMatch(/还没换上|没有换上/);
	});

	it("activate=true → 落进它具备的那个槽,并说清哪个模式下生效", async () => {
		// 入参过执行层时被逐值 String 归一,布尔到手是字符串。
		const out = await toolWith(genOf(JSON.stringify(DARK_SKIN))).execute({
			brief: "暗色",
			activate: "true",
		});

		const active = store.getActive();
		expect(active.dark).not.toBeNull();
		// 只有暗色一套 —— 浅色槽绝不能被顺手占掉。
		expect(active.light).toBeNull();
		expect(out).toContain("暗色");
	});

	it("activate=false → 不换", async () => {
		await toolWith(genOf(JSON.stringify(DARK_SKIN))).execute({ brief: "暗色", activate: "false" });
		expect(store.getActive()).toEqual({ light: null, dark: null });
	});

	it("生成两次都不过 → 抛错,错误里带原因,库里不留半个皮肤", async () => {
		const tool = toolWith(genOf("这不是 JSON", "还是不是"));
		await expect(tool.execute({ brief: "暗色" })).rejects.toThrow(/JSON|校验|失败/);
		expect(await store.list()).toHaveLength(0);
	});

	it("brief 是空白 → 当场拒,不白烧一次生成", async () => {
		const g = genOf(JSON.stringify(DARK_SKIN));
		await expect(toolWith(g).execute({ brief: "   " })).rejects.toThrow();
		expect(g).not.toHaveBeenCalled();
	});

	it("一轮最多两套 —— 第三次不生成,直接拒", async () => {
		const g = genOf(JSON.stringify(DARK_SKIN));
		const tool = toolWith(g);
		await tool.execute({ brief: "一套" });
		await tool.execute({ brief: "两套" });
		await expect(tool.execute({ brief: "三套" })).rejects.toThrow(/两套|上限|够/);

		expect(g).toHaveBeenCalledTimes(2);
		expect(await store.list()).toHaveLength(2);
	});

	it("AI 未就绪(热读口回 null)→ 抛错指路 AI 设置页", async () => {
		const tool = firstOf(createSkinChatTools({ skinStore: store, generator: () => null }));
		await expect(tool.execute({ brief: "暗色" })).rejects.toThrow(/智能女仆|AI/);
	});
});
