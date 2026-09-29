import type { Logger } from "@bilibili-notify/internal";

/** 不出声的 logger:被测的零件必须接上 logger(接线靠类型钉住),而这条测试不关心日志内容时用。 */
export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
