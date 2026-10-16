import Foundation
import Darwin

private actor HistoryReadGate {
    private var release: CheckedContinuation<Data, Never>?
    private var started: CheckedContinuation<Void, Never>?
    func read() async -> Data {
        await withCheckedContinuation { continuation in
            release = continuation; started?.resume(); started = nil
        }
    }
    func wait() async {
        if release != nil { return }
        await withCheckedContinuation { started = $0 }
    }
    func finish() { release?.resume(returning: Data("Song Name,Event End Timestamp\nSong,".utf8)); release = nil }
}

private final class HistoryChunks: @unchecked Sendable {
    private let lock = NSLock()
    private var remaining: Int
    init(_ bytes: Int) { remaining = bytes }
    func next() -> Data? {
        lock.lock(); defer { lock.unlock() }
        guard remaining > 0 else { return nil }
        let count = min(65536, remaining); remaining -= count
        return Data(repeating: 65, count: count)
    }
}

enum HistoryChecks {
    @MainActor static func run() async throws {
        var row = HistoryRow(id: "track", label: "Song", artist: nil, album: nil, albumArtist: nil, genre: nil, libraryPlayCount: nil, activityRecords: 0, reportedDurationMs: nil, skippedCount: nil, favoriteTracks: nil, lastDate: nil)
        var firstAlbum = row; firstAlbum.label = "Shared album"; firstAlbum.artist = "Track artist"; firstAlbum.albumArtist = "First album artist"
        var secondAlbum = firstAlbum; secondAlbum.albumArtist = "Second album artist"
        precondition(firstAlbum.label == secondAlbum.label && firstAlbum.rankingDetail(for: "albums") == "First album artist" && secondAlbum.rankingDetail(for: "albums") == "Second album artist", "Same-name albums must display their distinct album artist identities")
        firstAlbum.albumArtist = nil
        precondition(firstAlbum.rankingDetail(for: "albums") == "Track artist", "Album rows must fall back to track artist")
        firstAlbum.artist = nil
        precondition(firstAlbum.rankingDetail(for: "albums") == "Unavailable", "Absent album and track artists must display Unavailable")
        for kind in ["artists", "genres", "tracks", "daily", "monthly", "hourly"] {
            precondition(secondAlbum.rankingDetail(for: kind) == nil, "Album artist details must not change nonalbum rows")
        }
        precondition(row.metricText(for: "libraryPlayCount") == "Unavailable")
        precondition(row.metricText(for: "activityRecords") == "0")
        precondition(row.metricText(for: "reportedDurationMs") == "Unavailable")
        row.reportedDurationMs = 0; row.libraryPlayCount = 0
        precondition(row.metricText(for: "reportedDurationMs") == "0 s" && row.metricText(for: "libraryPlayCount") == "0")
        row.reportedDurationMs = 61000
        precondition(row.metricText(for: "reportedDurationMs") == "1 min 1 s")
        row.libraryPlayCount = Double.greatestFiniteMagnitude; row.reportedDurationMs = Double.greatestFiniteMagnitude
        precondition(row.metricText(for: "libraryPlayCount") != "Unavailable" && row.metricText(for: "reportedDurationMs").contains(" h "))
        precondition(HistoryDate(kind: "date", value: "2026-01-01").displayText == "2026-01-01 · calendar date")
        precondition(HistoryDate(kind: "unresolved", value: "2026-01-01 12:00").displayText.contains("time zone unresolved"))
        precondition(HistoryDate(kind: "instant", value: "2026-01-01T12:00:00.000Z").displayText.contains(TimeZone.current.identifier))
        let summaryData = Data(#"{"source":"export","savedAt":"2026-01-01","profile":"recently-played","metricLabel":"Recently played records","totals":{"tracks":1,"artists":1,"albums":0,"libraryPlayCount":null,"activityRecords":1,"reportedDurationMs":null,"skippedCount":null,"favoriteTracks":null},"coverage":{"inputRows":1,"acceptedRows":1,"rejectedRows":0,"missing":{"artist":0,"album":1,"genre":1,"date":0,"reportedDurationMs":1,"mediaDurationMs":1},"firstDate":null,"lastDate":null,"datedRows":1,"instantRows":1,"durationRows":0,"enrichedRows":0,"unmatchedRows":1,"availableFields":["title"],"warnings":[]},"suggestions":[],"trendsAvailable":false}"#.utf8)
        var summary = try JSONDecoder().decode(HistorySourceSummary.self, from: summaryData)
        precondition(summary.sourceLabel == "Apple CSV · Recently played" && !summary.pageKinds.contains("daily"))
        summary.source = "library"; summary.profile = nil
        precondition(summary.sourceLabel == "Music library snapshot" && !summary.pageKinds.contains("hourly"))
        summary.source = "export"; summary.profile = "play-activity"; summary.trendsAvailable = true
        precondition(summary.sourceLabel == "Apple CSV · Play activity" && summary.pageKinds.contains("monthly"))
        summary.profile = "daily-tracks"
        precondition(summary.sourceLabel == "Apple CSV · Daily tracks")
        let api = APIClient(baseURL: URL(string: "http://127.0.0.1:12345")!)
        api.token = "fixture-token"
        let read = try api.request("/api/history?source=library&timeZone=Australia%2FBrisbane")
        precondition(read.value(forHTTPHeaderField: "x-wavelength-token") == "fixture-token")
        let unsigned = APIClient(baseURL: api.baseURL)
        do { _ = try unsigned.request("/api/history?timeZone=UTC"); preconditionFailure("Unsigned history read accepted") } catch {}
        let bootstrap = try unsigned.request("/api/ready")
        precondition(bootstrap.value(forHTTPHeaderField: "x-wavelength-token") == nil)
        let bytes = Data("Song Name,Event End Timestamp\nSong,".utf8)
        let csv = try api.csvRequest(bytes)
        precondition(csv.url?.path == "/api/history/preview" && csv.httpMethod == "POST")
        precondition(csv.value(forHTTPHeaderField: "Content-Type") == "text/csv; charset=utf-8")
        precondition(csv.value(forHTTPHeaderField: "Origin") == "http://127.0.0.1:12345")
        precondition(csv.value(forHTTPHeaderField: "x-wavelength-token") == "fixture-token" && csv.httpBody == bytes && csv.timeoutInterval == 120)
        let limit = 20 * 1024 * 1024
        do { _ = try api.csvRequest(Data(repeating: 0, count: limit + 1)); preconditionFailure("Oversized upload accepted") } catch { precondition(error.localizedDescription.contains("20 MiB")) }
        let chunks = HistoryChunks(limit)
        let exact = try await HistoryFileReader.readChunks(size: limit, next: { chunks.next() })
        precondition(exact.count == limit)
        let growth = HistoryChunks(limit + 1)
        do { _ = try await HistoryFileReader.readChunks(size: 1, next: { growth.next() }); preconditionFailure("Growing file accepted") } catch { precondition(error.localizedDescription.contains("20 MiB")) }
        do { _ = try await HistoryFileReader.readChunks(size: limit + 1, next: { preconditionFailure("Oversize must fail before reading") }); preconditionFailure("Announced oversize accepted") } catch {}
        let cancelled = Task { try await HistoryFileReader.readChunks(size: nil, next: { withUnsafeCurrentTask { $0?.cancel() }; return Data([65]) }) }
        do { _ = try await cancelled.value; preconditionFailure("Cancelled read accepted") } catch is CancellationError {} catch { preconditionFailure("Read lost cancellation") }
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("wavelength-file-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let file = directory.appendingPathComponent("selected.csv")
        try Data(repeating: 65, count: limit).write(to: file)
        let readFile = try await HistoryFileReader.read(file)
        precondition(readFile.count == limit)
        try Data(repeating: 65, count: limit + 1).write(to: file)
        do { _ = try await HistoryFileReader.read(file); preconditionFailure("Oversized selected file accepted") } catch {}
        do { _ = try await HistoryFileReader.read(directory); preconditionFailure("Directory accepted") } catch {}
        let fifo = directory.appendingPathComponent("selected-fifo.csv")
        precondition(mkfifo(fifo.path, 0o600) == 0)
        do { _ = try await HistoryFileReader.read(fifo); preconditionFailure("FIFO accepted") } catch {}
        try Data("bounded".utf8).write(to: file)
        let descriptors = try FileManager.default.contentsOfDirectory(atPath: "/dev/fd").count
        for _ in 0..<10 { _ = try await HistoryFileReader.read(file); do { _ = try await HistoryFileReader.read(directory) } catch {} }
        let afterDescriptors = try FileManager.default.contentsOfDirectory(atPath: "/dev/fd").count
        precondition(afterDescriptors == descriptors, "Rejected files leaked a handle")
        let cancelledFile = Task { try await HistoryFileReader.read(file) }
        cancelledFile.cancel()
        do { _ = try await cancelledFile.value; preconditionFailure("Cancelled selected file read accepted") } catch is CancellationError {} catch { preconditionFailure("Selected file read lost cancellation") }
        let model = AppModel()
        let suggestion = HistorySuggestion(artist: "Fixture artist", kind: "top", basis: "3 activity records")
        model.settings.country = "NZ"; model.settings.count = 12; model.settings.selection = "recent"
        model.requestHistorySeed(suggestion)
        precondition(model.page == .discover && model.settings.mode == "artist" && model.settings.seed == "Fixture artist")
        precondition(!model.includeAI && model.settings.country == "NZ" && model.settings.count == 12 && model.settings.selection == "recent")
        precondition(model.draft == nil && model.preflight == nil)
        model.includeAI = true; model.requestHistorySeed(HistorySuggestion(artist: "Other artist", kind: "top", basis: "fixture"))
        precondition(model.includeAI)
        for artist in ["", " ", "A\nB", "A\u{7F}B", String(repeating: "😀", count: 61)] {
            model.requestHistorySeed(HistorySuggestion(artist: artist, kind: "top", basis: "fixture"))
            precondition(model.settings.seed == "Other artist", "Unsafe history artist was applied")
        }
        let boundary = String(repeating: "😀", count: 60)
        model.requestHistorySeed(HistorySuggestion(artist: boundary, kind: "top", basis: "fixture"))
        precondition(model.settings.seed == boundary, "120 UTF-16 units should be accepted")
        print("History pure checks passed: authentication, byte transport, bounded reader, cancellation and seed validation")
        if CommandLine.arguments.count > 1 {
            let resources = URL(fileURLWithPath: CommandLine.arguments[1])
            try await runPackaged(resources: resources)
            try await runPackagedProfileReplacement(resources: resources)
        }
    }

    @MainActor private static func runPackagedProfileReplacement(resources: URL) async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("wavelength-profile-replacement-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try packagedDatabaseCheck(resources: resources, directory: directory, script: """
            import {Store} from './src/store.ts';
            import {libraryEnvelope} from './src/history.ts';
            const store = new Store();
            store.replaceHistory(libraryEnvelope({complete: true, declaredTrackCount: 1, warnings: [], tracks: [{id: '0000000000000001', title: 'Invented song', artist: 'Fixture artist', albumArtist: null, album: 'Fixture album', genre: null, durationMs: 120000, playedCount: 1, playedAt: null, skippedCount: 0, skippedAt: null, addedAt: null, favorite: false}]}, '2026-01-01T00:00:00Z'));
            store.close();
            """)
        let formatter = ISO8601DateFormatter()
        let rows = (0..<60).map { index in
            "Invented song \(index),Fixture artist,\(formatter.string(from: Date(timeIntervalSince1970: 1767225600 + Double(index) * 86400)))"
        }.joined(separator: "\n")
        let activity = Data("Song Name,Artist,Event End Timestamp\n\(rows)".utf8)
        let recent = Data("Track Description,Last Event End Timestamp\nInvented recent,2026-01-01T12:00:00Z".utf8)
        let engine = EngineController(resources: resources, dataDirectory: directory)
        let model = AppModel(engine: engine, historyFileReader: { url in url.lastPathComponent == "activity.csv" ? activity : recent })
        _ = try await connect(model, engine)
        let activityFile = directory.appendingPathComponent("activity.csv")
        let recentFile = directory.appendingPathComponent("recent.csv")
        await model.previewHistoryFile(activityFile); await model.importHistory(replace: false)
        model.selectHistorySource("export"); await model.loadHistory(kind: "tracks", offset: 50)
        precondition(model.history?.page?.rows.count == 10)
        await model.previewHistoryFile(recentFile); await model.importHistory(replace: true)
        precondition(model.error == nil && model.history?.page?.source == "export" && model.history?.page?.kind == "tracks" && model.history?.page?.offset == 50, "Replacing export must retain a supported export query")
        model.selectHistorySource("library"); await model.loadHistory(kind: "tracks", offset: 50)
        await model.previewHistoryFile(activityFile); await model.importHistory(replace: true)
        precondition(model.error == nil && model.history?.page?.source == "library" && model.history?.page?.kind == "tracks" && model.history?.page?.offset == 50, "Replacing export must retain the current library query")
        model.selectHistorySource("export")
        for kind in ["daily", "monthly", "hourly"] {
            await model.loadHistory(kind: kind, offset: 50)
            precondition(model.error == nil && model.history?.page?.kind == kind && model.history?.page?.offset == 50)
            if kind == "daily" { precondition(model.history?.page?.rows.count == 10) }
            await model.previewHistoryFile(recentFile); await model.importHistory(replace: true)
            precondition(model.error == nil, "Replacing \(kind) activity with Recently played must not issue an unsupported query")
            precondition(model.historyPreview == nil && model.historyOperation == .idle)
            precondition(model.history?.sources.first { $0.source == "export" }?.profile == "recently-played")
            precondition(model.history?.page?.source == "export" && model.history?.page?.kind == "artists" && model.history?.page?.offset == 0, "An unsupported trend page must be replaced by artists page zero")
            await model.previewHistoryFile(activityFile); await model.importHistory(replace: true)
            precondition(model.error == nil && model.history?.page?.kind == "artists" && model.history?.page?.offset == 0)
        }
        await model.shutdown()
        print("Packaged profile replacement checks passed: unsupported daily/monthly/hourly reset to artists page zero, valid export/library queries retained")
    }

    @MainActor private static func runPackaged(resources: URL) async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("wavelength-packaged-history-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let engine = EngineController(resources: resources, dataDirectory: directory)
        let api = try await engine.start()
        do {
            let empty: HistoryResponse = try await api.call("/api/history?timeZone=UTC")
            precondition(empty.sources.isEmpty && empty.page == nil)
            try packagedDatabaseCheck(resources: resources, directory: directory, script: """
                import {Store} from './src/store.ts';
                import {libraryEnvelope} from './src/history.ts';
                const store = new Store();
                for (const kind of ['draft', 'job', 'provenance']) store.put(kind, 'sentinel', {id: 'sentinel', state: 'complete', updatedAt: '2026-01-01', marker: 'preserve'});
                store.replaceHistory(libraryEnvelope({complete: true, declaredTrackCount: 1, warnings: [], tracks: [{id: '0000000000000001', title: 'Invented zero', artist: 'Fixture artist', albumArtist: null, album: null, genre: null, durationMs: 120000, playedCount: 0, playedAt: null, skippedCount: 0, skippedAt: null, addedAt: null, favorite: false}]}, '2026-01-01T00:00:00Z'));
                store.close();
                """)
            let library: HistoryResponse = try await api.call("/api/history?source=library&kind=tracks&timeZone=UTC")
            precondition(library.page?.rows.first?.metricText(for: "libraryPlayCount") == "0" && library.sources.first?.totals.reportedDurationMs == nil)
            let rows = (0..<60).map { "Invented song \($0),Fixture artist,2026-01-\(String(format: "%02d", $0 % 28 + 1))T12:00:00Z,\($0 == 0 ? "0" : "61000")" }.joined(separator: "\n")
            let csv = Data("Song Name,Artist,Event End Timestamp,Play Duration Milliseconds\n\(rows)".utf8)
            let preview: HistoryPreview = try await api.uploadCSV(csv)
            precondition(preview.profile == "play-activity" && !preview.replacesExport && preview.coverage.acceptedRows == 60)
            let stillEmpty: HistoryResponse = try await api.call("/api/history?timeZone=UTC")
            precondition(stillEmpty.sources.map(\.source) == ["library"], "Preview must never save")
            let saved: HistoryResponse = try await api.call("/api/history/import", body: ["token": preview.token, "replace": false])
            precondition(saved.sources.first { $0.source == "export" }?.totals.activityRecords == 60 && saved.sources.count == 2)
            let first: HistoryResponse = try await api.call("/api/history?source=export&kind=tracks&limit=50&timeZone=Australia%2FBrisbane")
            let second: HistoryResponse = try await api.call("/api/history?source=export&kind=tracks&limit=50&offset=50&timeZone=Australia%2FBrisbane")
            precondition(first.page?.rows.count == 50 && second.page?.rows.count == 10 && second.page?.offset == 50)
            let dates: HistoryResponse = try await api.call("/api/history?source=export&kind=daily&limit=50&timeZone=Australia%2FBrisbane")
            precondition(dates.page?.rows.count == 28 && dates.page?.timeZone == "Australia/Brisbane" && dates.page?.excludedRows == 0)
            precondition(dates.page?.rows.reduce(0, { $0 + ($1.activityRecords ?? 0) }) == 60)
            for (text, profile) in [("Track Description,Date Played\nInvented daily,2026-01-01", "daily-tracks"), ("Track Description,Last Event End Timestamp\nInvented recent,2026-01-01T12:00:00Z", "recently-played")] {
                let replacement: HistoryPreview = try await api.uploadCSV(Data(text.utf8))
                precondition(replacement.profile == profile && replacement.replacesExport)
                do { let _: HistoryResponse = try await api.call("/api/history/import", body: ["token": replacement.token, "replace": false]); preconditionFailure("Replacement saved without confirmation") } catch {}
                let unchanged: HistoryResponse = try await api.call("/api/history?timeZone=UTC")
                precondition(unchanged.sources.first { $0.source == "export" }?.profile != profile)
                let replaced: HistoryResponse = try await api.call("/api/history/import", body: ["token": replacement.token, "replace": true])
                precondition(replaced.sources.first { $0.source == "export" }?.profile == profile && replaced.sources.first { $0.source == "export" }?.totals.reportedDurationMs == nil)
                if profile == "recently-played" {
                    precondition(replaced.sources.first { $0.source == "export" }?.trendsAvailable == false)
                    do { let _: HistoryResponse = try await api.call("/api/history?source=export&kind=daily&timeZone=UTC"); preconditionFailure("Recently played exposed a timeline") } catch {}
                }
            }
            do { let _: HistoryPreview = try await api.uploadCSV(Data("Unsupported,Columns\nInvented,Only".utf8)); preconditionFailure("Unsupported CSV accepted") } catch {}
            let beforeForget: HistoryResponse = try await api.call("/api/history?timeZone=UTC")
            precondition(beforeForget.sources.first { $0.source == "export" }?.profile == "recently-played")
            let _: OKResponse = try await api.call("/api/history/forget", body: [:])
            let forgotten: HistoryResponse = try await api.call("/api/history?timeZone=UTC")
            precondition(forgotten.sources.isEmpty)
            try packagedDatabaseCheck(resources: resources, directory: directory, script: """
                import {Store} from './src/store.ts';
                const store = new Store(); store.put('history', 'export', {schemaVersion: 999}); store.close();
                """)
            do { let _: HistoryResponse = try await api.call("/api/history?timeZone=UTC"); preconditionFailure("Unsupported saved schema accepted") } catch { precondition(error.localizedDescription.contains("schema")) }
            let _: OKResponse = try await api.call("/api/history/forget", body: [:])
            try packagedDatabaseCheck(resources: resources, directory: directory, script: """
                import {Store} from './src/store.ts';
                const store = new Store();
                for (const kind of ['draft', 'job', 'provenance']) if (store.get(kind, 'sentinel')?.marker !== 'preserve') throw new Error('Forget removed unrelated ' + kind);
                if (store.history().length) throw new Error('Forget left history');
                store.close();
                """)
            await engine.stop()
        } catch { await engine.stop(); throw error }
        print("Packaged history checks passed: isolated empty startup, both sources, zero-play library, three profiles, preview without save, bounded pages, timezone bins, replacement decline/confirm, unsupported input and Forget recovering unsupported schema while preserving unrelated state")
    }

    private static func packagedDatabaseCheck(resources: URL, directory: URL, script: String) throws {
        let process = Process()
        process.executableURL = resources.appendingPathComponent("bin/bun")
        process.currentDirectoryURL = resources.appendingPathComponent("engine")
        process.arguments = ["-e", script]
        var environment = ProcessInfo.processInfo.environment
        environment["WAVELENGTH_DATA_DIR"] = directory.path
        process.environment = environment
        try process.run(); process.waitUntilExit()
        precondition(process.terminationStatus == 0, "Isolated packaged database check failed")
    }

    private struct FixtureState: Decodable { let counters: [String: Int]; let pending: [String] }
    @MainActor private static func state(_ api: APIClient) async throws -> FixtureState { try await api.call("/api/test-history-state") }
    @MainActor private static func gate(_ api: APIClient, _ route: String, failure: Bool = false) async throws {
        let _: OKResponse = try await api.call("/api/test-history-gate", body: ["route": route, "failure": failure])
    }
    @MainActor private static func release(_ api: APIClient, _ route: String) async throws {
        let _: OKResponse = try await api.call("/api/test-history-release", body: ["route": route])
    }
    @MainActor private static func wait(_ api: APIClient, _ route: String) async throws {
        for _ in 0..<1000 { if try await state(api).pending.contains(route) { return }; await Task.yield() }
        preconditionFailure("Missing controlled history request \(route)")
    }
    @MainActor private static func waitForPage(_ model: AppModel, _ api: APIClient, source: String) async throws {
        for _ in 0..<1000 {
            if model.history?.page?.source == source { return }
            _ = try await state(api)
        }
        preconditionFailure("Assigning historySource alone did not load its page")
    }
    @MainActor private static func connect(_ model: AppModel, _ engine: EngineController, expectsHistory: Bool = true) async throws -> APIClient {
        model.start()
        for _ in 0..<100 { if model.connected && (!expectsHistory || model.history != nil) { break }; try await Task.sleep(for: .milliseconds(30)) }
        precondition(model.connected && (!expectsHistory || model.history != nil))
        let log = try String(contentsOf: engine.logURL!, encoding: .utf8)
        let range = log.range(of: #"http://127\.0\.0\.1:[0-9]+"#, options: .regularExpression)!
        let api = APIClient(baseURL: URL(string: String(log[range]))!)
        let session: SessionResponse = try await api.call("/api/session"); api.token = session.token
        return api
    }
    @MainActor static func run(resources: URL) async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("wavelength-history-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let engine = EngineController(resources: resources, dataDirectory: directory)
        let model = AppModel(engine: engine)
        var api = try await connect(model, engine)
        precondition(model.page == .getStarted && model.historySource == "export")
        precondition(model.history?.sources.count == 2 && model.history?.sources[0].totals.reportedDurationMs == nil)
        let startup = try await state(api)
        precondition(startup.counters["/api/history", default: 0] > 0 && startup.counters["/api/history/library", default: 0] == 0)
        let unsigned = APIClient(baseURL: api.baseURL)
        let raw = URLRequest(url: api.baseURL.appendingPathComponent("api/history"))
        let (data, response) = try await URLSession.shared.data(for: raw)
        do { let _: HistoryResponse = try unsigned.decode(data, response: response); preconditionFailure("Engine accepted unsigned history read") } catch { precondition(error.localizedDescription.contains("token")) }
        for profile in ["play-activity", "daily-tracks", "recently-played"] {
            let response: HistoryResponse = try await api.call("/api/test-history-profile?profile=\(profile)")
            precondition(response.sources[1].profile == profile && response.sources[1].totals.libraryPlayCount == nil)
        }
        await model.loadHistory()
        await model.loadHistory(kind: "daily", offset: 50)
        let beforeNativeSource = try await state(api)
        model.selectHistorySource("library")
        try await waitForPage(model, api, source: "library")
        precondition(model.history?.page?.kind == "artists" && model.history?.page?.offset == 0)
        let afterNativeSource = try await state(api)
        precondition(afterNativeSource.counters["/api/history", default: 0] == beforeNativeSource.counters["/api/history", default: 0] + 1)
        model.selectHistorySource("library"); model.selectHistorySource("missing")
        await Task.yield()
        let afterRepeatedSource = try await state(api)
        precondition(afterRepeatedSource.counters["/api/history", default: 0] == afterNativeSource.counters["/api/history", default: 0])
        model.historySource = "export"; try await waitForPage(model, api, source: "export")
        let beforeSourceSelection = try await state(api)
        model.historySource = "library"
        try await waitForPage(model, api, source: "library")
        let afterSourceSelection = try await state(api)
        precondition(afterSourceSelection.counters["/api/history", default: 0] == beforeSourceSelection.counters["/api/history", default: 0] + 1, "A source selection must trigger exactly one refresh")
        try await gate(api, "query")
        let oldQuery = Task { await model.loadHistory(kind: "tracks", offset: 50) }
        try await wait(api, "query")
        model.historySource = "export"
        try await waitForPage(model, api, source: "export")
        try await release(api, "query"); await oldQuery.value
        precondition(model.history?.page?.source == "export" && model.history?.page?.kind == "tracks" && model.history?.page?.offset == 50, "Source-only refresh must retain the selected page and reject an older query")
        let beforeExplicitQuery = try await state(api)
        model.historySource = "library"; await model.loadHistory(kind: "albums", offset: 0)
        let afterExplicitQuery = try await state(api)
        precondition(afterExplicitQuery.counters["/api/history", default: 0] == beforeExplicitQuery.counters["/api/history", default: 0] + 1, "An explicit page query must supersede the queued source refresh")
        let beforeQueryFailure = model.history
        try await gate(api, "query", failure: true)
        let failedQuery = Task { await model.loadHistory(kind: "albums") }; try await wait(api, "query")
        try await release(api, "query"); await failedQuery.value
        precondition(model.history == beforeQueryFailure && model.error != nil, "Read failures must preserve saved history")
        let suggestion = HistorySuggestion(artist: "Fixture artist", kind: "top", basis: "3 records")
        let beforeSeed = try await state(api)
        model.requestHistorySeed(suggestion)
        let afterSeed = try await state(api)
        for route in ["/api/drafts", "/api/preflight", "/api/jobs"] { precondition(beforeSeed.counters[route, default: 0] == afterSeed.counters[route, default: 0]) }
        let draft: Draft = try await api.call("/api/test-draft")
        model.receiveDraft(draft); await model.checkLibrary()
        model.requestHistorySeed(suggestion)
        precondition(model.pendingHistorySeed == suggestion && model.draft?.id == "draft")
        let selection = model.selected; let settings = model.settings.seed
        model.cancelHistorySeed(); precondition(model.selected == selection && model.settings.seed == settings && model.preflight != nil)
        model.requestHistorySeed(suggestion); model.confirmHistorySeed()
        precondition(model.draft == nil && model.selected.isEmpty && model.removed.isEmpty && model.preflight == nil)
        model.receiveDraft(draft); model.requestHistorySeed(suggestion)
        var replacementDraft = draft; replacementDraft.id = "new-draft"
        model.receiveDraft(replacementDraft); model.confirmHistorySeed()
        precondition(model.draft?.id == "new-draft", "Confirmation must apply only to the draft shown in the prompt")
        model.cancelHistorySeed()
        model.receiveDraft(draft)
        try await gate(api, "preflight")
        let pendingCheck = Task { await model.checkLibrary() }; try await wait(api, "preflight")
        let beforePendingScan = try await state(api)
        await model.scanHistory()
        let afterPendingScan = try await state(api)
        precondition(beforePendingScan.counters["/api/history/library", default: 0] == afterPendingScan.counters["/api/history/library", default: 0], "Pending preflight must block history scans")
        try await release(api, "preflight"); await pendingCheck.value
        let beforeScanRevision = model.selectionRevision
        try await gate(api, "scan")
        let scan = Task { await model.scanHistory() }; try await wait(api, "scan")
        precondition(model.historyScanInFlight && model.historyOperation == .scanning && !model.canCheck && !model.canCreate && model.preflight == nil)
        model.acceptPreflight(Preflight(id: "before-scan", newLibraryAdditions: 1, existingLibrarySongs: 0, total: 1), revision: beforeScanRevision)
        precondition(model.preflight == nil, "A pre-scan library result must stay invalid")
        let beforeBlocked = try await state(api)
        await model.checkLibrary(); await model.create(); await model.jobAction("retry"); await model.jobAction("open")
        let afterBlocked = try await state(api)
        for route in ["/api/preflight", "/api/jobs", "/api/jobs/job/retry", "/api/jobs/job/open"] { precondition(beforeBlocked.counters[route, default: 0] == afterBlocked.counters[route, default: 0]) }
        model.historySource = "library"; await model.loadHistory(kind: "tracks", offset: 50)
        try await gate(api, "query")
        try await release(api, "scan"); try await wait(api, "query")
        precondition(!model.historyScanInFlight && model.historyOperation == .scanning, "Physical scan ownership must end before a pending summary refresh")
        try await release(api, "query"); await scan.value
        precondition(model.historyOperation == .idle && !model.historyScanInFlight && model.history?.page?.source == "library" && model.history?.page?.kind == "tracks" && model.history?.page?.offset == 50)
        precondition(model.history?.sources.first { $0.source == "library" }?.savedAt == "2026-02-01")
        let file = directory.appendingPathComponent("synthetic.csv")
        try Data("Song Name,Event End Timestamp\nSong,".utf8).write(to: file)
        await model.previewHistoryFile(file)
        precondition(model.historyPreview?.replacesExport == true && model.historyOperation == .idle)
        let beforeDecline = try await state(api)
        model.dismissHistoryPreview()
        precondition(model.historyPreview == nil && model.history != nil)
        let afterDecline = try await state(api)
        precondition(afterDecline.counters["/api/history/import", default: 0] == beforeDecline.counters["/api/history/import", default: 0])
        await model.previewHistoryFile(file)
        try await gate(api, "import")
        let importing = Task { await model.importHistory(replace: true) }; try await wait(api, "import")
        model.dismissHistoryPreview(); precondition(model.historyOperation == .importing && model.historyPreview != nil)
        model.historySource = "export"; await model.loadHistory(kind: "tracks", offset: 50)
        try await release(api, "import"); await importing.value
        precondition(model.historyPreview == nil && model.historyOperation == .idle && model.history?.page?.source == "export" && model.history?.page?.offset == 50)
        precondition(model.history?.sources.first { $0.source == "export" }?.savedAt == "2026-03-01")
        await model.previewHistoryFile(file)
        await model.importHistory(replace: false)
        precondition(model.error != nil && model.historyPreview != nil && model.history?.sources.count == 2)
        model.dismissHistoryPreview()
        try await gate(api, "preview")
        let preview = Task { await model.previewHistoryFile(file) }; try await wait(api, "preview")
        model.dismissHistoryPreview(); try await release(api, "preview"); await preview.value
        precondition(model.historyPreview == nil && model.historyOperation == .idle)
        try await gate(api, "preview")
        let stalePreview = Task { await model.previewHistoryFile(file) }; try await wait(api, "preview")
        model.dismissHistoryPreview(); await model.previewHistoryFile(file)
        try await gate(api, "import")
        let newImport = Task { await model.importHistory(replace: true) }; try await wait(api, "import")
        try await release(api, "preview"); await stalePreview.value
        precondition(model.historyOperation == .importing, "A stale preview defer must not clear a newer import")
        try await release(api, "import"); await newImport.value
        try await gate(api, "scan", failure: true)
        let failed = Task { await model.scanHistory() }; try await wait(api, "scan"); try await release(api, "scan"); await failed.value
        precondition(model.error?.contains("Automation") == true && model.history?.sources.count == 2 && !model.historyScanInFlight)
        try await gate(api, "scan")
        let forgottenScan = Task { await model.scanHistory() }; try await wait(api, "scan")
        await model.forgetHistory()
        precondition(model.history?.sources.isEmpty == true && model.historyScanInFlight)
        let beforeSecondScan = try await state(api)
        await model.scanHistory(); await model.checkLibrary(); await model.create()
        let afterSecondScan = try await state(api)
        precondition(afterSecondScan.counters["/api/history/library"] == beforeSecondScan.counters["/api/history/library"])
        try await gate(api, "preview")
        let newerPreview = Task { await model.previewHistoryFile(file) }; try await wait(api, "preview")
        try await release(api, "scan"); await forgottenScan.value
        precondition(model.history?.sources.isEmpty == true && !model.historyScanInFlight && model.historyOperation == .parsing, "An old scan defer must preserve the newer preview operation")
        model.dismissHistoryPreview(); try await release(api, "preview"); await newerPreview.value
        precondition(model.historyOperation == .idle)
        await model.previewHistoryFile(file); precondition(model.historyPreview?.replacesExport == false)
        await model.importHistory(replace: false); precondition(model.history?.sources.map(\.source) == ["export"])
        try await gate(api, "preview")
        let forgottenPreview = Task { await model.previewHistoryFile(file) }; try await wait(api, "preview")
        await model.forgetHistory(); try await release(api, "preview"); await forgottenPreview.value
        precondition(model.historyPreview == nil && model.history?.sources.isEmpty == true)
        try await gate(api, "preview")
        let restartingPreview = Task { await model.previewHistoryFile(file) }; try await wait(api, "preview")
        try await gate(api, "query")
        let restartingQuery = Task { await model.loadHistory(kind: "albums", offset: 50) }; try await wait(api, "query")
        await model.shutdown(); api = try await connect(model, engine); await restartingPreview.value; await restartingQuery.value
        await model.loadHistory()
        precondition(model.historyPreview == nil && model.historyOperation == .idle && !model.historyScanInFlight && model.history?.sources.count == 2)
        precondition(model.history?.page?.kind == "artists" && model.history?.page?.offset == 0, "Old engine queries must not replace the restarted page")
        try await gate(api, "scan")
        let restartingScan = Task { await model.scanHistory() }; try await wait(api, "scan")
        await model.shutdown(); api = try await connect(model, engine); await restartingScan.value
        precondition(!model.historyScanInFlight && model.historyOperation == .idle && model.history?.sources.first { $0.source == "library" }?.savedAt == "2026-01-01", "An old engine scan must not change the restarted summaries")
        let historyBeforeMissingFile = model.history
        await model.previewHistoryFile(directory.appendingPathComponent("missing.csv"))
        precondition(model.history == historyBeforeMissingFile && model.historyPreview == nil && model.historyOperation == .idle && model.error != nil)
        model.receiveDraft(draft); model.requestHistorySeed(suggestion)
        await model.checkLibrary()
        let creating = Task { await model.create() }
        for _ in 0..<1000 { let pending: OKResponse = try await api.call("/api/test-pending"); if pending.ok { break }; await Task.yield() }
        precondition(model.pendingMusicRequest)
        model.confirmHistorySeed(); model.requestHistorySeed(suggestion); await model.scanHistory()
        precondition(model.draft?.id == "draft" && model.pendingHistorySeed != nil && !model.historyScanInFlight)
        let _: OKResponse = try await api.call("/api/test-release", body: [:]); await creating.value
        model.cancelHistorySeed()
        try await gate(api, "scan")
        let jobScan = Task { await model.scanHistory() }; try await wait(api, "scan")
        let beforeActions = try await state(api)
        await model.jobAction("retry"); await model.jobAction("open")
        let afterActions = try await state(api)
        precondition(beforeActions.counters["/api/jobs/job/retry", default: 0] == afterActions.counters["/api/jobs/job/retry", default: 0] && beforeActions.counters["/api/jobs/job/open", default: 0] == afterActions.counters["/api/jobs/job/open", default: 0])
        try await release(api, "scan"); await jobScan.value
        var building = draft; building.status = "building"; model.receiveDraft(building)
        model.requestHistorySeed(suggestion); await model.scanHistory()
        precondition(model.pendingHistorySeed == nil && !model.historyScanInFlight && model.building)
        model.receiveDraft(draft); await model.checkLibrary()
        let _: OKResponse = try await api.call("/api/test-failure", body: ["started": true, "readinessFailures": 1])
        let ambiguous = Task { await model.jobAction("retry") }
        for _ in 0..<1000 { let pending: OKResponse = try await api.call("/api/test-pending"); if pending.ok { break }; await Task.yield() }
        let _: OKResponse = try await api.call("/api/test-release", body: [:]); await ambiguous.value
        precondition(model.musicWriteUnconfirmed && model.activeJob)
        model.requestHistorySeed(suggestion); await model.scanHistory()
        precondition(model.pendingHistorySeed == nil && !model.historyScanInFlight)
        for _ in 0..<100 { if !model.musicWriteUnconfirmed { break }; try await Task.sleep(for: .milliseconds(20)) }
        precondition(model.job?.active == true)
        model.requestHistorySeed(suggestion); await model.scanHistory()
        precondition(model.pendingHistorySeed == nil && !model.historyScanInFlight)
        await model.shutdown()
        setenv("WAVELENGTH_HISTORY_ACTIVE_JOB", "1", 1)
        let restored = AppModel(engine: engine)
        _ = try await connect(restored, engine)
        unsetenv("WAVELENGTH_HISTORY_ACTIVE_JOB")
        precondition(restored.page == .discover && restored.activeJob)
        await restored.shutdown()
        let readGate = HistoryReadGate()
        let readingModel = AppModel(engine: engine, historyFileReader: { _ in await readGate.read() })
        let readingAPI = try await connect(readingModel, engine)
        let beforeRead = try await state(readingAPI)
        let reading = Task { await readingModel.previewHistoryFile(file) }
        await readGate.wait(); precondition(readingModel.historyOperation == .readingFile)
        readingModel.dismissHistoryPreview(); await readGate.finish(); await reading.value
        let afterRead = try await state(readingAPI)
        precondition(readingModel.historyPreview == nil && readingModel.historyOperation == .idle && beforeRead.counters["/api/history/preview", default: 0] == afterRead.counters["/api/history/preview", default: 0], "Dismissed file reading must never upload")
        await readingModel.shutdown()
        setenv("WAVELENGTH_HISTORY_READ_FAILURE", "1", 1)
        let failedStartup = AppModel(engine: engine)
        let failedStartupAPI = try await connect(failedStartup, engine, expectsHistory: false)
        unsetenv("WAVELENGTH_HISTORY_READ_FAILURE")
        await failedStartup.loadHistory()
        let startupFailureState = try await state(failedStartupAPI)
        precondition(failedStartup.connected && failedStartup.history == nil && failedStartup.error != nil && startupFailureState.counters["/api/genres", default: 0] > 0 && startupFailureState.counters["/api/history/library", default: 0] == 0, "History read failure must leave startup usable without scanning")
        await failedStartup.shutdown()
        print("History workflow checks passed: startup, profiles, source races, guarded seed handoff, import, Forget, scan ownership and restart")
    }
}
