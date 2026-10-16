import Foundation
import Combine
import AppKit

enum AppPage: String, CaseIterable { case getStarted, discover, listening }
enum HistoryOperation: Equatable { case idle, readingFile, parsing, scanning, importing, forgetting }

@MainActor final class AppModel: ObservableObject {
    @Published var page: AppPage = .getStarted
    @Published private(set) var history: HistoryResponse?
    @Published private(set) var historyPreview: HistoryPreview?
    @Published var historySource: String? {
        didSet {
            guard historySource != oldValue else { return }
            historyQueryRevision += 1
            history?.page = nil
            guard connected, historySource != nil else { return }
            let revision = historyQueryRevision; let session = epoch
            Task {
                guard revision == historyQueryRevision, session == epoch else { return }
                await loadHistory(kind: historyKind, offset: historyOffset)
            }
        }
    }
    @Published private(set) var historyOperation: HistoryOperation = .idle
    @Published private(set) var historyScanInFlight = false
    @Published private(set) var pendingHistorySeed: HistorySuggestion?
    @Published var settings = SeedRequest() {
        didSet {
            if settings.mode != oldValue.mode || settings.seed != oldValue.seed || settings.country != oldValue.country {
                resetArtistSearch()
            }
        }
    }
    @Published private(set) var artistMatches: [CatalogArtist] = []
    @Published private(set) var chosenArtist: CatalogArtist?
    private var artistSearchRevision = 0
    @Published var includeAI = false {
        didSet {
            guard !restoringLockedSetting else { return }
            guard includeAI != oldValue else { return }
            guard !activeJob else { restoringLockedSetting = true; includeAI = oldValue; restoringLockedSetting = false; return }
            invalidatePreflight()
            if !includeAI { selected.subtract(draft?.tracks.filter { $0.provenance.kind == "ai" }.map(\.id) ?? []) }
        }
    }
    @Published private(set) var draft: Draft?
    @Published private(set) var selected = Set<String>()
    @Published private(set) var removed = Set<String>()
    @Published var name = "" {
        didSet {
            if !restoringLockedSetting && activeJob && name != oldValue {
                restoringLockedSetting = true; name = oldValue; restoringLockedSetting = false
            }
        }
    }
    @Published private(set) var job: MusicJob?
    @Published private(set) var coverThumbnail: NSImage?
    private var coverThumbnailKey: String?
    @Published private(set) var preflight: Preflight?
    @Published private(set) var catalogAvailability: Preflight?
    @Published private(set) var genres: [Genre] = []
    @Published private(set) var musicStatus: MusicStatus?
    @Published private(set) var connected = false
    @Published private(set) var starting = false
    @Published private(set) var busy = false
    @Published private(set) var pendingMusicRequest = false
    @Published private(set) var musicWriteUnconfirmed = false
    @Published var message = "Starting the local engine…"
    @Published var error: String?
    @Published var genreError: String?
    private(set) var selectionRevision = 0
    private var preflightDate: Date?
    private var api: APIClient?
    let engine: EngineController
    let musicConnection: MusicConnection
    private var connectionUpdates: AnyCancellable?
    private var polling: Task<Void, Never>?
    private var startup: Task<Void, Never>?
    private var epoch = 0
    private var jobRevision = 0
    private var restoringLockedSetting = false
    private var historyOperationRevision = 0
    private var historyQueryRevision = 0
    private var historyKind = "artists"
    private var historyOffset = 0
    private var historyScanOwner: UUID?
    private var historyScanEpoch: Int?
    private var historyLoading: Task<Void, Never>?
    private var pendingHistoryDraftID: String?
    private let historyFileReader: @Sendable (URL) async throws -> Data
    init(engine: EngineController? = nil, historyFileReader: @escaping @Sendable (URL) async throws -> Data = { try await HistoryFileReader.read($0) }) {
        self.engine = engine ?? EngineController()
        self.musicConnection = MusicConnection(resources: self.engine.resources)
        self.historyFileReader = historyFileReader
        connectionUpdates = musicConnection.objectWillChange.sink { [weak self] _ in self?.objectWillChange.send() }
    }
    var building: Bool { draft?.status == "building" }
    var activeJob: Bool { pendingMusicRequest || musicWriteUnconfirmed || job?.active == true || musicConnection.busy }
    var canManageConnection: Bool { connected && !busy && !activeJob && !historyScanInFlight }
    var visibleTracks: [DraftTrack] { draft?.tracks.filter { !removed.contains($0.id) } ?? [] }
    var canSearchArtists: Bool { connected && !busy && !building && !activeJob && !historyScanInFlight && settings.mode == "discography" && !settings.seed.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && settings.seed.utf16.count <= 120 }
    var canPreview: Bool { connected && !busy && !building && !activeJob && !historyScanInFlight && !settings.seed.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && settings.seed.utf16.count <= 120 && (settings.mode == "discography" ? chosenArtist != nil : (1...50).contains(settings.count)) }
    var canCheck: Bool { connected && !busy && !historyScanInFlight && !building && !activeJob && draft?.status == "ready" && !selected.isEmpty }
    var canCreate: Bool { connected && !busy && !historyScanInFlight && !building && !activeJob && draft?.status == "ready" && !selected.isEmpty && !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && name.count <= 150 && preflight != nil && (preflight?.unavailableCatalogTracks ?? 0) == 0 && Date().timeIntervalSince(preflightDate ?? .distantPast) < 600 }
    var canDeselectUnavailable: Bool { canCheck && visibleTracks.contains { selected.contains($0.id) && unavailableStorefront(for: $0) != nil } }
    var canScanHistory: Bool { connected && !busy && !building && !activeJob && !historyScanInFlight && historyOperation == .idle }
    var suggestionNames: [Genre] { Array(genres.filter { settings.seed.isEmpty || $0.name.localizedCaseInsensitiveContains(settings.seed) }.prefix(7)) }
    func invalidatePreflight(clearAvailability: Bool = false) {
        selectionRevision += 1; preflight = nil; preflightDate = nil
        if clearAvailability { catalogAvailability = nil }
    }
    func unavailableStorefront(for track: DraftTrack) -> String? {
        guard let check = catalogAvailability, check.unavailableCatalogIds?.contains(String(track.catalogId)) == true else { return nil }
        return check.storefront?.uppercased() ?? "your storefront"
    }
    func deselectUnavailable() {
        guard canDeselectUnavailable else { return }
        selected.subtract(visibleTracks.filter { unavailableStorefront(for: $0) != nil }.map(\.id))
        invalidatePreflight()
        message = "Unavailable songs deselected. Check the remaining \(selected.count) songs again before creating."
    }
    func setSelected(_ id: String, _ value: Bool) {
        guard !building, !activeJob, let track = draft?.tracks.first(where: { $0.id == id }), !removed.contains(id) else { return }
        guard !value || includeAI || track.provenance.kind != "ai" else { return }
        invalidatePreflight()
        if value { selected.insert(id) } else { selected.remove(id) }
    }
    func remove(_ id: String) { guard !building, !activeJob else { return }; invalidatePreflight(); selected.remove(id); removed.insert(id) }
    func receiveDraft(_ incoming: Draft) {
        let changed = draft?.id != incoming.id
        let wasBuilding = building
        draft = incoming
        if changed {
            removed = []
            selected = Set(incoming.tracks.filter { $0.selected && $0.match == "exact" && (includeAI || $0.provenance.kind != "ai") }.map(\.id))
            name = incoming.title
            invalidatePreflight(clearAvailability: true)
        } else if wasBuilding && incoming.status == "ready" {
            // Discovery publishes its tracks only when the draft finishes.
            selected = Set(incoming.tracks.filter { $0.selected && $0.match == "exact" && (includeAI || $0.provenance.kind != "ai") }.map(\.id))
        }
    }
    func acceptPreflight(_ incoming: Preflight, revision: Int) {
        guard revision == selectionRevision else { return }
        if let generation = incoming.generation, let current = musicStatus?.generation, generation != current { return }
        preflight = incoming
        catalogAvailability = incoming
        preflightDate = Date()
    }
    func acceptMusicStatus(_ incoming: MusicStatus) {
        if incoming.generation != musicStatus?.generation { invalidatePreflight(clearAvailability: true); resetArtistSearch() }
        musicStatus = incoming
    }
    func acceptJob(_ incoming: MusicJob?) {
        job = incoming
        let key = incoming.flatMap { value in value.cover?.imageHash.map { value.id + ":" + $0 } }
        guard key != coverThumbnailKey else { return }
        coverThumbnailKey = key; coverThumbnail = nil
        guard let incoming, let hash = incoming.cover?.imageHash else { return }
        let id = incoming.id
        Task {
            let bytes = await Task.detached { try? PlaylistCover.thumbnailData(jobID: id, expectedHash: hash) }.value
            guard coverThumbnailKey == key, job?.id == id, job?.cover?.imageHash == hash else { return }
            coverThumbnail = bytes.flatMap { NSImage(data: $0) }
        }
    }
    func connectionAction(_ action: String) async {
        guard canManageConnection else { return }
        invalidatePreflight(clearAvailability: true)
        switch action {
        case "save": await musicConnection.save(expectedGeneration: musicStatus?.generation)
        case "check": await musicConnection.check(expectedGeneration: musicStatus?.generation)
        case "disconnect": await musicConnection.disconnect(expectedGeneration: musicStatus?.generation)
        default: return
        }
        if let status = musicConnection.status { acceptMusicStatus(status); message = status.message }
        if let error = musicConnection.error { self.error = error }
    }
    func applyProvenance(artistID: Int, provenance: Provenance) {
        invalidatePreflight()
        if var value = draft {
            for index in value.tracks.indices where value.tracks[index].artistId == artistID {
                value.tracks[index].provenance = provenance
                if !includeAI && provenance.kind == "ai" { selected.remove(value.tracks[index].id) }
            }
            draft = value
        }
    }
    func start() {
        guard !starting else { return }
        startup = Task { await initialize() }
    }
    private func initialize() async {
        starting = true; connected = false; error = nil; message = "Starting the local engine…"
        epoch += 1
        resetHistorySession()
        resetArtistSearch()
        let revision = epoch
        polling?.cancel()
        invalidatePreflight(clearAvailability: true)
        do {
            let client = try await engine.start()
            try Task.checkCancellation()
            guard revision == epoch else { return }
            api = client
            let ready: ReadyResponse = try await client.call("/api/ready")
            acceptJob(ready.activeJob)
            musicWriteUnconfirmed = false
            connected = true; starting = false; message = "Ready to preview. Connect to Apple Music before creating a playlist."
            page = draft != nil || activeJob ? .discover : .getStarted
            polling = Task { await poll(revision: revision) }
            historyLoading = Task { await loadHistory() }
            do { let response: GenresResponse = try await client.call("/api/genres"); genres = response.genres; genreError = nil }
            catch { if !Task.isCancelled { genreError = error.localizedDescription } }
        } catch {
            if !Task.isCancelled { self.error = error.localizedDescription; message = "Startup failed. Retry to start the local engine." }
            starting = false
        }
    }
    func shutdown() async {
        resetHistorySession()
        resetArtistSearch()
        invalidatePreflight(clearAvailability: true)
        musicConnection.stop()
        epoch += 1; startup?.cancel(); polling?.cancel(); connected = false; api = nil
        await engine.stop()
    }
    private func poll(revision: Int) async {
        while !Task.isCancelled && epoch == revision {
            do {
                try await Task.sleep(for: .milliseconds(800))
                guard engine.running else { connected = false; error = "The local engine stopped. Retry startup to restore saved work."; return }
                guard let api else { return }
                if musicWriteUnconfirmed {
                    let ready: ReadyResponse = try await api.call("/api/ready")
                    guard epoch == revision else { continue }
                    acceptJob(ready.activeJob); musicWriteUnconfirmed = false
                }
                if let current = draft, current.status == "building" {
                    let incoming: Draft = try await api.call("/api/drafts/\(current.id)")
                    guard epoch == revision, draft?.id == current.id, draft?.status == "building" else { continue }
                    receiveDraft(incoming)
                    message = incoming.error ?? incoming.progress.message
                }
                if let current = job, current.active {
                    let jobVersion = jobRevision
                    let incoming: MusicJob = try await api.call("/api/jobs/\(current.id)")
                    guard epoch == revision, jobRevision == jobVersion, job?.id == current.id, job?.active == true else { continue }
                    acceptJob(incoming); message = incoming.message
                }
            } catch {
                if !Task.isCancelled { self.error = "Could not refresh saved progress. \(error.localizedDescription)" }
            }
        }
    }
    private func perform(_ action: () async throws -> Void) async {
        guard !busy, connected, api != nil else { return }
        busy = true; error = nil
        defer { busy = false }
        do { try await action() } catch { self.error = error.localizedDescription }
    }
    private func resetArtistSearch() {
        artistSearchRevision += 1; artistMatches = []; chosenArtist = nil
    }
    func searchArtists() async {
        guard canSearchArtists else { return }
        resetArtistSearch()
        let revision = artistSearchRevision; let session = epoch
        let term = settings.seed.trimmingCharacters(in: .whitespacesAndNewlines)
        let country = settings.country
        await perform {
            message = "Searching Apple Music artists…"
            do {
                let response: CatalogArtistsResponse = try await api!.call("/api/artists/search", body: ["term": term, "country": country])
                guard session == epoch, revision == artistSearchRevision, settings.mode == "discography" else { return }
                artistMatches = response.artists
                message = response.artists.isEmpty ? "No artists found. Try another name." : "Choose the artist below, then preview their releases."
            } catch {
                guard session == epoch, revision == artistSearchRevision else { return }
                throw error
            }
        }
    }
    func chooseArtist(_ artist: CatalogArtist) {
        guard canSearchArtists, artistMatches.contains(where: { $0.id == artist.id }) else { return }
        chosenArtist = artist
    }
    func preview() async {
        guard canPreview else { return }
        await perform {
            var request = settings; request.includeAI = includeAI
            if request.mode == "discography", let artist = chosenArtist { request.seed = artist.name; request.artistId = artist.id }
            let body = try JSONSerialization.jsonObject(with: JSONEncoder().encode(request)) as! [String: Any]
            let incoming: Draft = try await api!.call("/api/drafts", body: body)
            receiveDraft(incoming); message = incoming.progress.message
        }
    }
    func cancelPreview() async {
        guard building, let id = draft?.id else { return }
        await perform { let incoming: Draft = try await api!.call("/api/drafts/\(id)/cancel", body: [:]); receiveDraft(incoming); invalidatePreflight(); message = "Preview cancelled. Build another preview when ready." }
    }
    private var selectionBody: [String: Any] { ["draftId": draft?.id ?? "", "trackIds": visibleTracks.filter { selected.contains($0.id) }.map(\.id), "includeAI": includeAI] }
    func checkLibrary() async {
        guard canCheck else { return }
        invalidatePreflight(clearAvailability: true)
        let revision = selectionRevision
        let body = selectionBody
        await perform {
            message = "Checking the Apple Music session and catalog availability."
            let result: Preflight = try await api!.call("/api/preflight", body: body)
            acceptPreflight(result, revision: revision)
            message = preflight == nil ? "Selection changed. Check again." : (preflight?.unavailableCatalogTracks ?? 0) > 0 ? "Some songs are unavailable in this storefront. Deselect unavailable songs, then check the remaining selection again." : "Catalog check complete. Review the counts before creating."
        }
    }
    func create() async {
        guard canCreate, let id = preflight?.id else { return }
        var body = selectionBody; body["name"] = name.trimmingCharacters(in: .whitespacesAndNewlines); body["preflightId"] = id
        invalidatePreflight()
        await perform { try await submitMusicJob("/api/jobs", body: body) }
    }
    private func submitMusicJob(_ path: String, body: [String: Any]) async throws {
        guard let client = api else { throw AppError(message: "The engine session is not ready. Retry startup.") }
        let submissionEpoch = epoch
        pendingMusicRequest = true
        defer { pendingMusicRequest = false }
        jobRevision += 1
        do {
            let incoming: MusicJob = try await client.call(path, body: body)
            guard epoch == submissionEpoch else { throw CancellationError() }
            acceptJob(incoming)
            message = job?.message ?? "Creating playlist"
        } catch {
            let submissionError = error
            guard epoch == submissionEpoch else { throw submissionError }
            // The engine may have started work before its POST response failed.
            do {
                let ready: ReadyResponse = try await client.call("/api/ready")
                guard epoch == submissionEpoch else { throw CancellationError() }
                acceptJob(ready.activeJob)
                musicWriteUnconfirmed = false
            } catch {
                if epoch == submissionEpoch {
                    musicWriteUnconfirmed = true
                    message = "Could not confirm saved Music work. Controls stay locked while the app checks again."
                }
            }
            throw submissionError
        }
    }
    func jobAction(_ action: String) async {
        guard let current = job, ["cancel", "retry", "open"].contains(action) else { return }
        guard action == "cancel" || !historyScanInFlight else { return }
        guard action != "cancel" || current.songActive else { return }
        guard action != "retry" || (!activeJob && current.retryable) else { return }
        if action == "retry", current.includeAI == true, !includeAI { error = "This saved job includes AI artists. Turn Include AI artists on to retry it."; return }
        await perform {
            if action == "open" { let _: OKResponse = try await api!.call("/api/jobs/\(current.id)/open", body: [:]); message = "Opened the playlist in Music." }
            else if action == "retry" { try await submitMusicJob("/api/jobs/\(current.id)/retry", body: [:]) }
            else { jobRevision += 1; let incoming: MusicJob = try await api!.call("/api/jobs/\(current.id)/cancel", body: [:]); acceptJob(incoming); message = job?.message ?? "Job updated" }
        }
    }
    func coverAction(_ action: String) async {
        guard let current = job, current.coverAction == action, !activeJob, !historyScanInFlight, !building else { return }
        await perform {
            jobRevision += 1
            let revision = epoch
            pendingMusicRequest = true
            defer { pendingMusicRequest = false }
            do {
                let incoming: MusicJob = try await api!.call("/api/jobs/\(current.id)/\(action)", body: [:])
                guard epoch == revision, job?.id == current.id else { return }
                acceptJob(incoming)
            } catch {
                let requestError = error
                guard epoch == revision else { throw requestError }
                do {
                    let ready: ReadyResponse = try await api!.call("/api/ready")
                    guard epoch == revision else { throw CancellationError() }
                    acceptJob(ready.activeJob)
                } catch {
                    if epoch == revision { musicWriteUnconfirmed = true }
                }
                throw requestError
            }
        }
    }
    func saveProvenance(track: DraftTrack, kind: String, evidence: String) async -> Bool {
        guard evidence.count <= 2000, ["unknown", "human", "ai"].contains(kind), !building, !activeJob else { return false }
        var saved = false
        invalidatePreflight()
        await perform {
            let _: OKResponse = try await api!.call("/api/provenance", body: ["artistId": track.artistId, "kind": kind, "evidence": evidence])
            applyProvenance(artistID: track.artistId, provenance: Provenance(kind: kind, evidence: evidence.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? [] : [evidence], note: "Personal classification, not independently verified")); saved = true; message = "Saved the local artist assessment. Check the library again before creating."
        }
        return saved
    }
    func refreshMusicStatus() async {
        await perform { let result: StatusResponse = try await api!.call("/api/status"); acceptMusicStatus(result.music); message = result.music.message }
    }
    private func resetHistorySession() {
        historyOperationRevision += 1; historyQueryRevision += 1
        historyLoading?.cancel(); historyLoading = nil
        historyScanOwner = nil; historyScanEpoch = nil; historyScanInFlight = false
        historyOperation = .idle; historyPreview = nil; cancelHistorySeed()
    }
    private func currentHistoryOperation(_ revision: Int, _ session: Int) -> Bool {
        revision == historyOperationRevision && session == epoch
    }
    private func finishHistoryOperation(_ revision: Int, _ session: Int) {
        if currentHistoryOperation(revision, session) { historyOperation = .idle }
    }
    private func mergeHistorySummaries(_ incoming: HistoryResponse) {
        let oldPage = history?.page
        history = HistoryResponse(sources: incoming.sources, preferredSource: incoming.preferredSource, page: oldPage)
        if !incoming.sources.contains(where: { $0.source == historySource }) {
            historySource = incoming.preferredSource
            history?.page = nil
        }
        if let source = incoming.sources.first(where: { $0.source == historySource }), !source.pageKinds.contains(historyKind) {
            historyKind = "artists"; historyOffset = 0
            history?.page = nil
        }
    }
    func selectHistorySource(_ source: String) {
        guard source != historySource, history?.sources.contains(where: { $0.source == source }) == true else { return }
        historyKind = "artists"; historyOffset = 0
        historySource = source
    }
    func loadHistory(kind: String = "artists", offset: Int = 0) async {
        guard connected, let client = api else { return }
        if let history, let source = historySource, !history.sources.contains(where: { $0.source == source }) { historySource = history.preferredSource }
        guard ["artists", "albums", "tracks", "genres", "daily", "monthly", "hourly"].contains(kind), (0...100000).contains(offset), historySource == nil || ["library", "export"].contains(historySource!) else {
            error = "Invalid listening history page."; return
        }
        historyKind = kind; historyOffset = offset
        historyQueryRevision += 1
        let revision = historyQueryRevision; let session = epoch; let source = historySource
        var components = URLComponents()
        components.path = "/api/history"
        components.queryItems = [URLQueryItem(name: "kind", value: kind), URLQueryItem(name: "offset", value: String(offset)), URLQueryItem(name: "limit", value: "50"), URLQueryItem(name: "timeZone", value: TimeZone.current.identifier)]
        if let source { components.queryItems?.append(URLQueryItem(name: "source", value: source)) }
        do {
            let incoming: HistoryResponse = try await client.call(components.string!)
            guard session == epoch, revision == historyQueryRevision, source == historySource, kind == historyKind, offset == historyOffset else { return }
            history = incoming
            if !incoming.sources.contains(where: { $0.source == source }) {
                historySource = incoming.preferredSource
                if historySource != nil { await loadHistory(kind: kind, offset: offset) }
            }
        } catch {
            if session == epoch, revision == historyQueryRevision, !Task.isCancelled { self.error = "Could not read saved listening history. \(error.localizedDescription)" }
        }
    }
    func scanHistory() async {
        guard canScanHistory, let client = api else { return }
        historyOperationRevision += 1
        let revision = historyOperationRevision; let session = epoch; let owner = UUID()
        historyScanOwner = owner; historyScanEpoch = session; historyScanInFlight = true
        historyOperation = .scanning; error = nil; invalidatePreflight()
        message = "Music may ask for Automation permission. Scanning only reads library metadata."
        defer { finishHistoryOperation(revision, session) }
        do {
            let incoming: HistoryResponse
            do {
                defer {
                    if historyScanOwner == owner, historyScanEpoch == session {
                        historyScanOwner = nil; historyScanEpoch = nil; historyScanInFlight = false
                    }
                }
                incoming = try await client.call("/api/history/library", body: [:])
            }
            guard currentHistoryOperation(revision, session) else { return }
            mergeHistorySummaries(incoming)
            await loadHistory(kind: historyKind, offset: historyOffset)
        } catch {
            if currentHistoryOperation(revision, session), !Task.isCancelled { self.error = error.localizedDescription }
        }
    }
    func previewHistoryFile(_ url: URL) async {
        guard connected, let client = api, historyOperation == .idle || historyOperation == .readingFile || historyOperation == .parsing else { return }
        historyOperationRevision += 1
        let revision = historyOperationRevision; let session = epoch
        historyPreview = nil; historyOperation = .readingFile; error = nil
        defer { finishHistoryOperation(revision, session) }
        do {
            let data = try await historyFileReader(url)
            guard currentHistoryOperation(revision, session) else { return }
            historyOperation = .parsing
            let incoming: HistoryPreview = try await client.uploadCSV(data)
            guard currentHistoryOperation(revision, session) else { return }
            historyPreview = incoming
        } catch {
            if currentHistoryOperation(revision, session), !Task.isCancelled { self.error = error.localizedDescription }
        }
    }
    func importHistory(replace: Bool) async {
        guard connected, let client = api, let preview = historyPreview, historyOperation == .idle else { return }
        historyOperationRevision += 1
        let revision = historyOperationRevision; let session = epoch
        historyOperation = .importing; error = nil
        defer { finishHistoryOperation(revision, session) }
        do {
            let incoming: HistoryResponse = try await client.call("/api/history/import", body: ["token": preview.token, "replace": replace])
            guard currentHistoryOperation(revision, session) else { return }
            historyPreview = nil; mergeHistorySummaries(incoming)
            await loadHistory(kind: historyKind, offset: historyOffset)
        } catch {
            if currentHistoryOperation(revision, session), !Task.isCancelled { self.error = error.localizedDescription }
        }
    }
    func dismissHistoryPreview() {
        guard historyOperation != .importing else { return }
        if historyOperation == .readingFile || historyOperation == .parsing {
            historyOperationRevision += 1; historyOperation = .idle
        }
        historyPreview = nil
    }
    func forgetHistory() async {
        guard connected, let client = api, historyOperation != .forgetting else { return }
        historyOperationRevision += 1; historyQueryRevision += 1
        let revision = historyOperationRevision; let session = epoch
        historyOperation = .forgetting; error = nil
        defer { finishHistoryOperation(revision, session) }
        do {
            let _: OKResponse = try await client.call("/api/history/forget", body: [:])
            guard currentHistoryOperation(revision, session) else { return }
            historyQueryRevision += 1
            history = HistoryResponse(sources: [], preferredSource: nil, page: nil)
            historySource = nil; historyPreview = nil; cancelHistorySeed()
        } catch {
            if currentHistoryOperation(revision, session), !Task.isCancelled { self.error = error.localizedDescription }
        }
    }
    private func validHistorySeed(_ suggestion: HistorySuggestion) -> Bool {
        !suggestion.artist.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && suggestion.artist.utf16.count <= 120 && !suggestion.artist.unicodeScalars.contains { $0.value < 32 || $0.value == 127 }
    }
    func requestHistorySeed(_ suggestion: HistorySuggestion) {
        guard validHistorySeed(suggestion), !building, !activeJob else { return }
        if let draft { pendingHistorySeed = suggestion; pendingHistoryDraftID = draft.id; return }
        applyHistorySeed(suggestion)
    }
    func confirmHistorySeed() {
        guard let suggestion = pendingHistorySeed, validHistorySeed(suggestion), !building, !activeJob, draft?.id == pendingHistoryDraftID else { return }
        applyHistorySeed(suggestion)
    }
    func cancelHistorySeed() { pendingHistorySeed = nil; pendingHistoryDraftID = nil }
    private func applyHistorySeed(_ suggestion: HistorySuggestion) {
        draft = nil; selected = []; removed = []; invalidatePreflight(clearAvailability: true); cancelHistorySeed()
        settings.mode = "artist"; settings.seed = suggestion.artist; page = .discover
    }
}
