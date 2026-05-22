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

const FACE_OVAL_POINTS = [
  10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377,
  152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109,
];

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

function isMirrored() {
  return facingMode === "user";
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
    const lowerFaceMask = makeLowerFaceMask(points, faceWidth);
    const cheekRadius = faceWidth * 0.24;
    const jawRadius = faceWidth * 0.2;
    const pull = faceWidth * 0.13 * slim;
    const leftMove = vectorToward(points.leftLowerCheek, points.faceCenter, pull);
    const rightMove = vectorToward(points.rightLowerCheek, points.faceCenter, pull);
    const jawLeftMove = vectorToward(points.jawLeft, points.faceCenter, pull * 0.72);
    const jawRightMove = vectorToward(points.jawRight, points.faceCenter, pull * 0.72);

    localTranslate(frame, points.leftLowerCheek, cheekRadius, leftMove.x, leftMove.y, 0.95, lowerFaceMask);
    localTranslate(frame, points.rightLowerCheek, cheekRadius, rightMove.x, rightMove.y, 0.95, lowerFaceMask);
    localTranslate(frame, points.jawLeft, jawRadius, jawLeftMove.x, jawLeftMove.y, 0.72, lowerFaceMask);
    localTranslate(frame, points.jawRight, jawRadius, jawRightMove.x, jawRightMove.y, 0.72, lowerFaceMask);
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
    const mappedX = (point.x * video.videoWidth - transform.sourceX) * transform.scaleX;
    return {
      x: isMirrored() ? targetWidth - mappedX : mappedX,
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
    nose: pick(1),
    chin: pick(152),
    mouthLeft: pick(61),
    mouthRight: pick(291),
  };
  const faceOval = FACE_OVAL_POINTS.map((index) => pick(index));

  if (Object.values(points).some((point) => !point) || faceOval.some((point) => !point)) return null;

  const faceCenter = midpoint(points.leftCheek, points.rightCheek);
  faceCenter.y = points.nose.y;

  return {
    ...points,
    faceCenter,
    faceOval,
    lowerFaceCenter: midpoint(points.nose, points.chin),
    leftLowerCheek: weightedPoint(points.jawLeft, points.mouthLeft, 0.44),
    rightLowerCheek: weightedPoint(points.jawRight, points.mouthRight, 0.44),
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
  const mirrored = isMirrored();

  targetCtx.save();
  if (mirrored) {
    targetCtx.translate(targetWidth, 0);
    targetCtx.scale(-1, 1);
  }

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
  targetCtx.restore();
}

function makeLowerFaceMask(points, faceWidth) {
  const center = points.lowerFaceCenter;
  const radiusX = faceWidth * 0.5;
  const radiusY = distance(points.nose, points.chin) * 1.08;
  const top = points.nose.y - faceWidth * 0.04;
  const bottom = points.chin.y + faceWidth * 0.08;

  return (x, y) => {
    if (y < top || y > bottom) return false;
    if (!pointInPolygon(x, y, points.faceOval)) return false;
    const nx = (x - center.x) / radiusX;
    const ny = (y - center.y) / radiusY;
    return nx * nx + ny * ny <= 1.08;
  };
}

function localTranslate(frame, center, radius, moveX, moveY, strength, mask = null) {
  const source = new Uint8ClampedArray(frame.data);
  const left = Math.max(0, Math.floor(center.x - radius));
  const right = Math.min(frame.width - 1, Math.ceil(center.x + radius));
  const top = Math.max(0, Math.floor(center.y - radius));
  const bottom = Math.min(frame.height - 1, Math.ceil(center.y + radius));

  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) {
      if (mask && !mask(x, y)) continue;
      const dx = x - center.x;
      const dy = y - center.y;
      const dist = Math.hypot(dx, dy);
      if (dist > radius) continue;
      const weight = Math.pow(1 - dist / radius, 2) * strength;
      const sampleX = x - moveX * weight;
      const sampleY = y - moveY * weight;
      if (mask && !mask(sampleX, sampleY)) continue;
      sampleInto(frame.data, source, frame.width, frame.height, x, y, sampleX, sampleY);
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

function weightedPoint(a, b, amountTowardB) {
  return {
    x: a.x + (b.x - a.x) * amountTowardB,
    y: a.y + (b.y - a.y) * amountTowardB,
  };
}

function pointInPolygon(x, y, polygon) {
  let inside = false;

  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const current = polygon[i];
    const previous = polygon[j];
    const crosses = current.y > y !== previous.y > y;
    if (!crosses) continue;

    const intersectX =
      ((previous.x - current.x) * (y - current.y)) / (previous.y - current.y || 0.0001) +
      current.x;
    if (x < intersectX) inside = !inside;
  }

  return inside;
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function vectorToward(from, to, amount) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy) || 1;
  return {
    x: (dx / length) * amount,
    y: (dy / length) * amount,
  };
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
