const state = {
  image: null,
  imageName: '',
  imageSize: { width: 0, height: 0 },
  detections: [],
  drawScale: { x: 1, y: 1 },
  activeDetectionId: null,
  dimensionsCache: {},
  sessionLog: [],
  focalConstant: 1400,
  lastMeasurement: null,
  distanceUnit: 'm',
  isCalibrated: false,
  calibrationObject: '',
  calibrationSource: 'none',
  accurateMode: true,
};

const CONFIDENCE_THRESHOLD = 0.55;

const els = {
  uploadBtn: document.getElementById('uploadBtn'),
  fileInput: document.getElementById('fileInput'),
  calibrationFileInput: document.getElementById('calibrationFileInput'),
  startCalibrationBtn: document.getElementById('startCalibrationBtn'),
  imageMeta: document.getElementById('imageMeta'),
  scanner: document.getElementById('scanner'),
  canvas: document.getElementById('scannerCanvas'),
  detectionBadge: document.getElementById('detectionBadge'),
  targetClass: document.getElementById('targetClass'),
  confVal: document.getElementById('confVal'),
  confidenceFill: document.getElementById('confidenceFill'),
  distVal: document.getElementById('distVal'),
  distUnitText: document.getElementById('distUnitText'),
  refWidth: document.getElementById('refWidth'),
  bboxPx: document.getElementById('bboxPx'),
  focalMeta: document.getElementById('focalMeta'),
  focalVal: document.getElementById('focalVal'),
  focalSlider: document.getElementById('focalSlider'),
  formulaBox: document.getElementById('formulaBox'),
  sessionLog: document.getElementById('sessionLog'),
  statMeasured: document.getElementById('statMeasured'),
  statAvgDist: document.getElementById('statAvgDist'),
  statAvgConf: document.getElementById('statAvgConf'),
  fps: document.getElementById('fps'),
  hudTopRight: document.getElementById('hudTopRight'),
  hudBottomRight: document.getElementById('hudBottomRight'),
  crosshair: document.getElementById('crosshair'),
  unitToggle: document.getElementById('unitToggle'),
  calibrationWarning: document.getElementById('calibrationWarning'),
  autoCalibrationBadge: document.getElementById('autoCalibrationBadge'),
  calibrationOverlay: document.getElementById('calibrationOverlay'),
  calibrationStatusText: document.getElementById('calibrationStatusText'),
};

const ctx = els.canvas.getContext('2d');

function setCanvasSize() {
  const rect = els.scanner.getBoundingClientRect();
  els.canvas.width = Math.max(1, Math.floor(rect.width));
  els.canvas.height = Math.max(1, Math.floor(rect.height));
}

function computeContainRect(canvasW, canvasH, imageW, imageH) {
  // Prevent implicit upscaling that can feel like auto zoom.
  const scale = Math.min(canvasW / imageW, canvasH / imageH, 1);
  const width = imageW * scale;
  const height = imageH * scale;
  const x = (canvasW - width) / 2;
  const y = (canvasH - height) / 2;
  return { x, y, width, height, scale };
}

