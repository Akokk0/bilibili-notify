/**
 * 直播拆键(⑬d):0.x 的 `live` 一把开关同时管开播、周期「正在直播」与重启补报;1.0 拆成 `liveStart` / `liveStreaming`
 * 两把特性(各有开关与目标),周期间隔与重启补报各是自己的一段设置。接在 0.x 那一遍与 1.0 改名({@link
 * renameGlobalSettingsKeys} / {@link renameSubscriptionKeys},`feature-renames.ts`)之后、同一族里串着跑:
 *
 * | 0.x(改名之后的形状) | 1.0 |
 * | --- | --- |
 * | `defaults.features.liveStart`(原 `live`)、`defaults.schedule.pushTime` | `defaults.features.liveStreaming` = 开播开着 且 `pushTime > 0` |
 * | `defaults.schedule.pushTime`(0 = 关,1–24 小时) | `defaults.liveStreaming.streamingIntervalHours` = `pushTime > 0 ? pushTime : 1`(「0 = 关」交给开关) |
 * | `defaults.schedule.restartPush` | `defaults.liveStart.catchUpOnBoot` |
 * | `routing.liveStart` | 另存一份给 `routing.liveStreaming`(拷贝) |
 * | 逐订阅的 `overrides.features.liveStart` / `overrides.schedule.pushTime` | **按合并后的值**算这条订阅的 `liveStreaming` 开关,只有和全局算出来的不同才写进 `overrides.features.liveStreaming` |
 * | 逐订阅的 `overrides.schedule.pushTime`(> 0) | 和全局间隔不同才写 `overrides.liveStreaming.streamingIntervalHours`(自己写 0 的意思是「这条关掉」,已经由开关表达,不再写间隔) |
 * | 逐订阅的 `overrides.schedule.restartPush` | `overrides.liveStart.catchUpOnBoot` |
 *
 * `schedule` 只搬走 `pushTime` 与 `restartPush` 两格(逐订阅那份拿掉后空了就删掉 `schedule` 这个键);静音时段与断流接续
 * 随 3a 的设置分拆。`templates.liveOngoing` → `templates.liveStreaming`(含账本)是纯改名,归 `feature-renames.ts`。
 *
 * **订阅那一步要全局的值**:`overrides.schedule.pushTime` 没写的订阅沿用全局的 `pushTime`,而设置那一步已经把它拿出
 * `schedule`、折成了间隔 —— 间隔里 `pushTime` 为 0 与 1 一个样(都是 1),全局开播关着时开关又是 `false` 与 `pushTime = 0`
 * 分不开,所以从迁好的设置里反推不出「全局 `pushTime` 是不是大于 0」。订阅那一步因此拿**同一份第 0 代全局设置**过一遍
 * 设置那一步用的同一条流水(`migrateGlobals` → `renameGlobalSettingsKeys`)、用同一个 {@link liveFactsOf} 取值,由调用方
 * 把结果当参数递进来({@link GlobalLiveFacts}),行级函数里不读盘。
 *
 * 认不得的形状原样放过(由配置仓开机时报出来);已经是新键的数据再跑一遍不变,新老键并存时以新键为准、老键丢掉。
 */

import { isPlainObject } from "./files.js";

/** 全局设置里拆键要用的两样(0.x 的值):开播开关与周期间隔(`pushTime`,0 = 关)。 */
export interface GlobalLiveFacts {
	/** 全局 `features.liveStart`(0.x 的 `live`)。 */
	liveStart: boolean;
	/** 全局 `schedule.pushTime`:0 = 关,1–24 小时。 */
	pushTime: number;
}

/** 0.12 的出厂值:全局设置读不到的时候,订阅那一步按它算(开播开、周期关)。 */
export const ZERO_GLOBAL_LIVE_FACTS: GlobalLiveFacts = { liveStart: true, pushTime: 0 };

/**
 * 从整份全局设置(**已经改成 1.0 的特性键**:`defaults.features.liveStart`)取拆键要的两样。形状不对(没有 `defaults` /
 * `features` / `schedule`,或者那两格不是该有的类型)回 `undefined`。设置那一步与订阅那一步共用它 —— 两边的「全局值」
 * 只此一个读法。
 */
export function liveFactsOf(renamedGlobals: unknown): GlobalLiveFacts | undefined {
	if (!isPlainObject(renamedGlobals) || !isPlainObject(renamedGlobals.defaults)) return undefined;
	const { features, schedule } = renamedGlobals.defaults;
	if (!isPlainObject(features) || !isPlainObject(schedule)) return undefined;
	if (typeof features.liveStart !== "boolean" || typeof schedule.pushTime !== "number") {
		return undefined;
	}
	return { liveStart: features.liveStart, pushTime: schedule.pushTime };
}

