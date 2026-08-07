// 桌面端图标生成器 —— 把满幅方形的 icon.png 裁成 Apple 规范的 squircle,
// 一次产出 macOS / Windows / Linux 三套资产。
//
//   swift make-icons.swift
//
// 在本目录下跑,读 icon.png,就地覆盖下列产物:
//   icon.icns          macOS —— 10 个切片
//   icon.ico           Windows —— 6 个切片(16/24/32/48/64/256),PNG 编码
//   32x32.png          Linux / 通用
//   64x64.png
//   128x128.png
//   128x128@2x.png
//
// 不进任何构建流程,换 logo 时手动跑一次(需要 Xcode Command Line Tools)。
//
// **`icon.png` 自己不动** —— 它是没套过形状的纯净源图。套完再当源图喂进来会二次
// 套圆角,角上啃掉一圈。`tauri icon` 也是拿它当输入的。
//
// 同理不碰的还有:`Square*Logo.png` / `StoreLogo.png`(Windows Store 磁贴,磁贴规范
// 是满幅、且当前 CI 打的是 nsis 不是 msix)、`tray-logo*`(托盘模板图,黑白剪影)、
// `ios/` 与 `android/`。
//
// Apple 的数字(HIG「App icons · macOS」):
//   画布 1024 × 1024,图标主体 824 × 824 居中(四周各留白 100),圆角半径 185.4。
// 圆角走 SwiftUI 的 `.continuous` —— 苹果自己的 squircle 实现,角部曲率是渐变的,
// 与普通圆角矩形(`.circular`)肉眼可辨。不要用近似路径替换它。
//
// 投影是烘焙进图里的 —— 系统自带 App(拿 Mail.app 的 ApplicationIcon.icns 反解对过)
// 就是这么做的,那道淡影属于图标资产本身,不是 Dock 加的。不烘的话跟一排系统图标并排
// 会显得"浮不起来"。留白 100 足够容下 offset 10 + blur 20,不会被画布裁掉。
//
// Windows 与 Linux 的原生规范其实是满幅方图,这里按主人的要求统一成同一套形状。
import AppKit
import SwiftUI

let canvas: CGFloat = 1024
let body: CGFloat = 824
let radius: CGFloat = 185.4
let shadowOffset: CGFloat = 10
let shadowBlur: CGFloat = 20
let shadowAlpha: CGFloat = 0.25

let source = "icon.png"
/// iconutil 认的十个切片:文件名 → 像素边长。
let icnsSlices: [(name: String, px: Int)] = [
	("icon_16x16", 16),
	("icon_16x16@2x", 32),
	("icon_32x32", 32),
	("icon_32x32@2x", 64),
	("icon_128x128", 128),
	("icon_128x128@2x", 256),
	("icon_256x256", 256),
	("icon_256x256@2x", 512),
	("icon_512x512", 512),
	("icon_512x512@2x", 1024),
]
/// 与原 icon.ico 相同的尺寸构成,别擅自增删 —— Windows 各处(任务栏/资源管理器/
/// Alt-Tab)按尺寸挑切片,少一档就得由系统现缩,糊。
let icoSlices = [16, 24, 32, 48, 64, 256]
/// tauri.conf.json 的 bundle.icon 直接引用的那几个,外加目录里同源的 64x64。
let looseSlices: [(file: String, px: Int)] = [
	("32x32.png", 32),
	("64x64.png", 64),
	("128x128.png", 128),
	("128x128@2x.png", 256),
]

func fail(_ msg: String) -> Never {
	FileHandle.standardError.write("make-icons: \(msg)\n".data(using: .utf8)!)
	exit(1)
}

guard let src = NSImage(contentsOfFile: source),
	let cg = src.cgImage(forProposedRect: nil, context: nil, hints: nil)
else { fail("读不出源图 \(source) —— 请在 icons/ 目录下运行") }

