// README 用的 LOGO 生成器 —— 把满幅方形的 logo.png 裁成 Apple 规范的 squircle。
//
//   swift make-logo.swift
//
// 在本目录下跑,读 logo.png,产出 logo-squircle.png(512 × 512,带透明角与投影)。
//
// **`logo.png` 自己不动** —— 它是没套过形状的纯净源图。套完再喂回来会二次套圆角,
// 角上啃掉一圈。同理 `logo.jpg` 也不动(jpg 没有 alpha,存不了透明角)。
//
// ⚠️ 形状参数与 `apps/desktop/src-tauri/icons/make-icons.swift` **必须一致** ——
// 桌面图标和 README 的 LOGO 是同一个形状,改一边就得同步另一边,否则两处的圆角
// 肉眼可辨地对不上。那边的注释里有这几个数字的出处(HIG「App icons · macOS」)与
// 为什么必须用 SwiftUI 的 `.continuous` 而不是近似圆角路径。
//
// 输出 512 而非 1024:README 里显示宽度 200px,Retina 2x 也才 400,512 绰绰有余,
// 而 1024 会让这张图无谓地大一倍。要更大的尺寸就改 `output` 那个数,源图是 1024 的。
import AppKit
import SwiftUI

let canvas: CGFloat = 1024
let body: CGFloat = 824
let radius: CGFloat = 185.4
let shadowOffset: CGFloat = 10
let shadowBlur: CGFloat = 20
let shadowAlpha: CGFloat = 0.25

let source = "logo.png"
let target = "logo-squircle.png"
let output = 512

func fail(_ msg: String) -> Never {
	FileHandle.standardError.write("make-logo: \(msg)\n".data(using: .utf8)!)
	exit(1)
}

guard let src = NSImage(contentsOfFile: source),
	let cg = src.cgImage(forProposedRect: nil, context: nil, hints: nil)
else { fail("读不出源图 \(source) —— 请在 docs/images/ 目录下运行") }

/// 把源图缩到 `side` 见方,套上 squircle 遮罩。留白比例与桌面图标保持一致。
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

guard let data = NSBitmapImageRep(cgImage: render(side: output)).representation(using: .png, properties: [:])
else { fail("PNG 编码失败") }
try data.write(to: URL(fileURLWithPath: target))
print("\(target)  \(output)×\(output)")