function formatDistance(distanceM) {
  if (state.distanceUnit === 'ft') {
    return `${(distanceM * 3.28084).toFixed(2)}ft`;
  }
  return `${distanceM.toFixed(2)}m`;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function selectReferenceWidthMm(det, dims) {
  const width = clamp(Number(dims.width_mm) || 400, 40, 3000);
  const height = clamp(Number(dims.height_mm) || 400, 40, 3000);
  const depth = clamp(Number(dims.depth_mm) || 400, 40, 3000);
  const portraitLike = det.bbox.height > det.bbox.width * 1.2;

  // Conservative reference selection reduces systematic overestimation.
  if (portraitLike) {
    return Math.min(height, width, depth);
  }
  return Math.min(width, depth, height);
}

function drawScene() {
  setCanvasSize();
  ctx.clearRect(0, 0, els.canvas.width, els.canvas.height);

  if (!state.image) {
    return;
  }

  // Scale bbox coordinates from original image resolution to canvas resolution.
  const scaleX = els.canvas.width / state.imageSize.width;
  const scaleY = els.canvas.height / state.imageSize.height;
  state.drawScale = { x: scaleX, y: scaleY };
  ctx.drawImage(state.image, 0, 0, els.canvas.width, els.canvas.height);

  const palette = ['#00f5ff', '#00ff88', '#ff6b2b'];
  ctx.font = '12px "Share Tech Mono"';

  for (const det of state.detections) {
    const color = palette[det.id % palette.length];
    const isActive = state.activeDetectionId === det.id;
    const bx = det.bbox.x1 * scaleX;
    const by = det.bbox.y1 * scaleY;
    const bw = det.bbox.width * scaleX;
    const bh = det.bbox.height * scaleY;

    ctx.strokeStyle = color;
    ctx.lineWidth = isActive ? 2.4 : 1.6;
    ctx.shadowColor = color;
    ctx.shadowBlur = isActive ? 14 : 8;
    ctx.strokeRect(bx, by, bw, bh);

    const label = `${det.label.toUpperCase()} · ${(det.confidence * 100).toFixed(1)}%`;
    const textWidth = ctx.measureText(label).width + 12;
    const textX = bx;
    const textY = Math.max(16, by - 8);

    ctx.shadowBlur = 0;
    ctx.fillStyle = color;
    ctx.fillRect(textX, textY - 14, textWidth, 16);
    ctx.fillStyle = '#060a0e';
    ctx.fillText(label, textX + 6, textY - 2);
  }

  ctx.shadowBlur = 0;
}

function updateCalibrationUi() {
  if (!els.calibrationWarning) {
    return;
  }
  if (state.isCalibrated) {
    els.calibrationWarning.textContent = `Calibrated using: ${state.calibrationObject || 'object'}. Ready to measure.`;
    els.calibrationWarning.style.color = '#00ff88';
    if (els.calibrationOverlay) {
      els.calibrationOverlay.classList.add('hidden');
    }
    if (els.uploadBtn) {
      els.uploadBtn.textContent = 'LOAD IMAGE';
    }
  } else {
    els.calibrationWarning.textContent = 'Calibration required: hold any object approximately 1 foot away (about forearm length), take a photo, then upload it here.';
    els.calibrationWarning.style.color = '#ff6b2b';
    if (els.calibrationOverlay) {
      els.calibrationOverlay.classList.remove('hidden');
    }
    if (els.uploadBtn) {
      els.uploadBtn.textContent = 'COMPLETE CALIBRATION';
    }
  }
}

function showAutoCalibrationBadge(anchorLabel) {
  if (!els.autoCalibrationBadge) {
    return;
  }
  els.autoCalibrationBadge.textContent = `Calibrated using: ${anchorLabel.toLowerCase()}`;
  els.autoCalibrationBadge.classList.add('visible');
}

function hideAutoCalibrationBadge() {
  if (!els.autoCalibrationBadge) {
    return;
  }
  els.autoCalibrationBadge.classList.remove('visible');
  els.autoCalibrationBadge.textContent = '';
}

function formatTime() {
  return new Date().toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function updateStats() {
  const n = state.sessionLog.length;
  els.statMeasured.textContent = String(n);
  if (!n) {
    els.statAvgDist.textContent = '--';
    els.statAvgConf.textContent = '--';
    return;
  }

  const avgDist = state.sessionLog.reduce((sum, row) => sum + row.distance_m, 0) / n;
  const avgConf = state.sessionLog.reduce((sum, row) => sum + row.confidence, 0) / n;
  els.statAvgDist.textContent = formatDistance(avgDist);
  els.statAvgConf.textContent = `${(avgConf * 100).toFixed(0)}%`;
}

function renderSessionLog() {
  els.sessionLog.innerHTML = '';
  for (const row of state.sessionLog) {
    const entry = document.createElement('div');
    entry.className = 'log-entry';
    const modeText = row.estimate_mode === 'experimental' ? ' · EXP' : '';
    entry.innerHTML = `
      <div>
        <div class="log-obj">${row.label.toUpperCase()}</div>
        <div class="log-meta">W:${(row.real_width_mm / 1000).toFixed(2)}m · CONF:${(row.confidence * 100).toFixed(1)}% · K:${Math.round(row.focal_constant)}${modeText}</div>
      </div>
      <div>
        <div class="log-dist">${formatDistance(row.distance_m)}</div>
        <div class="log-time">${row.time}</div>
      </div>
    `;
    els.sessionLog.appendChild(entry);
  }
  updateStats();
}

function updateFormula(realWidthMm, pixelWidth, distanceM) {
  const realWidthM = realWidthMm / 1000;
  const formattedDistance = state.distanceUnit === 'ft'
    ? `${(distanceM * 3.28084).toFixed(2)} ft`
    : `${distanceM.toFixed(2)} m`;
  els.formulaBox.innerHTML = `
    D = (<span>K</span> × <strong>W_real</strong>) / <span>W_pixel</span>
    <br />
    D = (<span>${state.focalConstant.toFixed(1)}</span> × <strong>${realWidthM.toFixed(2)}</strong>) / <span>${pixelWidth.toFixed(0)}</span>
    <br />
    D = <strong style="color:var(--green)">${formattedDistance}</strong>
  `;
}

async function getDimensions(label) {
  if (state.dimensionsCache[label]) {
    return state.dimensionsCache[label];
  }

  const resp = await fetch('/dimensions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label }),
  });
  if (!resp.ok) {
    throw new Error('Failed to fetch object dimensions');
  }
  const dims = await resp.json();
  state.dimensionsCache[label] = dims;
  return dims;
}

async function measureDetection(det, addToLog = true) {
  const t0 = performance.now();
  const isAnchor = Boolean(det.anchor_width_mm && det.anchor_width_mm > 0);
  let referenceWidthMm;
  let estimateMode = 'anchor';

  if (isAnchor) {
    referenceWidthMm = Number(det.anchor_width_mm);
  } else {
    estimateMode = 'experimental';
    const dims = await getDimensions(det.label);
    referenceWidthMm = selectReferenceWidthMm(det, dims);
  }

  const measureResp = await fetch('/measure', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      pixel_width: det.bbox.width,
      real_width_mm: referenceWidthMm,
      focal_constant: state.focalConstant,
    }),
  });

  if (!measureResp.ok) {
    throw new Error('Measure request failed');
  }

  const measure = await measureResp.json();
  const latencyMs = Math.round(performance.now() - t0);

  els.targetClass.textContent = det.label.toUpperCase();
  els.confVal.textContent = `${(det.confidence * 100).toFixed(1)}%`;
  els.confidenceFill.style.width = `${(det.confidence * 100).toFixed(1)}%`;
  els.distVal.textContent = state.distanceUnit === 'ft'
    ? (measure.distance_m * 3.28084).toFixed(2)
    : measure.distance_m.toFixed(2);
  els.distUnitText.textContent = state.distanceUnit === 'ft' ? 'FEET' : 'METERS';
  els.refWidth.textContent = `${(referenceWidthMm / 1000).toFixed(2)} m`;
  els.bboxPx.textContent = `${det.bbox.width.toFixed(0)} px`;
  els.focalMeta.textContent = state.focalConstant.toFixed(1);
  els.hudBottomRight.innerHTML = `LAT: ${latencyMs}ms<br/>INF: LIVE`;
  updateFormula(referenceWidthMm, det.bbox.width, measure.distance_m);

  state.lastMeasurement = {
    detection: det,
    referenceWidthMm,
    distance_m: measure.distance_m,
  };

  if (addToLog) {
    state.sessionLog.unshift({
      label: det.label,
      confidence: det.confidence,
      real_width_mm: referenceWidthMm,
      distance_m: measure.distance_m,
      focal_constant: state.focalConstant,
      estimate_mode: estimateMode,
      time: formatTime(),
    });
    renderSessionLog();
  }
}

