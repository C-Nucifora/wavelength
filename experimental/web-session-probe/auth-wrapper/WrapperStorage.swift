import Foundation
import Security

struct WrapperKeychain: CredentialStorage {
    private var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: "local.wavelength.auth-wrapper-probe.credentials.v1",
         kSecAttrAccount as String: "own-apple-music-web-session"]
    }
    func read() throws -> Data? {
        var request = query
        request[kSecReturnData as String] = true; request[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else { throw ProbeError.storage }
        return data
    }
    func save(_ data: Data) throws {
        let attributes: [String: Any] = [kSecValueData as String: data, kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]
        var item = query; item.merge(attributes) { _, new in new }
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
