import Darwin
import Foundation

struct ArtworkAsset { let url: URL; let hash: String }
struct ArtworkJournal: Codable {
    let version: Int
    let jobID: String
    let cloudID: String
    let name: String
    let tracks: [ArtworkTrack]
    var localID: String?
    let imageHash: String
    var writeAttempted: Bool
}

struct ArtworkStore {
    let root: URL
    init(root: URL = ArtworkPaths.root()) { self.root = root }
    static func safeFile(_ s: stat, limit: Int) -> Bool {
        s.st_uid == getuid() && s.st_mode & S_IFMT == S_IFREG && s.st_mode & 0o777 == 0o600 && s.st_nlink == 1 && s.st_size >= 0 && s.st_size <= limit
    }

    private func directory(_ target: ArtworkTarget, create: Bool) throws -> Int32? {
        let job = try ArtworkPaths.directory(jobID: target.jobID, root: root)
        let components = job.pathComponents.dropFirst()
        var fd = open("/", O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
        guard fd >= 0 else { throw ArtworkFailure.unsafeStore }
        do {
            for (index, component) in components.enumerated() {
                if create {
                    if mkdirat(fd, component, 0o700) == 0 {
                        guard fsync(fd) == 0 else { throw ArtworkFailure.unsafeStore }
                    } else if errno != EEXIST { throw ArtworkFailure.unsafeStore }
                }
                let next = openat(fd, component, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
                if next < 0 {
                    if !create && errno == ENOENT { close(fd); return nil }
                    throw ArtworkFailure.unsafeStore
                }
                close(fd); fd = next
                if index >= components.count - 2 {
                    var s = stat()
                    guard fstat(fd, &s) == 0, s.st_uid == getuid(), s.st_mode & 0o777 == 0o700 else { throw ArtworkFailure.unsafeStore }
                }
            }
            return fd
        } catch { close(fd); throw error }
    }
    private func read(_ name: String, directory: Int32, limit: Int) throws -> Data? {
        let fd = openat(directory, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
        if fd < 0 { if errno == ENOENT { return nil }; throw ArtworkFailure.unsafeStore }
        defer { close(fd) }
        var s = stat()
        guard fstat(fd, &s) == 0, Self.safeFile(s, limit: limit) else { throw ArtworkFailure.unsafeStore }
        let data = try FileHandle(fileDescriptor: fd, closeOnDealloc: false).read(upToCount: limit + 1) ?? Data()
        guard data.count == Int(s.st_size), data.count <= limit else { throw ArtworkFailure.unsafeStore }
        return data
    }
    private func write(_ data: Data, name: String, directory: Int32, replace: Bool) throws {
        if let _ = try read(name, directory: directory, limit: name == "cover.jpg" ? 4 * 1024 * 1024 : 16 * 1024 * 1024), !replace { throw ArtworkFailure.unsafeStore }
        let temporary = "." + UUID().uuidString
        let fd = openat(directory, temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
        guard fd >= 0 else { throw ArtworkFailure.unsafeStore }
        defer { close(fd); unlinkat(directory, temporary, 0) }
        try FileHandle(fileDescriptor: fd, closeOnDealloc: false).write(contentsOf: data)
        guard fsync(fd) == 0 else { throw ArtworkFailure.unsafeStore }
        let renamed = replace ? renameat(directory, temporary, directory, name) : renameatx_np(directory, temporary, directory, name, UInt32(RENAME_EXCL))
        guard renamed == 0, fsync(directory) == 0 else { throw ArtworkFailure.unsafeStore }
    }
    func load(_ target: ArtworkTarget) throws -> ArtworkJournal? {
        guard let fd = try directory(target, create: false) else { return nil }; defer { close(fd) }
        guard let data = try read("journal.json", directory: fd, limit: 16 * 1024 * 1024) else { return nil }
        let journal = try JSONDecoder().decode(ArtworkJournal.self, from: data)
        guard journal.version == 1, journal.jobID == UUID(uuidString: target.jobID)?.uuidString,
              journal.cloudID == target.playlistID, journal.name == target.name, journal.tracks == target.tracks,
              journal.imageHash.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
              !journal.writeAttempted || journal.localID != nil,
              journal.localID == nil || journal.localID!.range(of: "^[A-Fa-f0-9]{16}$", options: .regularExpression) != nil else { throw ArtworkFailure.unsafeStore }
        return journal
    }
    func save(_ journal: ArtworkJournal, target: ArtworkTarget) throws {
        guard let fd = try directory(target, create: true) else { throw ArtworkFailure.unsafeStore }; defer { close(fd) }
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        try write(encoder.encode(journal), name: "journal.json", directory: fd, replace: true)
    }
    func asset(_ target: ArtworkTarget, journal: ArtworkJournal?, render: (() throws -> Data)?) throws -> ArtworkAsset {
        guard let fd = try directory(target, create: render != nil) else { throw ArtworkFailure.unsafeStore }; defer { close(fd) }
        let bytes: Data
        if let existing = try read("cover.jpg", directory: fd, limit: 4 * 1024 * 1024) { bytes = existing }
        else {
            guard journal == nil, let render else { throw ArtworkFailure.unsafeStore }
            bytes = try render(); try ArtworkRenderer.validate(bytes)
            try write(bytes, name: "cover.jpg", directory: fd, replace: false)
        }
        try ArtworkRenderer.validate(bytes)
        let hash = ArtworkRenderer.hash(bytes)
        guard journal == nil || journal!.imageHash == hash else { throw ArtworkFailure.unsafeStore }
        return ArtworkAsset(url: try ArtworkPaths.directory(jobID: target.jobID, root: root).appendingPathComponent("cover.jpg"), hash: hash)
    }
    // UI reads bytes through the same no-follow boundary instead of opening a helper-supplied path.
    func image(jobID: String) throws -> Data {
        let target = ArtworkTarget(jobID: jobID, playlistID: "", name: "", tracks: [])
        guard let fd = try directory(target, create: false) else { throw ArtworkFailure.unsafeStore }; defer { close(fd) }
        guard let data = try read("journal.json", directory: fd, limit: 16 * 1024 * 1024),
              let journal = try? JSONDecoder().decode(ArtworkJournal.self, from: data), journal.version == 1,
              journal.jobID == UUID(uuidString: jobID)?.uuidString,
              journal.imageHash.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
              let image = try read("cover.jpg", directory: fd, limit: 4 * 1024 * 1024),
              ArtworkRenderer.hash(image) == journal.imageHash else { throw ArtworkFailure.unsafeStore }
        try ArtworkRenderer.validate(image); return image
    }
}
