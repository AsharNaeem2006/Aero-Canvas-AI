// AeroCanvas AI - Core Application Logic (Zero-Delay Optimized)

// ─────────────────────────────────────────────
// DOM Elements
// ─────────────────────────────────────────────
const video        = document.getElementById('webcam');
const paintCanvas  = document.getElementById('paintCanvas');
const trackingCanvas = document.getElementById('trackingCanvas');
const paintCtx     = paintCanvas.getContext('2d');
const trackingCtx  = trackingCanvas.getContext('2d');

const loadingOverlay = document.getElementById('loadingOverlay');
const modeBadge      = document.getElementById('currentMode');
const modeText       = modeBadge.querySelector('.mode-text');

const colorButtons   = document.querySelectorAll('.color-btn');
const colorPicker    = document.getElementById('colorPicker');
const brushSizeSlider = document.getElementById('brushSize');
const brushSizeVal   = document.getElementById('brushSizeVal');

const btnUndo  = document.getElementById('btnUndo');
const btnRedo  = document.getElementById('btnRedo');
const btnClear = document.getElementById('btnClear');
const btnSave  = document.getElementById('btnSave');

const toggleWebcam   = document.getElementById('toggleWebcam');
const toggleSkeleton = document.getElementById('toggleSkeleton');

// ─────────────────────────────────────────────
// Drawing State
// ─────────────────────────────────────────────
let currentColor = '#00f0ff';
let currentSize  = 15;
let isEraser     = false;
let showSkeleton = true;
let showWebcam   = true;

const isCoarsePointer = window.matchMedia('(pointer: coarse)').matches;

let undoStack    = [];   // committed stroke objects
let redoStack    = [];
let currentStroke = null; // live stroke being drawn

// ─────────────────────────────────────────────
// Performance: Offscreen "committed" canvas
// Instead of replaying ALL strokes every frame,
// we bake committed strokes onto an offscreen canvas
// and only draw the live stroke on top each frame.
// ─────────────────────────────────────────────
let committedCanvas = document.createElement('canvas');
let committedCtx    = committedCanvas.getContext('2d');

// ─────────────────────────────────────────────
// Tracking / Smoothing State
// ─────────────────────────────────────────────
let lastSmoothedX = null;
let lastSmoothedY = null;
let lastMode = 'idle';

// DELAY FIX: Alpha values are now much higher → near-zero lag.
// Alpha = 1.0 means no smoothing at all (raw). 0.85 gives tiny jitter
// reduction while feeling instant.
const DRAW_ALPHA  = isCoarsePointer ? 0.9 : 0.85;  // prioritize responsiveness on touch devices
const HOVER_ALPHA = isCoarsePointer ? 0.82 : 0.75;

// ─────────────────────────────────────────────
// Air-Click State
// ─────────────────────────────────────────────
let currentHoveredElement = null;
let hoverDuration  = 0;
let clickCooldown  = 0;
const CLICK_DELAY  = 1200;
let lastFrameTime  = performance.now();

// ─────────────────────────────────────────────
// DELAY FIX: Frame-skip guard.
// The biggest delay source was awaiting hands.send() *before*
// scheduling the next RAF. Now we schedule the next frame
// IMMEDIATELY and use a lock to skip if still processing.
// ─────────────────────────────────────────────
let isProcessingFrame = false;

// Hand skeleton connections
const HAND_CONNECTIONS = [
  [0,1],[1,2],[2,3],[3,4],
  [0,5],[5,6],[6,7],[7,8],
  [0,9],[9,10],[10,11],[11,12],
  [0,13],[13,14],[14,15],[15,16],
  [0,17],[17,18],[18,19],[19,20],
  [5,9],[9,13],[13,17]
];

// ─────────────────────────────────────────────
// Canvas Sizing
// ─────────────────────────────────────────────
function resizeCanvases() {
  const container = document.getElementById('canvasContainer');
  const w = container.clientWidth;
  const h = container.clientHeight;

  paintCanvas.width  = w;
  paintCanvas.height = h;
  trackingCanvas.width  = w;
  trackingCanvas.height = h;

  // Resize offscreen canvas and re-bake all strokes
  committedCanvas.width  = w;
  committedCanvas.height = h;
  rebakeCommitted();

  // Redraw live view
  renderPaintFrame();
}

