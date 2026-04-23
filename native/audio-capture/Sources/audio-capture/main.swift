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
        let content: SCShareableContent
        do {
            content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        } catch {
            FileHandle.standardError.write("ERR: SCShareableContent failed: \(error.localizedDescription) (need Screen Recording permission)\n".data(using: .utf8)!)
            exit(2)
        }
        FileHandle.standardError.write("INFO: SCK sees \(content.applications.count) apps, \(content.displays.count) displays\n".data(using: .utf8)!)

        guard let firstDisplay = content.displays.first else {
            FileHandle.standardError.write("ERR: no displays\n".data(using: .utf8)!)
            exit(2)
        }

        let target = content.applications.first { $0.bundleIdentifier == bundleID }

        let filter: SCContentFilter
        if let target {
            FileHandle.standardError.write("INFO: filter on bundle \(bundleID)\n".data(using: .utf8)!)
            filter = SCContentFilter(display: firstDisplay, including: [target], exceptingWindows: [])
        } else {
            FileHandle.standardError.write("WARN: bundle \(bundleID) not running, capturing full display audio\n".data(using: .utf8)!)
            filter = SCContentFilter(display: firstDisplay, excludingApplications: [], exceptingWindows: [])
        }

        let config = SCStreamConfiguration()
        config.capturesAudio = true
        config.sampleRate = 16000
        config.channelCount = 1

        let stream = SCStream(filter: filter, configuration: config, delegate: nil)
        let out = StdoutSink(track: track)
        do {
            try stream.addStreamOutput(out, type: .audio, sampleHandlerQueue: .main)
        } catch {
            FileHandle.standardError.write("ERR: addStreamOutput: \(error.localizedDescription)\n".data(using: .utf8)!)
            exit(2)
        }
        do {
            try await stream.startCapture()
        } catch {
            FileHandle.standardError.write("ERR: startCapture: \(error.localizedDescription)\n".data(using: .utf8)!)
            exit(2)
        }
        FileHandle.standardError.write("INFO: capture started\n".data(using: .utf8)!)

        // Also tap mic on a background task as track 1
        Task.detached { try? MicCapture.run(track: 1) }

        dispatchMain()
    }
}

final class StdoutSink: NSObject, SCStreamOutput {
    let track: UInt8
    var callbacks = 0
    init(track: UInt8) { self.track = track }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        callbacks += 1
        if callbacks <= 3 || callbacks % 50 == 0 {
            FileHandle.standardError.write("INFO: callback #\(callbacks) type=\(type.rawValue)\n".data(using: .utf8)!)
        }
        guard type == .audio else { return }
        // SCK audio arrives as AudioBufferList, not plain block buffer. Extract samples via that API.
        var abl = AudioBufferList(mNumberBuffers: 1, mBuffers: AudioBuffer(mNumberChannels: 0, mDataByteSize: 0, mData: nil))
        var blockBuffer: CMBlockBuffer?
        let status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
            sampleBuffer,
            bufferListSizeNeededOut: nil,
            bufferListOut: &abl,
            bufferListSize: MemoryLayout<AudioBufferList>.size,
            blockBufferAllocator: nil,
            blockBufferMemoryAllocator: nil,
            flags: kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment,
            blockBufferOut: &blockBuffer
        )
        guard status == noErr else {
            FileHandle.standardError.write("ERR: GetAudioBufferList status=\(status)\n".data(using: .utf8)!)
            return
        }
        let buffer = abl.mBuffers
        guard let data = buffer.mData else { return }
        let byteCount = Int(buffer.mDataByteSize)
        // SCK delivers Float32 at requested sampleRate. Convert to Int16 mono @16 kHz.
        let sampleCount = byteCount / MemoryLayout<Float>.size
        var int16 = [Int16](repeating: 0, count: sampleCount)
        data.bindMemory(to: Float.self, capacity: sampleCount).withMemoryRebound(to: Float.self, capacity: sampleCount) { ptr in
            for i in 0..<sampleCount {
                let f = max(-1.0, min(1.0, ptr[i]))
                int16[i] = Int16(f * Float(Int16.max))
            }
        }
        int16.withUnsafeBufferPointer { buf in
            buf.baseAddress!.withMemoryRebound(to: Int8.self, capacity: sampleCount * 2) { raw in
                writeFrame(track: track, bytes: UnsafeBufferPointer(start: raw, count: sampleCount * 2))
            }
        }
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
