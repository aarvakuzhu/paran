// Scan a shelf or room: pan the camera, and a sharp still is kept every couple of seconds.
// Resolves to an array of canvases (≤1600px), or null if cancelled. Nothing leaves the phone here.
import { esc, toast, icon } from './ui.js';
import { processPhoto } from './image.js';

const EVERY_MS = 2000;  // one kept photo per window
const SAMPLE_MS = 200;  // sharpness check rate
const SMALL = 160;      // size used for sharpness / change checks

function draw(src, w, h, max) {
  const scale = Math.min(1, max / Math.max(w, h));
  const c = document.createElement(`canvas`);
  c.width = Math.round(w * scale); c.height = Math.round(h * scale);
  c.getContext(`2d`, { willReadFrequently: max <= SMALL }).drawImage(src, 0, 0, c.width, c.height);
  return c;
}
function gray(c) {
  const d = c.getContext(`2d`).getImageData(0, 0, c.width, c.height).data;
  const g = new Float32Array(c.width * c.height);
  for (let i = 0, j = 0; i < d.length; i += 4, j++) g[j] = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
  return g;
}
/** Higher = sharper (mean absolute Laplacian). */
function sharpness(g, w, h) {
  let sum = 0;
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    sum += Math.abs(4 * g[i] - g[i - 1] - g[i + 1] - g[i - w] - g[i + w]);
  }
  return sum / ((w - 2) * (h - 2));
}
/** Mean absolute difference 0–255 between two same-size gray images. */
function change(a, b) {
  if (!a || !b || a.length !== b.length) return 255;
  let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
}

export function canUseCamera() { return Boolean(navigator.mediaDevices?.getUserMedia); }

export function captureScan({ max = 8, title = `` } = {}) {
  return new Promise((resolve) => {
    const shots = []; // canvases
    let stream = null, timer = null, auto = true, finished = false;
    let best = null, windowStart = 0, lastGray = null;

    const el = document.createElement(`div`);
    el.className = `scan`;
    el.innerHTML = `
      <video playsinline muted autoplay></video>
      <div class="scan-flash"></div>
      <header class="scan-top">
        <button type="button" class="scan-pill" data-cancel>${icon(`x`)} Cancel</button>
        <span class="scan-count" aria-live="polite"></span>
      </header>
      <p class="scan-hint">${title ? `<b>${esc(title)}</b><br>` : ``}Move slowly along the shelf. A photo is taken every couple of seconds.</p>
      <div class="scan-strip"></div>
      <footer class="scan-bottom">
        <button type="button" class="scan-pill" data-auto aria-pressed="true">Auto</button>
        <button type="button" class="scan-shutter" data-shoot aria-label="Take photo"><i></i></button>
        <button type="button" class="scan-pill primary" data-done disabled>Done</button>
      </footer>
      <input type="file" accept="image/*" multiple hidden data-files>`;
    document.body.appendChild(el);
    document.body.classList.add(`scanning`);
    const video = el.querySelector(`video`);
    const $ = (s) => el.querySelector(s);

    const update = () => {
      $(`.scan-count`).textContent = `${shots.length} of ${max}`;
      $(`[data-done]`).disabled = !shots.length;
      $(`[data-done]`).textContent = shots.length ? `Done · ${shots.length}` : `Done`;
      $(`[data-auto]`).setAttribute(`aria-pressed`, String(auto));
      $(`[data-auto]`).textContent = auto ? `Auto on` : `Auto off`;
      $(`.scan-strip`).innerHTML = shots.map((c, i) => `<button type="button" data-drop="${i}" aria-label="Remove photo ${i + 1}"><img src="${c.__thumb}" alt=""></button>`).join(``);
    };
    const keep = (canvas) => {
      if (shots.length >= max) return;
      canvas.__thumb = draw(canvas, canvas.width, canvas.height, 96).toDataURL(`image/jpeg`, 0.6);
      shots.push(canvas);
      const f = $(`.scan-flash`); f.classList.remove(`on`); void f.offsetWidth; f.classList.add(`on`);
      navigator.vibrate?.(10);
      update();
      if (shots.length >= max) { auto = false; update(); toast(`That’s ${max} photos. Tap Done.`); }
    };
    const frame = (maxSide) => draw(video, video.videoWidth, video.videoHeight, maxSide);

    const finish = (result) => {
      if (finished) return; finished = true;
      clearInterval(timer);
      stream?.getTracks().forEach((t) => t.stop());
      document.body.classList.remove(`scanning`);
      el.remove();
      resolve(result);
    };

    const tick = () => {
      if (!auto || !video.videoWidth || shots.length >= max) return;
      const now = Date.now();
      const small = frame(SMALL); const g = gray(small);
      const score = sharpness(g, small.width, small.height);
      const moved = change(g, lastGray);
      if (moved > 7 && (!best || score > best.score)) best = { score, canvas: frame(1600), g }; // only new views
      if (now - windowStart >= EVERY_MS && best) {
        keep(best.canvas); lastGray = best.g; best = null; windowStart = now;
      } else if (!best && now - windowStart >= EVERY_MS) windowStart = now;
    };

    el.addEventListener(`click`, async (e) => {
      const b = e.target.closest(`button`); if (!b) return;
      if (b.hasAttribute(`data-cancel`)) return finish(null);
      if (b.hasAttribute(`data-done`)) return finish(shots);
      if (b.hasAttribute(`data-auto`)) { auto = !auto; best = null; windowStart = Date.now(); return update(); }
      if (b.hasAttribute(`data-shoot`)) {
        if (!video.videoWidth) return $(`[data-files]`).click();
        const c = frame(1600); keep(c); lastGray = gray(frame(SMALL)); windowStart = Date.now(); best = null; return;
      }
      if (b.dataset.drop !== undefined) { shots.splice(Number(b.dataset.drop), 1); update(); }
    });
    $(`[data-files]`).addEventListener(`change`, async (e) => {
      for (const file of [...e.target.files].slice(0, max - shots.length)) {
        try { keep((await processPhoto(file)).canvas); } catch { /* skip unreadable */ }
      }
      e.target.value = ``;
    });

    update();
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: `environment` }, width: { ideal: 1920 }, height: { ideal: 1440 } } });
        if (finished) { stream.getTracks().forEach((t) => t.stop()); return; }
        video.srcObject = stream;
        await video.play().catch(() => {});
        windowStart = Date.now();
        timer = setInterval(tick, SAMPLE_MS);
      } catch {
        // No camera access (denied, or not supported): fall back to picking photos.
        auto = false; update();
        $(`.scan-hint`).innerHTML = `Camera isn’t available here. Tap the round button to choose photos instead (up to ${max}).`;
        $(`[data-auto]`).hidden = true;
      }
    })();
  });
}
