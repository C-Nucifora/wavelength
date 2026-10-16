import Foundation
import Combine
import Darwin

typealias Credentials = WebCredentials
@MainActor final class MusicConnection: ObservableObject {
    @Published var bearerInput = ""
    @Published var userInput = ""
    @Published var status: MusicStatus?
    @Published var error: String?
    @Published private(set) var busy = false
    private let invoke: ([String: Any]) async throws -> [String: Any]
    private var ipc: NativeMusicIPC?
    init(invoke: @escaping ([String: Any]) async throws -> [String: Any]) { self.invoke = invoke }
    convenience init(resources: URL) {
        let ipc = NativeMusicIPC(executable: resources.appendingPathComponent("bin/WebMusicBridge"))
        self.init(invoke: { try await ipc.call($0) })
        self.ipc = ipc
    }
    func capture(_ credentials: Credentials) {
        guard !busy else { return }
        bearerInput = credentials.bearer; userInput = credentials.user
        error = nil
    }
    func stop() { ipc?.stop(); bearerInput = ""; userInput = "" }
    func save(expectedGeneration: String?) async {
        guard !busy else { return }
        busy = true; error = nil
        defer { busy = false }
        do {
            let credentials = try WebCredentials.parse(bearer: bearerInput, user: userInput)
            var input: [String: Any] = ["action": "saveConnection", "credentials": ["bearer": credentials.bearer, "user": credentials.user]]
            if let expectedGeneration { input["generation"] = expectedGeneration }
            let result = try await invoke(input)
            status = try JSONDecoder().decode(MusicStatus.self, from: JSONSerialization.data(withJSONObject: result))
            bearerInput = ""; userInput = ""
        } catch { self.error = "Could not validate and save the connection. Check the session values or close any active operation, then retry. Your values remain only in these local fields." }
    }
    func check(expectedGeneration _: String?) async {
        guard !busy else { return }
        busy = true; error = nil
        defer { busy = false }
        do {
            let initial = try await invoke(["action": "status"])
            var current = try JSONDecoder().decode(MusicStatus.self, from: JSONSerialization.data(withJSONObject: initial))
            status = current
            if let generation = current.generation {
                let result = try await invoke(["action": "checkConnection", "generation": generation])
                guard result["generation"] as? String == generation else { throw AppError(message: "Changed") }
                current.storefront = result["storefront"] as? String
                current.message = "Apple Music connection checked."
            }
            status = current
        } catch { self.error = "The Apple Music connection could not be checked. Reconnect if the session has expired." }
    }
    func disconnect(expectedGeneration: String?) async {
        guard !busy else { return }
        busy = true; error = nil
        defer { busy = false }
        do {
            var input: [String: Any] = ["action": "disconnect"]
            if let expectedGeneration { input["generation"] = expectedGeneration }
            let result = try await invoke(input)
            status = try JSONDecoder().decode(MusicStatus.self, from: JSONSerialization.data(withJSONObject: result))
            bearerInput = ""; userInput = ""
        } catch { self.error = "Could not disconnect. Wait for the current operation and try again. No playlists or history were removed." }
    }
}

final class NativeMusicIPC: @unchecked Sendable {
    private let executable: URL
    private let lock = NSLock()
    private var owned: Process?
    init(executable: URL) { self.executable = executable }
    func stop() {
        lock.lock(); let process = owned; lock.unlock()
        if let process, process.isRunning { kill(process.processIdentifier, SIGKILL) }
    }
    func call(_ input: [String: Any]) async throws -> [String: Any] {
        let data = try JSONSerialization.data(withJSONObject: input)
        guard data.count <= 131072 else { throw AppError(message: "Connection input is too large.") }
        let result = try await Task.detached { [self] in try run(data) }.value
        guard let object = try JSONSerialization.jsonObject(with: result) as? [String: Any], object["ok"] as? Bool == true, let response = object["result"] as? [String: Any] else { throw AppError(message: "The Apple Music bridge could not complete this operation.") }
        return response
    }
    private func run(_ data: Data) throws -> Data {
        let process = Process(); let input = Pipe(); let output = Pipe()
        process.executableURL = executable; process.arguments = []
        process.standardInput = input; process.standardOutput = output; process.standardError = FileHandle.nullDevice
        lock.lock()
        guard owned == nil else { lock.unlock(); throw AppError(message: "A connection operation is already running.") }
        owned = process; lock.unlock()
        defer { lock.lock(); owned = nil; lock.unlock() }
        do { try process.run() } catch { throw AppError(message: "The bundled Apple Music bridge is unavailable.") }
        let deadline = DispatchWorkItem { if process.isRunning { kill(process.processIdentifier, SIGKILL) } }
        DispatchQueue.global().asyncAfter(deadline: .now() + 120, execute: deadline)
        defer { deadline.cancel(); if process.isRunning { kill(process.processIdentifier, SIGKILL) }; try? input.fileHandleForWriting.close(); try? output.fileHandleForReading.close() }
        do {
            try input.fileHandleForWriting.write(contentsOf: data)
            try input.fileHandleForWriting.close()
            var result = Data()
            while let chunk = try output.fileHandleForReading.read(upToCount: 16384), !chunk.isEmpty {
                guard result.count + chunk.count <= 131072 else { throw AppError(message: "The connection response is too large.") }
                result.append(chunk)
            }
            process.waitUntilExit()
            guard process.terminationStatus == 0 else { throw AppError(message: "The connection operation did not complete.") }
            return result
        } catch { throw AppError(message: "The connection operation did not return a safe result.") }
    }
}
