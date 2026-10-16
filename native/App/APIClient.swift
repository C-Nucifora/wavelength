import Foundation

@MainActor final class APIClient {
    let baseURL: URL
    var token = ""
    private let session: URLSession
    init(baseURL: URL, session: URLSession = .shared) { self.baseURL = baseURL; self.session = session }
    func request(_ path: String, body: [String: Any]? = nil) throws -> URLRequest {
        guard path.hasPrefix("/api/"), let url = URL(string: path, relativeTo: baseURL)?.absoluteURL else {
            throw AppError(message: "Invalid engine request.")
        }
        var request = URLRequest(url: url, timeoutInterval: 120)
        request.cachePolicy = .reloadIgnoringLocalCacheData
        if url.path == "/api/history" {
            guard !token.isEmpty else { throw AppError(message: "The engine session is not ready. Retry startup.") }
            request.setValue(token, forHTTPHeaderField: "x-wavelength-token")
        }
        if let body {
            guard !token.isEmpty else { throw AppError(message: "The engine session is not ready. Retry startup.") }
            request.httpMethod = "POST"
            request.setValue(baseURL.absoluteString, forHTTPHeaderField: "Origin")
            request.setValue(token, forHTTPHeaderField: "x-wavelength-token")
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        return request
    }
    func csvRequest(_ data: Data) throws -> URLRequest {
        guard data.count <= HistoryFileReader.byteLimit else { throw AppError(message: "CSV exceeds 20 MiB.") }
        var request = try self.request("/api/history/preview", body: [:])
        request.setValue("text/csv; charset=utf-8", forHTTPHeaderField: "Content-Type")
        request.httpBody = data
        return request
    }
    func uploadCSV<T: Decodable>(_ data: Data) async throws -> T {
        let (data, response) = try await session.data(for: csvRequest(data))
        try Task.checkCancellation()
        return try decode(data, response: response)
    }
    func decode<T: Decodable>(_ data: Data, response: URLResponse) throws -> T {
        guard let response = response as? HTTPURLResponse else { throw AppError(message: "The engine returned an invalid response.") }
        guard (200..<300).contains(response.statusCode) else {
            throw AppError(message: (try? JSONDecoder().decode(ErrorResponse.self, from: data).error) ?? "Engine request failed with HTTP \(response.statusCode).")
        }
        do { return try JSONDecoder().decode(T.self, from: data) }
        catch { throw AppError(message: "The engine response could not be read. Retry startup.") }
    }
    func call<T: Decodable>(_ path: String, body: [String: Any]? = nil) async throws -> T {
        let (data, response) = try await session.data(for: request(path, body: body))
        try Task.checkCancellation()
        return try decode(data, response: response)
    }
}
