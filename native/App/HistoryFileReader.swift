import Foundation
import Darwin

enum HistoryFileReader {
    static let byteLimit = 20 * 1024 * 1024

    static func read(_ url: URL) async throws -> Data {
        let task = Task.detached {
            try Task.checkCancellation()
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            guard url.isFileURL else { throw AppError(message: "Select a regular CSV file.") }
            // Nonblocking open lets us reject FIFOs without waiting for a writer.
            let descriptor = open(url.path, O_RDONLY | O_NONBLOCK)
            guard descriptor >= 0 else { throw AppError(message: "The selected CSV could not be opened.") }
            let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
            defer { try? handle.close() }
            var status = stat()
            guard fstat(descriptor, &status) == 0, status.st_mode & S_IFMT == S_IFREG else {
                throw AppError(message: "Select a regular CSV file.")
            }
            return try await readChunks(size: Int(exactly: status.st_size)) {
                let remaining = byteLimit - Int(try handle.offset())
                return try handle.read(upToCount: min(65536, max(1, remaining + 1)))
            }
        }
        return try await withTaskCancellationHandler {
            let data = try await task.value
            try Task.checkCancellation()
            return data
        } onCancel: { task.cancel() }
    }

    static func readChunks(size: Int?, next: @Sendable () throws -> Data?) async throws -> Data {
        try Task.checkCancellation()
        if let size, size > byteLimit { throw AppError(message: "CSV exceeds 20 MiB.") }
        var data = Data()
        if let size, size > 0 { data.reserveCapacity(size) }
        while let chunk = try next(), !chunk.isEmpty {
            try Task.checkCancellation()
            guard chunk.count <= byteLimit - data.count else { throw AppError(message: "CSV exceeds 20 MiB.") }
            data.append(chunk)
        }
        try Task.checkCancellation()
        return data
    }
}
