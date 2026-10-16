import Foundation
import Security
import LocalAuthentication
import Darwin

final class WebFileLock: WebOperationLock {
    private let directory: URL
    private var descriptor: Int32 = -1
    init(directory: URL = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Wavelength/WebMusic", isDirectory: true)) { self.directory = directory }
    func acquire() throws {
        guard descriptor == -1 else { throw WebMusicError.busy }
        do { try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700]) }
        catch { throw WebMusicError.storage }
        var info = stat()
        guard lstat(directory.path, &info) == 0, info.st_uid == getuid(), (info.st_mode & S_IFMT) == S_IFDIR, (info.st_mode & 0o077) == 0 else { throw WebMusicError.storage }
        let file = directory.appendingPathComponent("operation.lock").path
        let fd = open(file, O_CREAT | O_RDWR | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard fd >= 0 else { throw WebMusicError.storage }
        guard fstat(fd, &info) == 0, info.st_uid == getuid(), (info.st_mode & S_IFMT) == S_IFREG, (info.st_mode & 0o077) == 0, info.st_nlink == 1 else { close(fd); throw WebMusicError.storage }
        guard flock(fd, LOCK_EX | LOCK_NB) == 0 else {
            let busy = errno == EWOULDBLOCK || errno == EAGAIN
            close(fd); throw busy ? WebMusicError.busy : WebMusicError.storage
        }
        descriptor = fd
    }
    func release() {
        if descriptor >= 0 { flock(descriptor, LOCK_UN); close(descriptor); descriptor = -1 }
    }
    deinit { release() }
}

enum WebKeychainOperation { case read, add, update, delete }
struct WebKeychainStorage: WebCredentialStorage {
    typealias Access = (WebKeychainOperation, [String: Any], [String: Any]?) -> (OSStatus, Data?)
    private let access: Access
    private let allowInteraction: Bool
    init(allowInteraction: Bool = false, access: @escaping Access = WebKeychainStorage.systemAccess) { self.allowInteraction = allowInteraction; self.access = access }
    private var query: [String: Any] {
        let context = LAContext(); context.interactionNotAllowed = !allowInteraction
        return [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: "local.wavelength.apple-music.web-session.v1",
         kSecAttrAccount as String: "apple-music-web-session",
         kSecUseAuthenticationContext as String: context]
    }
    private static func systemAccess(_ operation: WebKeychainOperation, _ query: [String: Any], _ attributes: [String: Any]?) -> (OSStatus, Data?) {
        switch operation {
        case .read:
            var value: CFTypeRef?
            let status = SecItemCopyMatching(query as CFDictionary, &value)
            return (status, value as? Data)
        case .add: return (SecItemAdd(query as CFDictionary, nil), nil)
        case .update: return (SecItemUpdate(query as CFDictionary, attributes! as CFDictionary), nil)
        case .delete: return (SecItemDelete(query as CFDictionary), nil)
        }
    }
    func read() throws -> Data? {
        var query = query; query[kSecReturnData as String] = true; query[kSecMatchLimit as String] = kSecMatchLimitOne
        let (status, data) = access(.read, query, nil)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data else { throw WebMusicError.storage }
        return data
    }
    func save(_ data: Data) throws {
        guard data.count <= 40_000 else { throw WebMusicError.storage }
        let attributes: [String: Any] = [kSecValueData as String: data, kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]
        var item = query; item.merge(attributes) { _, new in new }
        let (status, _) = access(.add, item, nil)
        if status == errSecDuplicateItem {
            guard access(.update, query, attributes).0 == errSecSuccess else { throw WebMusicError.storage }
        } else if status != errSecSuccess { throw WebMusicError.storage }
    }
    func delete() throws {
        let (status, _) = access(.delete, query, nil)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw WebMusicError.storage }
    }
}