/** 周期「正在直播」这个特性的开关:开播开着,且周期间隔不是 0(旧的「关」)。 */
function streamingOn(liveStart: boolean, pushTime: number): boolean {
	return liveStart && pushTime > 0;
}

/** 周期间隔:`pushTime` 大于 0 就是它,0 的「关」交给开关、间隔填 1 小时。 */
function intervalOf(pushTime: number): number {
	return pushTime > 0 ? pushTime : 1;
}

type Obj = Record<string, unknown>;

/**
 * 往对象里加一个键,排在 `before` 里**最先出现**的那个键前面;一个都没有就加在末尾。键序照 1.0 schema 的顺序,新键别随手
 * 垫在最后(迁出来的文件是配置仓装载前的原样,键序整齐些方便人读)。
 */
function insertBefore(obj: Obj, before: readonly string[], key: string, value: unknown): Obj {
	const entries = Object.entries(obj);
	const at = entries.findIndex(([k]) => before.includes(k));
	const item: [string, unknown] = [key, value];
	if (at === -1) entries.push(item);
	else entries.splice(at, 0, item);
	return Object.fromEntries(entries);
}

/** 1.0 的特性键顺序里排在 `liveStreaming` 后面的那几个(`features` 与 `routing` 共用)。 */
const AFTER_LIVE_STREAMING = [
	"liveEnd",
	"membership",
	"superchat",
	"specialDanmaku",
	"specialUserEnter",
	"extras",
] as const;

/** 全局 `defaults` 里排在 `liveStart` / `liveStreaming` 两段后面的键(1.0 schema 的顺序)。 */
const AFTER_LIVE_SECTIONS = [
	"liveEnd",
	"templates",
	"ai",
	"cardStyle",
	"cardStyleByKind",
	"cardSkin",
	"cardSkinKnobs",
	"messageLayout",
	"imageGroup",
] as const;

/** 逐订阅 `overrides` 里排在 `liveStart` / `liveStreaming` 两段后面的键。 */
const AFTER_LIVE_OVERRIDES = [
	"templates",
	"ai",
	"cardStyle",
	"cardStyleByKind",
	"cardSkin",
	"cardSkinKnobs",
	"messageLayout",
	"imageGroup",
] as const;

/** 拿掉 `schedule` 里已经搬走的格;没有可拿的就原样回(同一个对象)。 */
function withoutKeys(obj: Obj, keys: readonly string[]): Obj {
	if (!keys.some((k) => k in obj)) return obj;
	return Object.fromEntries(Object.entries(obj).filter(([k]) => !keys.includes(k)));
}

/**
 * 整份全局设置(已改成 1.0 的特性键)的 raw → raw:`schedule.pushTime` / `restartPush` 拆进 `features.liveStreaming`、
 * `liveStreaming.streamingIntervalHours`、`liveStart.catchUpOnBoot`。各格独立判:值的类型不对、认不得的留在原处不动。
 */
export function splitGlobalLiveSettings(raw: unknown): unknown {
	if (!isPlainObject(raw) || !isPlainObject(raw.defaults)) return raw;
	const defaults = raw.defaults;
	if (!isPlainObject(defaults.schedule)) return raw;
	const { pushTime, restartPush } = defaults.schedule;
	const movedKeys: string[] = [];
	let next: Obj = { ...defaults };

	if (typeof pushTime === "number") {
		movedKeys.push("pushTime");
		// 开关:开播开着 且 pushTime > 0。features 不是对象(手改坏了)就不碰它,由配置仓开机时报出来。
		const { features } = next;
		if (isPlainObject(features) && !("liveStreaming" in features)) {
			next = {
				...next,
				features: insertBefore(
					features,
					AFTER_LIVE_STREAMING,
					"liveStreaming",
					streamingOn(features.liveStart === true, pushTime),
				),
			};
		}
		if (!("liveStreaming" in next)) {
			next = insertBefore(next, AFTER_LIVE_SECTIONS, "liveStreaming", {
				streamingIntervalHours: intervalOf(pushTime),
			});
		}
	}
	if (typeof restartPush === "boolean") {
		movedKeys.push("restartPush");
		if (!("liveStart" in next)) {
			next = insertBefore(next, ["liveStreaming", ...AFTER_LIVE_SECTIONS], "liveStart", {
				catchUpOnBoot: restartPush,
			});
		}
	}
	if (movedKeys.length === 0) return raw;
	return { ...raw, defaults: { ...next, schedule: withoutKeys(defaults.schedule, movedKeys) } };
}

