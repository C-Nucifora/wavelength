import Foundation

struct PlaylistCover: Codable {
    var state: String
    var helperAttempted: Bool
    var code: String?
    var writeAttempted: Bool?
    var imageHash: String?

    var message: String {
        if state == "pending" { return "Cover waiting to start." }
        if state == "applying" { return "Preparing and checking the playlist cover in Music…" }
        if state == "verified" { return "Cover verified in Music on this Mac. Music manages cloud sync." }
        switch code {
        case "automation-permission": return "Cover needs Automation permission to control Music. Completed songs are saved."
        case "permission-ready": return "Automation permission is ready. Retry the cover, or check a previous attempt."
        case "journal-missing": return "Cover is unconfirmed. Its local verification record is unavailable."
        case "unsafe-store", "invalid-image": return "Cover files could not be validated. Completed songs are saved."
        case "identity-mismatch", "rejected": return "Cover could not match the saved playlist and songs safely."
        case "generation-changed", "connection-unconfirmed": return "Cover needs the Apple Music connection checked. Completed songs are saved."
        case "music-unavailable", "unavailable": return "Music could not complete the cover check. Completed songs are saved."
        case "busy": return "Cover is waiting for another Music operation to finish."
        case "missing": return "The saved playlist or connection is unavailable for the cover."
        case "storage": return "Cover progress could not be saved. Completed songs are saved."
        case "invalid-input": return "Cover details could not be validated. Completed songs are saved."
        default: return state == "uncertain" ? "Cover is unconfirmed. Check again without applying another image." : "Cover could not be confirmed. Completed songs are saved."
        }
    }
    static func thumbnailData(jobID: String, expectedHash: String, store: ArtworkStore = ArtworkStore()) throws -> Data {
        guard UUID(uuidString: jobID) != nil, expectedHash.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else { throw ArtworkFailure.invalidImage }
        let bytes = try store.image(jobID: jobID)
        guard ArtworkRenderer.hash(bytes) == expectedHash else { throw ArtworkFailure.invalidImage }
        return bytes
    }
}
