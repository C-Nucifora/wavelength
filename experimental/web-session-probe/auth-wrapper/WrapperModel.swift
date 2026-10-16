import Foundation
import Combine

@MainActor final class WrapperModel: ObservableObject {
    @Published var showingSignIn = false
    @Published var busy = false
    @Published var status = "Connect your Apple Music account to begin."
    @Published var connection: Connection?
    @Published var saved = false
    private let storage: CredentialStorage
    private let validate: (Credentials) async throws -> Connection
    private var generation = UUID()
    private var candidate: Credentials?
    private var validationTask: Task<Connection, Error>?
    init(storage: CredentialStorage, validate: @escaping (Credentials) async throws -> Connection = { try await ProbeClient(credentials: $0).check() }) {
        self.storage = storage; self.validate = validate
        do { saved = try storage.read() != nil; if saved { status = "Connection saved locally. Check it or reconnect." } }
        catch { status = "The saved connection could not be read." }
    }
    var canSave: Bool { !busy && candidate != nil && connection != nil }
    func connect() { cancel(); showingSignIn = true; status = "Sign in on Apple's page." }
    func capture(_ credentials: Credentials) async {
        guard showingSignIn, !busy else { return }
        showingSignIn = false; busy = true
        let epoch = generation
        status = "Checking your Apple Music connection..."
        let task = Task { try await validate(credentials) }
        validationTask = task
        do {
            let checked = try await task.value
            guard generation == epoch, !Task.isCancelled else { return }
            connection = checked; candidate = credentials
            status = "Connection checked. Save it locally to finish."
        } catch {
            guard generation == epoch else { return }
            connection = nil; candidate = nil
            status = (error as? ProbeError ?? .transport).localizedDescription
        }
        guard generation == epoch else { return }
        busy = false; validationTask = nil
    }
    func cancel() {
        generation = UUID(); validationTask?.cancel(); validationTask = nil
        showingSignIn = false; busy = false; candidate = nil; connection = nil
        status = "Connection attempt cancelled. Any previously saved connection remains."
    }
    func checkSaved() async {
        guard !busy else { return }
        do {
            guard let data = try storage.read() else { throw ProbeError.storage }
            let decoded = try JSONDecoder().decode(Credentials.self, from: data)
            let parsed = try Credentials.parse(bearer: decoded.bearer, user: decoded.user)
            connect(); await capture(parsed)
        } catch { status = "The saved connection could not be read. Reconnect to replace it." }
    }
    func save() {
        guard canSave, let candidate else { return }
        do { try storage.save(JSONEncoder().encode(candidate)); saved = true; self.candidate = nil; status = "Connection saved in this spike's separate Keychain item." }
        catch { status = "The connection could not be saved in Keychain." }
    }
    func disconnect() {
        cancel()
        do { try storage.delete(); saved = false; status = "Deleted this spike's saved connection." }
        catch { status = "The saved connection could not be deleted." }
    }
}
