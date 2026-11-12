import Foundation
#if canImport(Darwin)
import Darwin
#else
import Glibc
#endif

// NativeChecks and the standalone driver call run(bun:); children stay below TMPDIR.
@MainActor enum EngineRaceChecks {
    @MainActor private final class Probe {
        let root: URL
        let engine: EngineController
        let sentinel = Process()
        var checks = 0
        var failures = 0
        var tasks: [Task<Result<APIClient, Error>, Never>] = []

        init(bun: URL, name: String) throws {
            root = FileManager.default.temporaryDirectory.appendingPathComponent("wavelength-engine-race-\(name)-\(UUID().uuidString)")
            let resources = root.appendingPathComponent("resources")
            let data = root.appendingPathComponent("data")
            for path in ["resources/bin", "resources/engine/src", "data/events"] {
                try FileManager.default.createDirectory(at: root.appendingPathComponent(path), withIntermediateDirectories: true)
            }
            try FileManager.default.createSymbolicLink(at: resources.appendingPathComponent("bin/bun"), withDestinationURL: bun)
            let bridge = resources.appendingPathComponent("bin/WebMusicBridge")
            try "#!/bin/sh\nexit 0\n".write(to: bridge, atomically: true, encoding: .utf8)
            try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: bridge.path)
            try fakeEngine.write(to: resources.appendingPathComponent("engine/src/index.ts"), atomically: true, encoding: .utf8)
            engine = EngineController(resources: resources, dataDirectory: data)
            sentinel.executableURL = URL(fileURLWithPath: "/bin/sleep")
            sentinel.arguments = ["30"]
            try sentinel.run()
        }

        func check(_ condition: Bool, _ message: String) {
            checks += 1
            if !condition { failures += 1 }
            print("\(condition ? "PASS" : "FAIL") \(message)")
        }

        func mode(_ value: String) throws {
            try value.write(to: engine.dataDirectory.appendingPathComponent("mode"), atomically: true, encoding: .utf8)
        }

        func launch() -> Task<Result<APIClient, Error>, Never> {
            let index = tasks.count
            let task = Task<Result<APIClient, Error>, Never> { @MainActor in
                self.trace("start-\(index)-called")
                do {
                    let client = try await self.engine.start()
                    self.trace("start-\(index)-returned")
                    return .success(client)
                } catch {
                    self.trace("start-\(index)-failed: \(error.localizedDescription)")
                    return .failure(error)
                }
            }
            tasks.append(task)
            return task
        }

        func trace(_ message: String) {
            let value: [String: Any] = ["event": message, "time": Date().timeIntervalSince1970 * 1000,
                                        "ownedPID": engine.process?.processIdentifier ?? 0]
            guard var data = try? JSONSerialization.data(withJSONObject: value) else { return }
            data.append(10)
            let path = root.appendingPathComponent("controller.jsonl")
            if !FileManager.default.fileExists(atPath: path.path) { try? Data().write(to: path) }
            if let handle = try? FileHandle(forWritingTo: path) {
                _ = try? handle.seekToEnd()
                try? handle.write(contentsOf: data)
                try? handle.close()
            }
        }

        func event(_ instance: String, _ name: String) -> URL {
            engine.dataDirectory.appendingPathComponent("events/\(instance)/\(name)")
        }

        func instances() -> [String] {
            (try? FileManager.default.contentsOfDirectory(atPath: engine.dataDirectory.appendingPathComponent("events").path)) ?? []
        }

        func wait(_ label: String, until predicate: () -> Bool) async throws {
            for _ in 0..<400 {
                if predicate() { return }
                try await Task.sleep(for: .milliseconds(5))
            }
            throw AppError(message: "Barrier timed out: \(label)")
        }

        func waitEvent(_ instance: String, _ name: String) async throws {
            try await wait(name) { FileManager.default.fileExists(atPath: event(instance, name).path) }
        }

        func release(_ instance: String, _ name: String) throws {
            try Data().write(to: event(instance, "release-\(name)"))
        }

