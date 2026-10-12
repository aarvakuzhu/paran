// Shrink camera photos on the device before anything is stored or uploaded.
async function loadBitmap(file) {
  if (`createImageBitmap` in window) {
    try { return await createImageBitmap(file, { imageOrientation: `from-image` }); } catch { /* fall back */ }
  }
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

function draw(src, max, sx = 0, sy = 0, sw = src.width, sh = src.height) {
  const scale = Math.min(1, max / Math.max(sw, sh));
  const c = document.createElement(`canvas`);
  c.width = Math.max(1, Math.round(sw * scale)); c.height = Math.max(1, Math.round(sh * scale));
  c.getContext(`2d`).drawImage(src, sx, sy, sw, sh, 0, 0, c.width, c.height);
  return c;
}

const toBlob = (canvas, q) => new Promise((r) => canvas.toBlob(r, `image/jpeg`, q));

/** Thumbnail as a data URL small enough for a spreadsheet cell (default < 40k chars). */
function thumbOf(canvas, { max = 280, limit = 40000 } = {}) {
  const small = draw(canvas, max);
  let q = 0.7, thumb = small.toDataURL(`image/jpeg`, q);
  while (thumb.length > limit && q > 0.3) { q -= 0.1; thumb = small.toDataURL(`image/jpeg`, q); }
  if (thumb.length > limit) thumb = draw(canvas, Math.round(max * 0.65)).toDataURL(`image/jpeg`, 0.5);
  return thumb;
}

/**
 * Returns { photo: Blob (≤1600px), thumb: data URL, canvas: the 1600px canvas (for crops),
 *           aiImage(): Promise<Blob> (≤1024px, only built if AI is used) }
 */
export async function processPhoto(file) {
  const bmp = await loadBitmap(file);
  const canvas = draw(bmp, 1600);
  const photo = await toBlob(canvas, 0.82);
  return { photo, thumb: thumbOf(canvas), canvas, aiImage: () => toBlob(draw(canvas, 1024), 0.8) };
}

/** Additional photos: full photo + a small preview, so up to five fit in one sheet cell. */
export async function processExtraPhoto(file) {
  const bmp = await loadBitmap(file);
  const canvas = draw(bmp, 1600);
  return { photo: await toBlob(canvas, 0.85), thumb: thumbOf(canvas, { max: 180, limit: 8000 }), aiImage: () => toBlob(draw(canvas, 1024), 0.8) };
}

/** A stored photo (Blob) reduced for sending to AI. */
export async function shrinkForAi(blob) {
  const bmp = await loadBitmap(blob);
  return toBlob(draw(bmp, 1024), 0.8);
}

/** Crop one item out of the photo using a Gemini box [ymin, xmin, ymax, xmax] on a 0–1000 scale. */
export async function cropItem(canvas, box) {
  if (!box) return { photo: await toBlob(canvas, 0.82), thumb: thumbOf(canvas) };
  const W = canvas.width, H = canvas.height;
  let [y0, x0, y1, x1] = [box[0] / 1000 * H, box[1] / 1000 * W, box[2] / 1000 * H, box[3] / 1000 * W];
  const padX = (x1 - x0) * 0.08, padY = (y1 - y0) * 0.08;
  x0 = Math.max(0, x0 - padX); y0 = Math.max(0, y0 - padY);
  x1 = Math.min(W, x1 + padX); y1 = Math.min(H, y1 + padY);
  if (x1 - x0 < 24 || y1 - y0 < 24) return { photo: await toBlob(canvas, 0.82), thumb: thumbOf(canvas) };
  const crop = draw(canvas, 1600, x0, y0, x1 - x0, y1 - y0);
  return { photo: await toBlob(crop, 0.85), thumb: thumbOf(crop) };
}