/**
 * 一条订阅(已改成 1.0 的键,B 站或拓展)的 raw → raw:`routing.liveStreaming` 拷一份 `routing.liveStart`;逐订阅覆盖里按
 * **合并后的值**算这条订阅的 `liveStreaming` 开关(和全局算出来的不同才写),`overrides.schedule` 里的 `pushTime` /
 * `restartPush` 搬成间隔与补报。`global` 是第 0 代全局设置里拆键要的值(见文件头)。
 */
export function splitSubscriptionLiveSettings(row: unknown, global: GlobalLiveFacts): unknown {
	if (!isPlainObject(row)) return row;
	let next: Obj = { ...row };
	let changed = false;

	// routing:拷一份开播的目标。新键已经在(再跑一遍,或者手写过)就不动。
	if (isPlainObject(next.routing) && Array.isArray(next.routing.liveStart)) {
		if (!("liveStreaming" in next.routing)) {
			next = {
				...next,
				routing: insertBefore(next.routing, AFTER_LIVE_STREAMING, "liveStreaming", [
					...(next.routing.liveStart as unknown[]),
				]),
			};
			changed = true;
		}
	}

	if (isPlainObject(next.overrides)) {
		const overrides = splitOverrides(next.overrides, global);
		if (overrides !== next.overrides) {
			next = { ...next, overrides };
			changed = true;
		}
	}
	return changed ? next : row;
}

/** 逐订阅 `overrides` 里排在 `features` 后面的键(1.0 schema 的顺序)。 */
const AFTER_OVERRIDE_FEATURES = [
	"filters",
	"schedule",
	"liveStart",
	"liveStreaming",
	...AFTER_LIVE_OVERRIDES,
] as const;

/** `overrides` 一格:没有要搬的就原样回(同一个对象)。 */
function splitOverrides(overrides: Obj, global: GlobalLiveFacts): Obj {
	const schedule = isPlainObject(overrides.schedule) ? overrides.schedule : undefined;
	const pushTime = typeof schedule?.pushTime === "number" ? schedule.pushTime : undefined;
	const restartPush = typeof schedule?.restartPush === "boolean" ? schedule.restartPush : undefined;
	const features = isPlainObject(overrides.features) ? overrides.features : undefined;
	let next: Obj = overrides;

	// 开关:这条订阅合并后的值(自己写了就用自己的,没写继承全局)和全局算出来的不同才写。
	// 只有这条订阅碰过开播开关或 pushTime 才可能不同(都没写 = 和全局一样),所以什么都没碰的订阅不会凭空长出键。
	if (!(features && "liveStreaming" in features)) {
		const liveStart =
			typeof features?.liveStart === "boolean" ? features.liveStart : global.liveStart;
		const effective = streamingOn(liveStart, pushTime ?? global.pushTime);
		if (effective !== streamingOn(global.liveStart, global.pushTime)) {
			next = features
				? {
						...next,
						features: insertBefore(features, AFTER_LIVE_STREAMING, "liveStreaming", effective),
					}
				: insertBefore(next, AFTER_OVERRIDE_FEATURES, "features", { liveStreaming: effective });
		}
	}

	// 间隔:这条订阅自己写了(> 0)、且和全局间隔不一样才写。自己写 0 = 这条关掉,开关已经表达了。
	if (
		pushTime !== undefined &&
		pushTime > 0 &&
		pushTime !== intervalOf(global.pushTime) &&
		!("liveStreaming" in next)
	) {
		next = insertBefore(next, AFTER_LIVE_OVERRIDES, "liveStreaming", {
			streamingIntervalHours: pushTime,
		});
	}

	// 补报:有值就搬(含 false —— 盖掉全局的 true 也是一种覆盖)。
	if (restartPush !== undefined && !("liveStart" in next)) {
		next = insertBefore(next, ["liveStreaming", ...AFTER_LIVE_OVERRIDES], "liveStart", {
			catchUpOnBoot: restartPush,
		});
	}

	// schedule 拿掉搬走的格;空了就删掉这个键。
	const moved = [
		...(pushTime !== undefined ? ["pushTime"] : []),
		...(restartPush !== undefined ? ["restartPush"] : []),
	];
	if (schedule && moved.length > 0) {
		const rest = withoutKeys(schedule, moved);
		next =
			Object.keys(rest).length === 0
				? Object.fromEntries(Object.entries(next).filter(([k]) => k !== "schedule"))
				: { ...next, schedule: rest };
	}
	return next;
}