function setDistanceUnit(unit) {
  state.distanceUnit = unit;
  els.distUnitText.textContent = unit === 'ft' ? 'FEET' : 'METERS';
  if (els.unitToggle) {
    const buttons = els.unitToggle.querySelectorAll('.unit-btn');
    buttons.forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.unit === unit);
    });
  }

  if (state.lastMeasurement) {
    els.distVal.textContent = unit === 'ft'
      ? (state.lastMeasurement.distance_m * 3.28084).toFixed(2)
      : state.lastMeasurement.distance_m.toFixed(2);
    updateFormula(
      state.lastMeasurement.referenceWidthMm,
      state.lastMeasurement.detection.bbox.width,
      state.lastMeasurement.distance_m,
    );
  }
  renderSessionLog();
}

function findClickedDetection(clientX, clientY) {
  if (!state.detections.length) {
    return null;
  }

  const rect = els.canvas.getBoundingClientRect();
  const xCanvas = ((clientX - rect.left) / rect.width) * els.canvas.width;
  const yCanvas = ((clientY - rect.top) / rect.height) * els.canvas.height;

  const xImg = xCanvas / state.drawScale.x;
  const yImg = yCanvas / state.drawScale.y;

  const containing = state.detections.filter(
    (det) =>
      xImg >= det.bbox.x1 &&
      xImg <= det.bbox.x2 &&
      yImg >= det.bbox.y1 &&
      yImg <= det.bbox.y2,
  );

  if (!containing.length) {
    return null;
  }

  // Resolve overlap by preferring the most specific box.
  containing.sort((a, b) => {
    const areaA = a.bbox.width * a.bbox.height;
    const areaB = b.bbox.width * b.bbox.height;
    if (areaA !== areaB) {
      return areaA - areaB;
    }
    return b.confidence - a.confidence;
  });

  return containing[0];
}

