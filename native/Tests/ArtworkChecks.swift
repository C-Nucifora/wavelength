import AppKit
import Darwin
import Foundation

func expectArtwork(_ condition: Bool, _ message: String) throws {
    if !condition { throw NSError(domain: message, code: 1) }
}
final class FakeArtworkMusic: ArtworkMusicDriver {
    var allowed = true
    var asked = false
    var setCalls = 0
    var local: LocalArtworkTarget
    var readBytes = Data()
    var readError = false
    var setterError = false
    var installedInitially = false
    var resolveError = false
    var beforeSet: (() throws -> Void)?
    init(_ target: ArtworkTarget) {
        local = LocalArtworkTarget(persistentID: "0123456789ABCDEF", name: target.name, marker: "Wavelength playlist job " + target.jobID, tracks: target.tracks)
    }
    func permission(ask: Bool) async -> Bool { asked = ask; return allowed }
    func resolve(_ target: ArtworkTarget) async throws -> LocalArtworkTarget {
        if resolveError { throw ArtworkFailure.identity }; return local
    }
    func read(_ target: LocalArtworkTarget) async throws -> Data {
        if readError { throw NSError(domain: "unreadable", code: 1) }; return setCalls == 0 && !installedInitially ? Data() : readBytes
    }
    func set(_ target: LocalArtworkTarget, asset: ArtworkAsset) async throws {
        try beforeSet?(); setCalls += 1
        if setterError { throw NSError(domain: "fixture", code: 1) }
    }
}
@main struct ArtworkChecks {
    static func main() async throws {
        guard let canonicalTemporary = realpath(FileManager.default.temporaryDirectory.path, nil) else { throw ArtworkFailure.unsafeStore }
        let root = URL(fileURLWithPath: String(cString: canonicalTemporary)).appendingPathComponent("wavelength-artwork-" + UUID().uuidString)
        free(canonicalTemporary)
        defer { try? FileManager.default.removeItem(at: root) }
        let target = ArtworkTarget(jobID: "00000000-0000-0000-0000-000000000001", playlistID: "p.fixture", name: "Night waves", tracks: [ArtworkTrack(title: "Song", artist: "Artist", album: "Album", durationSeconds: 180)])
        let renderer = ArtworkRenderer()
        let bytes = try renderer.render(jobID: target.jobID, title: target.name)
        try expectArtwork(bytes == renderer.render(jobID: target.jobID, title: target.name), "deterministic JPEG")
        let rep = NSBitmapImageRep(data: bytes)
        try expectArtwork(rep?.pixelsWide == 1024 && rep?.pixelsHigh == 1024, "1024 JPEG")
        let other = try renderer.render(jobID: "00000000-0000-0000-0000-000000000002", title: target.name)
        try expectArtwork(bytes != other, "UUID affects design")
        _ = try renderer.render(jobID: target.jobID, title: String(repeating: "夜の海 ", count: 40))
        do { _ = try renderer.render(jobID: target.jobID, title: String(repeating: "é", count: 257)); throw NSError(domain: "accepted oversized title", code: 1) } catch is ArtworkFailure {}
        let store = ArtworkStore(root: root)
        try expectArtwork(!FileManager.default.fileExists(atPath: root.path), "store initializer inert")
        let driver = FakeArtworkMusic(target)
        driver.setterError = true; driver.readBytes = bytes
        let service = NativeArtworkService(store: store, renderer: renderer, driver: driver)
        driver.beforeSet = {
            let journal = try store.load(target)!
            try expectArtwork(journal.writeAttempted && journal.localID == "0123456789ABCDEF", "durable intent precedes setter")
        }
        let result = await service.handle(target, mode: .apply)
        try expectArtwork(result.state == "verified" && result.writeAttempted && driver.setCalls == 1, "direct readback beats setter error and zero artwork enumeration: \(result.state)/\(result.code)/\(result.writeAttempted)/\(driver.setCalls)")
        let checked = await service.handle(target, mode: .check)
        try expectArtwork(checked.state == "verified" && driver.setCalls == 1, "lost result recovery reads only")
        try expectArtwork(try store.image(jobID: target.jobID) == bytes, "UI image reader validates journal and JPEG")
        driver.readBytes = other
        let wrong = await service.handle(target, mode: .apply)
        try expectArtwork(wrong.state == "uncertain" && wrong.writeAttempted && driver.setCalls == 1, "attempted asset never reapplied")
        driver.readError = true
        try expectArtwork((await service.handle(target, mode: .check)).state == "uncertain", "unreadable artwork uncertain")
        driver.allowed = false
        try expectArtwork((await service.handle(target, mode: .apply)).state == "uncertain", "permission denial preserves write uncertainty")
        driver.allowed = true; driver.readError = false; driver.readBytes = bytes
        driver.local = LocalArtworkTarget(persistentID: "FEDCBA9876543210", name: target.name, marker: "Wavelength playlist job " + target.jobID, tracks: target.tracks)
        try expectArtwork((await service.handle(target, mode: .check)).state == "uncertain", "changed saved local ID blocks readback")
        let absent = ArtworkTarget(jobID: "00000000-0000-0000-0000-000000000003", playlistID: "p.fixture", name: target.name, tracks: target.tracks)
        let freshDriver = FakeArtworkMusic(absent)
        let fresh = NativeArtworkService(store: store, renderer: renderer, driver: freshDriver)
        try expectArtwork((await fresh.handle(absent, mode: .check)).state == "uncertain" && freshDriver.setCalls == 0, "absent journal check never writes")
        freshDriver.allowed = false
        try expectArtwork((await fresh.handle(absent, mode: .apply)).state == "blocked" && !freshDriver.asked, "apply never requests permission")
        _ = await fresh.handle(absent, mode: .authorize)
        try expectArtwork(freshDriver.asked && freshDriver.setCalls == 0, "only authorize asks without setter")
        freshDriver.allowed = true; freshDriver.resolveError = true
        let duplicate = await fresh.handle(absent, mode: .apply)
        try expectArtwork(duplicate.state == "blocked" && freshDriver.setCalls == 0, "duplicate or missing local resolution blocks before setter")
        let normalized = ArtworkTrack(title: "  SONG\u{2003}\n", artist: "artist", album: "ALBUM", durationSeconds: 183)
        try expectArtwork(ArtworkMatching.tracks([normalized], target.tracks), "Unicode whitespace and inclusive 3 seconds")
        try expectArtwork(!ArtworkMatching.tracks([ArtworkTrack(title: "Song", artist: "Artist", album: "Album", durationSeconds: 183.001)], target.tracks), "over 3 seconds rejected")
        let second = ArtworkTrack(title: "Second", artist: "Artist", album: "Album", durationSeconds: 180)
        try expectArtwork(!ArtworkMatching.tracks([second, target.tracks[0]], [target.tracks[0], second]), "ordered tracks compared")
        try expectArtwork(!ArtworkMatching.tracks([ArtworkTrack(title: "Song", artist: "Artist", album: "Album", durationSeconds: .nan)], target.tracks), "nonfinite duration rejected")
        let asset = try store.asset(target, journal: store.load(target), render: { throw NSError(domain: "must reuse immutable bytes", code: 1) })
        try expectArtwork(try Data(contentsOf: asset.url) == bytes, "existing image survives renderer change")
        let crashTarget = ArtworkTarget(jobID: "00000000-0000-0000-0000-000000000004", playlistID: "p.fixture", name: target.name, tracks: target.tracks)
        let crashAsset = try store.asset(crashTarget, journal: nil, render: { bytes })
        let crashJournal = ArtworkJournal(version: 1, jobID: crashTarget.jobID, cloudID: crashTarget.playlistID, name: crashTarget.name, tracks: crashTarget.tracks, localID: "0123456789ABCDEF", imageHash: crashAsset.hash, writeAttempted: true)
        try store.save(crashJournal, target: crashTarget)
        let crashDriver = FakeArtworkMusic(crashTarget)
        let crashService = NativeArtworkService(store: store, renderer: renderer, driver: crashDriver)
        let crashResult = await crashService.handle(crashTarget, mode: .apply)
        try expectArtwork(crashResult.state == "uncertain" && crashResult.writeAttempted && crashDriver.setCalls == 0, "crash after intent before setter never resends")
        crashDriver.installedInitially = true; crashDriver.readBytes = bytes
        try expectArtwork((await crashService.handle(crashTarget, mode: .check)).state == "verified" && crashDriver.setCalls == 0, "crash after setter recovers by reading")
        for changed in [
            LocalArtworkTarget(persistentID: "0123456789ABCDEF", name: target.name, marker: "duplicate-marker", tracks: target.tracks),
            LocalArtworkTarget(persistentID: "0123456789ABCDEF", name: target.name, marker: "Wavelength playlist job " + crashTarget.jobID, tracks: [second]),
        ] {
            crashDriver.local = changed
            try expectArtwork((await crashService.handle(crashTarget, mode: .check)).state == "uncertain", "marker or ordered metadata mismatch blocked")
        }
        let safetyRoot = root.appendingPathComponent("safety")
        let safety = ArtworkStore(root: safetyRoot)
        _ = try safety.asset(target, journal: nil, render: { bytes })
        let safetyDirectory = try ArtworkPaths.directory(jobID: target.jobID, root: safetyRoot)
        func rejected(_ label: String, _ operation: () throws -> Void) throws {
            do { try operation() } catch { return }
            throw NSError(domain: label, code: 1)
        }
        let safetyImage = safetyDirectory.appendingPathComponent("cover.jpg")
        try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: safetyImage.path)
        try rejected("public image accepted") { _ = try safety.asset(target, journal: nil, render: nil) }
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: safetyImage.path)
        let hardLink = safetyDirectory.appendingPathComponent("hardlink")
        try FileManager.default.linkItem(at: safetyImage, to: hardLink)
        try rejected("hardlinked image accepted") { _ = try safety.asset(target, journal: nil, render: nil) }
        try FileManager.default.removeItem(at: hardLink)
        try FileManager.default.removeItem(at: safetyImage)
        try FileManager.default.createSymbolicLink(at: safetyImage, withDestinationURL: asset.url)
        try rejected("symlinked image accepted") { _ = try safety.asset(target, journal: nil, render: nil) }
        try FileManager.default.removeItem(at: safetyImage)
        try bytes.write(to: safetyImage); try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: safetyImage.path)
        let wrongHashJournal = ArtworkJournal(version: 1, jobID: target.jobID, cloudID: target.playlistID, name: target.name, tracks: target.tracks, localID: "0123456789ABCDEF", imageHash: String(repeating: "0", count: 64), writeAttempted: true)
        try safety.save(wrongHashJournal, target: target)
        let loadedWrongHash = try safety.load(target)
        try expectArtwork(loadedWrongHash?.imageHash == String(repeating: "0", count: 64), "hash-mismatch fixture loads valid intent before asset comparison")
        try rejected("journal hash mismatch accepted") { _ = try safety.asset(target, journal: loadedWrongHash, render: nil) }
        try rejected("UI image hash mismatch accepted") { _ = try safety.image(jobID: target.jobID) }
        for data in [Data("not a jpeg".utf8), Data(repeating: 0, count: 4 * 1024 * 1024 + 1)] {
            try data.write(to: safetyImage); try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: safetyImage.path)
            try rejected("bad image accepted") { _ = try safety.asset(target, journal: nil, render: nil) }
        }
        let parentLink = root.appendingPathComponent("linked-parent")
        try FileManager.default.createSymbolicLink(at: parentLink, withDestinationURL: safetyRoot)
        try rejected("symlinked parent accepted") { _ = try ArtworkStore(root: parentLink).load(target) }
        var owner = stat(); owner.st_uid = getuid() + 1; owner.st_mode = S_IFREG | 0o600; owner.st_nlink = 1
        try expectArtwork(!ArtworkStore.safeFile(owner, limit: 1024), "wrong ownership rejected")
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: safetyRoot.path)
        try rejected("public managed root accepted") { _ = try safety.load(target) }
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: safetyRoot.path)
        let small = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 8, pixelsHigh: 8, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
        try rejected("wrong image dimensions accepted") { try ArtworkRenderer.validate(small.representation(using: .jpeg, properties: [:])!) }
        for source in try ArtworkScripts.allTemplates(target: target, local: FakeArtworkMusic(target).local, asset: ArtworkAsset(url: root.appendingPathComponent("cover.jpg"), hash: ArtworkRenderer.hash(bytes))) {
            try await MainActor.run {
                var error: NSDictionary?
                guard NSAppleScript(source: source)?.compileAndReturnError(&error) == true, error == nil else { throw NSError(domain: "script compile: \(String(describing: error))", code: 1) }
            }
        }
        if CommandLine.arguments.count == 2 { try bytes.write(to: URL(fileURLWithPath: CommandLine.arguments[1]), options: .withoutOverwriting) }
        print("Artwork checks passed: renderer, durable intent, read-only recovery, permission, identity and offline scripts; no Music execution")
    }
}
