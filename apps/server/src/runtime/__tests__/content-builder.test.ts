/**
 * 单元测试 — `standaloneContentBuilder` + `segmentToPayload`(独立端直播 payload 段构造)。
 *
 * 守护契约:
 *   - builder factory:text / image(string→url, Buffer→buf+默认 mime) / atAll / message(过滤 null)
 *   - segmentToPayload:null→[];string 空→[],非空→[text];text 空→[],非空→[text];
 *     image-url→[link];image-buf→[image];atAll→[text "@全体成员 "];
 *     message→递归 flatMap 展平嵌套
 */

import type { PayloadSegment } from "@bilibili-notify/internal";
import { describe, expect, it } from "vitest";
import {
	type SegmentValue,
	segmentToPayload,
	standaloneContentBuilder,
} from "../content-builder.js";

const B = standaloneContentBuilder;

describe("standaloneContentBuilder — factory", () => {
	it("text / atAll", () => {
		expect(B.text("hi")).toEqual({ kind: "text", text: "hi" });
		expect(B.atAll()).toEqual({ kind: "atAll" });
	});

	it("image:string → image-url;Buffer → image-buf(默认 mime image/jpeg)", () => {
		expect(B.image("http://x/a.png")).toEqual({ kind: "image-url", url: "http://x/a.png" });
		const buf = Buffer.from("X");
		expect(B.image(buf)).toEqual({ kind: "image-buf", buffer: buf, mime: "image/jpeg" });
		expect(B.image(buf, "image/png")).toEqual({
			kind: "image-buf",
			buffer: buf,
			mime: "image/png",
		});
	});

	it("message:过滤 null/undefined 段", () => {
		const seg = B.message([B.text("a"), null, undefined, B.atAll()]);
		expect(seg).toEqual({
			kind: "message",
			segments: [{ kind: "text", text: "a" }, { kind: "atAll" }],
		});
	});
});

describe("segmentToPayload — 解码", () => {
	it("null / undefined → []", () => {
		expect(segmentToPayload(null)).toEqual([]);
		expect(segmentToPayload(undefined)).toEqual([]);
	});

	it("string:空 → [],非空 → [text]", () => {
		expect(segmentToPayload("")).toEqual([]);
		expect(segmentToPayload("hello")).toEqual([{ type: "text", text: "hello" }]);
	});

	it("text 段:空文本丢弃,非空保留", () => {
		expect(segmentToPayload({ kind: "text", text: "" })).toEqual([]);
		expect(segmentToPayload({ kind: "text", text: "x" })).toEqual([{ type: "text", text: "x" }]);
	});

	it("image-url → link;image-buf → image;atAll → @全体成员 文本", () => {
		expect(segmentToPayload({ kind: "image-url", url: "http://x" })).toEqual([
			{ type: "link", href: "http://x" },
		]);
		const buf = Buffer.from("Z");
		expect(segmentToPayload({ kind: "image-buf", buffer: buf, mime: "image/png" })).toEqual([
			{ type: "image", buffer: buf, mime: "image/png" },
		]);
		expect(segmentToPayload({ kind: "atAll" })).toEqual([{ type: "text", text: "@全体成员 " }]);
	});

	it("message:递归 flatMap 展平嵌套,空文本沿途丢弃", () => {
		const tree: SegmentValue = {
			kind: "message",
			segments: [
				{ kind: "text", text: "a" },
				{ kind: "text", text: "" }, // 丢弃
				{
					kind: "message",
					segments: [{ kind: "image-url", url: "http://i" }, { kind: "atAll" }],
				},
			],
		};
		const out: PayloadSegment[] = segmentToPayload(tree);
		expect(out).toEqual([
			{ type: "text", text: "a" },
			{ type: "link", href: "http://i" },
			{ type: "text", text: "@全体成员 " },
		]);
	});
});
