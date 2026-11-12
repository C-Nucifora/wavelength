import Foundation
import Darwin

@MainActor final class EngineController {
    let resources: URL
    let dataDirectory: URL
    private(set) var process: Process?
    private var output: FileHandle?
    private var launchGeneration = UUID()
    private(set) var logURL: URL?
    var running: Bool { process?.isRunning == true }
    init(resources: URL = Bundle.main.resourceURL!, dataDirectory: URL? = nil) {
        self.resources = resources
        self.dataDirectory = dataDirectory ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/Wavelength", isDirectory: true)
    }
    func start() async throws -> APIClient {
        let generation = UUID()
        launchGeneration = generation
        await stop(process, output: output)
        try Task.checkCancellation()
        guard launchGeneration == generation else { throw CancellationError() }
        guard process == nil else { throw AppError(message: "The previous engine has not stopped. Retry startup.") }
        let executable = resources.appendingPathComponent("bin/bun")
        let entry = resources.appendingPathComponent("engine/src/index.ts")
        let bridge = resources.appendingPathComponent("bin/WebMusicBridge")
        guard FileManager.default.isExecutableFile(atPath: executable.path),
              FileManager.default.isExecutableFile(atPath: bridge.path),
              FileManager.default.fileExists(atPath: entry.path) else {
            throw AppError(message: "The app bundle is incomplete. Rebuild Wavelength and retry.")
        }
        let data = dataDirectory
        let logs = data.appendingPathComponent("logs", isDirectory: true)
        try FileManager.default.createDirectory(at: logs, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let instance = UUID().uuidString
        let engineToken = UUID().uuidString + UUID().uuidString
        let log = logs.appendingPathComponent("engine-\(instance).log")
        guard FileManager.default.createFile(atPath: log.path, contents: nil, attributes: [.posixPermissions: 0o600]) else {
            throw AppError(message: "Cannot create the engine log in Application Support.")
        }
        let output = try FileHandle(forWritingTo: log)
        self.output = output
        logURL = log
        let process = Process()
        process.executableURL = executable
        process.arguments = [entry.path]
        process.currentDirectoryURL = resources.appendingPathComponent("engine")
        var environment = ProcessInfo.processInfo.environment
        environment["PORT"] = "0"
        environment["WAVELENGTH_INSTANCE"] = instance
        environment["WAVELENGTH_ENGINE_TOKEN"] = engineToken
        environment["WAVELENGTH_DATA_DIR"] = data.path
        environment["WAVELENGTH_WEB_MUSIC_BRIDGE"] = bridge.path
        process.environment = environment
        process.standardOutput = output
        process.standardError = output
        self.process = process
        do {
            try process.run()
            for _ in 0..<100 {
                try checkLaunch(generation, process: process)
                let handle = try FileHandle(forReadingFrom: log)
                let text = String(data: try handle.read(upToCount: 65536) ?? Data(), encoding: .utf8) ?? ""
                try handle.close()
                if let range = text.range(of: #"http://127\.0\.0\.1:[0-9]+"#, options: .regularExpression),
                   let url = URL(string: String(text[range])) {
                    let api = APIClient(baseURL: url)
                    api.token = engineToken
                    let ready: ReadyResponse = try await api.call("/api/ready")
                    try checkLaunch(generation, process: process)
                    guard ready.ready, ready.instance == instance else { throw AppError(message: "The engine readiness response did not match this app instance.") }
                    let session: SessionResponse = try await api.call("/api/session")
                    try checkLaunch(generation, process: process)
                    api.token = session.token
                    return api
                }
                try await Task.sleep(for: .milliseconds(100))
            }
            throw AppError(message: "The engine did not start within 10 seconds. Check \(log.path) and retry.")
        } catch {
            await stop(process, output: output)
            throw error
        }
    }
    private func checkLaunch(_ generation: UUID, process: Process) throws {
        try Task.checkCancellation()
        guard launchGeneration == generation, self.process === process else { throw CancellationError() }
        guard process.isRunning else { throw AppError(message: "The engine stopped during startup.") }
    }
    func stop() async {
        launchGeneration = UUID()
        await stop(process, output: output)
    }
    private func stop(_ owned: Process?, output ownedOutput: FileHandle?) async {
        // Cleanup must keep waiting even when the startup caller was cancelled.
        await Task { @MainActor in
            if let owned, owned.isRunning {
                owned.terminate()
                for _ in 0..<40 {
                    if !owned.isRunning { break }
                    try? await Task.sleep(for: .milliseconds(50))
                }
                if owned.isRunning { kill(owned.processIdentifier, SIGKILL) }
                for _ in 0..<20 {
                    if !owned.isRunning { break }
                    try? await Task.sleep(for: .milliseconds(50))
                }
            }
            // Retain the child and log until exit, including a delayed SIGKILL reap.
            guard owned?.isRunning != true else { return }
            if process === owned {
                process = nil
                output = nil
            }
            try? ownedOutput?.close()
        }.value
    }
}
