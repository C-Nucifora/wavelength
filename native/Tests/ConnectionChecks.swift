import Foundation

enum ConnectionChecks {
    @MainActor static func run() async throws {
        let legacy = try JSONDecoder().decode(MusicJob.self, from: Data(#"{"id":"old","name":"Old","state":"complete","tracks":[],"message":"All songs added","createdAt":"today","updatedAt":"today"}"#.utf8))
        precondition(legacy.cover == nil && !legacy.active && legacy.coverAction == nil, "Old records acquire no cover work")
        var coverJob = legacy
        coverJob.id = UUID().uuidString; coverJob.writer = "web-session"; coverJob.creationState = "known"; coverJob.coverEligible = true
        coverJob.cover = PlaylistCover(state: "applying", helperAttempted: true)
        precondition(coverJob.state == "complete" && coverJob.active && coverJob.coverActive, "Cover keeps polling after songs complete")
        precondition(!coverJob.songActive && !coverJob.retryable && coverJob.coverAction == nil, "Cover work exposes no song retry or cover action")
        coverJob.cover = PlaylistCover(state: "blocked", helperAttempted: true, code: "automation-permission", writeAttempted: false)
        precondition(coverJob.coverAction == "cover-permission" && coverJob.cover!.message.contains("Automation"))
        coverJob.cover = PlaylistCover(state: "uncertain", helperAttempted: true, code: "automation-permission", writeAttempted: true)
        precondition(coverJob.coverAction == "cover-permission", "Permission remedy never applies artwork")
        coverJob.cover?.code = "image-unconfirmed"
        precondition(coverJob.coverAction == "cover-check" && coverJob.cover!.message.contains("unconfirmed"), "Uncertain writes offer only a read check")
        coverJob.cover = PlaylistCover(state: "blocked", helperAttempted: true, code: "permission-ready", writeAttempted: false)
        precondition(coverJob.coverAction == "cover-retry")
        coverJob.cover?.writeAttempted = true
        precondition(coverJob.coverAction == "cover-check", "Known intent cannot expose a write retry")
        coverJob.cover?.code = "untrusted helper text"
        precondition(!coverJob.cover!.message.contains("untrusted helper text"), "Unknown helper codes never become UI text")
        var finishJob = legacy
        finishJob.writer = "web-session"; finishJob.creationState = "known"; finishJob.playlistId = "p.saved"
        let song = DraftTrack(id: "one", catalogId: 1, artistId: 2, title: "Song", artist: "Artist", album: "Album", durationMs: 120000, releaseDate: "today", url: "https://music.apple.com/", source: "test", match: "exact", provenance: Provenance(kind: "unknown", evidence: []), selected: true)
        finishJob.tracks = [TrackResult(track: song, state: "added", outcome: "confirmed")]
        for state in ["interrupted", "cancelled", "partial", "failed"] {
            finishJob.state = state
            precondition(finishJob.retryable, "All-confirmed known jobs offer explicit finish without cover eligibility")
        }
        finishJob.tracks[0].outcome = nil
        precondition(!finishJob.retryable, "Unconfirmed saved items cannot expose Finish playlist")
        finishJob.tracks[0].outcome = "confirmed"; finishJob.playlistId = nil
        precondition(!finishJob.retryable, "Finish requires a known saved playlist")
        finishJob.playlistId = "p.saved"; finishJob.creationState = "unknown"
        precondition(!finishJob.retryable, "Unknown create never offers finish")
        try checkThumbnail()
        let receipt = try JSONDecoder().decode(Preflight.self, from: Data(#"{"id":"mixed","newLibraryAdditions":0,"existingLibrarySongs":0,"total":2,"generation":"g1","storefront":"au","availableCatalogTracks":1,"unavailableCatalogTracks":1,"unavailableCatalogIds":["2"]}"#.utf8))
        let encoded = try JSONSerialization.jsonObject(with: JSONEncoder().encode(receipt)) as! [String: Any]
        precondition(encoded["unavailableCatalogIds"] as? [String] == ["2"], "Native receipts must preserve unavailable catalog identities")
        var fail = true
        var requests: [[String: Any]] = []
        let connection = MusicConnection(invoke: { input in
            requests.append(input)
            if input["action"] as? String == "saveConnection", fail { throw AppError(message: "Rejected") }
            return ["platform": "darwin", "running": false, "accessibility": false, "automation": "unknown", "backend": "web-session", "connection": "saved", "generation": "g2", "storefront": "au", "message": "Saved"]
        })
        connection.bearerInput = "fake-bearer"
        connection.userInput = "fake-user"
        await connection.save(expectedGeneration: "g1")
        precondition(connection.bearerInput == "fake-bearer" && connection.userInput == "fake-user" && connection.status == nil && connection.error != nil, "Failed save must retain local input and prior state")
        fail = false
        await connection.save(expectedGeneration: "g1")
        precondition(connection.bearerInput.isEmpty && connection.userInput.isEmpty && connection.status?.generation == "g2", "Successful save must clear inputs and expose only generation")
        precondition(requests.count == 2 && requests[1]["generation"] as? String == "g1", "Save must compare the expected generation")
        let model = AppModel()
        model.acceptMusicStatus(MusicStatus(platform: "darwin", running: false, accessibility: false, automation: "unknown", message: "Saved", backend: "web-session", connection: "saved", generation: "g1"))
        model.acceptPreflight(Preflight(id: "checked", newLibraryAdditions: 0, existingLibrarySongs: 0, total: 1, generation: "g1", storefront: "au", availableCatalogTracks: 1, unavailableCatalogTracks: 0), revision: model.selectionRevision)
        precondition(model.preflight != nil)
        model.acceptMusicStatus(MusicStatus(platform: "darwin", running: false, accessibility: false, automation: "unknown", message: "New", backend: "web-session", connection: "saved", generation: "g2"))
        precondition(model.preflight == nil, "Connection changes must clear selection receipts")
        model.acceptPreflight(Preflight(id: "stale", newLibraryAdditions: 0, existingLibrarySongs: 0, total: 1, generation: "g1"), revision: model.selectionRevision)
        precondition(model.preflight == nil, "Stale generation must not enable Create")
        var checks: [String] = []
        let refreshed = MusicConnection(invoke: { input in
            if input["action"] as? String == "status" { return ["platform": "darwin", "running": false, "accessibility": false, "automation": "unknown", "message": "Saved", "backend": "web-session", "connection": "saved", "generation": "g2"] }
            let generation = input["generation"] as? String ?? ""
            checks.append(generation)
            guard generation == "g2" else { throw AppError(message: "Changed") }
            return ["generation": "g2", "storefront": "au"]
        })
        refreshed.status = MusicStatus(platform: "darwin", running: false, accessibility: false, automation: "unknown", message: "Old", backend: "web-session", connection: "saved", generation: "g1")
        await refreshed.check(expectedGeneration: "g1")
        precondition(refreshed.status?.generation == "g2" && refreshed.error == nil && checks == ["g2"], "Explicit check must refresh a stale UI generation using a fresh native status")
        var generation = "g2"
        var racingChecks: [String] = []
        let racing = MusicConnection(invoke: { input in
            if input["action"] as? String == "status" { return ["platform": "darwin", "running": false, "accessibility": false, "automation": "unknown", "message": "Saved", "backend": "web-session", "connection": "saved", "generation": generation] }
            let requested = input["generation"] as? String ?? ""
            racingChecks.append(requested)
            if generation == "g2" { generation = "g3"; throw AppError(message: "Changed again") }
            guard requested == generation else { throw AppError(message: "Stale") }
            return ["generation": generation, "storefront": "au"]
        })
        await racing.check(expectedGeneration: "g1")
        precondition(racing.status?.generation == "g2" && racing.error != nil, "A racing replacement must publish only local status, not claim successful validation")
        await racing.check(expectedGeneration: "g2")
        precondition(racing.status?.generation == "g3" && racing.error == nil && racingChecks == ["g2", "g3"], "The next explicit check must recover after a second replacement")
        var removalReads = 0
        let removed = MusicConnection(invoke: { input in
            precondition(input["action"] as? String == "status", "Missing saved session must start no authenticated request")
            removalReads += 1
            return ["platform": "darwin", "running": false, "accessibility": false, "automation": "unknown", "message": "Connect", "backend": "web-session", "connection": "missing"]
        })
        removed.status = refreshed.status
        await removed.check(expectedGeneration: "g2")
        precondition(removed.status?.generation == nil && removed.status?.connection == "missing" && removalReads == 1, "Explicit check must recover from removal")
        print("Connection checks passed: failed/successful save, cleared local input, generation-bound selection")
    }
    private static func checkThumbnail() throws {
        let temporary = FileManager.default.temporaryDirectory.appendingPathComponent("wavelength-thumbnail-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: temporary, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: temporary) }
        let resolved = temporary.path.withCString { realpath($0, nil) }!
        let root = URL(fileURLWithPath: String(cString: resolved)); free(resolved)
        let store = ArtworkStore(root: root.appendingPathComponent("covers"))
        let target = ArtworkTarget(jobID: UUID().uuidString, playlistID: "cloud", name: "Night", tracks: [])
        let asset = try store.asset(target, journal: nil, render: { try ArtworkRenderer().render(jobID: target.jobID, title: target.name) })
        try store.save(ArtworkJournal(version: 1, jobID: target.jobID, cloudID: "cloud", name: "Night", tracks: [], localID: nil, imageHash: asset.hash, writeAttempted: false), target: target)
        let data = try PlaylistCover.thumbnailData(jobID: target.jobID, expectedHash: asset.hash, store: store)
        precondition(ArtworkRenderer.hash(data) == asset.hash, "Verified private bytes load as a thumbnail")
        for (id, hash) in [("../escape", asset.hash), (target.jobID, "bad"), (target.jobID, String(repeating: "0", count: 64))] {
            do { _ = try PlaylistCover.thumbnailData(jobID: id, expectedHash: hash, store: store); preconditionFailure("Untrusted thumbnail accepted") } catch {}
        }
        try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: asset.url.path)
        do { _ = try PlaylistCover.thumbnailData(jobID: target.jobID, expectedHash: asset.hash, store: store); preconditionFailure("Public thumbnail accepted") } catch {}
    }
}
