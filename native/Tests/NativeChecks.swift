import Foundation

@main struct NativeChecks {
    @MainActor static func main() async throws {
        try await ConnectionChecks.run()
        try await HistoryChecks.run()
        if let path = ProcessInfo.processInfo.environment["WAVELENGTH_PENDING_FIXTURE"] { try await DiscographyChecks.run(resources: URL(fileURLWithPath: path)); try await PendingChecks.run(resources: URL(fileURLWithPath: path)); try await HistoryChecks.run(resources: URL(fileURLWithPath: path)) }
        let api = APIClient(baseURL: URL(string: "http://127.0.0.1:12345")!)
        api.token = "session-token"
        let request = try api.request("/api/preflight", body: ["includeAI": false])
        precondition(request.value(forHTTPHeaderField: "Origin") == "http://127.0.0.1:12345")
        precondition(request.value(forHTTPHeaderField: "x-wavelength-token") == "session-token")
        precondition(request.httpMethod == "POST")
        let unsigned = APIClient(baseURL: api.baseURL)
        do { _ = try unsigned.request("/api/jobs", body: [:]); preconditionFailure("Write lacked a session token") } catch {}
        let read = try unsigned.request("/api/ready")
        precondition(read.httpMethod == "GET" && read.value(forHTTPHeaderField: "x-wavelength-token") == nil)
        let model = AppModel()
        let data = Data(#"{"id":"draft","request":{"mode":"genre","seed":"ambient","count":2,"selection":"mix","perArtist":1,"includeAI":false,"country":"AU"},"status":"ready","title":"Draft","tracks":[{"id":"one","catalogId":1,"artistId":2,"title":"Song","artist":"Artist","album":"Album","durationMs":120000,"releaseDate":"2026-01-01","url":"https://music.apple.com/","source":"test","match":"exact","provenance":{"kind":"unknown","evidence":[]},"selected":true},{"id":"review","catalogId":2,"artistId":3,"title":"Uncertain","artist":"Other","album":"Album","durationMs":120000,"releaseDate":"2026-01-01","url":"https://music.apple.com/","source":"test","match":"review","provenance":{"kind":"unknown","evidence":[]},"selected":true}],"warnings":[],"progress":{"done":2,"total":2,"message":"Ready"},"createdAt":"2026-01-01"}"#.utf8)
        model.receiveDraft(try JSONDecoder().decode(Draft.self, from: data))
        precondition(model.selected == ["one"], "Uncertain matches must start unselected")
        let revision = model.selectionRevision
        model.setSelected("one", false)
        model.acceptPreflight(Preflight(id: "stale", newLibraryAdditions: 1, existingLibrarySongs: 0, total: 1), revision: revision)
        precondition(model.preflight == nil, "Stale checks must not enable creation")
        model.setSelected("one", true)
        model.acceptPreflight(Preflight(id: "fresh", newLibraryAdditions: 1, existingLibrarySongs: 0, total: 1), revision: model.selectionRevision)
        precondition(model.preflight?.id == "fresh")
        precondition(model.canCreate == false, "Disconnected clients cannot create")
        model.name = "Renamed playlist"
        precondition(model.preflight?.id == "fresh", "Name changes should retain the library check")
        let beforeAssessment = model.selectionRevision
        model.applyProvenance(artistID: 3, provenance: Provenance(kind: "human", evidence: ["Local evidence"], note: nil))
        model.acceptPreflight(Preflight(id: "before-assessment", newLibraryAdditions: 1, existingLibrarySongs: 0, total: 1), revision: beforeAssessment)
        precondition(model.preflight == nil, "Provenance changes must discard in-flight library checks")
        model.includeAI = true
        precondition(model.preflight == nil)
        model.applyProvenance(artistID: 2, provenance: Provenance(kind: "ai", evidence: [], note: nil))
        model.includeAI = false
        precondition(model.selected.isEmpty)
        model.setSelected("one", true)
        precondition(model.selected.isEmpty, "Known AI tracks cannot be selected when AI is off")
        model.includeAI = true
        model.setSelected("one", true)
        let beforeRemoval = model.selectionRevision
        model.remove("one")
        model.acceptPreflight(Preflight(id: "before-removal", newLibraryAdditions: 1, existingLibrarySongs: 0, total: 1), revision: beforeRemoval)
        precondition(model.preflight == nil && !model.visibleTracks.contains { $0.id == "one" })
        model.receiveDraft(model.draft!)
        precondition(model.selected.isEmpty, "Repeated ready drafts must not restore a cleared selection")
        let failed = HTTPURLResponse(url: api.baseURL, statusCode: 403, httpVersion: nil, headerFields: nil)!
        do {
            let _: SessionResponse = try api.decode(Data(#"{"error":"Invalid session token"}"#.utf8), response: failed)
            preconditionFailure("Transport accepted a forbidden response")
        } catch { precondition(error.localizedDescription == "Invalid session token") }
        let success = HTTPURLResponse(url: api.baseURL, statusCode: 200, httpVersion: nil, headerFields: nil)!
        do { let _: SessionResponse = try api.decode(Data("not JSON".utf8), response: success); preconditionFailure("Malformed JSON accepted") } catch {}
        let engine = EngineController(resources: URL(fileURLWithPath: "/missing-resources"))
        do { _ = try await engine.start(); preconditionFailure("Missing bundle launched") } catch {}
        await engine.stop()
        let unrelated = Process()
        unrelated.executableURL = URL(fileURLWithPath: "/bin/sleep")
        unrelated.arguments = ["30"]
        try unrelated.run()
        await engine.stop()
        precondition(unrelated.isRunning, "Stopping an unstarted engine killed another process")
        unrelated.terminate()
        unrelated.waitUntilExit()
        if CommandLine.arguments.count > 1 {
            let dataDirectory = FileManager.default.temporaryDirectory.appendingPathComponent("wavelength-native-\(UUID().uuidString)")
            defer { try? FileManager.default.removeItem(at: dataDirectory) }
            let packaged = EngineController(resources: URL(fileURLWithPath: CommandLine.arguments[1]), dataDirectory: dataDirectory)
            let client = try await packaged.start()
            let child = packaged.process!
            precondition(client.baseURL.port != 8769, "Native app reused the developer port")
            let ready: ReadyResponse = try await client.call("/api/ready")
            precondition(ready.ready && !ready.instance.isEmpty)
            let sentinel = Process()
            sentinel.executableURL = URL(fileURLWithPath: "/bin/sleep")
            sentinel.arguments = ["30"]
            try sentinel.run()
            await packaged.stop()
            precondition(!child.isRunning, "Owned engine remained running")
            precondition(sentinel.isRunning, "Stopping the owned engine killed an unrelated process")
            sentinel.terminate(); sentinel.waitUntilExit()
            let restarted = try await packaged.start()
            let _: ReadyResponse = try await restarted.call("/api/ready")
            await packaged.stop()
            print("Packaged engine checks passed: bundled Bun/resources, nonce readiness, ephemeral port, shutdown and restart")
        }
        print("Native checks passed: transport, stale preflight, review defaults, AI exclusion, resource errors, process ownership")
    }
}
