/**
 * 卡片皮肤编辑器那口 AI(ADR-0015 决策 3–10、24–26):给**一个框**写 CSS ——
 * 一个块的,或整张卡外框的。
 *
 * 两件事住这儿:
 * - **提示词**。规则一律从清洗器真在执行的常量拼(决策 25 的改正:卡片 CSS 走的是
 *   属性黑名单,不是白名单),上下文只给这个框用得着的(决策 5):整卡轮廓、外框 CSS、
 *   这个框的挂点与现有内容、已声明的旋钮。别的块的 CSS 正文不给,纯占 token。
 * - **一轮生成**。逐条规则往外交(决策 7 的 🔗:预览是停手 400ms 才重渲染整份草稿,
 *   交半条规则只会让预览闪警告);清洗器整份拒收时带着错误重试一次(决策 9)。
 *
 * 框里最后留的是**模型的原文**(剥掉围栏),不是清洗后的版本 —— 清洗器会把它重新
 * 序列化成一行,人没法读。削掉了什么由 warnings 报,与人手写的走同一道门(决策 26)。
 */

import {
	CARD_SKIN_BUILTIN_BLOCKS,
	CARD_SKIN_FRAME_HOOKS,
	CARD_SKIN_LIMITS,
	CARD_SKIN_SELF_HOOK,
	CARD_SKIN_VARIABLES,
	type CardSkinAssetVars,
	type CardSkinKind,
	type CardSkinKnob,
	type CardSkinManifest,
	cardSkinKnobVar,
} from "@bilibili-notify/internal";
import { FORBIDDEN_VALUE, POSITION_VALUES } from "../skins/scoped-css.js";
import {
	CARD_CSS_DENY_PROPS,
	type SanitizeCssResult,
	sanitizeCardBlockCss,
	sanitizeCardFrameCss,
} from "./css-sanitizer.js";

type Card = NonNullable<CardSkinManifest["cards"][CardSkinKind]>;
type Block = Card["blocks"][number];

/** 写哪个框:给了 `blockId` 是那一块,没给是这种卡的外框。 */
export interface CardCssAiTarget {
	kind: CardSkinKind;
	blockId?: string;
}

/**
 * 生成器的最小面。路由那头接的是 `generateRaw(system, user, undefined, stream)`;
 * 单独立一个形状是为了测试不必造一整台引擎。
 */
export type CardCssAiGenerate = (
	system: string,
	user: string,
	stream: { onText: (text: string) => void; signal?: AbortSignal },
) => Promise<string>;

export type CardCssAiResult =
	| { ok: true; css: string; warnings: string[] }
	| { ok: false; errors: string[] };

/**
 * 写卡片 CSS 的规矩 —— 选择器、属性与值、能用的变量。编辑器那口与工坊那口**共用这一段**
 * (决策 25:规矩从清洗器真在执行的常量拼,两份提示词各抄一遍就会各漂各的)。
 *
 * `where` 说旋钮与包内图片的清单在哪:编辑器那口拼在用户消息里,工坊那口要模型自己去读。
 */
export function cardCssRules(where: string): string {
	const vars = Object.values(CARD_SKIN_VARIABLES)
		.map((v) => `  - \`${v.css}\`:${v.label}`)
		.join("\n");
	return `## 选择器
- 块的 CSS 以 \`[data-bn="${CARD_SKIN_SELF_HOOK}"]\`(这块自己)或这块的内部挂点起头;外框的 CSS 以 ${Object.keys(
		CARD_SKIN_FRAME_HOOKS,
	)
		.map((h) => `\`[data-bn="${h}"]\``)
		.join(" 或 ")} 起头。
