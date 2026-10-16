import { describe, expect, it } from "vite-plus/test";
import { stripHtmlTags } from "../strip-html-tags.js";

describe("stripHtmlTags", () => {
	it("去掉 B 站搜索结果里包关键词的高亮标签,文字原样留着", () => {
		expect(stripHtmlTags('咩<em class="keyword">栗</em>酱')).toBe("咩栗酱");
		expect(stripHtmlTags("没有标签")).toBe("没有标签");
	});
});
