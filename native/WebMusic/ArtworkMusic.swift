import AppKit
import Carbon
import Foundation

struct LocalArtworkTarget: Codable {
    let persistentID: String
    let name: String
    let marker: String
    let tracks: [ArtworkTrack]
}
protocol ArtworkMusicDriver {
    func permission(ask: Bool) async -> Bool
    func resolve(_ target: ArtworkTarget) async throws -> LocalArtworkTarget
    func read(_ target: LocalArtworkTarget) async throws -> Data
    func set(_ target: LocalArtworkTarget, asset: ArtworkAsset) async throws
}
enum ArtworkMatching {
    static func validID(_ value: String) -> Bool { value.range(of: "^[A-Fa-f0-9]{16}$", options: .regularExpression) != nil }
    static func normalized(_ value: String) -> String { value.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ").lowercased(with: Locale(identifier: "en_US_POSIX")) }
    static func tracks(_ actual: [ArtworkTrack], _ expected: [ArtworkTrack]) -> Bool {
        actual.count == expected.count && zip(actual, expected).allSatisfy { a, b in
            a.durationSeconds.isFinite && b.durationSeconds.isFinite && a.durationSeconds > 0 && b.durationSeconds > 0 &&
            a.durationSeconds <= 86_400 && b.durationSeconds <= 86_400 && abs(a.durationSeconds - b.durationSeconds) <= 3 &&
            zip([a.title, a.artist, a.album], [b.title, b.artist, b.album]).allSatisfy {
                !$0.0.isEmpty && $0.0.utf8.count <= 4096 && !normalized($0.0).isEmpty && normalized($0.0) == normalized($0.1)
            }
        }
    }
    static func validate(_ local: LocalArtworkTarget, target: ArtworkTarget, savedID: String?) throws {
        guard validID(local.persistentID), savedID == nil || savedID == local.persistentID,
              local.name == target.name, local.marker == "Wavelength playlist job " + UUID(uuidString: target.jobID)!.uuidString,
              tracks(local.tracks, target.tracks) else { throw ArtworkFailure.identity }
    }
}

struct NativeArtworkService: ArtworkService {
    let store: ArtworkStore
    let renderer: ArtworkRenderer
    let driver: any ArtworkMusicDriver
    init(store: ArtworkStore = ArtworkStore(), renderer: ArtworkRenderer = ArtworkRenderer(), driver: any ArtworkMusicDriver = MusicArtworkDriver()) {
        self.store = store; self.renderer = renderer; self.driver = driver
    }
    func handle(_ target: ArtworkTarget, mode: ArtworkMode) async -> ArtworkResult {
        var attempted = false
        var journalKnown = false
        var hash: String?
        func result(_ state: String, _ code: String) -> ArtworkResult { ArtworkResult(state: state, code: code, writeAttempted: attempted, imageHash: hash) }
        do {
            guard UUID(uuidString: target.jobID) != nil, !target.name.isEmpty, target.name.utf8.count <= 512,
                  !target.tracks.isEmpty, target.tracks.count <= 1000, ArtworkMatching.tracks(target.tracks, target.tracks) else { throw ArtworkFailure.identity }
            var journal = try store.load(target)
            journalKnown = true
            attempted = journal?.writeAttempted ?? false
            hash = journal?.imageHash
            guard await driver.permission(ask: mode == .authorize) else { return result(attempted || mode == .check ? "uncertain" : "blocked", "automation-permission") }
            if mode == .authorize { return result(attempted ? "uncertain" : "blocked", "permission-ready") }
            if mode == .check && journal == nil { return result("uncertain", "journal-missing") }
            let asset = try store.asset(target, journal: journal, render: mode == .apply && !attempted ? { try renderer.render(jobID: target.jobID, title: target.name) } : nil)
            hash = asset.hash
            let local = try await driver.resolve(target)
            try ArtworkMatching.validate(local, target: target, savedID: journal?.localID)
            if journal == nil {
                journal = ArtworkJournal(version: 1, jobID: UUID(uuidString: target.jobID)!.uuidString, cloudID: target.playlistID, name: target.name, tracks: target.tracks, localID: local.persistentID, imageHash: asset.hash, writeAttempted: false)
                try store.save(journal!, target: target)
            }
            if let bytes = try? await driver.read(local), (try? ArtworkRenderer.validate(bytes)) != nil, ArtworkRenderer.hash(bytes) == asset.hash { return result("verified", "image-verified") }
            guard mode == .apply, !attempted else { return result("uncertain", "image-unconfirmed") }
            journal!.localID = local.persistentID
            journal!.writeAttempted = true
            try store.save(journal!, target: target)
            attempted = true
            // Music can throw error 1 after applying artwork. Only direct image bytes establish success.
            try? await driver.set(local, asset: asset)
            if let bytes = try? await driver.read(local), (try? ArtworkRenderer.validate(bytes)) != nil, ArtworkRenderer.hash(bytes) == asset.hash { return result("verified", "image-verified") }
            return result("uncertain", "image-unconfirmed")
        } catch {
            return result(attempted || mode == .check || !journalKnown ? "uncertain" : "blocked", (error as? ArtworkFailure)?.rawValue ?? "unsafe-store")
        }
    }
}

enum ArtworkScripts {
    static func quote(_ value: String) -> String {
        "\"" + value.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"").replacingOccurrences(of: "\n", with: "\\n").replacingOccurrences(of: "\r", with: "\\r").replacingOccurrences(of: "\t", with: "\\t") + "\""
    }
    static func bounded(_ source: String) -> String { "with timeout of 15 seconds\nconsidering case, diacriticals, hyphens, punctuation, white space\n" + source + "\nend considering\nend timeout" }
    static func selection(marker: String, name: String, id: String? = nil) -> String {
        """
        tell application id "com.apple.Music"
            set candidates to get every user playlist whose description is \(quote(marker))
            if (count of candidates) is not 1 then error number -2700
            set p to item 1 of candidates
            if (name of p) is not \(quote(name)) then error number -2700
        """ + (id.map { "\nif (persistent ID of p) is not \(quote($0)) then error number -2700\n" } ?? "\n")
    }
    static func resolve(_ target: ArtworkTarget) -> String {
        bounded(selection(marker: "Wavelength playlist job " + UUID(uuidString: target.jobID)!.uuidString, name: target.name) + """
            if (count of tracks of p) is not \(target.tracks.count) then error number -2700
            set rows to {}
            repeat with t in (get tracks of p)
                set end of rows to {name of t, artist of t, album of t, duration of t}
            end repeat
            return {persistent ID of p, name of p, description of p, rows}
        end tell
        """)
    }
    static func checked(_ target: LocalArtworkTarget) -> String {
        var script = selection(marker: target.marker, name: target.name, id: target.persistentID)
        script += "if (count of tracks of p) is not \(target.tracks.count) then error number -2700\n"
        for (index, track) in target.tracks.enumerated() {
            script += "set t to track \(index + 1) of p\n"
            for (field, value) in [("name", track.title), ("artist", track.artist), ("album", track.album)] {
                script += "if (\(field) of t) is not \(quote(value)) then error number -2700\n"
            }
            script += "if (duration of t) is not \(track.durationSeconds) then error number -2700\n"
        }
        return script
    }
    static func set(_ target: LocalArtworkTarget, asset: ArtworkAsset) -> String {
        bounded("set imageData to (read POSIX file \(quote(asset.url.path)) as picture)\n" + checked(target) + "set data of artwork 1 of p to imageData\nend tell")
    }
    static func read(_ target: LocalArtworkTarget) -> String { bounded(checked(target) + "return data of artwork 1 of p\nend tell") }
    static func allTemplates(target: ArtworkTarget, local: LocalArtworkTarget, asset: ArtworkAsset) throws -> [String] { [resolve(target), read(local), set(local, asset: asset)] }
}