window.addEventListener('resize', resizeCanvases);
document.addEventListener('DOMContentLoaded', () => {
  resizeCanvases();
  setupEventListeners();
});

// ─────────────────────────────────────────────
// Event Listeners
// ─────────────────────────────────────────────
function setupEventListeners() {
  colorButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      colorButtons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentColor = btn.getAttribute('data-color');
      colorPicker.value = currentColor;
      isEraser = false;
      playBeep('hover');
    });
  });

  colorPicker.addEventListener('input', (e) => {
    currentColor = e.target.value;
    colorButtons.forEach(b => b.classList.remove('active'));
    isEraser = false;
  });

  brushSizeSlider.addEventListener('input', (e) => {
    currentSize = parseInt(e.target.value);
    brushSizeVal.innerText = `${currentSize}px`;
  });

  btnUndo.addEventListener('click', undo);
  btnRedo.addEventListener('click', redo);
  btnClear.addEventListener('click', clearCanvas);
  btnSave.addEventListener('click', saveImage);

  toggleWebcam.addEventListener('change', (e) => {
    showWebcam = e.target.checked;
    video.style.opacity = showWebcam ? '1' : '0';
  });

  toggleSkeleton.addEventListener('change', (e) => {
    showSkeleton = e.target.checked;
  });
}

// ─────────────────────────────────────────────
// Drawing Engine — Offscreen Bake Strategy
// ─────────────────────────────────────────────

/**
 * Re-paint the offscreen canvas with ALL committed strokes.
 * Only called when the stack changes (undo/redo/clear/commit).
 * NOT called every frame.
 */
function rebakeCommitted() {
  committedCtx.clearRect(0, 0, committedCanvas.width, committedCanvas.height);
  undoStack.forEach(stroke => drawStroke(committedCtx, stroke));
}

/**
 * Fast per-frame render: copy baked canvas + draw live stroke only.
 * O(1) instead of O(n strokes) — eliminates the main source of
 * growing delay as more strokes accumulate.
 */
function renderPaintFrame() {
  paintCtx.clearRect(0, 0, paintCanvas.width, paintCanvas.height);
  // Paste baked committed strokes instantly
  paintCtx.drawImage(committedCanvas, 0, 0);
  // Overlay current live stroke only
  if (currentStroke && currentStroke.points.length > 0) {
    drawStroke(paintCtx, currentStroke);
  }
}

/**
 * Draw a stroke object onto a given context.
 * stroke = { points:[{x,y},...], color, size, isEraser }
 * x/y are normalized [0..1] ratios.
 */
