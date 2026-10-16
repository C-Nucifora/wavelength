import AppKit
import CryptoKit
import Foundation

enum ArtworkFailure: String, Error { case unsafeStore = "unsafe-store", invalidImage = "invalid-image", identity = "identity-mismatch", unavailable = "music-unavailable" }

struct ArtworkRenderer {
    static func hash(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
    static func validate(_ data: Data) throws {
        guard data.count <= 4 * 1024 * 1024, data.starts(with: [0xff, 0xd8]),
              let source = CGImageSourceCreateWithData(data as CFData, nil),
              CGImageSourceGetType(source) as String? == "public.jpeg",
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              properties[kCGImagePropertyPixelWidth] as? Int == 1024,
              properties[kCGImagePropertyPixelHeight] as? Int == 1024,
              CGImageSourceCreateImageAtIndex(source, 0, nil) != nil else { throw ArtworkFailure.invalidImage }
    }
    func render(jobID: String, title: String) throws -> Data {
        guard let uuid = UUID(uuidString: jobID), !title.isEmpty, title.utf8.count <= 512 else { throw ArtworkFailure.invalidImage }
        let seed = Array(SHA256.hash(data: Data((uuid.uuidString + "\n" + title).utf8)))
        guard let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 1024, pixelsHigh: 1024, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0),
              let context = NSGraphicsContext(bitmapImageRep: bitmap) else { throw ArtworkFailure.invalidImage }
        NSGraphicsContext.saveGraphicsState(); NSGraphicsContext.current = context
        defer { NSGraphicsContext.restoreGraphicsState() }
        NSColor(calibratedRed: 0.075, green: 0.065, blue: 0.11, alpha: 1).setFill()
        NSBezierPath(rect: CGRect(x: 0, y: 0, width: 1024, height: 1024)).fill()
        for band in 0..<14 {
            let path = NSBezierPath()
            let y = CGFloat(70 + band * 31)
            path.move(to: CGPoint(x: -80, y: y))
            path.curve(to: CGPoint(x: 1104, y: y + CGFloat(Int(seed[band]) - 128)), controlPoint1: CGPoint(x: 300, y: y + CGFloat(100 + Int(seed[band + 1]))), controlPoint2: CGPoint(x: 700, y: y - CGFloat(100 + Int(seed[band + 2]))))
            NSColor(calibratedHue: CGFloat(0.68 + Double(seed[0]) / 255 * 0.14 + Double(band) * 0.006), saturation: 0.57, brightness: 0.65 + CGFloat(band) * 0.022, alpha: 1).setStroke()
            path.lineWidth = 13; path.stroke()
        }
        let paragraph = NSMutableParagraphStyle(); paragraph.lineBreakMode = .byWordWrapping
        let titleFont = NSFont.systemFont(ofSize: title.count > 90 ? 48 : 72, weight: .bold)
        (title as NSString).draw(with: CGRect(x: 72, y: 555, width: 880, height: 365), options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine], attributes: [.font: titleFont, .foregroundColor: NSColor.white, .paragraphStyle: paragraph])
        ("WAVELENGTH" as NSString).draw(at: CGPoint(x: 76, y: 962), withAttributes: [.font: NSFont.systemFont(ofSize: 18, weight: .semibold), .foregroundColor: NSColor(calibratedWhite: 0.68, alpha: 1), .kern: 5])
        guard let data = bitmap.representation(using: .jpeg, properties: [.compressionFactor: 0.9]) else { throw ArtworkFailure.invalidImage }
        try Self.validate(data); return data
    }
}
