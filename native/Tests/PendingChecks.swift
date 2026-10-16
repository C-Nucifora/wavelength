import Foundation

enum PendingChecks {
    @MainActor static func run(resources: URL) async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("wavelength-pending-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let engine = EngineController(resources: resources, dataDirectory: directory)
        let model = AppModel(engine: engine)
        model.start()
        for _ in 0..<100 {
            if model.connected { break }
            try await Task.sleep(for: .milliseconds(30))
        }
        precondition(model.connected, "Fixture model did not connect")
        let log = try String(contentsOf: engine.logURL!, encoding: .utf8)
        let range = log.range(of: #"http://127\.0\.0\.1:[0-9]+"#, options: .regularExpression)!
        let api = APIClient(baseURL: URL(string: String(log[range]))!)
        let session: SessionResponse = try await api.call("/api/session")
        api.token = session.token
        try await checkCovers(model, api: api)
        try await checkAvailability(model, api: api)
        let draft: Draft = try await api.call("/api/test-draft")
        model.receiveDraft(draft)
        await model.checkLibrary()
        precondition(model.canCreate)
        let creating = Task { await model.create() }
        try await waitForRequest(api)
        precondition(model.activeJob && model.pendingMusicRequest, "Quit confirmation must cover a delayed Create response")
        try await assertLocked(model)
        let _: OKResponse = try await api.call("/api/test-release", body: [:])
        await creating.value
        precondition(!model.busy && !model.activeJob && !model.pendingMusicRequest && model.job?.state == "partial")
        let retrying = Task { await model.jobAction("retry") }
        try await waitForRequest(api)
        precondition(model.activeJob && model.pendingMusicRequest, "Quit confirmation must cover a delayed Retry response")
        try await assertLocked(model)
        let _: OKResponse = try await api.call("/api/test-release", body: [:])
        await retrying.value
        precondition(!model.busy && !model.activeJob && !model.pendingMusicRequest && model.job?.state == "partial")
        let _: OKResponse = try await api.call("/api/test-failure", body: ["started": false])
        let failing = Task { await model.jobAction("retry") }
        try await waitForRequest(api)
        precondition(model.activeJob)
        let _: OKResponse = try await api.call("/api/test-release", body: [:])
        await failing.value
        precondition(!model.busy && !model.activeJob && model.error != nil, "Rejected writes must clear the pending guard")
        let _: OKResponse = try await api.call("/api/test-failure", body: ["started": true, "readinessFailures": 1])
        let ambiguous = Task { await model.jobAction("retry") }
        try await waitForRequest(api)
        let _: OKResponse = try await api.call("/api/test-release", body: [:])
        await ambiguous.value
        precondition(model.activeJob && model.musicWriteUnconfirmed && !model.pendingMusicRequest, "An unavailable saved-state read must retain the quit and editing guard")
        try await assertLocked(model)
        for _ in 0..<100 {
            if !model.musicWriteUnconfirmed { break }
            try await Task.sleep(for: .milliseconds(20))
        }
        precondition(model.activeJob && model.job?.state == "running", "Failed responses must restore a server-started job before unlocking edits")
        precondition(!model.pendingMusicRequest && !model.musicWriteUnconfirmed)
        await model.shutdown()
        model.start()
        for _ in 0..<100 {
            if model.connected { break }
            try await Task.sleep(for: .milliseconds(30))
        }
        precondition(model.connected)
        let newLog = try String(contentsOf: engine.logURL!, encoding: .utf8)
        let newRange = newLog.range(of: #"http://127\.0\.0\.1:[0-9]+"#, options: .regularExpression)!
        let newAPI = APIClient(baseURL: URL(string: String(newLog[newRange]))!)
        let newSession: SessionResponse = try await newAPI.call("/api/session")
        newAPI.token = newSession.token
        await model.checkLibrary()
        let quitting = Task { await model.create() }
        try await waitForRequest(newAPI)
        precondition(model.activeJob)
        await model.shutdown()
        await quitting.value
        precondition(!model.pendingMusicRequest && !model.busy && !engine.running, "Confirmed quit during a pending response must clean up safely")
        print("Pending write checks passed: delayed Create/Retry quit guard, editing lock, rejection cleanup and saved-job reconciliation")
    }
    private struct FixtureState: Decodable { var counters: [String: Int] }
    @MainActor private static func checkCovers(_ model: AppModel, api: APIClient) async throws {
        let applying: MusicJob = try await api.call("/api/test-cover", body: ["state": "applying", "helperAttempted": true])
        model.acceptJob(applying)
        precondition(model.activeJob && !model.canManageConnection && !model.canScanHistory, "Cover excludes connection changes and history scans")
        let before: FixtureState = try await api.call("/api/test-history-state")
        await model.scanHistory()
        await model.connectionAction("disconnect")
        await model.jobAction("cancel")
        await model.jobAction("retry")
        let blocked: MusicJob = try await api.call("/api/test-cover", body: ["state": "blocked", "helperAttempted": true, "code": "automation-permission", "writeAttempted": false])
        for _ in 0..<100 {
            if model.job?.cover?.state == "blocked" { break }
            try await Task.sleep(for: .milliseconds(30))
        }
        precondition(model.job?.cover?.state == blocked.cover?.state && !model.activeJob, "Complete songs continue polling through cover work")
        precondition(model.job?.addedCount == 1 && model.job?.message == "All songs added.", "Cover block preserves completed songs")
        let after: FixtureState = try await api.call("/api/test-history-state")
        for route in ["/api/history/library", "/api/jobs/\(applying.id)/cancel", "/api/jobs/\(applying.id)/retry"] { precondition(before.counters[route, default: 0] == after.counters[route, default: 0], "Cover work must exclude song and scan actions") }
        await model.coverAction("cover-retry")
        precondition(model.job?.cover?.state == "blocked", "Permission status offers no retry")
        for (code, state, attempted, action) in [("automation-permission", "blocked", false, "cover-permission"), ("permission-ready", "blocked", false, "cover-retry"), ("image-unconfirmed", "uncertain", true, "cover-check")] {
            let current: MusicJob = try await api.call("/api/test-cover", body: ["state": state, "helperAttempted": true, "code": code, "writeAttempted": attempted])
            model.acceptJob(current)
            if action == "cover-permission" {
                let _: OKResponse = try await api.call("/api/test-history-gate", body: ["route": "cover", "failure": true])
                let actionTask = Task { await model.coverAction(action) }
                for _ in 0..<100 {
                    let state: CoverFixtureState = try await api.call("/api/test-history-state")
                    if state.pending.contains("cover") { break }
                    try await Task.sleep(for: .milliseconds(20))
                }
                precondition(model.activeJob && model.pendingMusicRequest, "Pending cover response must retain quit and editing guard")
                let _: OKResponse = try await api.call("/api/test-history-release", body: ["route": "cover"])
                await actionTask.value
            } else { await model.coverAction(action) }
            precondition(model.job?.coverActive == true && model.job?.state == "complete" && model.job?.addedCount == 1)
            let counts: FixtureState = try await api.call("/api/test-history-state")
            precondition(counts.counters["/api/jobs/\(applying.id)/\(action)"] == 1, "Cover-only actions dispatch their own empty-body route")
        }
        model.acceptJob(nil)
        print("Cover UI checks passed: complete-song polling, busy exclusions, permission/retry/check routes and preserved song results")
    }
    private struct CoverFixtureState: Decodable { var pending: [String] }
    @MainActor private static func checkAvailability(_ model: AppModel, api: APIClient) async throws {
        let status = MusicStatus(platform: "darwin", running: false, accessibility: false, automation: "unknown", message: "Saved fixture", backend: "web-session", connection: "saved", generation: "g1", storefront: "au")
        model.acceptMusicStatus(status)
        let mixed: Draft = try await api.call("/api/test-availability-draft")
        model.receiveDraft(mixed)
        precondition(model.selected == ["one", "two"] && !model.includeAI)
        await model.checkLibrary()
        precondition(!model.canCreate && model.canDeselectUnavailable)
        precondition(model.unavailableStorefront(for: mixed.tracks[0]) == nil && model.unavailableStorefront(for: mixed.tracks[1]) == "AU")
        precondition(model.selected == ["one", "two"], "Checking must never deselect songs")
        let receipt = model.preflight!
        let revision = model.selectionRevision
        let before: FixtureState = try await api.call("/api/test-history-state")
        await model.create()
        model.deselectUnavailable()
        let after: FixtureState = try await api.call("/api/test-history-state")
        for route in ["/api/preflight", "/api/jobs"] { precondition(before.counters[route, default: 0] == after.counters[route, default: 0], "Deselect must start no check or playlist request") }
        precondition(model.selected == ["one"] && model.preflight == nil && !model.canCreate && model.canCheck && !model.canDeselectUnavailable)
        precondition(model.visibleTracks.count == 3 && model.unavailableStorefront(for: mixed.tracks[1]) == "AU", "Deselected songs must remain visible and marked")
        model.acceptPreflight(receipt, revision: revision)
        precondition(model.preflight == nil, "Deselect must invalidate an in-flight old receipt")
        await model.checkLibrary()
        precondition(model.canCreate && model.preflight?.total == 1 && model.unavailableStorefront(for: mixed.tracks[1]) == nil)
        model.setSelected("two", true)
        await model.checkLibrary()
        var replacement = status; replacement.generation = "g2"
        model.acceptMusicStatus(replacement)
        precondition(model.preflight == nil && model.unavailableStorefront(for: mixed.tracks[1]) == nil, "Connection changes must clear availability labels")
        model.acceptPreflight(receipt, revision: model.selectionRevision)
        precondition(model.preflight == nil && model.unavailableStorefront(for: mixed.tracks[1]) == nil, "Stale generations must not restore labels")
        model.acceptMusicStatus(status)
        await model.checkLibrary()
        model.receiveDraft(Draft(id: "replacement", request: mixed.request, status: mixed.status, title: mixed.title, tracks: mixed.tracks, warnings: mixed.warnings, progress: mixed.progress, createdAt: mixed.createdAt))
        precondition(model.unavailableStorefront(for: mixed.tracks[1]) == nil && model.preflight == nil, "New drafts must clear availability labels")
        print("Availability checks passed: explicit deselection, retained row labels, recheck, AI exclusion, no automatic requests and stale receipt protection")
    }
    @MainActor private static func waitForRequest(_ api: APIClient) async throws {
        for _ in 0..<100 {
            let state: OKResponse = try await api.call("/api/test-pending")
            if state.ok { return }
            try await Task.sleep(for: .milliseconds(20))
        }
        preconditionFailure("Fixture did not receive a delayed write")
    }
    @MainActor private static func assertLocked(_ model: AppModel) async throws {
        let selected = model.selected
        let visible = model.visibleTracks.map(\.id)
        let includeAI = model.includeAI
        let name = model.name
        model.setSelected("one", false)
        model.remove("one")
        model.includeAI.toggle()
        model.name = "Changed during submission"
        let saved = await model.saveProvenance(track: model.visibleTracks[0], kind: "ai", evidence: "Not submitted")
        precondition(!saved && model.selected == selected && model.visibleTracks.map(\.id) == visible)
        precondition(model.includeAI == includeAI && model.name == name, "Pending writes must freeze the submitted draft settings")
        precondition(!model.canCreate && !model.canCheck && !model.canPreview)
    }
}