function drawStroke(ctx, stroke) {
  if (!stroke || stroke.points.length === 0) return;

  const cw = committedCanvas.width  || paintCanvas.width;
  const ch = committedCanvas.height || paintCanvas.height;

  ctx.save();
  ctx.lineCap  = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = stroke.size;

  if (stroke.isEraser) {
    ctx.globalCompositeOperation = 'destination-out';
    ctx.shadowBlur = 0;
    ctx.strokeStyle = 'rgba(0,0,0,1)';
    ctx.fillStyle   = 'rgba(0,0,0,1)';
  } else {
    ctx.globalCompositeOperation = 'source-over';
    ctx.shadowBlur  = stroke.size / 2 + 4;
    ctx.shadowColor = stroke.color;
    ctx.strokeStyle = stroke.color;
    ctx.fillStyle   = stroke.color;
  }

  const pts = stroke.points;
  if (pts.length === 1) {
    ctx.beginPath();
    ctx.arc(pts[0].x * cw, pts[0].y * ch, stroke.size / 2, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.beginPath();
    ctx.moveTo(pts[0].x * cw, pts[0].y * ch);
    for (let i = 1; i < pts.length; i++) {
      ctx.lineTo(pts[i].x * cw, pts[i].y * ch);
    }
    ctx.stroke();
  }

  ctx.restore();
}

/**
 * Commit the live stroke: push to stack, bake it onto offscreen canvas,
 * then reset live stroke. Baking is incremental — just draw the one
 * new stroke on top of the committed canvas instead of replaying all.
 */
function commitCurrentStroke() {
  if (currentStroke && currentStroke.points && currentStroke.points.length > 0) {
    // Incrementally bake the new stroke (fast — no full replay)
    drawStroke(committedCtx, currentStroke);
    undoStack.push(currentStroke);
    redoStack = [];
  }
  currentStroke = null;
}

function beginNewStroke() {
  currentStroke = {
    points: [],
    color: currentColor,
    size: currentSize,
    isEraser: isEraser
  };
}

function undo() {
  commitCurrentStroke();
  if (undoStack.length > 0) {
    redoStack.push(undoStack.pop());
    rebakeCommitted(); // Replay needed because we removed a stroke
    renderPaintFrame();
    playBeep('hover');
  }
}

function redo() {
  if (redoStack.length > 0) {
    undoStack.push(redoStack.pop());
    rebakeCommitted();
    renderPaintFrame();
    playBeep('hover');
  }
}

function clearCanvas() {
  commitCurrentStroke();
  undoStack = [];
  redoStack = [];
  currentStroke = null;
  committedCtx.clearRect(0, 0, committedCanvas.width, committedCanvas.height);
  renderPaintFrame();
  playBeep('success');
}

// ─────────────────────────────────────────────
// Save Image
// ─────────────────────────────────────────────
function saveImage() {
  const tmp = document.createElement('canvas');
  tmp.width  = paintCanvas.width;
  tmp.height = paintCanvas.height;
  const tCtx = tmp.getContext('2d');

  if (showWebcam) {
    tCtx.save();
    tCtx.translate(tmp.width, 0);
    tCtx.scale(-1, 1);
    tCtx.drawImage(video, 0, 0, tmp.width, tmp.height);
    tCtx.restore();
  } else {
    tCtx.fillStyle = '#080710';
    tCtx.fillRect(0, 0, tmp.width, tmp.height);
  }

  tCtx.drawImage(committedCanvas, 0, 0);
  if (currentStroke && currentStroke.points.length > 0) {
    drawStroke(tCtx, currentStroke);
  }

  const link = document.createElement('a');
  link.download = `aerocanvas_art_${Date.now()}.png`;
  link.href = tmp.toDataURL('image/png');
  link.click();
  playBeep('success');
}

// ─────────────────────────────────────────────
// Audio Feedback
// ─────────────────────────────────────────────
function playBeep(type = 'success') {
  try {
    const ac  = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.connect(gain);
    gain.connect(ac.destination);

    if (type === 'success') {
      osc.type = 'sine';
      osc.frequency.setValueAtTime(600, ac.currentTime);
      osc.frequency.exponentialRampToValueAtTime(1200, ac.currentTime + 0.12);
      gain.gain.setValueAtTime(0.12, ac.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, ac.currentTime + 0.12);
      osc.start(); osc.stop(ac.currentTime + 0.12);
    } else {
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(450, ac.currentTime);
      gain.gain.setValueAtTime(0.04, ac.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, ac.currentTime + 0.06);
      osc.start(); osc.stop(ac.currentTime + 0.06);
    }
  } catch (e) { /* blocked until user interaction */ }
}

// ─────────────────────────────────────────────
// Air Click Handler
// ─────────────────────────────────────────────
function handleAirClick(canvasX, canvasY, deltaTime) {
  if (clickCooldown > 0) {
    clickCooldown -= deltaTime;
    currentHoveredElement = null;
    hoverDuration = 0;
    return 0;
  }

  const rect = trackingCanvas.getBoundingClientRect();
  const elem = document.elementFromPoint(rect.left + canvasX, rect.top + canvasY);

  if (elem) {
    const target = elem.closest('.color-btn, .action-btn, .toggle-switch, .custom-color-picker');
    if (target) {
      if (currentHoveredElement === target) {
        hoverDuration += deltaTime;
        if (Math.floor((hoverDuration - deltaTime) / 300) < Math.floor(hoverDuration / 300)) {
          playBeep('hover');
        }
        if (hoverDuration >= CLICK_DELAY) {
          target.click();
          target.classList.add('clicking-effect');
          setTimeout(() => target.classList.remove('clicking-effect'), 250);
          playBeep('success');
          clickCooldown = 1200;
          hoverDuration = 0;
          currentHoveredElement = null;
          return 0;
        }
        return hoverDuration / CLICK_DELAY;
      } else {
        currentHoveredElement = target;
        hoverDuration = 0;
      }
    } else {
      currentHoveredElement = null;
      hoverDuration = 0;
    }
  } else {
    currentHoveredElement = null;
    hoverDuration = 0;
  }
  return 0;
}

// ─────────────────────────────────────────────
// MediaPipe Result Callback
// ─────────────────────────────────────────────
function onResults(results) {
  if (loadingOverlay && !loadingOverlay.classList.contains('fade-out')) {
    loadingOverlay.classList.add('fade-out');
  }

  const now = performance.now();
  const deltaTime = Math.min(now - lastFrameTime, 100);
  lastFrameTime = now;

  const w = trackingCanvas.width;
  const h = trackingCanvas.height;

  trackingCtx.clearRect(0, 0, w, h);

  if (results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
    const lm = results.multiHandLandmarks[0];

    const indexUp  = lm[8].y  < lm[6].y;
    const middleUp = lm[12].y < lm[10].y;
    const ringUp   = lm[16].y < lm[14].y;
    const pinkyUp  = lm[20].y < lm[18].y;

    let mode = 'idle';
    if      (indexUp && !middleUp && !ringUp && !pinkyUp) mode = 'draw';
    else if (indexUp &&  middleUp && !ringUp && !pinkyUp) mode = 'hover';
    else if (indexUp &&  middleUp &&  ringUp &&  pinkyUp) mode = 'erase';

    // Mirror x to match displayed feed
    const targetX = (1 - lm[8].x) * w;
    const targetY = lm[8].y * h;

    // DELAY FIX: Higher alpha = faster response, less lag
    const alpha = (mode === 'hover') ? HOVER_ALPHA : DRAW_ALPHA;
    const smoothedX = lastSmoothedX === null ? targetX : alpha * targetX + (1 - alpha) * lastSmoothedX;
    const smoothedY = lastSmoothedY === null ? targetY : alpha * targetY + (1 - alpha) * lastSmoothedY;
    lastSmoothedX = smoothedX;
    lastSmoothedY = smoothedY;

    if (mode === 'draw') {
      updateModeUI('draw', 'Drawing');
      isEraser = false;

      if (lastMode !== 'draw') {
        commitCurrentStroke();
        beginNewStroke();
      } else if (!currentStroke) {
        beginNewStroke();
      }

      currentStroke.points.push({ x: smoothedX / w, y: smoothedY / h });
      renderPaintFrame();
      drawCursorIndicator(smoothedX, smoothedY, currentColor, 0);

    } else if (mode === 'hover') {
      updateModeUI('hover', 'Pointer / Air Click');
      if (lastMode === 'draw' || lastMode === 'erase') commitCurrentStroke();

      const progress = handleAirClick(smoothedX, smoothedY, deltaTime);
      drawCursorIndicator(smoothedX, smoothedY, '#ffe600', progress);

    } else if (mode === 'erase') {
      updateModeUI('erase', 'Eraser Brush');
      isEraser = true;

      if (lastMode !== 'erase') {
        commitCurrentStroke();
        beginNewStroke();
      } else if (!currentStroke) {
        beginNewStroke();
      }

      currentStroke.points.push({ x: smoothedX / w, y: smoothedY / h });
      renderPaintFrame();
      drawEraserIndicator(smoothedX, smoothedY, currentSize * 1.5);

    } else {
      updateModeUI('idle', 'Hand Detected (Idle)');
      if (lastMode === 'draw' || lastMode === 'erase') commitCurrentStroke();
      drawCursorIndicator(smoothedX, smoothedY, '#8a889e', 0);
    }

    lastMode = mode;
    if (showSkeleton) drawHandSkeleton(lm, w, h);

  } else {
    updateModeUI('none', 'Detecting Hand...');
    if (lastMode === 'draw' || lastMode === 'erase') commitCurrentStroke();
    lastSmoothedX = null;
    lastSmoothedY = null;
    lastMode = 'idle';
    currentHoveredElement = null;
    hoverDuration = 0;
  }

  // Release processing lock
  isProcessingFrame = false;
}

// ─────────────────────────────────────────────
// UI Drawing Helpers
// ─────────────────────────────────────────────
function updateModeUI(modeClass, text) {
  modeBadge.className = 'mode-badge';
  if (modeClass !== 'none') modeBadge.classList.add(modeClass);
  modeText.innerText = text;
}

function drawCursorIndicator(x, y, color, progress) {
  trackingCtx.save();
  trackingCtx.shadowBlur  = 10;
  trackingCtx.shadowColor = color;

  trackingCtx.beginPath();
  trackingCtx.arc(x, y, 6, 0, Math.PI * 2);
  trackingCtx.fillStyle = color;
  trackingCtx.fill();

  trackingCtx.shadowBlur = 0;
  trackingCtx.beginPath();
  trackingCtx.arc(x, y, 14, 0, Math.PI * 2);
  trackingCtx.lineWidth = 2;
  trackingCtx.strokeStyle = 'rgba(255,255,255,0.35)';
  trackingCtx.stroke();

  if (progress > 0) {
    trackingCtx.beginPath();
    trackingCtx.arc(x, y, 14, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * progress);
    trackingCtx.lineWidth = 3;
    trackingCtx.strokeStyle = color;
    trackingCtx.shadowBlur  = 6;
    trackingCtx.shadowColor = color;
    trackingCtx.stroke();
  }
  trackingCtx.restore();
}

function drawEraserIndicator(x, y, size) {
  trackingCtx.save();
  trackingCtx.beginPath();
  trackingCtx.arc(x, y, size, 0, Math.PI * 2);
  trackingCtx.strokeStyle = 'rgba(255,0,127,0.7)';
  trackingCtx.lineWidth   = 2;
  trackingCtx.setLineDash([5, 3]);
  trackingCtx.stroke();
  trackingCtx.fillStyle = 'rgba(255,0,127,0.06)';
  trackingCtx.fill();
  trackingCtx.restore();
}

function drawHandSkeleton(landmarks, width, height) {
  trackingCtx.save();
  trackingCtx.lineWidth   = 2.5;
  trackingCtx.strokeStyle = 'rgba(0,240,255,0.35)';
  trackingCtx.shadowBlur  = 4;
  trackingCtx.shadowColor = '#00f0ff';

  HAND_CONNECTIONS.forEach(([a, b]) => {
    const p1 = landmarks[a], p2 = landmarks[b];
    trackingCtx.beginPath();
    trackingCtx.moveTo((1 - p1.x) * width, p1.y * height);
    trackingCtx.lineTo((1 - p2.x) * width, p2.y * height);
    trackingCtx.stroke();
  });

  trackingCtx.shadowBlur = 3;
  landmarks.forEach((lm, idx) => {
    const lx = (1 - lm.x) * width;
    const ly = lm.y * height;
    trackingCtx.beginPath();
    if (idx === 8) {
      trackingCtx.arc(lx, ly, 7, 0, Math.PI * 2);
      trackingCtx.fillStyle   = '#ff007f';
      trackingCtx.fill();
      trackingCtx.strokeStyle = '#fff';
      trackingCtx.lineWidth   = 1.5;
      trackingCtx.stroke();
    } else {
      trackingCtx.arc(lx, ly, 4, 0, Math.PI * 2);
      trackingCtx.fillStyle = '#00f0ff';
      trackingCtx.fill();
    }
  });
  trackingCtx.restore();
}

// ─────────────────────────────────────────────
// MediaPipe Init — Lighter model for speed
// ─────────────────────────────────────────────
const hands = new Hands({
  locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`
});

hands.setOptions({
  maxNumHands: 1,
  // DELAY FIX: modelComplexity 0 = lite model, ~2x faster inference
  // than complexity 1, with no meaningful loss for gesture detection
  modelComplexity: 0,
  minDetectionConfidence: 0.7,
  minTrackingConfidence: 0.7
});

hands.onResults(onResults);

let animLoopId = null;

// ─────────────────────────────────────────────
// Camera Error
// ─────────────────────────────────────────────
function showCameraError(message) {
  const loadingState = document.getElementById('loadingState');
  const errorState   = document.getElementById('cameraErrorState');
  const errorMsg     = document.getElementById('cameraErrorMsg');

  if (loadingState) loadingState.style.display = 'none';
  if (errorMsg) errorMsg.textContent = message;
  if (errorState) errorState.style.display = 'block';

  if (loadingOverlay) {
    loadingOverlay.classList.remove('fade-out');
    loadingOverlay.style.opacity    = '1';
    loadingOverlay.style.visibility = 'visible';
    loadingOverlay.style.pointerEvents = 'auto';
  }
}

// ─────────────────────────────────────────────
// Camera Start — Non-blocking frame loop
// ─────────────────────────────────────────────
async function startCamera() {
  const loadingState = document.getElementById('loadingState');
  const errorState   = document.getElementById('cameraErrorState');

  if (loadingState) loadingState.style.display = 'block';
  if (errorState) errorState.style.display = 'none';
  if (loadingOverlay) loadingOverlay.classList.remove('fade-out');

  if (animLoopId) { cancelAnimationFrame(animLoopId); animLoopId = null; }
  if (video.srcObject) {
    video.srcObject.getTracks().forEach(t => t.stop());
    video.srcObject = null;
  }

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: isCoarsePointer ? 960 : 1280 },
        height: { ideal: isCoarsePointer ? 540 : 720 },
        frameRate: { ideal: isCoarsePointer ? 24 : 30, max: 30 },
        facingMode: 'user'
      },
      audio: false
    });
  } catch (err) {
    let msg;
    if (err.name === 'NotReadableError' || err.name === 'TrackStartError') {
      msg = 'Your camera is in use by another app. Close it and click "Try Again".';
    } else if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
      msg = 'Camera permission denied. Allow access in your browser address bar and click "Try Again".';
    } else if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
      msg = 'No camera found. Connect a camera and click "Try Again".';
    } else if (err.name === 'OverconstrainedError') {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      } catch (e2) {
        showCameraError(`Could not access camera: ${e2.message}`);
        return;
      }
    } else {
      msg = `Camera error: ${err.message}`;
    }
    if (!stream) { showCameraError(msg); return; }
  }

  video.srcObject = stream;
  await video.play();

  /**
   * DELAY FIX — Non-blocking frame loop:
   *
   * OLD (broken): await hands.send()  ← blocks until inference done,
   *               then schedules next RAF. Net rate: ~15–20fps with lag.
   *
   * NEW (fast):   Schedule RAF immediately, then call hands.send()
   *               without awaiting in the RAF itself. The `isProcessingFrame`
   *               flag ensures we skip a frame if inference hasn't finished,
   *               preventing queue buildup while keeping the loop at 60fps.
   */
  function processFrame() {
    // Schedule next frame immediately — never block the render loop
    animLoopId = requestAnimationFrame(processFrame);

    if (!isProcessingFrame && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      isProcessingFrame = true;
      // Fire-and-forget; onResults callback releases the lock
      hands.send({ image: video }).catch(() => { isProcessingFrame = false; });
    }
  }

  video.addEventListener('error', () => {
    if (animLoopId) cancelAnimationFrame(animLoopId);
    showCameraError('Video stream interrupted. Please try again.');
  }, { once: true });

  animLoopId = requestAnimationFrame(processFrame);
}

// ─────────────────────────────────────────────
// Retry Button
// ─────────────────────────────────────────────
const btnRetryCamera = document.getElementById('btnRetryCamera');
if (btnRetryCamera) btnRetryCamera.addEventListener('click', startCamera);

// ─────────────────────────────────────────────
// Boot
// ─────────────────────────────────────────────
startCamera();
