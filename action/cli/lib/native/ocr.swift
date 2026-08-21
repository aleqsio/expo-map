// Tiny OCR CLI on Apple Vision: prints one JSON line per recognized string with
// its normalized bounding box (origin bottom-left, as Vision reports). Compiled
// on first use by lib/ocr.mjs; macOS runners have swiftc via Xcode.
import Foundation
import Vision
import AppKit
let path = CommandLine.arguments[1]
guard let img = NSImage(contentsOfFile: path), let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else { exit(2) }
let req = VNRecognizeTextRequest { r, _ in
  for o in (r.results as? [VNRecognizedTextObservation]) ?? [] {
    if let t = o.topCandidates(1).first {
      let b = o.boundingBox
      let s = t.string.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"").replacingOccurrences(of: "\n", with: " ")
      print("{\"text\":\"\(s)\",\"x\":\(b.origin.x),\"y\":\(b.origin.y),\"w\":\(b.size.width),\"h\":\(b.size.height)}")
    }
  }
}
req.recognitionLevel = .fast
req.usesLanguageCorrection = false
try? VNImageRequestHandler(cgImage: cg, options: [:]).perform([req])
