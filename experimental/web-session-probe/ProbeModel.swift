import Foundation
import Combine

struct AttemptState: Codable { var attempted = false; var playlistID: String? }
protocol AttemptStorage { func read() throws -> AttemptState; func save(_ state: AttemptState) throws }

@MainActor final class ProbeModel: ObservableObject {
    @Published var bearerInput = ""
    @Published var userInput = ""
    @Published var status = "Save your own web-session headers locally to begin."
    @Published var busy = false
    @Published var writing = false
    @Published var connection: Connection?
    @Published var state = AttemptState()
    @Published var saved = false
    private let storage: CredentialStorage
    private let journal: AttemptStorage
    private let configuration: URLSessionConfiguration
    init(storage: CredentialStorage, journal: AttemptStorage, configuration: URLSessionConfiguration = .ephemeral) {
        self.storage = storage; self.journal = journal; self.configuration = configuration
        do {
            state = try journal.read()
            saved = try storage.read() != nil
            if state.attempted { status = "This probe already attempted a write. Inspect the retained playlist ID or your Apple Music library. Further writes are blocked." }
            else if saved { status = "Connection saved locally. Check connection to preview the two test songs." }
        } catch {
            state.attempted = true
            status = "Local connection or attempt state could not be read. Writes are blocked."
        }
    }
    var canCreate: Bool { saved && connection != nil && !busy && !state.attempted && bearerInput.isEmpty && userInput.isEmpty }
    private func credentials() throws -> Credentials {
        guard let data = try storage.read(), let decoded = try? JSONDecoder().decode(Credentials.self, from: data) else { throw ProbeError.storage }
        return try Credentials.parse(bearer: decoded.bearer, user: decoded.user)
    }
    private func safeMessage(_ error: Error) -> String { (error as? ProbeError ?? .storage).localizedDescription }
    func save() {
        guard !busy else { return }
        connection = nil
        do {
            let values = try Credentials.parse(bearer: bearerInput, user: userInput)
            try storage.save(JSONEncoder().encode(values))
            bearerInput = ""; userInput = ""; saved = true
            status = "Connection saved in this probe's Keychain item. Check connection to preview songs."
        } catch { status = safeMessage(error) }
    }
    func deleteConnection() {
        guard !busy else { return }
        do {
            try storage.delete(); saved = false; connection = nil; bearerInput = ""; userInput = ""
            status = "Deleted this probe's saved connection. The write attempt record and playlists remain."
        } catch { status = safeMessage(error) }
    }
    func check() async {
        guard !busy else { return }
        busy = true; connection = nil; status = "Checking your storefront and two exact catalog matches..."
        defer { busy = false }
        do {
            connection = try await ProbeClient(credentials: credentials(), configuration: configuration).check()
            status = "Connection checked. Review the songs before creating the test playlist."
        } catch { status = safeMessage(error) }
    }
    func create() async {
        guard canCreate, let connection else { return }
        busy = true; writing = true
        defer { busy = false; writing = false }
        do {
            let values = try credentials()
            state.attempted = true
            do { try journal.save(state) }
            catch { throw ProbeError.attemptStorage }
            status = "Creating one labelled playlist, then appending the second song. Keep this window open."
            let outcome = await ProbeClient(credentials: values, configuration: configuration).create(connection) { id in
                self.state.playlistID = id
                try self.journal.save(self.state)
            }
            if let id = outcome.playlistID { state.playlistID = id }
            status = outcome.message
        } catch { status = safeMessage(error) + " No write was started." }
    }
}
