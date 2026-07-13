// pep-ocr — on-device text recognition via Apple's Vision framework (VNRecognizeTextRequest).
// Reads an image file, returns JSON: {"lines":[{"text","confidence","x","y","w","h"}]} where the
// box is normalized 0–1 with a TOP-LEFT origin (converted from Vision's bottom-left) so the Node
// side can map it straight onto ffmpeg crop coordinates. No app bundle needed — pure CLI.
//
// Build:  swiftc -O -o pep-ocr pep-ocr.swift -framework Vision -framework AppKit
// Usage:  pep-ocr <imagePath> [fast]     (2nd arg "fast" → .fast recognition level)

import Foundation
import Vision
import AppKit

func fail(_ msg: String, _ code: Int32) -> Never {
  FileHandle.standardError.write((msg + "\n").data(using: .utf8)!)
  exit(code)
}

let args = CommandLine.arguments
guard args.count >= 2 else { fail("usage: pep-ocr <image> [fast]", 2) }
let imagePath = args[1]
let fast = args.count >= 3 && args[2] == "fast"

guard let image = NSImage(contentsOfFile: imagePath),
      let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
  fail("cannot load image: \(imagePath)", 3)
}

let request = VNRecognizeTextRequest()
request.recognitionLevel = fast ? .fast : .accurate
request.usesLanguageCorrection = false   // HUD text is not prose; correction hurts scores/tags

let handler = VNImageRequestHandler(cgImage: cg, options: [:])
do {
  try handler.perform([request])
} catch {
  fail("vision request failed: \(error.localizedDescription)", 4)
}

var lines: [[String: Any]] = []
for obs in (request.results ?? []) {
  guard let best = obs.topCandidates(1).first else { continue }
  let b = obs.boundingBox   // normalized, bottom-left origin
  lines.append([
    "text": best.string,
    "confidence": best.confidence,
    "x": b.origin.x,
    "y": 1.0 - b.origin.y - b.size.height,   // flip to top-left origin
    "w": b.size.width,
    "h": b.size.height,
  ])
}

let out = try! JSONSerialization.data(withJSONObject: ["lines": lines], options: [])
FileHandle.standardOutput.write(out)