- 不以挂点起头的选择器会被自动补上前缀、收进这个框里,所以 class、标签、伪类(:is / :has / :not / :first-child…)、::before / ::after 都能写。
- 只准用给你的那几个挂点;别的挂点属于别的块,写了整条规则被丢。
- 挂点后面不能接 \`+\` 或 \`~\`,那会摸到别的块。

## 属性与值
- 属性基本都能写(布局、间距、字号、背景、边框、阴影、滤镜……),只有这几个不收:${[...CARD_CSS_DENY_PROPS].join(" / ")}。
- 值里不准出现 ${FORBIDDEN_VALUE.join(" / ")}。图一律走下面的变量,别写 url()。
- 不准用反斜杠转义;\`!important\` 会被摘掉。
- position 只能是 ${[...POSITION_VALUES].join(" / ")}。
- at 规则只收 @media;@import、@font-face、@keyframes 都不收。
- 每段 CSS 不超过 ${CARD_SKIN_LIMITS.maxCssBytes} 字节(UTF-8)。

## 能用的变量
- **旋钮**:皮肤作者声明的可调项,只能引用、不能新增。写成 \`var(--bn-knob-<key>, <兜底值>)\`,兜底值必须写 —— 用户没拧过的旋钮不会注入。有哪几枚${where}。
- 半透明色写 \`color-mix(in srgb, var(--bn-knob-x, #hex) 35%, transparent)\`,rgba() 读不了变量。
- 宿主注入的变量:
${vars}
- **包内图片**:\`var(--bn-asset-<名>)\`,值是一整层 url,可以直接放进 background;有哪些${where}。`;
}

/** 与框无关的那半:这张卡是什么、选择器怎么写、清洗器收什么。 */
export function buildCardCssAiSystem(): string {
	return `你给 B 站推送卡片的皮肤写 CSS,每次只写**一个框**:一个块的 CSS,或整张卡外框的 CSS。

## 这张卡是什么
- 卡片由服务端用 Chromium 渲染成一张**静态 PNG**:没有鼠标、没有动画。:hover、:focus、transition、animation 写了也画不出来,别写。
- 卡片是网格排版,块在网格里的位置由编辑器定,不归这段 CSS 管;CSS 管的是这个框长什么样、里面怎么排。

${cardCssRules("见用户消息")}

## 输出
- 只输出 CSS 本身:不要解释,不要代码块围栏。
- 你的输出会**整段替换**这个框里现有的 CSS:用户没要求改的规则原样保留。
- 一条规则写完再写下一条。`;
}

export type PreparedCardCssAi =
	| {
			ok: true;
			/** 用户消息:框的上下文 + 用户那句话。 */
			user: (instruction: string) => string;
			/** 这个框该过的那道门(挂点表按框定)。 */
			sanitize: (css: string) => SanitizeCssResult;
	  }
	| { ok: false; error: string };

/** 与框有关的那半。卡种没接管、块不存在时说清楚,不硬拼。 */
export function prepareCardCssAi(
	manifest: CardSkinManifest,
	target: CardCssAiTarget,
): PreparedCardCssAi {
	const card = manifest.cards[target.kind];
	if (!card) {
		return { ok: false, error: `这套皮肤还没接管 ${target.kind} 卡,先在编辑器里接管再写` };
	}
	const block =
		target.blockId === undefined ? undefined : card.blocks.find((b) => b.id === target.blockId);
	if (target.blockId !== undefined && !block) {
		return { ok: false, error: `${target.kind} 卡里没有 id 为「${target.blockId}」的块` };
	}

	const sections: string[] = [];
	if (block) {
		const hooks: Array<[string, string]> = [[CARD_SKIN_SELF_HOOK, "这块自己"]];
		if (block.kind === "builtin") {
			hooks.push(
				...Object.entries(CARD_SKIN_BUILTIN_BLOCKS[target.kind][block.builtin]?.hooks ?? {}),
			);
		}
		sections.push(
			`## 要写的框\n${target.kind} 卡里的「${blockLabel(target.kind, block)}」块(id: ${block.id})`,
			`### 能用的挂点\n${hookLines(hooks)}`,
			`### 它现在的 CSS\n${fenced("css", block.css)}`,
		);
		if (block.kind === "custom") {
			sections.push(`### 这块的 HTML(只读)\n${fenced("html", block.html)}`);
		}
	} else {
		sections.push(
			`## 要写的框\n${target.kind} 卡的外框`,
			`### 能用的挂点\n${hookLines(Object.entries(CARD_SKIN_FRAME_HOOKS))}`,
			`### 它现在的 CSS\n${fenced("css", card.css)}`,
		);
	}

	sections.push(
		`## 整张卡\n- 卡宽 ${card.width}px\n- 块(按行排):\n${outline(target.kind, card, block)}`,
	);
	if (block) sections.push(`### 外框 CSS(只读)\n${fenced("css", card.css)}`);
	sections.push(`## 旋钮(只读)\n${knobLines(manifest.knobs ?? [])}`);
	const assets = { ...card.assets, ...(block?.assets ?? {}) };
	sections.push(`## 包内图片\n${assetLines(assets)}`);

	const context = sections.join("\n\n");
	const sanitize = block
		? (css: string) =>
				sanitizeCardBlockCss(css, {
					kind: target.kind,
					...(block.kind === "builtin" ? { builtin: block.builtin } : {}),
				})
		: sanitizeCardFrameCss;
	return {
		ok: true,
		user: (instruction) => `${context}\n\n## 用户的要求\n${instruction}`,
		sanitize,
	};
}

