// Liest Etikettentext und Barcodes aus einem Foto. Gegenstück zu
// ios/Runner/AppDelegate.swift: läuft im Browser auf dem Gerät, das Foto
// verlässt es nicht. Der Worker hält die Oberfläche beim Rechnen frei.
//
// Unverändert aus npm übernommen:
//   ort/            onnxruntime-web 1.31.1 (MIT)
//   paddleocr.mjs   paddleocr 1.2.1 (MIT)
//   barcode/        barcode-detector 3.2.3 und zxing-wasm 3.1.6 (MIT)
// Modelle in models/ (Apache-2.0):
//   det.onnx        huggingface.co/PaddlePaddle/PP-OCRv6_tiny_det_onnx
//   rec.onnx        huggingface.co/PaddlePaddle/PP-OCRv6_tiny_rec_onnx
//   dict.txt        huggingface.co/x3zvawq/paddleocr-js-onnx, ppocr_v6_tiny/

import * as ort from './ort/ort.wasm.min.mjs';
import { BarcodeDetector, prepareZXingModule } from './barcode/ponyfill.js';
import { PaddleOcrService, parseRecognitionDictionary } from './paddleocr.mjs';

const base = new URL('.', import.meta.url);

ort.env.wasm.wasmPaths = new URL('ort/', base).href;
// Mehrere Threads gibt es nur, wenn die Seite cross-origin-isoliert ausgeliefert wird.
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;

prepareZXingModule({
  overrides: {
    locateFile: (path, prefix) =>
      path.endsWith('.wasm') ? new URL('barcode/zxing_reader.wasm', base).href : prefix + path,
  },
});

// Dieselben Codes wie auf iOS. UPC-A meldet Apple Vision als EAN-13.
const codes = new BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_e', 'upc_a', 'qr_code'] });

async function asset(name, kind) {
  const response = await fetch(new URL(`models/${name}`, base));
  if (!response.ok) throw new Error(`${name}: ${response.status}`);
  return kind === 'text' ? response.text() : response.arrayBuffer();
}

let loading;

/// Lädt die Texterkennung einmal. Schlägt das fehl, versucht es der nächste Scan erneut.
function textReader() {
  loading ??= (async () => {
    const [detection, recognition, dictionary] = await Promise.all([
      asset('det.onnx'),
      asset('rec.onnx'),
      asset('dict.txt', 'text'),
    ]);
    return PaddleOcrService.createInstance({
      ort,
      modelPreset: 'PP-OCRv6_tiny',
      detection: { modelBuffer: detection },
      recognition: {
        modelBuffer: recognition,
        charactersDictionary: parseRecognitionDictionary(dictionary),
      },
    });
  })();
  loading.catch(() => {
    loading = undefined;
  });
  return loading;
}

async function readTexts(width, height, data) {
  const reader = await textReader();
  const lines = await reader.recognize({ width, height, data });
  return lines.map((line) => line.text.trim()).filter((text) => text.length > 0);
}

async function readBarcodes(width, height, data) {
  const found = await codes.detect(new ImageData(new Uint8ClampedArray(data.buffer), width, height));
  const values = [];
  for (const code of found) {
    const value = code.format === 'upc_a' ? `0${code.rawValue}` : code.rawValue;
    if (value && !values.includes(value)) values.push(value);
  }
  return values;
}

self.onmessage = async (event) => {
  const { id, type, text, width, height, pixels } = event.data;
  if (type === 'warm') {
    textReader().catch(() => {});
    return;
  }
  const data = new Uint8Array(pixels);
  // Wie auf iOS: Was nicht lesbar ist, bleibt leer und bricht den Scan nicht ab.
  const [texts, barcodes] = await Promise.all([
    text ? readTexts(width, height, data).catch(() => []) : [],
    readBarcodes(width, height, data).catch(() => []),
  ]);
  self.postMessage({ id, texts, barcodes });
};
