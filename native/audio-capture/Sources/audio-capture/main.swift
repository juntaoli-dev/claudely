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

        // Also tap mic on a background task as track 1. Failures are non-fatal;
        // keep the process alive for SCK delegate callbacks.
        Task.detached { try? MicCapture.run(track: 1) }

        // Keep async main alive indefinitely so the SCStream delegate keeps
        // receiving audio. dispatchMain() does not play well with the Swift
        // concurrency runtime under @main async.
        try await Task.sleep(nanoseconds: UInt64.max)
    }
}

final class StdoutSink: NSObject, SCStreamOutput {
    let track: UInt8
    var callbacks = 0
    var srcRate: Double = 0
    var srcChannels: UInt32 = 0
    var srcIsFloat: Bool = false
    var srcIsPacked: Bool = false
    var srcIsNonInterleaved: Bool = false
    var formatLogged = false

    init(track: UInt8) { self.track = track }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        callbacks += 1
        guard type == .audio else { return }

        // Describe source format once.
        if !formatLogged,
           let fd = CMSampleBufferGetFormatDescription(sampleBuffer),
           let asbdPtr = CMAudioFormatDescriptionGetStreamBasicDescription(fd) {
            let asbd = asbdPtr.pointee
            srcRate = asbd.mSampleRate
            srcChannels = asbd.mChannelsPerFrame
            srcIsFloat = (asbd.mFormatFlags & kAudioFormatFlagIsFloat) != 0
            srcIsPacked = (asbd.mFormatFlags & kAudioFormatFlagIsPacked) != 0
            srcIsNonInterleaved = (asbd.mFormatFlags & kAudioFormatFlagIsNonInterleaved) != 0
            formatLogged = true
            FileHandle.standardError.write("INFO: SCK src fmt rate=\(srcRate) ch=\(srcChannels) bits=\(asbd.mBitsPerChannel) flags=\(asbd.mFormatFlags) float=\(srcIsFloat) nonInt=\(srcIsNonInterleaved)\n".data(using: .utf8)!)
        }
        guard srcRate == 16000, srcChannels == 1, srcIsFloat else {
            // Unexpected format — drop to avoid sending garbage to Deepgram.
            if callbacks % 100 == 0 {
                FileHandle.standardError.write("WARN: unexpected SCK format rate=\(srcRate) ch=\(srcChannels) float=\(srcIsFloat)\n".data(using: .utf8)!)
            }
            return
        }

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
        guard status == noErr, let data = abl.mBuffers.mData else { return }
        let byteCount = Int(abl.mBuffers.mDataByteSize)
        let sampleCount = byteCount / MemoryLayout<Float>.size
        if sampleCount == 0 { return }

        var int16 = [Int16](repeating: 0, count: sampleCount)
        data.withMemoryRebound(to: Float.self, capacity: sampleCount) { floatPtr in
            for i in 0..<sampleCount {
                let f = max(-1.0, min(1.0, floatPtr[i]))
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
    // installTap requires the tap format to match the node's native output format
    // (or nil). We tap at the native rate, then convert to Int16 mono @16 kHz
    // for uniform framing with SCK audio.
    static func run(track: UInt8) throws {
        let engine = AVAudioEngine()
        let input = engine.inputNode
        let srcFormat = input.outputFormat(forBus: 0)

        // Guard: silent no-op if mic has no valid input (0ch, 0Hz) so we don't
        // crash the whole helper when microphone permission isn't granted.
        if srcFormat.sampleRate == 0 || srcFormat.channelCount == 0 {
            FileHandle.standardError.write("WARN: mic input unavailable (rate=\(srcFormat.sampleRate) ch=\(srcFormat.channelCount)); skipping mic track\n".data(using: .utf8)!)
            return
        }

        guard let dstFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: true) else {
            FileHandle.standardError.write("WARN: could not create dst mic format; skipping mic track\n".data(using: .utf8)!)
            return
        }

        guard let converter = AVAudioConverter(from: srcFormat, to: dstFormat) else {
            FileHandle.standardError.write("WARN: could not create mic converter (\(srcFormat) → \(dstFormat)); skipping mic track\n".data(using: .utf8)!)
            return
        }

        input.installTap(onBus: 0, bufferSize: 2048, format: srcFormat) { buffer, _ in
            let capacity = AVAudioFrameCount(Double(buffer.frameLength) * 16000.0 / srcFormat.sampleRate) + 16
            guard let outBuf = AVAudioPCMBuffer(pcmFormat: dstFormat, frameCapacity: capacity) else { return }
            var error: NSError?
            var fed = false
            converter.convert(to: outBuf, error: &error) { _, outStatus in
                if fed { outStatus.pointee = .noDataNow; return nil }
                fed = true
                outStatus.pointee = .haveData
                return buffer
            }
            if let error {
                FileHandle.standardError.write("WARN: mic convert error: \(error.localizedDescription)\n".data(using: .utf8)!)
                return
            }
            guard let raw = outBuf.int16ChannelData?.pointee else { return }
            let byteCount = Int(outBuf.frameLength) * 2
            if byteCount == 0 { return }
            raw.withMemoryRebound(to: Int8.self, capacity: byteCount) { ptr in
                writeFrame(track: track, bytes: UnsafeBufferPointer(start: ptr, count: byteCount))
            }
        }

        do { try engine.start() } catch {
            FileHandle.standardError.write("WARN: mic engine start failed: \(error.localizedDescription)\n".data(using: .utf8)!)
            return
        }
        FileHandle.standardError.write("INFO: mic tap running at \(srcFormat.sampleRate) Hz → 16k Int16 mono\n".data(using: .utf8)!)
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
