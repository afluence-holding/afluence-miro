/** A presentation export contains pixels, and is never advertised as editable. */
export async function canvasToPdf(canvas: HTMLCanvasElement, title = 'Canvas') {
  const { PDFDocument } = await import('pdf-lib');
  const png = await new Promise<Blob | null>(resolve =>
    canvas.toBlob(resolve, 'image/png')
  );
  if (!png || !canvas.width || !canvas.height)
    throw new Error(
      'The canvas renderer did not produce a presentation image.'
    );
  const pdf = await PDFDocument.create();
  pdf.setTitle(title);
  pdf.setProducer('Edgeless Canvas');
  const image = await pdf.embedPng(await png.arrayBuffer());
  // PDF page coordinates are points. Bound unusually large boards uniformly.
  const scale = Math.min(0.75, 14400 / canvas.width, 14400 / canvas.height);
  const page = pdf.addPage([canvas.width * scale, canvas.height * scale]);
  page.drawImage(image, {
    x: 0,
    y: 0,
    width: page.getWidth(),
    height: page.getHeight(),
  });
  return new Blob([new Uint8Array(await pdf.save()).buffer], {
    type: 'application/pdf',
  });
}

/** Keep realtime image envelopes below 512 KiB including base64 and metadata. */
export async function boundedCanvasPreview(
  canvas: HTMLCanvasElement,
  maxBytes = 300 * 1024
) {
  let current = canvas;
  for (let attempt = 0; attempt < 5; attempt++) {
    const blob = await new Promise<Blob | null>(resolve =>
      current.toBlob(resolve, 'image/png')
    );
    if (blob && blob.size <= maxBytes) return blob;
    if (current.width <= 240 || current.height <= 160) return undefined;
    const next = document.createElement('canvas');
    next.width = Math.max(1, Math.floor(current.width * 0.7));
    next.height = Math.max(1, Math.floor(current.height * 0.7));
    const context = next.getContext('2d');
    if (!context) return undefined;
    context.drawImage(current, 0, 0, next.width, next.height);
    current = next;
  }
  return undefined;
}