        func livePIDs() -> [Int32] {
            instances().compactMap { instance in
                guard let text = try? String(contentsOf: event(instance, "pid"), encoding: .utf8),
                      let pid = Int32(text),
                      let parent = try? String(contentsOf: event(instance, "parent"), encoding: .utf8),
                      parent == String(getpid()), kill(pid, 0) == 0 else { return nil }
                return pid
            }
        }

        func matching(_ client: APIClient, label: String) async {
            do {
                let ready: ReadyResponse = try await client.call("/api/ready")
                let session: SessionResponse = try await client.call("/api/session")
                check(ready.ready && instances().contains(ready.instance), "\(label) live instance belongs to this fixture")
                check(session.token == client.token && !client.token.isEmpty, "\(label) session token matches authenticated child")
                let pid = try String(contentsOf: event(ready.instance, "pid"), encoding: .utf8)
                check(engine.process.map { String($0.processIdentifier) } == pid, "\(label) returned client matches currently owned child")
            } catch { check(false, "\(label) returned client remains callable: \(error.localizedDescription)") }
        }

        func cleanup() async {
            for task in tasks { task.cancel() }
            // Release owned barriers before awaiting cleanup, including any orphan's barrier.
            for instance in instances() {
                for name in ["log", "ready", "session", "term"] { try? release(instance, name) }
            }
            for task in tasks { _ = await task.value }
            await engine.stop()
            for _ in 0..<100 {
                if livePIDs().isEmpty { break }
                try? await Task.sleep(for: .milliseconds(10))
            }
            check(livePIDs().isEmpty, "controller eventually cleans every owned child")
            // Only exact PIDs recorded by this fixture's direct children, never process matching.
            for pid in livePIDs() { _ = kill(pid, SIGKILL) }
            for _ in 0..<100 {
                if livePIDs().isEmpty { break }
                try? await Task.sleep(for: .milliseconds(10))
            }
            check(livePIDs().isEmpty, "fixture cleanup leaves no child")
            check(sentinel.isRunning, "unrelated sentinel survives controller operations")
            _ = kill(sentinel.processIdentifier, SIGKILL)
            for _ in 0..<100 {
                if !sentinel.isRunning { break }
                try? await Task.sleep(for: .milliseconds(10))
            }
            check(!sentinel.isRunning, "fixture reaps its sentinel")
            print("ARTIFACT \(root.path)")
        }
    }

    static func run(bun: URL) async throws {
        var checks = 0
        var failures = 0
        let cases = ["sequential", "cancel-ready", "cancel-session", "replace-log-0", "replace-log-110", "replace-log-210", "replace-ready", "replace-session", "overlap-stops", "stop-log", "stop-ready", "stop-session", "cancel-stopping", "cancel-log-ignore-term", "launch-failure"]
        for name in cases {
            print("CASE \(name) deterministic barriers; seed none")
            let probe = try Probe(bun: bun, name: name)
            do {
                if name == "sequential" {
                    try probe.mode("normal")
                    let first = try await probe.launch().value.get()
                    await probe.matching(first, label: "first")
                    await probe.engine.stop()
                    await probe.engine.stop()
                    let second = try await probe.launch().value.get()
                    probe.check(first.token != second.token, "restart rotates launch token")
                    await probe.matching(second, label: "second")
                    let stale = APIClient(baseURL: second.baseURL)
                    stale.token = first.token
                    do {
                        let _: ReadyResponse = try await stale.call("/api/ready")
                        probe.check(false, "replacement rejects previous launch token")
                    } catch { probe.check(true, "replacement rejects previous launch token") }
                } else if name == "launch-failure" {
                    try probe.mode("normal")
                    let executable = probe.engine.resources.appendingPathComponent("bin/bun")
                    try FileManager.default.removeItem(at: executable)
                    try "#!/missing-wavelength-fixture-interpreter\n".write(to: executable, atomically: true, encoding: .utf8)
                    try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: executable.path)
                    switch await probe.launch().value {
                    case .success: probe.check(false, "exec failure rejects start")
                    case .failure: probe.check(true, "exec failure rejects start")
                    }
                    probe.check(probe.engine.process == nil, "exec failure clears unlaunched process ownership")
                    try FileManager.default.removeItem(at: executable)
                    try FileManager.default.createSymbolicLink(at: executable, withDestinationURL: bun)
                    let client = try await probe.launch().value.get()
                    await probe.matching(client, label: "restart after exec failure")
                } else if name == "cancel-stopping" {
                    try probe.mode("hold-term")
                    let original = try await probe.launch().value.get()
                    let ready: ReadyResponse = try await original.call("/api/ready")
                    try probe.mode("normal")
                    let replacement = probe.launch()
                    try await probe.waitEvent(ready.instance, "term")
                    replacement.cancel()
                    try probe.release(ready.instance, "term")
                    switch await replacement.value {
                    case .success: probe.check(false, "cancel while stopping rejects replacement")
                    case .failure: probe.check(true, "cancel while stopping rejects replacement")
                    }
                    probe.check(probe.instances().count == 1, "cancelled replacement never spawns a child")
                    probe.check(probe.engine.process == nil, "cancel while stopping reaps previous child")
                    let client = try await probe.launch().value.get()
                    await probe.matching(client, label: "restart after cancelled stop")
                } else if name.hasPrefix("stop-") {
                    let phase = String(name.dropFirst("stop-".count))
                    try probe.mode("hold-\(phase)")
                    let first = probe.launch()
                    try await probe.wait("child birth") { probe.instances().count == 1 }
                    let instance = probe.instances()[0]
                    try await probe.waitEvent(instance, phase)
                    await probe.engine.stop()
                    switch await first.value {
                    case .success: probe.check(false, "stop during \(phase) rejects pending start")
                    case .failure: probe.check(true, "stop during \(phase) rejects pending start")
                    }
                    probe.check(probe.engine.process == nil && probe.livePIDs().isEmpty, "stop during \(phase) reaps owned child")
                    try probe.mode("normal")
                    let client = try await probe.launch().value.get()
                    await probe.matching(client, label: "restart after stop during \(phase)")
                } else if name.hasPrefix("cancel-") {
                    let phase = name == "cancel-log-ignore-term" ? "log" : String(name.dropFirst("cancel-".count))
                    try probe.mode(name == "cancel-log-ignore-term" ? "hold-log-ignore-term" : "hold-\(phase)")
                    let first = probe.launch()
                    try await probe.wait("child birth") { probe.instances().count == 1 }
                    let instance = probe.instances()[0]
                    try await probe.waitEvent(instance, phase)
                    first.cancel()
                    switch await first.value {
                    case .success: probe.check(false, "cancel during \(phase) rejects start")
                    case .failure: probe.check(true, "cancel during \(phase) rejects start")
                    }
                    probe.check(!probe.engine.running, "cancel during \(phase) clears running ownership")
                    if name == "cancel-log-ignore-term" {
                        probe.check(FileManager.default.fileExists(atPath: probe.event(instance, "term").path), "cancel requests graceful shutdown before escalation")
                        probe.check(probe.livePIDs().isEmpty && probe.engine.process == nil, "cancel reaps SIGTERM-resistant child before returning")
                    }
                } else if name.hasPrefix("replace-") {
                    let phase = name.contains("log") ? "log" : String(name.dropFirst("replace-".count))
                    try probe.mode("hold-\(phase)")
                    let started = ContinuousClock.now
                    let first = probe.launch()
                    try await probe.wait("first child birth") { probe.instances().count == 1 }
                    let instance = probe.instances()[0]
                    try await probe.waitEvent(instance, phase)
                    if let delay = Int(name.split(separator: "-").last ?? ""), delay > 0 {
                        // Enter a later readiness poll while the child's log remains gated.
                        try await Task.sleep(until: started.advanced(by: .milliseconds(delay)), clock: .continuous)
                    }
                    try probe.mode("normal")
                    let second = probe.launch()
                    let newer = await second.value
                    let older = await first.value
                    switch older {
                    case .success: probe.check(false, "superseded pending start rejects")
                    case .failure: probe.check(true, "superseded pending start rejects")
                    }
                    switch newer {
                    case .success(let client): await probe.matching(client, label: "replacement after stale catch")
                    case .failure(let error): probe.check(false, "replacement starts successfully: \(error.localizedDescription)")
                    }
                    probe.check(probe.engine.running, "stale startup cleanup preserves replacement")
                } else {
                    try probe.mode("hold-term")
                    let original = try await probe.launch().value.get()
                    let ready: ReadyResponse = try await original.call("/api/ready")
                    try probe.mode("normal")
                    let first = probe.launch()
                    try await probe.waitEvent(ready.instance, "term")
                    let stop = Task { await probe.engine.stop() }
                    let second = probe.launch()
                    // The newest call wins; ownership and orphan checks also stand independently.
                    // Yield lets both calls enter stop's wait on the same gated child.
                    try await Task.sleep(for: .milliseconds(20))
                    try probe.release(ready.instance, "term")
                    _ = await first.value
                    let newer = await second.value
                    await stop.value
                    switch newer {
                    case .success(let client): await probe.matching(client, label: "newest overlapping start")
                    case .failure(let error): probe.check(false, "newest overlapping start succeeds: \(error.localizedDescription)")
                    }
                    probe.check(probe.engine.running, "older stop and startup cleanup preserve newest launch")
                }
            } catch { probe.check(false, "scenario completed: \(error.localizedDescription)") }
            await probe.cleanup()
            checks += probe.checks
            failures += probe.failures
        }
        print("RESULT \(cases.count) cases, \(checks) assertions, \(failures) failures; deterministic schedules, no random seed")
        if failures > 0 { throw AppError(message: "Engine race checks failed: \(failures)") }
    }

    private static let fakeEngine = #"""
    import {Database} from "bun:sqlite";
    import {mkdirSync, writeFileSync, readFileSync, existsSync, appendFileSync} from "node:fs";
    import {join} from "node:path";
    const root = process.env.WAVELENGTH_DATA_DIR!;
    const instance = process.env.WAVELENGTH_INSTANCE!;
    const token = process.env.WAVELENGTH_ENGINE_TOKEN!;
    const mode = readFileSync(join(root, "mode"), "utf8");
    const events = join(root, "events", instance);
    mkdirSync(events, {recursive: true});
    const mark = (name: string, value = "") => {
      writeFileSync(join(events, name), value);
      appendFileSync(join(events, "trace.jsonl"), JSON.stringify({event: name, time: Date.now(), pid: process.pid}) + "\n");
    };
    mark("parent", String(process.ppid)); mark("pid", String(process.pid));
    const gate = async (name: string) => {
      mark(name);
      const deadline = Date.now() + 6000;
      while (!existsSync(join(events, `release-${name}`))) {
        if (Date.now() > deadline) throw new Error(`Fixture barrier timed out: ${name}`);
        await Bun.sleep(5);
      }
    };
    // Same SQLite BEGIN IMMEDIATE lease as Store, in isolated synthetic state.
    const lease = new Database(join(root, "state.sqlite.lock"), {create: true});
    try { lease.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE"); }
    catch { mark("lease-rejected"); lease.close(); process.exit(23); }
    mark("leased");
    setTimeout(() => process.exit(24), 12000);
    process.on("SIGTERM", async () => {
      mark("term");
      if (mode === "hold-log-ignore-term") return;
      if (mode === "hold-term") await gate("term");
      lease.close(); process.exit(0);
    });
    const server = Bun.serve({hostname: "127.0.0.1", port: 0, async fetch(request) {
      if (request.headers.get("x-wavelength-token") !== token) {
        mark("bad-token"); return Response.json({error: "Wrong synthetic token"}, {status: 403});
      }
      const path = new URL(request.url).pathname;
      if (path === "/api/ready") {
        if (mode === "hold-ready") await gate("ready");
        return Response.json({ready: true, instance, activeJob: null});
      }
      if (path === "/api/session") {
        if (mode === "hold-session") await gate("session");
        return Response.json({token});
      }
      return Response.json({error: "Synthetic route missing"}, {status: 404});
    }});
    if (mode === "hold-log" || mode === "hold-log-ignore-term") await gate("log");
    console.log(`http://127.0.0.1:${server.port}`);
    """#
}
