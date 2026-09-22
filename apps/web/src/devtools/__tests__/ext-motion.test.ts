// @vitest-environment jsdom
/**
 * 「播放安装动画 / 播放更新动画」—— 不装东西,只往 `card-motion` 那一格里放一段,页面照着演。
 *
 * 动画本身只能靠眼睛看(jsdom 没有 Web Animations API),这里钉的是**放进去的那一段对不对**:
 * 演哪张卡、从哪儿起飞;以及页上没卡 / 没这张卡时只回一句话、那一格原样不动 —— 放一段
 * 找不到落点的动画进去,演的那头会干等到超时,看起来就是「按了没反应」。
 */

import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { EXT_UPDATE_BUTTON, useCardMotionStore } from "../../pages/extensions/card-motion";
import { EXT_CARD_ANCHOR } from "../../pages/extensions/install-flight";
import { WEB_SCENARIOS } from "../web-scenarios";

function scenario(id: string) {
	const s = WEB_SCENARIOS.find((x) => x.id === id);
	if (!s) throw new Error(`no ${id}`);
	return s;
}

const qc = new QueryClient();

function rect(left: number, top: number, width: number, height: number): DOMRect {
	return {
		left,
		top,
		width,
		height,
		x: left,
		y: top,
		right: left + width,
		bottom: top + height,
		toJSON: () => ({}),
	};
}

/** 页上摆一张已装卡片(与拓展页同一个锚点属性),量出来是给定的那个框。 */
function card(id: string, box = rect(40, 60, 360, 220)): HTMLElement {
	const el = document.createElement("div");
	el.setAttribute(EXT_CARD_ANCHOR, id);
	el.getBoundingClientRect = () => box;
	document.body.appendChild(el);
	return el;
}

/** 卡上那颗「更新」钮(有新版时才画)。 */
function updateButton(into: HTMLElement, box: DOMRect): HTMLButtonElement {
	const btn = document.createElement("button");
	btn.textContent = "更新";
	btn.setAttribute(EXT_UPDATE_BUTTON, "");
	btn.getBoundingClientRect = () => box;
	into.appendChild(btn);
	return btn;
}

const motion = () => useCardMotionStore.getState().motion;

beforeEach(() => {
	document.body.innerHTML = "";
	useCardMotionStore.setState({ motion: null });
});

describe("web.ext-install-motion", () => {
	const run = (params: Record<string, string>) =>
		scenario("web.ext-install-motion").run(params, { qc });

	it("指名一张卡:演那张;起点是一张卡那么大、在视口底部居中的框", () => {
		card("first");
		card("bridge", rect(500, 100, 360, 220));
		run({ id: "bridge" });

		const m = motion();
		expect(m?.kind).toBe("install");
		expect(m?.id).toBe("bridge");
		const from = m?.from;
		if (!from) throw new Error("安装那一段必须有起点");
		// 卡那么大(真的起点是市场里那张卡,与已装的这张同一身材)。
		expect([from.width, from.height]).toEqual([360, 220]);
		// 水平居中,贴着视口底部但整个在视口里。
		expect(from.left + from.width / 2).toBe(window.innerWidth / 2);
		expect(from.top + from.height).toBeLessThanOrEqual(window.innerHeight);
		expect(from.top).toBeGreaterThan(window.innerHeight / 2);
	});

	it("id 留空:演页上第一张", () => {
		card("first");
		card("second");
		run({ id: "" });
		expect(motion()).toMatchObject({ kind: "install", id: "first" });
	});

	it("量不出卡的身材(还没排版)也照样给一个看得见的起点", () => {
		card("bridge", rect(0, 0, 0, 0));
		run({ id: "bridge" });
		const from = motion()?.from;
		expect(from?.width).toBeGreaterThan(0);
		expect(from?.height).toBeGreaterThan(0);
	});
});

describe("web.ext-update-motion", () => {
	// 蓄 0 秒:这几条看的是「演哪张卡、从哪儿起飞」,不等那一段。
	const run = (params: Record<string, string | number>) =>
		scenario("web.ext-update-motion").run({ charge: 0, ...params }, { qc });

	it("卡上画着「更新」钮:从那颗钮起飞", () => {
		const el = card("bridge");
		const btn = rect(300, 180, 52, 28);
		updateButton(el, btn);
		run({ id: "bridge" });
		expect(motion()).toMatchObject({ kind: "update", id: "bridge", from: btn });
	});

	it("卡上没有「更新」钮(没有新版):不给起点 —— 球从卡片上方落下来", () => {
		const el = card("bridge");
		const other = document.createElement("button");
		other.textContent = "管理";
		other.getBoundingClientRect = () => rect(1, 2, 3, 4);
		el.appendChild(other);
		run({ id: "" });

		const m = motion();
		expect(m).toMatchObject({ kind: "update", id: "bridge" });
		expect(m?.from).toBeUndefined();
	});

	it("量的是**这张卡里**那颗钮,不是页上随便哪张卡的", () => {
		const first = card("first");
		updateButton(first, rect(10, 10, 52, 28));
		card("bridge");
		run({ id: "bridge" });
		expect(motion()).toMatchObject({ kind: "update", id: "bridge" });
		expect(motion()?.from).toBeUndefined();
	});

	/**
	 * 真更新的那段换装一直「蓄」到装完;这里没有真的装,所以假装装了几秒再落定。结果也能挑:
	 * 没装成那一版(光环淡出、不爆)同样得看得见。
	 */
	it("蓄几秒、落成什么都照参数:默认装成了", async () => {
		card("bridge");
		run({ id: "bridge", charge: 0.05 });
		const m = motion();
		if (m?.kind !== "update") throw new Error("应该是一段换装");
		const started = Date.now();
		await expect(m.outcome).resolves.toBe(true);
		expect(Date.now() - started).toBeGreaterThanOrEqual(40);
	});

	it("结果挑「没装成」→ 那一段落定成没装成", async () => {
		card("bridge");
		run({ id: "bridge", result: "failed" });
		const m = motion();
		if (m?.kind !== "update") throw new Error("应该是一段换装");
		await expect(m.outcome).resolves.toBe(false);
	});
});

describe.each(["web.ext-install-motion", "web.ext-update-motion"])("%s · 找不到卡", (id) => {
	it("页上一张卡都没有(不在拓展页):只回一句去打开拓展页,那一格不动", () => {
		const out = scenario(id).run({ id: "" }, { qc });
		expect(out).toMatch(/拓展/);
		expect(out).toMatch(/打开/);
		expect(motion()).toBeNull();
	});

	it("指名的 id 不在页上:说是哪一个、页上有哪些,那一格不动", () => {
		card("bridge");
		card("other");
		const out = scenario(id).run({ id: "ghost" }, { qc });
		expect(out).toContain("ghost");
		expect(out).toContain("bridge");
		expect(motion()).toBeNull();
	});
});
