/**
 * 字体选择的纯操作。
 *
 * 这一组守的核心是**两个字段只能有一个说了算**:`fontAsset`(上传的字体文件)一旦设着
 * 就优先于 `font`(家族名)。所以从「自己上传的那款」切回默认 / 手填时,必须把
 * `fontAsset` **清掉** —— 留着的话选择器显示的是手填那档,出图用的却还是上传那款,
 * 而两边都看不出哪里不对。这正是本仓库反复复发的那类「切了没生效 / 关不掉」。
 */

import { FONT_ASSET_WARN_BYTES } from "@bilibili-notify/internal/constants";
import { describe, expect, it } from "vite-plus/test";
import {
	fontSelection,
	fontSizeWarning,
	pickDefaultFont,
	pickFamilyFont,
	pickUploadedFont,
	removeFontFromStyle,
} from "../font-ops";

const UPLOADED = `${"a".repeat(32)}.woff2`;
const OTHER = `${"b".repeat(32)}.ttf`;

describe("当前选中的是哪一档", () => {
	it("什么都没设 → 默认(系统兜底)", () => {
		expect(fontSelection({ font: "" }, [])).toEqual({ kind: "default" });
	});

	it("镜像自带的 Noto 也只是个普通家族名 → 手填那一档,不再单列", () => {
		// 曾经给它单开过一档「内置」,但那是 Docker 镜像塞进去的字体 —— 桌面版出图用的
		// 是主人自己机器上的 Chrome,Win/mac 默认没有 Noto CJK,单列它只会骗人。
		expect(fontSelection({ font: "Noto Sans CJK SC" }, [])).toEqual({
			kind: "custom",
			family: "Noto Sans CJK SC",
		});
	});

	it("设了字体资产 → 上传那一档,且**盖过**家族名", () => {
		// 两个字段同时有值是常态(切到上传款时家族名留着当兜底),优先级不能含糊。
		const got = fontSelection({ font: "某家族名", fontAsset: UPLOADED }, [UPLOADED]);
		expect(got).toEqual({ kind: "uploaded", id: UPLOADED });
	});

	it("资产指向一款已经不在图廊里的字体 → 报成失效,而不是装作没事", () => {
		// 悄悄回落的话:选择器显示「默认」,出图也确实是默认 —— 但主人明明选过一款,
		// 界面上却再没有任何入口告诉他那款没了。
		expect(fontSelection({ font: "", fontAsset: UPLOADED }, [OTHER])).toEqual({
			kind: "missing",
			id: UPLOADED,
		});
	});

	it("图廊还没加载完(传 null)→ 不判失效,免得加载中闪一下「已失效」", () => {
		expect(fontSelection({ font: "", fontAsset: UPLOADED }, null)).toEqual({
			kind: "uploaded",
			id: UPLOADED,
		});
	});

	it("家族名是主人自己写的 → 手填那一档", () => {
		expect(fontSelection({ font: "我的字体" }, [])).toEqual({ kind: "custom", family: "我的字体" });
	});

	it("老配置里那种逗号列表 → 也是手填那一档,原样显示给主人看", () => {
		// 出厂默认值就长这样。不能把它硬塞进某个内置档里冒充,那等于替主人改了配置。
		const got = fontSelection({ font: "PingFang SC, sans-serif" }, []);
		expect(got).toEqual({ kind: "custom", family: "PingFang SC, sans-serif" });
	});
});

describe("切档", () => {
	it("切到上传那款 → 记下资产 id,家族名留着当兜底(哪天文件没了还有的落)", () => {
		const got = pickUploadedFont({ font: "原来的" }, UPLOADED);
		expect(got).toEqual({ font: "原来的", fontAsset: UPLOADED });
	});

	it("从上传款切到手填的家族名 → **资产必须清掉**,否则填了没反应", () => {
		const got = pickFamilyFont({ font: "旧的", fontAsset: UPLOADED }, "PingFang SC");
		expect(got.font).toBe("PingFang SC");
		expect(got.fontAsset).toBeUndefined();
	});

	it("从上传款切回默认 → 资产同样清掉,家族名也清空", () => {
		const got = pickDefaultFont({ font: "旧的", fontAsset: UPLOADED });
		expect(got).toEqual({ font: "" });
	});
});

describe("删盘之后的悬空清扫", () => {
	it("样式里选着这款 → 清掉,别让悬空 id 跟着落盘", () => {
		expect(removeFontFromStyle({ font: "兜底", fontAsset: UPLOADED }, UPLOADED)).toEqual({
			font: "兜底",
		});
	});

	it("选的是别款 → 一个字不动", () => {
		const style = { font: "兜底", fontAsset: OTHER };
		expect(removeFontFromStyle(style, UPLOADED)).toEqual(style);
	});

	it("压根没选字体的样式 → 原样返回,不平白多出一个 fontAsset 键", () => {
		const style: { cardColorStart: string; fontAsset?: string } = { cardColorStart: "#fff" };
		const got = removeFontFromStyle(style, UPLOADED);
		expect(got).toEqual(style);
		expect("fontAsset" in got).toBe(false);
	});
});

/**
 * 上传大字体的提醒。
 *
 * 单款上限是 20MB,但那个上限是按「字体文件本身多大」定的,没算出图时的开销:
 * 一款 ttf 会被 base64 内联进渲染 HTML(再涨三分之一),而 Docker 镜像里 V8 的堆上限
 * 只有 512MB。真有人传了 20MB 的 ttf 之后卡片就渲染不出来了。
 *
 * 所以**不降上限**(降了会把已经传上去的那款拒之门外),改成传完就直说:这么大在容器里
 * 悬,同一套字转 woff2 通常只占三分之一。
 */
describe("大字体提醒", () => {
	it("超过阈值 → 提醒换 woff2,并说出它实际多大", () => {
		const msg = fontSizeWarning(12.5 * 1024 * 1024);
		expect(msg).toMatch(/12\.5\s*MB/);
		expect(msg).toMatch(/woff2/);
	});

	it("阈值以内不吵 —— 正常大小的 woff2 不该每次上传都被念一遍", () => {
		expect(fontSizeWarning(3 * 1024 * 1024)).toBeNull();
		expect(fontSizeWarning(0)).toBeNull();
	});

	it("正好等于阈值不吵 —— 边界归「没超」那一侧", () => {
		expect(fontSizeWarning(FONT_ASSET_WARN_BYTES)).toBeNull();
		expect(fontSizeWarning(FONT_ASSET_WARN_BYTES + 1)).not.toBeNull();
	});
});