async function handleCanvasClick(evt) {
  if (!state.isCalibrated) {
    els.detectionBadge.textContent = '▶ CALIBRATE FOCAL CONSTANT FIRST';
    return;
  }

  const det = findClickedDetection(evt.clientX, evt.clientY);
  if (!det) {
    els.detectionBadge.textContent = '▶ CLICK INSIDE A DETECTED BOUNDING BOX';
    return;
  }

  state.activeDetectionId = det.id;
  drawScene();

  if (det.confidence < CONFIDENCE_THRESHOLD) {
    els.detectionBadge.textContent = `▶ LOW CONFIDENCE ${(det.confidence * 100).toFixed(1)}% (<${(CONFIDENCE_THRESHOLD * 100).toFixed(0)}%)`;
    return;
  }

  const isAnchor = Boolean(det.anchor_width_mm && det.anchor_width_mm > 0);
  if (state.accurateMode && !isAnchor) {
    els.targetClass.textContent = det.label.toUpperCase();
    els.confVal.textContent = `${(det.confidence * 100).toFixed(1)}%`;
    els.confidenceFill.style.width = `${(det.confidence * 100).toFixed(1)}%`;
    els.detectionBadge.textContent = '▶ ACCURATE MODE: ANCHOR OBJECTS ONLY';
    return;
  }

  try {
    await measureDetection(det);
    if (!isAnchor) {
      els.detectionBadge.textContent = `▶ EXPERIMENTAL ESTIMATE: ${det.label.toUpperCase()}`;
    } else {
      els.detectionBadge.textContent = `▶ TARGET LOCKED: ${det.label.toUpperCase()}`;
    }
  } catch (err) {
    console.error(err);
    els.detectionBadge.textContent = '▶ MEASUREMENT ERROR';
  }
}

async function detectImage(file) {
  const form = new FormData();
  form.append('image', file);

  const t0 = performance.now();
  const resp = await fetch('/detect', {
    method: 'POST',
    body: form,
  });

  if (!resp.ok) {
    throw new Error('Detection failed');
  }

  const data = await resp.json();
  const t1 = performance.now();

  state.detections = data.detections || [];
  state.imageSize = data.image;
  state.activeDetectionId = null;
  state.lastMeasurement = null;
  hideAutoCalibrationBadge();

  els.hudTopRight.innerHTML = `OBJECTS: ${state.detections.length}<br/>FRAME: ${Math.floor(Math.random() * 9000 + 1000)}`;
  els.hudBottomRight.innerHTML = `LAT: ${Math.round(t1 - t0)}ms<br/>INF: ${Math.round(t1 - t0)}ms`;
  els.detectionBadge.textContent = state.isCalibrated
    ? '▶ TAP OBJECT TO MEASURE DISTANCE'
    : '▶ CALIBRATION REQUIRED BEFORE MEASURE';
}

function loadImagePreview(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = reject;
    img.src = url;
  });
}

async function runGuidedCalibration(file) {
  const form = new FormData();
  form.append('image', file);

  const resp = await fetch('/calibrate', {
    method: 'POST',
    body: form,
  });
  if (!resp.ok) {
    let detail = 'Calibration failed';
    try {
      const data = await resp.json();
      detail = data.detail || detail;
    } catch {
      // ignore
    }
    throw new Error(detail);
  }
  return resp.json();
}