export function blockLabel(kind: CardSkinKind, block: Block): string {
	if (block.kind === "custom") return "自定义块";
	return CARD_SKIN_BUILTIN_BLOCKS[kind][block.builtin]?.label ?? block.builtin;
}

export function hookLines(hooks: ReadonlyArray<readonly [string, string]>): string {
	return hooks.map(([hook, label]) => `- \`[data-bn="${hook}"]\`:${label}`).join("\n");
}

export function fenced(lang: string, body: string | undefined): string {
	return body?.trim() ? `\`\`\`${lang}\n${body}\n\`\`\`` : "(空)";
}

function outline(kind: CardSkinKind, card: Card, target: Block | undefined): string {
	return [...card.blocks]
		.sort((a, b) => a.grid.row - b.grid.row || a.grid.column - b.grid.column)
		.map((b) => {
			const g = b.grid;
			const where = [
				`第 ${g.row} 行`,
				`第 ${g.column} 列起跨 ${g.span} 列`,
				...(g.rowSpan ? [`跨 ${g.rowSpan} 行`] : []),
			].join(",");
			const when = b.showIf ? `,字段 ${b.showIf} 为空时整块不出现` : "";
			const mark = b === target ? "  ← 就是这块" : "";
			return `  - ${b.id}:${blockLabel(kind, b)}(${where}${when})${mark}`;
		})
		.join("\n");
}

const KNOB_TYPE_LABEL: Record<CardSkinKnob["type"], string> = {
	color: "颜色",
	number: "数值",
	select: "下拉",
	switch: "开关",
	font: "字体,值是一串 font-family",
	image: "图片,值是一整层 url,放进 background",
};

/** 兜底值就是作者给的默认;图没有默认,字体默认可以是空串。 */
function knobFallback(knob: CardSkinKnob): string {
	switch (knob.type) {
		case "number":
			return `${knob.default}${knob.unit ?? ""}`;
		case "switch":
			return knob.default ? knob.on : knob.off;
		case "font":
			return knob.default || "inherit";
		case "image":
			return "none";
		default:
			return knob.default;
	}
}

export function knobLines(knobs: readonly CardSkinKnob[]): string {
	if (knobs.length === 0) return "(这套皮肤没有声明旋钮)";
	return knobs
		.map(
			(k) =>
				`- ${k.label}(${KNOB_TYPE_LABEL[k.type]}):\`var(${cardSkinKnobVar(k.key)}, ${knobFallback(k)})\``,
		)
		.join("\n");
}

function assetLines(assets: CardSkinAssetVars): string {
	const names = Object.keys(assets);
	if (names.length === 0) return "(没有)";
	return names.map((name) => `- \`var(--bn-asset-${name})\``).join("\n");
}

// ---- 一轮生成 -----------------------------------------------------------------

