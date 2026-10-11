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

function draw(bmp, max) {
  const w = bmp.width, h = bmp.height;
  const scale = Math.min(1, max / Math.max(w, h));
  const c = document.createElement(`canvas`);
  c.width = Math.round(w * scale); c.height = Math.round(h * scale);
  c.getContext(`2d`).drawImage(bmp, 0, 0, c.width, c.height);
  return c;
}

const toBlob = (canvas, q) => new Promise((r) => canvas.toBlob(r, `image/jpeg`, q));

/** Returns { photo: Blob (≤1600px), thumb: data URL small enough for one spreadsheet cell } */
export async function processPhoto(file) {
  const bmp = await loadBitmap(file);
  const photo = await toBlob(draw(bmp, 1600), 0.82);
  const small = draw(bmp, 280);
  let q = 0.7, thumb = small.toDataURL(`image/jpeg`, q);
  while (thumb.length > 40000 && q > 0.3) { q -= 0.1; thumb = small.toDataURL(`image/jpeg`, q); }
  if (thumb.length > 40000) thumb = draw(bmp, 180).toDataURL(`image/jpeg`, 0.5);
  return { photo, thumb };
}
