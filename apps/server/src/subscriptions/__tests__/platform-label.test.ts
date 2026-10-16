import { describe, expect, it } from "vite-plus/test";
import { platformLabelOf } from "../platform-label.js";

/** 来源登记表里各键的描述符 `label`;拓展装载器说的平台名另给。 */
function depsWith(labels: Record<string, string>, extensionLabels: Record<string, string> = {}) {
	return {
		sources: {
			get: (key: string) =>
				labels[key] === undefined ? undefined : { descriptor: { label: labels[key] as string } },
		},
		extensionPlatformLabel: (id: string) => extensionLabels[id],
	};
}

describe("platformLabelOf —— 订阅所属平台的叫法", () => {
	// 验红:把函数改成只问拓展装载器,第一条(登记表里的假来源)读到键名,红。
	it("在来源登记表里的来源:读描述符的 label,先于拓展装载器", () => {
		const deps = depsWith(
			{ bilibili: "B 站", "acme.inprocess": "对拍源" },
			{ "acme.inprocess": "装载器说的" },
		);
		expect(platformLabelOf("bilibili", deps)).toBe("B 站");
		expect(platformLabelOf("acme.inprocess", deps)).toBe("对拍源");
	});

	it("不在登记表里的(拓展):装载器说的平台名;取不到(拓展卸了、装载器没起来)写键名", () => {
		expect(platformLabelOf("douyin", depsWith({}, { douyin: "抖音" }))).toBe("抖音");
		expect(platformLabelOf("douyin", depsWith({}))).toBe("douyin");
		expect(platformLabelOf("douyin", { sources: depsWith({}).sources })).toBe("douyin");
	});
});
