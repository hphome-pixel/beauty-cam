const video = document.querySelector("#camera");
const canvas = document.querySelector("#preview");
const ctx = canvas.getContext("2d", { willReadFrequently: true });
const emptyState = document.querySelector("#emptyState");
const permissionState = document.querySelector("#permissionState");
const startButton = document.querySelector("#startButton");
const retryButton = document.querySelector("#retryButton");
const flipButton = document.querySelector("#flipButton");
const captureButton = document.querySelector("#captureButton");
const saveButton = document.querySelector("#saveButton");
const toast = document.querySelector("#toast");

const controls = {
  smoothness: document.querySelector("#smoothness"),
  whitening: document.querySelector("#whitening"),
  blush: document.querySelector("#blush"),
};

let stream = null;
let facingMode = "user";
let currentFilter = "natural";
let latestPhotoUrl = "";
let animationFrame = 0;
let previewWidth = 720;
let previewHeight = 1280;

const filterSettings = {
  natural: { brightness: 6, contrast: 1.04, saturation: 1.04, warmth: 2, fade: 0 },
  pink: { brightness: 12, contrast: 1.02, saturation: 1.08, warmth: -3, fade: 7 },
  cool: { brightness: 14, contrast: 1.05, saturation: 0.98, warmth: -12, fade: 3 },
  film: { brightness: 4, contrast: 1.14, saturation: 0.92, warmth: 10, fade: 10 },
  mono: { brightness: 6, contrast: 1.12, saturation: 0, warmth: 0, fade: 0 },
};

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("show");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toast.classList.remove("show"), 2200);
}

function fitCanvas() {
  const rect = canvas.getBoundingClientRect();
  const ratio = Math.min(window.devicePixelRatio || 1, 1.5);
  canvas.width = Math.max(1, Math.round(rect.width * ratio));
  canvas.height = Math.max(1, Math.round(rect.height * ratio));
}

async function startCamera() {
  stopCamera();
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode,
        width: { ideal: 1280 },
        height: { ideal: 1920 },
      },
    });

    video.srcObject = stream;
    await video.play();
    emptyState.hidden = true;
    permissionState.hidden = true;
    fitCanvas();
    drawLoop();
    showToast("相機已開啟");
  } catch (error) {
    emptyState.hidden = true;
    permissionState.hidden = false;
    showToast("無法開啟相機");
  }
}

function stopCamera() {
  window.cancelAnimationFrame(animationFrame);
  if (stream) {
    stream.getTracks().forEach((track) => track.stop());
  }
  stream = null;
}

function drawLoop() {
  if (!video.videoWidth || !video.videoHeight) {
    animationFrame = window.requestAnimationFrame(drawLoop);
    return;
  }

  previewWidth = video.videoWidth;
  previewHeight = video.videoHeight;
  ctx.save();
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  drawVideoCover(ctx, canvas.width, canvas.height);
  ctx.restore();

  const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
  beautify(frame.data);
  ctx.putImageData(frame, 0, 0);
  animationFrame = window.requestAnimationFrame(drawLoop);
}

function beautify(data) {
  const smoothness = Number(controls.smoothness.value) / 100;
  const whitening = Number(controls.whitening.value) / 100;
  const blush = Number(controls.blush.value) / 100;
  const filter = filterSettings[currentFilter];

  for (let i = 0; i < data.length; i += 4) {
    let r = data[i];
    let g = data[i + 1];
    let b = data[i + 2];

    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const skinTone =
      r > 72 &&
      g > 42 &&
      b > 32 &&
      r > b * 1.05 &&
      r > g * 0.88 &&
      max - min > 12 &&
      max - min < 120;

    if (skinTone) {
      const avg = (r + g + b) / 3;
      r = r + (avg - r) * smoothness * 0.24 + whitening * 22 + blush * 15;
      g = g + (avg - g) * smoothness * 0.2 + whitening * 18 + blush * 4;
      b = b + (avg - b) * smoothness * 0.18 + whitening * 16 + blush * 7;
    }

    r += filter.brightness + filter.warmth;
    g += filter.brightness;
    b += filter.brightness - filter.warmth;

    const gray = r * 0.299 + g * 0.587 + b * 0.114;
    r = gray + (r - gray) * filter.saturation;
    g = gray + (g - gray) * filter.saturation;
    b = gray + (b - gray) * filter.saturation;

    r = (r - 128) * filter.contrast + 128 + filter.fade;
    g = (g - 128) * filter.contrast + 128 + filter.fade;
    b = (b - 128) * filter.contrast + 128 + filter.fade;

    data[i] = clamp(r);
    data[i + 1] = clamp(g);
    data[i + 2] = clamp(b);
  }
}

function drawVideoCover(targetCtx, targetWidth, targetHeight) {
  const videoRatio = video.videoWidth / video.videoHeight;
  const targetRatio = targetWidth / targetHeight;
  let sourceWidth = video.videoWidth;
  let sourceHeight = video.videoHeight;
  let sourceX = 0;
  let sourceY = 0;

  if (videoRatio > targetRatio) {
    sourceWidth = video.videoHeight * targetRatio;
    sourceX = (video.videoWidth - sourceWidth) / 2;
  } else {
    sourceHeight = video.videoWidth / targetRatio;
    sourceY = (video.videoHeight - sourceHeight) / 2;
  }

  targetCtx.drawImage(
    video,
    sourceX,
    sourceY,
    sourceWidth,
    sourceHeight,
    0,
    0,
    targetWidth,
    targetHeight,
  );
}

function clamp(value) {
  return Math.max(0, Math.min(255, value));
}

function capturePhoto() {
  if (!stream) {
    showToast("請先開啟相機");
    return;
  }

  const photo = document.createElement("canvas");
  const photoCtx = photo.getContext("2d");
  photo.width = previewWidth;
  photo.height = previewHeight;
  drawVideoCover(photoCtx, photo.width, photo.height);

  const frame = photoCtx.getImageData(0, 0, photo.width, photo.height);
  beautify(frame.data);
  photoCtx.putImageData(frame, 0, 0);

  if (latestPhotoUrl) {
    URL.revokeObjectURL(latestPhotoUrl);
  }

  photo.toBlob((blob) => {
    latestPhotoUrl = URL.createObjectURL(blob);
    saveButton.disabled = false;
    showToast("已拍照，可以按右下儲存");
  }, "image/jpeg", 0.94);
}

function savePhoto() {
  if (!latestPhotoUrl) {
    showToast("還沒有照片");
    return;
  }

  const link = document.createElement("a");
  link.href = latestPhotoUrl;
  link.download = `beauty-cam-${Date.now()}.jpg`;
  document.body.append(link);
  link.click();
  link.remove();
  showToast("照片已輸出");
}

document.querySelector("#filterRow").addEventListener("click", (event) => {
  const button = event.target.closest("[data-filter]");
  if (!button) return;
  currentFilter = button.dataset.filter;
  document.querySelectorAll(".filter-chip").forEach((chip) => chip.classList.remove("active"));
  button.classList.add("active");
});

startButton.addEventListener("click", startCamera);
retryButton.addEventListener("click", startCamera);
captureButton.addEventListener("click", capturePhoto);
saveButton.addEventListener("click", savePhoto);
flipButton.addEventListener("click", () => {
  facingMode = facingMode === "user" ? "environment" : "user";
  startCamera();
});

window.addEventListener("resize", fitCanvas);
window.addEventListener("beforeunload", stopCamera);

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}
