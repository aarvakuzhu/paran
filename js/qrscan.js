// Scan a QR label with the camera, inside the app (so iPhone doesn't hand the link to Safari).
// Resolves with the decoded text, or null if cancelled. Uses the built-in BarcodeDetector where
// the browser has one (Android Chrome), otherwise the bundled jsQR decoder (iPhone, others).
import { esc, icon } from './ui.js';

let jsqrLoad = null;
function loadJsQR() {
  if (window.jsQR) return Promise.resolve();
  jsqrLoad ||= new Promise((res, rej) => {
    const s = document.createElement(`script`);
    s.src = `./js/vendor/jsQR.min.js`;
    s.onload = res; s.onerror = () => { jsqrLoad = null; rej(new Error(`decoder`)); };
    document.head.appendChild(s);
  });
  return jsqrLoad;
}

async function makeDetector() {
  try {
    if (`BarcodeDetector` in window && (await window.BarcodeDetector.getSupportedFormats?.())?.includes(`qr_code`)) {
      const d = new window.BarcodeDetector({ formats: [`qr_code`] });
      return async (video) => (await d.detect(video))[0]?.rawValue || null;
    }
  } catch { /* fall through */ }
  await loadJsQR();
  const c = document.createElement(`canvas`);
  const x = c.getContext(`2d`, { willReadFrequently: true });
  return async (video) => {
    const w = video.videoWidth, h = video.videoHeight; if (!w) return null;
    const scale = Math.min(1, 720 / Math.max(w, h));
    c.width = Math.round(w * scale); c.height = Math.round(h * scale);
    x.drawImage(video, 0, 0, c.width, c.height);
    const img = x.getImageData(0, 0, c.width, c.height);
    return window.jsQR(img.data, c.width, c.height, { inversionAttempts: `dontInvert` })?.data || null;
  };
}

export function scanLabel({ title = `Scan a label`, hint = `Point the camera at a Paran QR label.`, accept = () => true } = {}) {
  return new Promise((resolve) => {
    let stream = null, done = false, timer = null;
    const el = document.createElement(`div`);
    el.className = `scan qrscan`;
    el.innerHTML = `
      <video playsinline muted autoplay></video>
      <header class="scan-top"><button type="button" class="scan-pill" data-cancel>${icon(`x`)} Cancel</button><span class="scan-count">${esc(title)}</span></header>
      <div class="qr-frame" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
      <p class="scan-hint qr-hint">${esc(hint)}</p>`;
    document.body.appendChild(el);
    document.body.classList.add(`scanning`);
    const video = el.querySelector(`video`);
    const hintEl = el.querySelector(`.qr-hint`);

    const finish = (v) => {
      if (done) return; done = true;
      clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
      document.body.classList.remove(`scanning`);
      el.remove(); resolve(v);
    };
    el.querySelector(`[data-cancel]`).onclick = () => finish(null);

    (async () => {
      let detect;
      try {
        [stream, detect] = await Promise.all([
          navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: `environment` }, width: { ideal: 1280 }, height: { ideal: 960 } } }),
          makeDetector(),
        ]);
      } catch (e) {
        hintEl.innerHTML = e?.message === `decoder` ? `The scanner couldn’t load. Check your connection and try again.`
          : `Camera isn’t available. Allow camera access for this app in your phone’s settings, or use your phone’s camera app.`;
        return;
      }
      if (done) { stream.getTracks().forEach((t) => t.stop()); return; }
      video.srcObject = stream; await video.play().catch(() => {});
      let lastBad = ``;
      const loop = async () => {
        if (done) return;
        try {
          const text = await detect(video);
          if (text) {
            const verdict = accept(text);
            if (verdict === true) { navigator.vibrate?.(20); return finish(text); }
            if (text !== lastBad) { lastBad = text; hintEl.textContent = typeof verdict === `string` ? verdict : `That isn’t a Paran label.`; }
          }
        } catch { /* keep trying */ }
        timer = setTimeout(loop, 160);
      };
      loop();
    })();
  });
}
