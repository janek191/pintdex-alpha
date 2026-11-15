// Brücke zwischen der App (lib/scan/photo_web.dart) und dem Lese-Worker.
// `pintdexScan.read(url, text, mirrored)` liefert JSON mit `texts` und `barcodes`.

(() => {
  const here = document.currentScript.src;
  // Längste Seite des Fotos in Pixeln. Reicht für Etikett und Barcode.
  const longestSide = 1920;

  let worker;
  let count = 0;
  const waiting = new Map();

  function open() {
    if (worker) return worker;
    worker = new Worker(new URL('worker.js', here), { type: 'module' });
    worker.onmessage = (event) => {
      const done = waiting.get(event.data.id);
      waiting.delete(event.data.id);
      if (done) done({ texts: event.data.texts, barcodes: event.data.barcodes });
    };
    worker.onerror = () => {
      // Der Worker ist nicht mehr zu gebrauchen. Offene Scans enden ohne Treffer.
      for (const done of waiting.values()) done({ texts: [], barcodes: [] });
      waiting.clear();
      worker.terminate();
      worker = undefined;
    };
    return worker;
  }

  async function pixels(url, mirrored) {
    const image = new Image();
    image.src = url;
    await image.decode();
    const scale = Math.min(1, longestSide / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (mirrored) {
      context.translate(canvas.width, 0);
      context.scale(-1, 1);
    }
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return context.getImageData(0, 0, canvas.width, canvas.height);
  }

  /// Ohne `text` werden nur Barcodes gelesen, etwa beim Freundschaftscode.
  /// Ein `mirrored` aufgenommenes Foto wird vor dem Lesen zurückgespiegelt.
  async function read(url, text = true, mirrored = false) {
    const photo = await pixels(url, mirrored);
    const result = await new Promise((resolve) => {
      const id = ++count;
      waiting.set(id, resolve);
      open().postMessage(
        { id, type: 'read', text, width: photo.width, height: photo.height, pixels: photo.data.buffer },
        [photo.data.buffer],
      );
    });
    return JSON.stringify(result);
  }

  /// Lädt die Texterkennung vor, damit der erste Scan nicht darauf wartet.
  function warm() {
    open().postMessage({ type: 'warm' });
  }

  window.pintdexScan = { read, warm };
})();
