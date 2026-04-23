import Foundation
import AVFoundation
import ScreenCaptureKit
import CoreAudio

// Protocol: length-prefixed frames on stdout.
// Frame format: [UInt32 BE length][UInt8 track (0=them,1=me)][Int16 LE PCM samples @16kHz mono]

@main
struct AudioCapture {
    static func main() async {
        let bundleID = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "us.zoom.xos"
        do {
            try await runSCKStream(bundleID: bundleID, track: 0)
        } catch {
            FileHandle.standardError.write("ERR: \(error.localizedDescription)\n".data(using: .utf8)!)
            exit(2)
        }
    }

    static func runSCKStream(bundleID: String, track: UInt8) async throws {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        let target = content.applications.first { $0.bundleIdentifier == bundleID }

        let filter: SCContentFilter
        if let target {
            filter = SCContentFilter(display: content.displays.first!, including: [target], exceptingWindows: [])
        } else {
            FileHandle.standardError.write("WARN: bundle \(bundleID) not running, capturing full display audio\n".data(using: .utf8)!)
            filter = SCContentFilter(display: content.displays.first!, excludingApplications: [], exceptingWindows: [])
        }

        let config = SCStreamConfiguration()
        config.capturesAudio = true
        config.sampleRate = 16000
        config.channelCount = 1

        let stream = SCStream(filter: filter, configuration: config, delegate: nil)
        let out = StdoutSink(track: track)
        try stream.addStreamOutput(out, type: .audio, sampleHandlerQueue: .main)
        try await stream.startCapture()

        // Also tap mic on a background task as track 1
        Task.detached { try? MicCapture.run(track: 1) }

        dispatchMain()
    }
}

final class StdoutSink: NSObject, SCStreamOutput {
    let track: UInt8
    init(track: UInt8) { self.track = track }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio, let bb = sampleBuffer.dataBuffer else { return }
        var lengthOut = 0
        var dataOut: UnsafeMutablePointer<Int8>?
        CMBlockBufferGetDataPointer(bb, atOffset: 0, lengthAtOffsetOut: nil, totalLengthOut: &lengthOut, dataPointerOut: &dataOut)
        guard let dataOut else { return }
        writeFrame(track: track, bytes: UnsafeBufferPointer(start: dataOut, count: lengthOut))
    }
}

enum MicCapture {
    static func run(track: UInt8) throws {
        let engine = AVAudioEngine()
        let input = engine.inputNode
        let format = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: true)!
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
            guard let raw = buffer.int16ChannelData?.pointee else { return }
            let byteCount = Int(buffer.frameLength) * 2
            raw.withMemoryRebound(to: Int8.self, capacity: byteCount) { ptr in
                writeFrame(track: track, bytes: UnsafeBufferPointer(start: ptr, count: byteCount))
            }
        }
        try engine.start()
        RunLoop.current.run()
    }
}

func writeFrame(track: UInt8, bytes: UnsafeBufferPointer<Int8>) {
    var header = UInt32(bytes.count + 1).bigEndian
    let stdout = FileHandle.standardOutput
    withUnsafeBytes(of: &header) { stdout.write(Data($0)) }
    stdout.write(Data([track]))
    stdout.write(Data(buffer: bytes))
}
