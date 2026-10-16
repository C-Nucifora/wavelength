import Foundation
import Security

struct ProbeKeychain: CredentialStorage {
    // A separate fixed item. No access to Wavelength's keys or other browser/app items.
    private var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: "local.wavelength.web-session-probe.credentials.v1",
         kSecAttrAccount as String: "own-apple-music-web-session"]
    }
    func read() throws -> Data? {
        var request = query
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else { throw ProbeError.storage }
        return data
    }
    func save(_ data: Data) throws {
        let attributes: [String: Any] = [kSecValueData as String: data, kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]
        var item = query
        item.merge(attributes) { _, new in new }
        let status = SecItemAdd(item as CFDictionary, nil)
        if status == errSecDuplicateItem {
            guard SecItemUpdate(query as CFDictionary, attributes as CFDictionary) == errSecSuccess else { throw ProbeError.storage }
        } else if status != errSecSuccess { throw ProbeError.storage }
    }
    func delete() throws {
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw ProbeError.storage }
    }
}

struct ProbeJournal: AttemptStorage {
    private let url = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("Wavelength Web Session Probe/probe-attempt.json")
    func read() throws -> AttemptState {
        guard FileManager.default.fileExists(atPath: url.path) else { return AttemptState() }
        guard let data = try? Data(contentsOf: url), data.count <= 1024,
              let state = try? JSONDecoder().decode(AttemptState.self, from: data),
              state.playlistID == nil || state.playlistID!.range(of: "^[A-Za-z0-9][A-Za-z0-9.-]{0,127}$", options: .regularExpression) != nil,
              state.playlistID == nil || state.attempted else { throw ProbeError.attemptStorage }
        return state
    }
    func save(_ state: AttemptState) throws {
        do {
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            try JSONEncoder().encode(state).write(to: url, options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        } catch { throw ProbeError.attemptStorage }
    }
}