/// 把源图缩到 `side` 见方,套上 squircle 遮罩。留白比例在所有尺寸上保持一致。
func render(side: Int) -> CGImage {
	let s = CGFloat(side)
	let scale = s / canvas
	guard
		let ctx = CGContext(
			data: nil,
			width: side,
			height: side,
			bitsPerComponent: 8,
			bytesPerRow: 0,
			space: CGColorSpace(name: CGColorSpace.sRGB)!,
			bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
		)
	else { fail("建不出 \(side)px 画布") }

	let inset = (canvas - body) / 2 * scale
	let rect = CGRect(x: inset, y: inset, width: body * scale, height: body * scale)
	let shape = RoundedRectangle(cornerRadius: radius * scale, style: .continuous)
	let path = shape.path(in: rect).cgPath

	// ① 投影层:先拿实心 squircle 投一道影。必须在 clip 之前 —— 裁剪之后画的话
	//    影子会连同外溢部分一起被裁没。填充色随便,② 会整块盖住。
	ctx.saveGState()
	ctx.setShadow(
		offset: CGSize(width: 0, height: -shadowOffset * scale),
		blur: shadowBlur * scale,
		color: NSColor.black.withAlphaComponent(shadowAlpha).cgColor
	)
	ctx.addPath(path)
	ctx.setFillColor(NSColor.black.cgColor)
	ctx.fillPath()
	ctx.restoreGState()

	// ② 图像层。
	ctx.saveGState()
	ctx.addPath(path)
	ctx.clip()
	ctx.interpolationQuality = .high
	ctx.draw(cg, in: rect)
	ctx.restoreGState()

	guard let out = ctx.makeImage() else { fail("\(side)px 渲染失败") }
	return out
}

func png(_ image: CGImage) -> Data {
	guard let data = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:])
	else { fail("PNG 编码失败") }
	return data
}

let fm = FileManager.default

// ---- macOS ----------------------------------------------------------------
let work = fm.temporaryDirectory.appendingPathComponent("make-icons-\(getpid()).iconset")
try fm.createDirectory(at: work, withIntermediateDirectories: true)
defer { try? fm.removeItem(at: work) }

for slice in icnsSlices {
	try png(render(side: slice.px)).write(to: work.appendingPathComponent("\(slice.name).png"))
}
let iconutil = Process()
iconutil.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
iconutil.arguments = ["-c", "icns", work.path, "-o", "icon.icns"]
try iconutil.run()
iconutil.waitUntilExit()
guard iconutil.terminationStatus == 0 else { fail("iconutil 退出码 \(iconutil.terminationStatus)") }
print("icon.icns        \(icnsSlices.count) 个切片")

// ---- Windows --------------------------------------------------------------
// ICO 是手写的:macOS 没有 ico 编码器,而格式本身很薄 —— 一个 6 字节的 ICONDIR、
// 每片 16 字节的 ICONDIRENTRY,后面直接跟 PNG 数据(Vista 起支持 PNG 内嵌)。
// 全部小端序;边长 256 在那一个字节里写 0(255 是上限,0 约定为 256)。
func encodeICO(_ sides: [Int]) -> Data {
	let images = sides.map { png(render(side: $0)) }
	var out = Data()
	out.append(contentsOf: [0, 0]) // reserved
	out.append(contentsOf: [1, 0]) // type 1 = icon
	out.append(contentsOf: [UInt8(sides.count & 0xFF), UInt8(sides.count >> 8)])

	var offset = 6 + 16 * sides.count
	for (i, side) in sides.enumerated() {
		let byte = side >= 256 ? 0 : side
		out.append(contentsOf: [UInt8(byte), UInt8(byte)]) // width, height
		out.append(contentsOf: [0, 0]) // palette count, reserved
		out.append(contentsOf: [1, 0]) // color planes
		out.append(contentsOf: [32, 0]) // bits per pixel
		var size = UInt32(images[i].count).littleEndian
		var off = UInt32(offset).littleEndian
		withUnsafeBytes(of: &size) { out.append(contentsOf: $0) }
		withUnsafeBytes(of: &off) { out.append(contentsOf: $0) }
		offset += images[i].count
	}
	for image in images { out.append(image) }
	return out
}
try encodeICO(icoSlices).write(to: URL(fileURLWithPath: "icon.ico"))
print("icon.ico         \(icoSlices.count) 个切片 \(icoSlices.map(String.init).joined(separator: "/"))")

// ---- Linux / 通用 ----------------------------------------------------------
for slice in looseSlices {
	try png(render(side: slice.px)).write(to: URL(fileURLWithPath: slice.file))
	print("\(slice.file.padding(toLength: 17, withPad: " ", startingAt: 0))\(slice.px)px")
}