/** 以 \`\`\` 起头的整行是模型爱加的代码围栏,剥掉。 */
const FENCE_LINE = /^\s*```/;

/**
 * 剥围栏。`final=false` 时末尾那行还没写完,若它**可能**是围栏(空白或反引号起头)
 * 就先扣下 —— 等它写完再定;这样结果对前缀是单调的,已经交出去的规则不会被推翻。
 */
function stripFences(raw: string, final: boolean): string {
	const lines = raw.split("\n");
	const tail = final ? undefined : lines.pop();
	const kept = lines.filter((l) => !FENCE_LINE.test(l)).map((l) => `${l}\n`);
	if (tail !== undefined && !/^\s*`*$/.test(tail) && !FENCE_LINE.test(tail)) kept.push(tail);
	return kept.join("");
}

/**
 * 逐条规则往外交:扫到**顶层**的 `}` 就交一段。字符串与注释里的花括号不算。
 *
 * 每次都从上次交到的位置重扫 —— 那个位置恒在顶层、不在字符串或注释里,所以被切在
 * 两片之间的 `/*`、引号不会让状态错位。
 */
function createRuleSplitter(onRule: (text: string) => void) {
	let raw = "";
	let pos = 0;
	let first = true;

	const scan = (clean: string) => {
		let depth = 0;
		let quote: string | null = null;
		let comment = false;
		for (let i = pos; i < clean.length; i++) {
			const c = clean[i];
			if (comment) {
				if (c === "*" && clean[i + 1] === "/") {
					comment = false;
					i++;
				}
			} else if (quote) {
				if (c === "\\") i++;
				else if (c === quote) quote = null;
			} else if (c === "/" && clean[i + 1] === "*") {
				comment = true;
				i++;
			} else if (c === '"' || c === "'") {
				quote = c;
			} else if (c === "{") {
				depth++;
			} else if (c === "}") {
				depth = Math.max(0, depth - 1);
				if (depth === 0) {
					const segment = clean.slice(pos, i + 1);
					pos = i + 1;
					onRule(first ? segment.trimStart() : segment);
					first = false;
				}
			}
		}
	};

	return {
		push(delta: string) {
			raw += delta;
			scan(stripFences(raw, false));
		},
		/** 收尾:以生成器交回的全文为准,补交剩下的整条规则,回框里该留的那份。 */
		finish(full: string): string {
			raw = full;
			const clean = stripFences(raw, true);
			scan(clean);
			return clean.trim();
		},
	};
}

/**
 * 一轮「生成 → 清洗器判 → 没过就带着错误重试一次」。二败报错,不试第三次 ——
 * 再试就是在替用户烧他自己的 key(与 dashboard 的 `runSkinAiRound` 同一条纪律)。
 *
 * 取消原样抛出:那不是「没写好」,重试它等于无视用户点的「停」。
 */
export async function runCardCssAiRound(input: {
	generate: CardCssAiGenerate;
	system: string;
	user: string;
	sanitize: (css: string) => SanitizeCssResult;
	/** 写完的一整条规则。两趟各交各的;重试前会先收到 {@link onRetry}。 */
	onRule: (text: string) => void;
	/** 第一趟没过、要重来了 —— 前端据此把框退回动手前的样子。 */
	onRetry?: (errors: string[]) => void;
	signal?: AbortSignal;
}): Promise<CardCssAiResult> {
	const attempt = async (user: string) => {
		const splitter = createRuleSplitter(input.onRule);
		const raw = await input.generate(input.system, user, {
			onText: (t) => splitter.push(t),
			signal: input.signal,
		});
		const css = splitter.finish(raw);
		const judged: SanitizeCssResult =
			css === "" ? { ok: false, errors: ["输出是空的"] } : input.sanitize(css);
		return { raw, css, judged };
	};

	const first = await attempt(input.user);
	if (first.judged.ok) return { ok: true, css: first.css, warnings: first.judged.warnings };

	input.onRetry?.(first.judged.errors);
	const retryUser = `${input.user}\n\n你上次的输出没过清洗器:\n${first.judged.errors
		.map((e) => `- ${e}`)
		.join("\n")}\n\n上次的输出:\n${first.raw}\n\n请修正后重新输出这个框的完整 CSS,仍然只输出 CSS。`;
	const second = await attempt(retryUser);
	return second.judged.ok
		? { ok: true, css: second.css, warnings: second.judged.warnings }
		: { ok: false, errors: second.judged.errors };
}
