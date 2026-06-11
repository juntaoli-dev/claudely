import Foundation
import AVFoundation
import ScreenCaptureKit
import CoreAudio
import AppKit

// Sentinel exit code returned when the bundle we were filtering on (Zoom, Meet,
// Teams, …) quits or stops running. listenService treats this code specially:
// instead of auto-restarting the capture, it ends the listen session so we
// don't keep an idle Deepgram socket + Swift process burning CPU all night.
let SOURCE_QUIT_EXIT: Int32 = 64

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

        // If we found a target app at startup, watch for it quitting. NSWorkspace
        // notifications need a runloop and the @main async helper doesn't have
        // one wired, so just poll runningApplications(withBundleIdentifier:)
        // every few seconds. Once the app is gone we exit with SOURCE_QUIT_EXIT
        // so the JS supervisor can tear the listen session down cleanly instead
        // of restarting us against a closed app forever.
        if target != nil {
            Task.detached {
                while true {
                    try? await Task.sleep(nanoseconds: 5_000_000_000)
                    let running = NSRunningApplication.runningApplications(withBundleIdentifier: bundleID)
                    if running.isEmpty {
                        FileHandle.standardError.write("INFO: source-quit \(bundleID) — exiting\n".data(using: .utf8)!)
                        exit(SOURCE_QUIT_EXIT)
                    }
                }
            }
        }

        // SCK binds to the current default output device and AVCaptureSession to
        // the current default input device. Both keep capturing from the OLD
        // device when the user switches (e.g. plugs in AirPods mid-meeting),
        // silently dropping audio. Watch the default-device properties; when
        // either changes, exit with code 75 so the Node side respawns us
        // cleanly against the new routing. Exit code 75 is treated as a free
        // restart (no budget consumption) by listenService.
        DeviceRouteWatcher.install()

        // Keep async main alive indefinitely so the SCStream delegate keeps
        // receiving audio. dispatchMain() does not play well with the Swift
        // concurrency runtime under @main async.
        try await Task.sleep(nanoseconds: UInt64.max)
    }
}

enum DeviceRouteWatcher {
    static var armed = false

    static func install() {
        let selectors: [AudioObjectPropertySelector] = [
            kAudioHardwarePropertyDefaultOutputDevice,
            kAudioHardwarePropertyDefaultInputDevice,
        ]
        for sel in selectors {
            var addr = AudioObjectPropertyAddress(
                mSelector: sel,
                mScope: kAudioObjectPropertyScopeGlobal,
                mElement: kAudioObjectPropertyElementMain
            )
            let status = AudioObjectAddPropertyListenerBlock(
                AudioObjectID(kAudioObjectSystemObject),
                &addr,
                DispatchQueue.main
            ) { _, _ in
                guard armed else { return }
                FileHandle.standardError.write(
                    "INFO: default audio device changed (sel=\(sel)), exiting for clean restart\n".data(using: .utf8)!
                )
                exit(75)
            }
            if status != noErr {
                FileHandle.standardError.write("WARN: AddPropertyListener failed sel=\(sel) status=\(status)\n".data(using: .utf8)!)
            }
        }
        // Arm after a short delay so startup-time settling doesn't trip an
        // immediate exit before we've even emitted any samples.
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) { armed = true }
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

// AVCaptureSession-backed mic delegate. AVAudioEngine's tap callbacks don't
// fire in a CLI/@main async helper (no NSRunLoop source), but AVCaptureSession
// wired up through AVCaptureAudioDataOutput works reliably.
final class MicDelegate: NSObject, AVCaptureAudioDataOutputSampleBufferDelegate {
    let track: UInt8
    var callbacks = 0
    init(track: UInt8) { self.track = track }

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        callbacks += 1
        if callbacks <= 3 || callbacks % 100 == 0 {
            FileHandle.standardError.write("INFO: mic av callback #\(callbacks)\n".data(using: .utf8)!)
        }
        guard let fd = CMSampleBufferGetFormatDescription(sampleBuffer),
              let asbdPtr = CMAudioFormatDescriptionGetStreamBasicDescription(fd) else { return }
        let asbd = asbdPtr.pointee
        let srcRate = asbd.mSampleRate
        let srcChannels = Int(asbd.mChannelsPerFrame)
        let isFloat = (asbd.mFormatFlags & kAudioFormatFlagIsFloat) != 0

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
        // Convert to mono Float32 samples downmixed, then resample to 16 kHz Int16.
        let bytesPerSample = isFloat ? MemoryLayout<Float>.size : MemoryLayout<Int16>.size
        let totalSamples = byteCount / bytesPerSample
        let frameCount = totalSamples / max(1, srcChannels)
        if frameCount == 0 { return }

