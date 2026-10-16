import Foundation
import Darwin

@main struct WebMusicBridge {
    static func main() async {
        let envelope: [String: Any]
        do {
            guard CommandLine.arguments.count == 1 else { throw WebMusicError.invalidInput }
            var input = Data()
            while true {
                guard let chunk = try FileHandle.standardInput.read(upToCount: min(8192, 128 * 1024 + 1 - input.count)), !chunk.isEmpty else { break }
                input.append(chunk)
                guard input.count <= 128 * 1024 else { throw WebMusicError.invalidInput }
            }
            let request = try WebMusicRequest.decode(input)
            let service = WebMusicService(store: WebKeychainStorage(allowInteraction: request.action == "saveConnection"), lock: WebFileLock(), transport: WebURLSessionTransport(), artwork: NativeArtworkService())
            envelope = ["ok": true, "result": try await service.handle(request)]
        } catch let error as WebMusicError { envelope = error.envelope }
        catch { envelope = WebMusicError.unavailable.envelope }
        let output = (try? JSONSerialization.data(withJSONObject: envelope, options: [.sortedKeys])) ?? Data(#"{"ok":false,"error":{"code":"unavailable","message":"The Apple Music connection is unavailable.","uncertain":false}}"#.utf8)
        if output.count <= 128 * 1024 { try? FileHandle.standardOutput.write(contentsOf: output + Data([10])) }
        else { try? FileHandle.standardOutput.write(contentsOf: try! JSONSerialization.data(withJSONObject: WebMusicError.malformed.envelope)) }
    }
}
