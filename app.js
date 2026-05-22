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
const photoSheet = document.querySelector("#photoSheet");
const photoPreview = document.querySelector("#photoPreview");
const closePhotoButton = document.querySelector("#closePhotoButton");
const downloadPhotoLink = document.querySelector("#downloadPhotoLink");
const toast = document.querySelector("#toast");

const controls = {
  smoothness: document.querySelector("#smoothness"),
  whitening: document.querySelector("#whitening"),
  blush: document.querySelector("#blush"),
  slimFace: document.querySelector("#slimFace"),
  bigEyes: document.querySelector("#bigEyes"),
};

let stream = null;
let faceMesh = null;
let facingMode = "user";
let currentFilter = "natural";
let latestPhotoUrl = "";
let latestPhotoDataUrl = "";
let animationFrame = 0;
let previewWidth = 720;
let previewHeight = 1280;
let latestLandmarks = null;
let lastFaceSentAt = 0;
let faceModelReady = false;
let faceModelLoading = false;

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
    await setupFaceMesh();
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
  queueFaceDetection();
  applyFaceShape(frame);
  beautify(frame.data);
  ctx.putImageData(frame, 0, 0);
  animationFrame = window.requestAnimationFrame(drawLoop);
}

async function setupFaceMesh() {
  if (faceMesh || faceModelLoading || !window.FaceMesh) return;
  faceModelLoading = true;
  try {
    faceMesh = new window.FaceMesh({
      locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`,
    });
    faceMesh.setOptions({
      maxNumFaces: 1,
      refineLandmarks: true,
      minDetectionConfidence: 0.55,
      minTrackingConfidence: 0.55,
    });
    faceMesh.onResults((results) => {
      latestLandmarks = results.multiFaceLandmarks?.[0] || null;
      faceModelReady = true;
    });
  } catch (error) {
    faceMesh = null;
  } finally {
    faceModelLoading = false;
  }
}

function queueFaceDetection() {
  const wantsShape = Number(controls.slimFace.value) > 0 || Number(controls.bigEyes.value) > 0;
  if (!faceMesh || !wantsShape || !video.videoWidth || performance.now() - lastFaceSentAt < 160) {
    return;
  }

  lastFaceSentAt = performance.now();
  faceMesh.send({ image: video }).catch(() => {
    latestLandmarks = null;
  });
}

function applyFaceShape(frame) {
  const slim = Number(controls.slimFace.value) / 100;
  const eyes = Number(controls.bigEyes.value) / 100;
  if ((!slim && !eyes) || !latestLandmarks) return;

  const points = mapFacePoints(frame.width, frame.height);
  if (!points) return;

  if (slim > 0) {
    const faceWidth = distance(points.leftCheek, points.rightCheek);
    const radius = faceWidth * 0.34;
    const pull = faceWidth * 0.09 * slim;
    localTranslate(frame, points.leftCheek, radius, pull, 0, 1);
    localTranslate(frame, points.rightCheek, radius, -pull, 0, 1);
    localTranslate(frame, points.jawLeft, radius * 0.76, pull * 0.72, -pull * 0.16, 0.9);
    localTranslate(frame, points.jawRight, radius * 0.76, -pull * 0.72, -pull * 0.16, 0.9);
  }

  if (eyes > 0) {
    const faceWidth = distance(points.leftCheek, points.rightCheek);
    const radius = faceWidth * 0.16;
    localScale(frame, points.leftEye, radius, eyes * 0.26);
    localScale(frame, points.rightEye, radius, eyes * 0.26);
  }
}

function mapFacePoints(targetWidth, targetHeight) {
  const transform = getCoverTransform(targetWidth, targetHeight);
  const pick = (index) => {
    const point = latestLandmarks[index];
    if (!point) return null;
    return {
      x: (point.x * video.videoWidth - transform.sourceX) * transform.scaleX,
      y: (point.y * video.videoHeight - transform.sourceY) * transform.scaleY,
    };
  };

  const points = {
    leftCheek: pick(234),
    rightCheek: pick(454),
    jawLeft: pick(172),
    jawRight: pick(397),
    leftEyeOuter: pick(33),
    leftEyeInner: pick(133),
    rightEyeOuter: pick(362),
    rightEyeInner: pick(263),
  };

  if (Object.values(points).some((point) => !point)) return null;

  return {
    ...points,
    leftEye: midpoint(points.leftEyeOuter, points.leftEyeInner),
    rightEye: midpoint(points.rightEyeOuter, points.rightEyeInner),
  };
}

function getCoverTransform(targetWidth, targetHeight) {
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

  return {
    sourceX,
    sourceY,
    sourceWidth,
    sourceHeight,
    scaleX: targetWidth / sourceWidth,
    scaleY: targetHeight / sourceHeight,
  };
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
  const cover = getCoverTransform(targetWidth, targetHeight);

  targetCtx.drawImage(
    video,
    cover.sourceX,
    cover.sourceY,
    cover.sourceWidth,
    cover.sourceHeight,
    0,
    0,
    targetWidth,
    targetHeight,
  );
}

function localTranslate(frame, center, radius, moveX, moveY, strength) {
  const source = new Uint8ClampedArray(frame.data);
  const left = Math.max(0, Math.floor(center.x - radius));
  const right = Math.min(frame.width - 1, Math.ceil(center.x + radius));
  const top = Math.max(0, Math.floor(center.y - radius));
  const bottom = Math.min(frame.height - 1, Math.ceil(center.y + radius));

  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) {
      const dx = x - center.x;
      const dy = y - center.y;
      const dist = Math.hypot(dx, dy);
      if (dist > radius) continue;
      const weight = Math.pow(1 - dist / radius, 2) * strength;
      sampleInto(frame.data, source, frame.width, frame.height, x, y, x - moveX * weight, y - moveY * weight);
    }
  }
}

function localScale(frame, center, radius, strength) {
  const source = new Uint8ClampedArray(frame.data);
  const left = Math.max(0, Math.floor(center.x - radius));
  const right = Math.min(frame.width - 1, Math.ceil(center.x + radius));
  const top = Math.max(0, Math.floor(center.y - radius));
  const bottom = Math.min(frame.height - 1, Math.ceil(center.y + radius));

  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) {
      const dx = x - center.x;
      const dy = y - center.y;
      const dist = Math.hypot(dx, dy);
      if (dist > radius) continue;
      const weight = Math.pow(1 - dist / radius, 2);
      const scale = 1 + strength * weight;
      sampleInto(frame.data, source, frame.width, frame.height, x, y, center.x + dx / scale, center.y + dy / scale);
    }
  }
}

function sampleInto(target, source, width, height, x, y, sampleX, sampleY) {
  const sx = Math.max(0, Math.min(width - 1, sampleX));
  const sy = Math.max(0, Math.min(height - 1, sampleY));
  const x0 = Math.floor(sx);
  const y0 = Math.floor(sy);
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  const tx = sx - x0;
  const ty = sy - y0;
  const targetIndex = (y * width + x) * 4;
  const topLeft = (y0 * width + x0) * 4;
  const topRight = (y0 * width + x1) * 4;
  const bottomLeft = (y1 * width + x0) * 4;
  const bottomRight = (y1 * width + x1) * 4;

  for (let channel = 0; channel < 4; channel += 1) {
    const top = source[topLeft + channel] * (1 - tx) + source[topRight + channel] * tx;
    const bottom = source[bottomLeft + channel] * (1 - tx) + source[bottomRight + channel] * tx;
    target[targetIndex + channel] = top * (1 - ty) + bottom * ty;
  }
}

function midpoint(a, b) {
  return {
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
  };
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
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
  applyFaceShape(frame);
  beautify(frame.data);
  photoCtx.putImageData(frame, 0, 0);

  if (latestPhotoUrl) {
    URL.revokeObjectURL(latestPhotoUrl);
  }

  photo.toBlob((blob) => {
    latestPhotoUrl = URL.createObjectURL(blob);
    latestPhotoDataUrl = photo.toDataURL("image/jpeg", 0.94);
    photoPreview.src = latestPhotoDataUrl;
    downloadPhotoLink.href = latestPhotoDataUrl;
    downloadPhotoLink.download = `beauty-cam-${Date.now()}.jpg`;
    saveButton.disabled = false;
    showToast("已拍照，按右下角查看");
  }, "image/jpeg", 0.94);
}

function savePhoto() {
  if (!latestPhotoDataUrl) {
    showToast("還沒有照片");
    return;
  }

  photoSheet.hidden = false;
  showToast("長按圖片可存到照片");
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
closePhotoButton.addEventListener("click", () => {
  photoSheet.hidden = true;
});
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