struct MusicArtworkDriver: ArtworkMusicDriver {
    @MainActor private static func execute(_ source: String) throws -> NSAppleEventDescriptor {
        guard !NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.Music").isEmpty,
              let script = NSAppleScript(source: source) else { throw ArtworkFailure.unavailable }
        var error: NSDictionary?
        let descriptor = script.executeAndReturnError(&error)
        guard error == nil else { throw ArtworkFailure.unavailable }; return descriptor
    }
    func permission(ask: Bool) async -> Bool {
        await Self.permissionOnMain(ask: ask)
    }
    @MainActor private static func permissionOnMain(ask: Bool) async -> Bool {
        if NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.Music").isEmpty {
            guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.apple.Music") else { return false }
            let configuration = NSWorkspace.OpenConfiguration(); configuration.activates = false
            let launched: Bool = await withCheckedContinuation { continuation in
                NSWorkspace.shared.openApplication(at: url, configuration: configuration) { application, _ in continuation.resume(returning: application != nil) }
            }
            guard launched else { return false }
        }
        let target = NSAppleEventDescriptor(bundleIdentifier: "com.apple.Music")
        return AEDeterminePermissionToAutomateTarget(target.aeDesc, typeWildCard, typeWildCard, ask) == noErr
    }
    func resolve(_ target: ArtworkTarget) async throws -> LocalArtworkTarget {
        try await MainActor.run {
            let value = try Self.execute(ArtworkScripts.resolve(target))
            guard value.numberOfItems == 4, let id = value.atIndex(1)?.stringValue, let name = value.atIndex(2)?.stringValue,
                  let marker = value.atIndex(3)?.stringValue, let rows = value.atIndex(4), rows.numberOfItems == target.tracks.count else { throw ArtworkFailure.identity }
            var tracks: [ArtworkTrack] = []
            for index in 1...rows.numberOfItems {
                guard let row = rows.atIndex(index), row.numberOfItems == 4, let title = row.atIndex(1)?.stringValue,
                      let artist = row.atIndex(2)?.stringValue, let album = row.atIndex(3)?.stringValue,
                      let duration = row.atIndex(4), [typeIEEE64BitFloatingPoint, typeSInt32, typeSInt16, typeSInt64].contains(duration.descriptorType) else { throw ArtworkFailure.identity }
                tracks.append(ArtworkTrack(title: title, artist: artist, album: album, durationSeconds: duration.doubleValue))
            }
            let local = LocalArtworkTarget(persistentID: id, name: name, marker: marker, tracks: tracks)
            try ArtworkMatching.validate(local, target: target, savedID: nil); return local
        }
    }
    func read(_ target: LocalArtworkTarget) async throws -> Data {
        try await MainActor.run {
            let data = try Self.execute(ArtworkScripts.read(target)).data
            try ArtworkRenderer.validate(data); return data
        }
    }
    func set(_ target: LocalArtworkTarget, asset: ArtworkAsset) async throws {
        try await MainActor.run {
            let jobID = String(target.marker.suffix(36))
            let store = ArtworkStore(root: asset.url.deletingLastPathComponent().deletingLastPathComponent())
            guard ArtworkRenderer.hash(try store.image(jobID: jobID)) == asset.hash else { throw ArtworkFailure.invalidImage }
            _ = try Self.execute(ArtworkScripts.set(target, asset: asset))
        }
    }
}
