import Foundation
#if canImport(FoundationModels)
import FoundationModels
#endif

@main
struct Classifier {
    static let systemPrompt = """
    You classify meeting utterances. Decide if the utterance is addressed to a repo-aware AI assistant and needs answering.
    Always return strict JSON: {"addressed": bool, "question": string|null}. No prose.
    """

    static func main() async {
        #if canImport(FoundationModels)
        // SystemLanguageModel must be available + Apple Intelligence enabled.
        let model = SystemLanguageModel.default
        switch model.availability {
        case .available:
            FileHandle.standardError.write("INFO: SystemLanguageModel available\n".data(using: .utf8)!)
        case .unavailable(let reason):
            FileHandle.standardError.write("ERR: model-unavailable: \(String(describing: reason))\n".data(using: .utf8)!)
            exit(2)
        @unknown default:
            FileHandle.standardError.write("ERR: model-unavailable: unknown\n".data(using: .utf8)!)
            exit(2)
        }

        let session = LanguageModelSession(instructions: Self.systemPrompt)

        let stdin = FileHandle.standardInput
        while let line = try? stdin.readLineUTF8() {
            let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { continue }
            let prompt = "Utterance: \(trimmed)\nRespond with JSON only."
            do {
                let resp = try await session.respond(to: prompt)
                let payload = resp.content.trimmingCharacters(in: .whitespacesAndNewlines)
                print(payload)
                fflush(stdout)
            } catch {
                FileHandle.standardError.write("WARN: respond failed: \(error.localizedDescription)\n".data(using: .utf8)!)
                print("{\"addressed\":false,\"question\":null}")
                fflush(stdout)
            }
        }
        #else
        FileHandle.standardError.write("ERR: model-unavailable\n".data(using: .utf8)!)
        exit(2)
        #endif
    }
}

extension FileHandle {
    // Line-at-a-time reader for stdin. Returns nil on EOF.
    func readLineUTF8() throws -> String? {
        var buf = Data()
        while true {
            let b = try? read(upToCount: 1)
            guard let b, !b.isEmpty else { return buf.isEmpty ? nil : String(data: buf, encoding: .utf8) }
            if b == Data([0x0a]) { return String(data: buf, encoding: .utf8) }
            buf.append(b)
        }
    }
}
