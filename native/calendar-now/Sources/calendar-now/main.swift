import Foundation
import EventKit

@main
struct CalendarNow {
    static func main() async {
        let store = EKEventStore()

        // Request full access. macOS 14+ uses requestFullAccessToEvents.
        let granted: Bool
        if #available(macOS 14.0, *) {
            granted = (try? await store.requestFullAccessToEvents()) ?? false
        } else {
            granted = await withCheckedContinuation { c in
                store.requestAccess(to: .event) { ok, _ in c.resume(returning: ok) }
            }
        }
        if !granted {
            FileHandle.standardError.write("ERR: calendar-access-denied\n".data(using: .utf8)!)
            print("[]")
            exit(2)
        }

        let now = Date()
        let windowStart = now.addingTimeInterval(-30 * 60)   // 30 min back
        let windowEnd = now.addingTimeInterval(8 * 60 * 60)  // 8 hr forward (find next meeting)

        let calendars = store.calendars(for: .event)
        let predicate = store.predicateForEvents(withStart: windowStart, end: windowEnd, calendars: calendars)
        let events = store.events(matching: predicate)

        // Active = now between start and end. Else: next event in window.
        let active = events.filter { $0.startDate <= now && $0.endDate >= now }
        let result = !active.isEmpty
            ? active.sorted { $0.startDate < $1.startDate }
            : events.filter { $0.startDate > now }.sorted { $0.startDate < $1.startDate }.prefix(1).map { $0 }

        let iso = ISO8601DateFormatter()
        var out: [[String: Any]] = []
        for e in result {
            var item: [String: Any] = [
                "title": e.title ?? "",
                "start": iso.string(from: e.startDate),
                "end": iso.string(from: e.endDate),
                "isActive": (e.startDate <= now && e.endDate >= now),
                "calendar": e.calendar?.title ?? "",
            ]
            if let loc = e.location, !loc.isEmpty { item["location"] = loc }
            if let notes = e.notes, !notes.isEmpty { item["notes"] = notes }
            if let urlStr = e.url?.absoluteString, !urlStr.isEmpty { item["url"] = urlStr }
            if let attendees = e.attendees, !attendees.isEmpty {
                item["attendees"] = attendees.compactMap { att -> String? in
                    let n = att.name ?? ""
                    let u = att.url.absoluteString.replacingOccurrences(of: "mailto:", with: "")
                    return n.isEmpty ? u : (u.isEmpty ? n : "\(n) <\(u)>")
                }
            }
            out.append(item)
        }

        let data = try! JSONSerialization.data(withJSONObject: out, options: [])
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write("\n".data(using: .utf8)!)
    }
}