async function handleCalibrationUpload(file) {
  if (!file) {
    return;
  }
  if (els.calibrationStatusText) {
    els.calibrationStatusText.textContent = 'Running calibration inference... keep object approximately 1 foot away (about forearm length).';
  }
  els.detectionBadge.textContent = '▶ CALIBRATING...';

  try {
    const result = await runGuidedCalibration(file);
    state.focalConstant = Number(result.focal_constant);
    state.isCalibrated = true;
    state.calibrationSource = 'guided';
    state.calibrationObject = result.label;
    els.focalSlider.value = String(Math.round(state.focalConstant));
    els.focalVal.textContent = state.focalConstant.toFixed(1);
    els.focalMeta.textContent = state.focalConstant.toFixed(1);
    showAutoCalibrationBadge(result.label);
    updateCalibrationUi();
    if (els.calibrationStatusText) {
      els.calibrationStatusText.textContent = `Calibrated using: ${result.label}. Ready to measure.`;
    }
    els.detectionBadge.textContent = `▶ CALIBRATED USING: ${result.label.toUpperCase()}`;
  } catch (err) {
    console.error(err);
    if (els.calibrationStatusText) {
      els.calibrationStatusText.textContent = err.message || 'Calibration failed. Try a clearer photo.';
    }
    els.detectionBadge.textContent = '▶ CALIBRATION FAILED';
  }
}

async function handleUpload(file) {
  if (!file) {
    return;
  }
  if (!state.isCalibrated) {
    els.detectionBadge.textContent = '▶ COMPLETE CALIBRATION FIRST';
    return;
  }

  els.detectionBadge.textContent = '▶ RUNNING YOLO INFERENCE...';
  state.imageName = file.name;
  els.imageMeta.textContent = `${file.name} · ${(file.size / 1024).toFixed(1)} KB`;

  try {
    const [img] = await Promise.all([loadImagePreview(file), detectImage(file)]);
    state.image = img;
    drawScene();
  } catch (err) {
    console.error(err);
    els.detectionBadge.textContent = '▶ DETECTION FAILED';
  }
}

function updateFocal(value) {
  state.focalConstant = Number(value);
  state.isCalibrated = true;
  state.calibrationSource = 'manual';
  els.focalVal.textContent = state.focalConstant.toFixed(1);
  els.focalMeta.textContent = state.focalConstant.toFixed(1);
  updateCalibrationUi();

  if (state.lastMeasurement) {
    measureDetection(state.lastMeasurement.detection, false).catch((err) => {
      console.error(err);
    });
  }
}

els.uploadBtn.addEventListener('click', () => {
  if (!state.isCalibrated) {
    if (els.calibrationOverlay) {
      els.calibrationOverlay.classList.remove('hidden');
    }
    els.detectionBadge.textContent = '▶ COMPLETE CALIBRATION FIRST';
    return;
  }
  els.fileInput.click();
});
els.fileInput.addEventListener('change', (e) => handleUpload(e.target.files[0]));
if (els.startCalibrationBtn) {
  els.startCalibrationBtn.addEventListener('click', () => {
    if (els.calibrationFileInput) {
      els.calibrationFileInput.click();
    }
  });
}
if (els.calibrationFileInput) {
  els.calibrationFileInput.addEventListener('change', (e) => handleCalibrationUpload(e.target.files[0]));
}
els.canvas.addEventListener('click', handleCanvasClick);
els.focalSlider.addEventListener('input', (e) => updateFocal(e.target.value));
if (els.unitToggle) {
  els.unitToggle.querySelectorAll('.unit-btn').forEach((btn) => {
    btn.addEventListener('click', () => setDistanceUnit(btn.dataset.unit));
  });
}

els.scanner.addEventListener('mousemove', (e) => {
  const rect = els.scanner.getBoundingClientRect();
  const x = ((e.clientX - rect.left) / rect.width) * 100;
  const y = ((e.clientY - rect.top) / rect.height) * 100;
  els.crosshair.style.left = `${x.toFixed(1)}%`;
  els.crosshair.style.top = `${y.toFixed(1)}%`;
});

window.addEventListener('resize', drawScene);

setInterval(() => {
  els.fps.textContent = `${44 + Math.floor(Math.random() * 8)} FPS`;
}, 1000);

drawScene();
updateStats();
setDistanceUnit('m');
updateCalibrationUi();
