import Foundation

enum DiscographyChecks {
    private struct FixtureState: Decodable { var counters: [String: Int]; var pending: [String] }
    @MainActor static func run(resources: URL) async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("wavelength-discography-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let engine = EngineController(resources: resources, dataDirectory: directory)
        let model = AppModel(engine: engine)
        model.start()
        for _ in 0..<100 {
            if model.connected { break }
            try await Task.sleep(for: .milliseconds(30))
        }
        precondition(model.connected)
        let log = try String(contentsOf: engine.logURL!, encoding: .utf8)
        let range = log.range(of: #"http://127\.0\.0\.1:[0-9]+"#, options: .regularExpression)!
        let api = APIClient(baseURL: URL(string: String(log[range]))!)
        let session: SessionResponse = try await api.call("/api/session")
        api.token = session.token
        let status = MusicStatus(platform: "darwin", running: false, accessibility: false, automation: "unknown", message: "Saved fixture", backend: "web-session", connection: "saved", generation: "g1", storefront: "au")
        model.acceptMusicStatus(status)
        model.settings.mode = "discography"; model.settings.seed = "Fixture"
        precondition(model.canSearchArtists && !model.canPreview && !model.includeAI)
        let before: FixtureState = try await api.call("/api/test-history-state")
        await model.searchArtists()
        precondition(model.artistMatches.map(\.id) == [2, 3], "Same-name catalog artists must remain separate choices")
        precondition(!model.canPreview && model.chosenArtist == nil, "Search must not silently pick an artist")
        model.chooseArtist(model.artistMatches[1])
        precondition(model.canPreview && model.chosenArtist?.id == 3)
        model.settings.country = "US"
        precondition(model.chosenArtist == nil && model.artistMatches.isEmpty && !model.canPreview, "A region change must discard old artist choices")
        model.settings.country = "AU"
        let _: OKResponse = try await api.call("/api/test-history-gate", body: ["route": "artists", "failure": false])
        let searching = Task { await model.searchArtists() }
        for _ in 0..<100 {
            let state: FixtureState = try await api.call("/api/test-history-state")
            if state.pending.contains("artists") { break }
            try await Task.sleep(for: .milliseconds(20))
        }
        model.settings.seed = "Changed query"
        let _: OKResponse = try await api.call("/api/test-history-release", body: ["route": "artists"])
        await searching.value
        precondition(model.artistMatches.isEmpty && model.chosenArtist == nil, "An outdated search response must not restore artist choices")
        model.settings.seed = "Fixture"
        let _: OKResponse = try await api.call("/api/test-history-gate", body: ["route": "artists", "failure": true])
        let staleFailure = Task { await model.searchArtists() }
        for _ in 0..<100 {
            let state: FixtureState = try await api.call("/api/test-history-state")
            if state.pending.contains("artists") { break }
            try await Task.sleep(for: .milliseconds(20))
        }
        model.settings.country = "US"
        let _: OKResponse = try await api.call("/api/test-history-release", body: ["route": "artists"])
        await staleFailure.value
        precondition(model.error == nil && model.artistMatches.isEmpty, "An outdated failed search must not overwrite current status")
        model.settings.country = "AU"
        model.settings.seed = "Fixture"
        await model.searchArtists()
        model.chooseArtist(model.artistMatches[0])
        model.acceptMusicStatus(status)
        precondition(model.chosenArtist?.id == 2, "An unchanged connection must preserve the selected artist")
        var replacement = status; replacement.generation = "g2"
        model.acceptMusicStatus(replacement)
        precondition(model.chosenArtist == nil && !model.canPreview, "An account change must discard the selected artist")
        model.acceptMusicStatus(status)
        await model.searchArtists()
        model.chooseArtist(model.artistMatches[0])
        await model.preview()
        precondition(model.draft?.request.mode == "discography" && model.draft?.request.artistId == 2)
        precondition(model.draft?.request.seed == "Fixture artist", "Preview must use the selected catalog identity, not the search query")
        precondition(model.visibleTracks.count == 3 && model.selected.count == 3, "A single and album occurrence must be independently selected")
        precondition(model.visibleTracks.map(\.catalogId) == [1, 2, 1])
        precondition(model.visibleTracks[0].releaseId == 10 && model.visibleTracks[2].releaseId == 20)
        await model.checkLibrary()
        precondition(model.preflight?.total == 3 && model.canCreate, "Preflight must submit visible release order, not lexicographic occurrence IDs")
        model.setSelected(model.visibleTracks[0].id, false)
        precondition(model.selected.count == 2 && model.selected.contains(model.visibleTracks[2].id), "Deselecting a single must not deselect its album copy")
        model.settings.mode = "artist"
        precondition(model.chosenArtist == nil && model.artistMatches.isEmpty && model.canPreview)
        let after: FixtureState = try await api.call("/api/test-history-state")
        precondition(after.counters["/api/jobs", default: 0] == before.counters["/api/jobs", default: 0], "Artist selection and preview must never create a playlist")
        await model.shutdown()
        print("Discography UI checks passed: explicit artist identity, stale-search rejection, region reset, release-order selection and repeated-song occurrences")
    }
}