        var monoFloat = [Float](repeating: 0, count: frameCount)
        if isFloat {
            data.withMemoryRebound(to: Float.self, capacity: totalSamples) { ptr in
                for i in 0..<frameCount {
                    var acc: Float = 0
                    for c in 0..<srcChannels { acc += ptr[i * srcChannels + c] }
                    monoFloat[i] = acc / Float(srcChannels)
                }
            }
        } else {
            data.withMemoryRebound(to: Int16.self, capacity: totalSamples) { ptr in
                for i in 0..<frameCount {
                    var acc: Int32 = 0
                    for c in 0..<srcChannels { acc += Int32(ptr[i * srcChannels + c]) }
                    monoFloat[i] = Float(acc) / Float(srcChannels) / Float(Int16.max)
                }
            }
        }

        // Linear downsample to 16 kHz.
        let srcHz = srcRate
        let dstHz = 16000.0
        let ratio = dstHz / srcHz
        let outCount = Int(Double(frameCount) * ratio)
        if outCount == 0 { return }
        var int16 = [Int16](repeating: 0, count: outCount)
        for i in 0..<outCount {
            let srcIdx = Int(Double(i) / ratio)
            let s = min(max(monoFloat[min(srcIdx, frameCount - 1)], -1.0), 1.0)
            int16[i] = Int16(s * Float(Int16.max))
        }
        int16.withUnsafeBufferPointer { buf in
            buf.baseAddress!.withMemoryRebound(to: Int8.self, capacity: outCount * 2) { raw in
                writeFrame(track: track, bytes: UnsafeBufferPointer(start: raw, count: outCount * 2))
            }
        }
    }
}

enum MicCapture {
    // Hold strong references; otherwise the session/delegate dealloc on return.
    static var session: AVCaptureSession?
    static var delegate: MicDelegate?

    static func run(track: UInt8) throws {
        // Explicitly check + request mic TCC so the child binary is attributed
        // correctly. Electron-level grant doesn't always cascade.
        let current = AVCaptureDevice.authorizationStatus(for: .audio)
        FileHandle.standardError.write("INFO: mic TCC status=\(current.rawValue) (0=notDetermined 1=restricted 2=denied 3=authorized)\n".data(using: .utf8)!)
        if current == .denied || current == .restricted {
            FileHandle.standardError.write("ERR: mic access denied; user voice will not be captured. Grant Microphone in System Settings for the host app.\n".data(using: .utf8)!)
            return
        }
        if current == .notDetermined {
            let sem = DispatchSemaphore(value: 0)
            AVCaptureDevice.requestAccess(for: .audio) { granted in
                FileHandle.standardError.write("INFO: mic TCC request granted=\(granted)\n".data(using: .utf8)!)
                sem.signal()
            }
            sem.wait()
            if AVCaptureDevice.authorizationStatus(for: .audio) != .authorized {
                FileHandle.standardError.write("ERR: mic access still not authorized after request.\n".data(using: .utf8)!)
                return
            }
        }

        let session = AVCaptureSession()
        MicCapture.session = session
        session.beginConfiguration()

        guard let device = AVCaptureDevice.default(for: .audio) else {
            FileHandle.standardError.write("WARN: no default audio capture device\n".data(using: .utf8)!)
            return
        }
        FileHandle.standardError.write("INFO: mic device name=\(device.localizedName) uid=\(device.uniqueID)\n".data(using: .utf8)!)

        let input: AVCaptureDeviceInput
        do { input = try AVCaptureDeviceInput(device: device) } catch {
            FileHandle.standardError.write("WARN: mic AVCaptureDeviceInput failed: \(error.localizedDescription)\n".data(using: .utf8)!)
            return
        }
        if session.canAddInput(input) { session.addInput(input) }
        else {
            FileHandle.standardError.write("WARN: mic canAddInput=false\n".data(using: .utf8)!)
            return
        }

        let output = AVCaptureAudioDataOutput()
        let delegate = MicDelegate(track: track)
        MicCapture.delegate = delegate
        let q = DispatchQueue(label: "claudely.mic", qos: .userInitiated)
        output.setSampleBufferDelegate(delegate, queue: q)
        if session.canAddOutput(output) { session.addOutput(output) }
        else {
            FileHandle.standardError.write("WARN: mic canAddOutput=false\n".data(using: .utf8)!)
            return
        }
        session.commitConfiguration()

        session.startRunning()
        FileHandle.standardError.write("INFO: mic session running=\(session.isRunning)\n".data(using: .utf8)!)
    }
}

// Single serial queue for all stdout writes so SCK + mic don't interleave inside
// a length-prefixed frame and corrupt the parser.
private let stdoutQueue = DispatchQueue(label: "claudely.stdout-serial")

func writeFrame(track: UInt8, bytes: UnsafeBufferPointer<Int8>) {
    let payload = Data(buffer: bytes)
    stdoutQueue.async {
        var header = UInt32(payload.count + 1).bigEndian
        let stdout = FileHandle.standardOutput
        withUnsafeBytes(of: &header) { stdout.write(Data($0)) }
        stdout.write(Data([track]))
        stdout.write(payload)
    }
}
