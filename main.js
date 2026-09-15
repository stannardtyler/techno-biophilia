import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import TWEEN from 'three/addons/libs/tween.module.js';

class SimpleDepthOfFieldPass extends Pass {
  constructor(camera, params) {
    super();

    this.camera = camera;
    this.uniforms = {
      tDiffuse: { value: null },
      tDepth: { value: null },
      resolution: { value: new THREE.Vector2(1, 1) },
      focus: { value: params.focus },
      minDistance: { value: params.minDistance },
      maxDistance: { value: params.maxDistance },
      blurSize: { value: params.blurSize },
      blurSpread: { value: params.blurSpread },
      cameraNear: { value: camera.near },
      cameraFar: { value: camera.far }
    };

    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: `
        varying vec2 vUv;

        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }
      `,
      fragmentShader: `
        #include <packing>

        varying vec2 vUv;

        uniform sampler2D tDiffuse;
        uniform sampler2D tDepth;
        uniform vec2 resolution;
        uniform float focus;
        uniform float minDistance;
        uniform float maxDistance;
        uniform float blurSize;
        uniform float blurSpread;
        uniform float cameraNear;
        uniform float cameraFar;

        float getViewDistance(vec2 uv) {
          float depth = texture2D(tDepth, uv).x;
          float viewZ = perspectiveDepthToViewZ(depth, cameraNear, cameraFar);

          return -viewZ;
        }

        vec4 blurColor(vec2 uv, vec2 radius) {
          vec4 color = texture2D(tDiffuse, uv) * 0.2;

          color += texture2D(tDiffuse, uv + vec2(-radius.x, -radius.y)) * 0.08;
          color += texture2D(tDiffuse, uv + vec2(0.0, -radius.y)) * 0.12;
          color += texture2D(tDiffuse, uv + vec2(radius.x, -radius.y)) * 0.08;
          color += texture2D(tDiffuse, uv + vec2(-radius.x, 0.0)) * 0.12;
          color += texture2D(tDiffuse, uv + vec2(radius.x, 0.0)) * 0.12;
          color += texture2D(tDiffuse, uv + vec2(-radius.x, radius.y)) * 0.08;
          color += texture2D(tDiffuse, uv + vec2(0.0, radius.y)) * 0.12;
          color += texture2D(tDiffuse, uv + vec2(radius.x, radius.y)) * 0.08;

          return color;
        }

        void main() {
          vec4 sharp = texture2D(tDiffuse, vUv);
          float sceneDistance = getViewDistance(vUv);
          float distanceFromFocus = abs(sceneDistance - focus);
          float blurStart = min(minDistance, maxDistance);
          float blurEnd = max(max(minDistance, maxDistance), blurStart + 0.0001);
          float blurAmount = smoothstep(blurStart, blurEnd, distanceFromFocus);
          vec2 radius = (blurSize * blurSpread) / resolution;
          vec4 blurred = blurColor(vUv, radius);

          gl_FragColor = mix(sharp, blurred, blurAmount);
        }
      `
    });
    this.fsQuad = new FullScreenQuad(this.material);
  }

  render(renderer, writeBuffer, readBuffer) {
    this.uniforms.tDiffuse.value = readBuffer.texture;
    this.uniforms.tDepth.value = readBuffer.depthTexture;
    this.uniforms.cameraNear.value = this.camera.near;
    this.uniforms.cameraFar.value = this.camera.far;

    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    if (this.clear) renderer.clear();
    this.fsQuad.render(renderer);
  }

  setSize(width, height) {
    this.uniforms.resolution.value.set(width, height);
  }

  dispose() {
    this.material.dispose();
    this.fsQuad.dispose();
  }
}

const canvas = document.querySelector('#c');
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);

const camera = new THREE.PerspectiveCamera(
  45,
  window.innerWidth / window.innerHeight,
  0.1,
  100
);
camera.position.set(5, 4, 10);
camera.lookAt(0, 0, 0);

const renderer = new THREE.WebGLRenderer({ antialias: true, canvas });
const pixelRatio = Math.min(window.devicePixelRatio, 2);
renderer.setPixelRatio(pixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.NeutralToneMapping;

const cameraControls = new OrbitControls(camera, canvas);
cameraControls.target.set(0, 0, 0);
cameraControls.enableDamping = true;
cameraControls.update();

const modelRoot = new THREE.Group();
const modelAssets = {
  '1': { url: './treeScan.glb', label: 'tree scan' },
  '2': { url: './treeHole.glb', label: 'tree hole' }
};
const modelCache = new Map();
let activeModelKey = null;
let requestedModelKey = '1';
let modelRequestId = 0;
const focusTargets = [];
const initialFocusPoint = new THREE.Vector3();
const modelTargetSize = 4.5;
const modelCenterPosition = new THREE.Vector3(0, 0, 0);
modelRoot.position.copy(modelCenterPosition);
initialFocusPoint.copy(modelCenterPosition);
cameraControls.target.copy(initialFocusPoint);
cameraControls.update();
const modelPositionDefaults = {
  modelPositionX: modelCenterPosition.x,
  modelPositionY: modelCenterPosition.y,
  modelPositionZ: modelCenterPosition.z
};
const modelPositionSettings = { ...modelPositionDefaults };
const modelRotationDefaults = {
  modelRotationX: 0,
  modelRotationY: 0,
  modelRotationZ: 0
};
const modelRotationSettings = { ...modelRotationDefaults };
// Change these defaults if you want Reset to return to different DOF values.
const dofSettingDefaults = {
  minDistance: 1,
  maxDistance: 3,
  blurSize: 2,
  blurSpread: 4
};
const cameraDistanceBlurSettings = {
  enabled: true,
  nearFocusDistance: 3,
  farFocusDistance: 12,
  nearBlurMultiplier: 0.35,
  farBlurMultiplier: 1.8
};
// Sensor distances are centimeters; camera distances are Three.js scene units.
// Values beyond nearCm/farCm hold the corresponding camera distance.
const sensorZoomDefaults = {
  baudRate: 115200,
  nearCm: 20,
  farCm: 160,
  nearCameraDistance: 4,
  farCameraDistance: 14,
  sensitivity: 1, // Higher values increase how strongly approaching affects zoom.
  targetSmoothingSeconds: 0.6,
  smoothingSeconds: 1.2,
  zoomOutHoldMs: 3000,
  zoomOutSmoothingSeconds: 3.5,
  maxZoomSpeed: 3, // Maximum camera movement in scene units per second.
  staleAfterMs: 1000
};
const sensorZoomSettings = { ...sensorZoomDefaults };
let zoomOutStartedAt = null;
let smoothedSensorTarget = null;
const serialSupported = window.isSecureContext && 'serial' in navigator;
const serialState = {
  port: null,
  reader: null,
  readTask: null,
  busy: false,
  disconnecting: false,
  distanceCm: null,
  lastReadingAt: 0,
  status: serialSupported ? 'Disconnected' : 'Use Chrome or Edge on localhost or HTTPS'
};
const sensorCameraOffset = new THREE.Vector3();
let previousFrameTime = performance.now();
const modelBounds = new THREE.Box3();
scene.add(modelRoot);

const ambientLight = new THREE.HemisphereLight(0xe8fff1, 0x5588bb, 1.25);
scene.add(ambientLight);

const keyLight = new THREE.DirectionalLight(0xffffff, 2.4);
keyLight.position.set(5, 8, 6);
scene.add(keyLight);

const raycaster = new THREE.Raycaster();
const pointerCoords = new THREE.Vector2();
const reusableWorldPosition = new THREE.Vector3();
let modelLoaded = false;
let focusPoint = initialFocusPoint.clone();

const renderTarget = new THREE.WebGLRenderTarget(window.innerWidth, window.innerHeight);
renderTarget.depthTexture = new THREE.DepthTexture(window.innerWidth, window.innerHeight);
renderTarget.depthTexture.type = THREE.UnsignedShortType;

const composer = new EffectComposer(renderer, renderTarget);
composer.addPass(new RenderPass(scene, camera));
const dofSettings = { ...dofSettingDefaults };

const dofDefaults = {
  focus: getFocusDistance(focusPoint),
  ...dofSettingDefaults
};

const dofPass = new SimpleDepthOfFieldPass(camera, dofDefaults);
composer.addPass(dofPass);
composer.addPass(new OutputPass());
composer.setSize(window.innerWidth, window.innerHeight);

const gltfLoader = new GLTFLoader();

// Keep sensor calibration UI and behavior entirely on the JavaScript side.
const sensorCalibrationControl = document.createElement('label');
sensorCalibrationControl.className = 'control';
sensorCalibrationControl.htmlFor = 'sensorSensitivity';
sensorCalibrationControl.innerHTML = `
  <span>
    sensitivity
    <output id="sensorSensitivityValue" class="editable-value" for="sensorSensitivity" data-control="sensorSensitivity" tabindex="0" aria-label="Set sensor sensitivity manually">1.00x</output>
  </span>
  <input id="sensorSensitivity" type="range" min="0.25" max="3" step="0.05" value="1">
`;
document.querySelector('#sensorSettings').append(sensorCalibrationControl);

const controls = {
  panel: document.querySelector('.settings'),
  sensorZoomEnabled: document.querySelector('#sensorZoomEnabled'),
  sensorZoomState: document.querySelector('#sensorZoomState'),
  sensorStatus: document.querySelector('#sensorStatus'),
  sensorDistanceValue: document.querySelector('#sensorDistanceValue'),
  connectSensor: document.querySelector('#connectSensor'),
  sensorSensitivity: document.querySelector('#sensorSensitivity'),
  sensorSensitivityValue: document.querySelector('#sensorSensitivityValue'),
  enabled: document.querySelector('#dofEnabled'),
  state: document.querySelector('#dofState'),
  minDistance: document.querySelector('#minDistance'),
  minDistanceValue: document.querySelector('#minDistanceValue'),
  maxDistance: document.querySelector('#maxDistance'),
  maxDistanceValue: document.querySelector('#maxDistanceValue'),
  blurSize: document.querySelector('#blurSize'),
  blurSizeValue: document.querySelector('#blurSizeValue'),
  blurSpread: document.querySelector('#blurSpread'),
  blurSpreadValue: document.querySelector('#blurSpreadValue'),
  focusValue: document.querySelector('#focusValue'),
  targetValue: document.querySelector('#targetValue'),
  targetX: document.querySelector('#targetX'),
  targetXValue: document.querySelector('#targetXValue'),
  targetY: document.querySelector('#targetY'),
  targetYValue: document.querySelector('#targetYValue'),
  targetZ: document.querySelector('#targetZ'),
  targetZValue: document.querySelector('#targetZValue'),
  modelPositionX: document.querySelector('#modelPositionX'),
  modelPositionXValue: document.querySelector('#modelPositionXValue'),
  modelPositionY: document.querySelector('#modelPositionY'),
  modelPositionYValue: document.querySelector('#modelPositionYValue'),
  modelPositionZ: document.querySelector('#modelPositionZ'),
  modelPositionZValue: document.querySelector('#modelPositionZValue'),
  modelRotationX: document.querySelector('#modelRotationX'),
  modelRotationXValue: document.querySelector('#modelRotationXValue'),
  modelRotationY: document.querySelector('#modelRotationY'),
  modelRotationYValue: document.querySelector('#modelRotationYValue'),
  modelRotationZ: document.querySelector('#modelRotationZ'),
  modelRotationZValue: document.querySelector('#modelRotationZValue'),
  valueEditor: document.querySelector('#valueEditor'),
  valueEditorLabel: document.querySelector('#valueEditorLabel'),
  manualValue: document.querySelector('#manualValue'),
  cancelValueEdit: document.querySelector('#cancelValueEdit'),
  reset: document.querySelector('#resetDof')
};

const editableControls = [
  'minDistance',
  'maxDistance',
  'blurSize',
  'blurSpread',
  'targetX',
  'targetY',
  'targetZ',
  'modelPositionX',
  'modelPositionY',
  'modelPositionZ',
  'sensorSensitivity',
  'modelRotationX',
  'modelRotationY',
  'modelRotationZ'
];
const targetControlAxes = {
  targetX: 'x',
  targetY: 'y',
  targetZ: 'z'
};
const modelRotationControlAxes = {
  modelRotationX: 'x',
  modelRotationY: 'y',
  modelRotationZ: 'z'
};
const modelPositionControlAxes = {
  modelPositionX: 'x',
  modelPositionY: 'y',
  modelPositionZ: 'z'
};
let activeManualControl = null;

function updateDof() {
  dofPass.enabled = controls.enabled.checked;
  dofPass.uniforms.minDistance.value = dofSettings.minDistance;
  dofPass.uniforms.maxDistance.value = dofSettings.maxDistance;
  applyCameraDistanceBlur(getFocusDistance(focusPoint));

  controls.state.textContent = controls.enabled.checked ? 'On' : 'Off';
  controls.minDistanceValue.value = dofSettings.minDistance.toFixed(2);
  controls.maxDistanceValue.value = dofSettings.maxDistance.toFixed(2);
  controls.blurSizeValue.value = formatCompactValue(dofSettings.blurSize);
  controls.blurSpreadValue.value = formatCompactValue(dofSettings.blurSpread);
}

controls.enabled.addEventListener('change', updateDof);
controls.minDistance.addEventListener('input', () => updateDofSettingFromSlider('minDistance'));
controls.maxDistance.addEventListener('input', () => updateDofSettingFromSlider('maxDistance'));
controls.blurSize.addEventListener('input', () => updateDofSettingFromSlider('blurSize'));
controls.blurSpread.addEventListener('input', () => updateDofSettingFromSlider('blurSpread'));
controls.targetX.addEventListener('input', () => updateTargetAxisFromSlider('x', controls.targetX));
controls.targetY.addEventListener('input', () => updateTargetAxisFromSlider('y', controls.targetY));
controls.targetZ.addEventListener('input', () => updateTargetAxisFromSlider('z', controls.targetZ));
controls.modelRotationX.addEventListener('input', () => updateModelRotationFromSlider('modelRotationX'));
controls.modelRotationY.addEventListener('input', () => updateModelRotationFromSlider('modelRotationY'));
controls.modelRotationZ.addEventListener('input', () => updateModelRotationFromSlider('modelRotationZ'));
Object.keys(modelPositionControlAxes).forEach((controlName) => {
  controls[controlName].addEventListener('input', () => {
    setActualControlValue(controlName, Number(controls[controlName].value));
  });
});
controls.sensorSensitivity.addEventListener('input', () => {
  setActualControlValue('sensorSensitivity', Number(controls.sensorSensitivity.value));
});
controls.connectSensor.addEventListener('click', toggleSerialConnection);
controls.sensorZoomEnabled.addEventListener('change', updateSensorZoomMode);
if (serialSupported) {
  navigator.serial.addEventListener('disconnect', (event) => {
    if (event.target === serialState.port) disconnectSerialSensor();
  });
}
editableControls.forEach((controlName) => {
  const output = controls[`${controlName}Value`];

  output.addEventListener('click', (event) => {
    event.preventDefault();
    openValueEditor(controlName);
  });
  output.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openValueEditor(controlName);
    }
  });
});
controls.valueEditor.addEventListener('submit', applyManualValue);
controls.cancelValueEdit.addEventListener('click', closeValueEditor);
controls.reset.addEventListener('click', () => {
  TWEEN.removeAll();
  closeValueEditor();
  controls.enabled.checked = true;
  controls.sensorZoomEnabled.checked = false;
  updateSensorZoomMode();
  Object.assign(dofSettings, dofSettingDefaults);
  Object.assign(modelRotationSettings, modelRotationDefaults);
  Object.assign(modelPositionSettings, modelPositionDefaults);
  sensorZoomSettings.sensitivity = sensorZoomDefaults.sensitivity;
  applyModelPosition();
  focusPoint.copy(initialFocusPoint);
  cameraControls.target.copy(initialFocusPoint);
  applyModelRotation();
  controls.targetValue.value = `${getActiveModelLabel()} center`;
  syncDofSliders();
  updateTargetControls();
  updateModelRotationControls();
  updateModelPositionControls();
  updateSensorCalibrationControl();
  updateDof();
});
syncDofSliders();
updateTargetControls();
updateModelRotationControls();
updateModelPositionControls();
updateSensorCalibrationControl();
updateDof();
updateSensorZoomMode();
switchModel('1');

canvas.addEventListener('pointerdown', onPointerDown);
document.addEventListener('keydown', onDocumentKeyDown);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
});

function animate() {
  const now = performance.now();
  const deltaSeconds = Math.min((now - previousFrameTime) / 1000, 0.1);
  previousFrameTime = now;

  TWEEN.update();
  applySensorZoom(now, deltaSeconds);
  cameraControls.update();
  updateFocusUniform();
  composer.render();
}

function updateSensorUI() {
  const buttonText = serialState.port ? 'Disconnect Sensor' : 'Connect Sensor';
  controls.connectSensor.textContent = serialState.busy ? serialState.status : buttonText;
  controls.connectSensor.disabled = !serialSupported || serialState.busy;
  controls.sensorZoomEnabled.disabled = !serialState.port || serialState.busy;
  controls.sensorZoomState.textContent = controls.sensorZoomEnabled.checked ? 'Sensor' : 'Mouse';
  if (controls.sensorStatus.value !== serialState.status) {
    controls.sensorStatus.value = serialState.status;
  }
  controls.sensorDistanceValue.value = serialState.distanceCm === null
    ? '-- cm'
    : `${serialState.distanceCm.toFixed(1)} cm`;
}

function updateSensorZoomMode() {
  zoomOutStartedAt = null;
  smoothedSensorTarget = null;
  cameraControls.enableZoom = !controls.sensorZoomEnabled.checked;
  updateSensorUI();
}

async function toggleSerialConnection() {
  if (!serialSupported || serialState.busy) return;
  if (serialState.port) {
    await disconnectSerialSensor();
    return;
  }

  serialState.busy = true;
  serialState.status = 'Connecting...';
  updateSensorUI();

  try {
    const port = await navigator.serial.requestPort();
    await port.open({ baudRate: sensorZoomSettings.baudRate });
    serialState.port = port;
    serialState.distanceCm = null;
    serialState.lastReadingAt = performance.now();
    serialState.status = 'Waiting for data';
    serialState.readTask = readSerialSensor(port);
  } catch (error) {
    serialState.status = error.name === 'NotFoundError'
      ? 'Disconnected'
      : 'Cannot connect. Close Serial Monitor and retry.';
    if (error.name !== 'NotFoundError') console.error('Serial connection failed', error);
  } finally {
    serialState.busy = false;
    updateSensorUI();
  }
}

async function readSerialSensor(port) {
  const decoder = new TextDecoder();
  let buffer = '';
  let reader;
  let finalStatus = 'Disconnected';

  try {
    reader = port.readable.getReader();
    serialState.reader = reader;

    while (!serialState.disconnecting) {
      const { value, done } = await reader.read();
      if (done) break;

      // USB chunks may contain part of a line or several complete readings.
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      lines.forEach(handleSensorLine);
      if (buffer.length > 4096) buffer = '';
    }
  } catch (error) {
    if (!serialState.disconnecting) {
      finalStatus = 'Connection lost';
      console.error('Serial read failed', error);
    }
  } finally {
    serialState.busy = true;
    serialState.distanceCm = null;
    controls.sensorZoomEnabled.checked = false;
    serialState.status = 'Disconnecting...';
    updateSensorZoomMode();
    if (reader) reader.releaseLock();
    serialState.reader = null;
    try {
      await port.close();
    } catch (error) {
      console.warn('Serial port could not be closed', error);
    }
    serialState.port = null;
    serialState.readTask = null;
    serialState.busy = false;
    serialState.disconnecting = false;
    serialState.status = finalStatus;
    updateSensorUI();
  }
}

async function disconnectSerialSensor() {
  if (!serialState.port || serialState.busy) return;

  serialState.busy = true;
  serialState.disconnecting = true;
  serialState.distanceCm = null;
  serialState.status = 'Disconnecting...';
  controls.sensorZoomEnabled.checked = false;
  updateSensorZoomMode();
  try {
    if (serialState.reader) await serialState.reader.cancel();
  } catch (error) {
    console.warn('Serial reader was already disconnected', error);
  }
  await serialState.readTask;
}

function handleSensorLine(line) {
  let reading;
  try {
    reading = JSON.parse(line.trim());
  } catch {
    return; // Ignore ESP32 startup messages and incomplete/garbled JSON.
  }
  if (!reading || typeof reading.valid !== 'boolean') return;

  serialState.lastReadingAt = performance.now();
  const valid = reading.valid && Number.isFinite(reading.cm)
    && reading.cm >= 2 && reading.cm <= 400;
  serialState.distanceCm = valid ? reading.cm : null;
  serialState.status = valid ? 'Live' : 'No valid echo';
  updateSensorUI();
}

function applySensorZoom(now, deltaSeconds) {
  if (serialState.port && !serialState.busy
    && now - serialState.lastReadingAt > sensorZoomSettings.staleAfterMs
    && serialState.status !== 'No data') {
    serialState.distanceCm = null;
    serialState.status = 'No data';
    updateSensorUI();
  }
  if (!modelLoaded || !controls.sensorZoomEnabled.checked || !serialState.port || serialState.busy
    || (serialState.distanceCm === null && serialState.status !== 'No valid echo')) {
    zoomOutStartedAt = null;
    smoothedSensorTarget = null;
    return;
  }

  const range = sensorZoomSettings.farCm - sensorZoomSettings.nearCm;
  // Fresh no-echo readings request a delayed return; lost serial data holds the view.
  const rawAmount = serialState.distanceCm === null ? 1 : (range === 0 ? 0 : THREE.MathUtils.clamp(
    (serialState.distanceCm - sensorZoomSettings.nearCm) / range, 0, 1
  ));
  const amount = 1 - THREE.MathUtils.clamp(
    (1 - rawAmount) * Math.max(0, sensorZoomSettings.sensitivity), 0, 1
  );
  const targetDistance = THREE.MathUtils.clamp(
    THREE.MathUtils.lerp(sensorZoomSettings.nearCameraDistance, sensorZoomSettings.farCameraDistance, amount),
    Math.max(camera.near * 2, cameraControls.minDistance),
    cameraControls.maxDistance
  );
  sensorCameraOffset.copy(camera.position).sub(cameraControls.target);
  const currentDistance = sensorCameraOffset.length();
  if (Math.abs(targetDistance - currentDistance) < 0.00001) {
    zoomOutStartedAt = null;
    smoothedSensorTarget = currentDistance;
    return;
  }
  const zoomingOut = targetDistance > currentDistance;
  if (zoomingOut) {
    if (zoomOutStartedAt === null) zoomOutStartedAt = now;
    if (now - zoomOutStartedAt < sensorZoomSettings.zoomOutHoldMs) {
      smoothedSensorTarget = currentDistance;
      return;
    }
  } else {
    zoomOutStartedAt = null;
  }
  if (smoothedSensorTarget === null) smoothedSensorTarget = currentDistance;
  smoothedSensorTarget = THREE.MathUtils.clamp(
    smoothedSensorTarget,
    Math.min(currentDistance, targetDistance),
    Math.max(currentDistance, targetDistance)
  );
  // Smooth the destination first, then ease the camera toward it each frame.
  const targetBlend = sensorZoomSettings.targetSmoothingSeconds > 0
    ? 1 - Math.exp(-deltaSeconds / sensorZoomSettings.targetSmoothingSeconds)
    : 1;
  smoothedSensorTarget = THREE.MathUtils.lerp(smoothedSensorTarget, targetDistance, targetBlend);
  const smoothingSeconds = smoothedSensorTarget > currentDistance
    ? sensorZoomSettings.zoomOutSmoothingSeconds
    : sensorZoomSettings.smoothingSeconds;
  const blend = smoothingSeconds > 0
    ? 1 - Math.exp(-deltaSeconds / smoothingSeconds)
    : 1;
  const nextDistance = THREE.MathUtils.lerp(currentDistance, smoothedSensorTarget, blend);
  const maxStep = Math.max(0, sensorZoomSettings.maxZoomSpeed) * deltaSeconds;
  const distance = currentDistance + THREE.MathUtils.clamp(nextDistance - currentDistance, -maxStep, maxStep);
  if (currentDistance === 0) camera.getWorldDirection(sensorCameraOffset).negate();
  sensorCameraOffset.setLength(distance);
  camera.position.copy(cameraControls.target).add(sensorCameraOffset);
}

function onPointerDown(event) {
  if (event.target !== canvas) return;

  const rect = canvas.getBoundingClientRect();
  pointerCoords.set(
    ((event.clientX - rect.left) / rect.width) * 2 - 1,
    -((event.clientY - rect.top) / rect.height) * 2 + 1
  );

  raycaster.setFromCamera(pointerCoords, camera);

  const intersects = raycaster.intersectObjects(focusTargets, true);

  if (intersects.length > 0) {
    const hit = intersects[0];

    controls.enabled.checked = true;
    controls.targetValue.value = getTargetLabel(hit.object, hit.point);
    tweenFocusTo(hit.point);
    updateDof();
  }
}

function onDocumentKeyDown(event) {
  const activeElement = document.activeElement;
  const activeTag = activeElement?.tagName.toLowerCase();
  const isTyping = activeElement?.isContentEditable
    || ['textarea', 'select'].includes(activeTag)
    || (activeTag === 'input' && !['range', 'checkbox', 'radio'].includes(activeElement.type));

  if (isTyping || event.repeat || event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;

  if (Object.prototype.hasOwnProperty.call(modelAssets, event.key)) {
    event.preventDefault();
    switchModel(event.key);
    return;
  }

  if (event.key.toLowerCase() !== 'h') return;

  controls.panel.classList.toggle('is-hidden');
  controls.panel.setAttribute('aria-hidden', controls.panel.classList.contains('is-hidden'));
}

function getFocusDistance(point) {
  camera.updateMatrixWorld();
  const viewPoint = point.clone().applyMatrix4(camera.matrixWorldInverse);

  return -viewPoint.z;
}

function updateFocusUniform() {
  const focus = getFocusDistance(focusPoint);

  dofPass.uniforms.focus.value = focus;
  applyCameraDistanceBlur(focus);
  controls.focusValue.value = focus.toFixed(2);
}

function applyCameraDistanceBlur(focus) {
  const multiplier = getCameraDistanceBlurMultiplier(focus);

  dofPass.uniforms.blurSize.value = Math.max(0, dofSettings.blurSize * multiplier);
  dofPass.uniforms.blurSpread.value = Math.max(0, dofSettings.blurSpread * multiplier);
}

function getCameraDistanceBlurMultiplier(focus) {
  if (!cameraDistanceBlurSettings.enabled) return 1;

  const range = cameraDistanceBlurSettings.farFocusDistance - cameraDistanceBlurSettings.nearFocusDistance;
  const rawAmount = range === 0 ? 1 : (focus - cameraDistanceBlurSettings.nearFocusDistance) / range;
  const amount = THREE.MathUtils.smoothstep(rawAmount, 0, 1);

  return THREE.MathUtils.lerp(
    cameraDistanceBlurSettings.nearBlurMultiplier,
    cameraDistanceBlurSettings.farBlurMultiplier,
    amount
  );
}

function tweenFocusTo(point) {
  TWEEN.removeAll();

  new TWEEN.Tween(focusPoint)
    .to({ x: point.x, y: point.y, z: point.z }, 500)
    .easing(TWEEN.Easing.Cubic.InOut)
    .onUpdate(updateTargetControls)
    .start();
}

function updateTargetFromSliders() {
  TWEEN.removeAll();
  controls.targetValue.value = 'manual target';
  updateTargetControls();
}

function updateDofSettingFromSlider(controlName) {
  dofSettings[controlName] = Number(controls[controlName].value);
  updateDof();
}

function updateTargetAxisFromSlider(axis, input) {
  TWEEN.removeAll();
  focusPoint[axis] = Number(input.value);
  updateTargetFromSliders();
}

function updateModelRotationFromSlider(controlName) {
  modelRotationSettings[controlName] = Number(controls[controlName].value);
  applyModelRotation();
  updateModelRotationControls();
}

function updateTargetControls() {
  controls.targetX.value = getSliderPosition(controls.targetX, focusPoint.x);
  controls.targetY.value = getSliderPosition(controls.targetY, focusPoint.y);
  controls.targetZ.value = getSliderPosition(controls.targetZ, focusPoint.z);
  controls.targetXValue.value = focusPoint.x.toFixed(2);
  controls.targetYValue.value = focusPoint.y.toFixed(2);
  controls.targetZValue.value = focusPoint.z.toFixed(2);
}

function updateModelRotationControls() {
  Object.keys(modelRotationControlAxes).forEach((controlName) => {
    controls[controlName].value = getSliderPosition(controls[controlName], modelRotationSettings[controlName]);
    controls[`${controlName}Value`].value = modelRotationSettings[controlName].toFixed(1);
  });
}

function updateModelPositionControls() {
  Object.keys(modelPositionControlAxes).forEach((controlName) => {
    controls[controlName].value = getSliderPosition(controls[controlName], modelPositionSettings[controlName]);
    controls[`${controlName}Value`].value = modelPositionSettings[controlName].toFixed(2);
  });
}

function updateSensorCalibrationControl() {
  controls.sensorSensitivity.value = getSliderPosition(controls.sensorSensitivity, sensorZoomSettings.sensitivity);
  controls.sensorSensitivityValue.value = `${sensorZoomSettings.sensitivity.toFixed(2)}x`;
}

function syncDofSliders() {
  Object.keys(dofSettingDefaults).forEach((controlName) => {
    controls[controlName].value = getSliderPosition(controls[controlName], dofSettings[controlName]);
  });
}

function openValueEditor(controlName) {
  const output = controls[`${controlName}Value`];

  activeManualControl = controlName;
  controls.valueEditorLabel.textContent = output.parentElement.textContent.replace(output.textContent, '').trim();
  controls.manualValue.removeAttribute('min');
  controls.manualValue.removeAttribute('max');
  controls.manualValue.step = 'any';
  controls.manualValue.value = getActualControlValue(controlName);
  controls.valueEditor.hidden = false;
  controls.manualValue.focus();
  controls.manualValue.select();
}

function applyManualValue(event) {
  event.preventDefault();

  if (!activeManualControl) return;

  const nextValue = parseManualValue(controls.manualValue.value);

  if (nextValue === null) return;

  setActualControlValue(activeManualControl, nextValue);

  closeValueEditor();
}

function closeValueEditor() {
  controls.valueEditor.hidden = true;
  activeManualControl = null;
}

function parseManualValue(value) {
  const rawValue = Number(value);

  return Number.isFinite(rawValue) ? rawValue : null;
}

function getActualControlValue(controlName) {
  const targetAxis = targetControlAxes[controlName];

  if (targetAxis) return focusPoint[targetAxis];
  if (controlName === 'sensorSensitivity') return sensorZoomSettings.sensitivity;
  if (Object.prototype.hasOwnProperty.call(modelPositionControlAxes, controlName)) return modelPositionSettings[controlName];
  if (isModelRotationControl(controlName)) return modelRotationSettings[controlName];

  return dofSettings[controlName];
}

function setActualControlValue(controlName, value) {
  const targetAxis = targetControlAxes[controlName];

  if (controlName === 'sensorSensitivity') {
    sensorZoomSettings.sensitivity = value;
    zoomOutStartedAt = null;
    smoothedSensorTarget = null;
    updateSensorCalibrationControl();
    return;
  }

  if (Object.prototype.hasOwnProperty.call(modelPositionControlAxes, controlName)) {
    modelPositionSettings[controlName] = value;
    applyModelPosition();
    updateModelPositionControls();
    return;
  }

  if (targetAxis) {
    TWEEN.removeAll();
    focusPoint[targetAxis] = value;
    controls.targetValue.value = 'manual target';
    updateTargetControls();
    return;
  }

  if (isModelRotationControl(controlName)) {
    modelRotationSettings[controlName] = value;
    applyModelRotation();
    updateModelRotationControls();
    return;
  }

  dofSettings[controlName] = value;
  syncDofSliders();
  updateDof();
}

function isModelRotationControl(controlName) {
  return Object.prototype.hasOwnProperty.call(modelRotationControlAxes, controlName);
}

function applyModelRotation() {
  modelRoot.rotation.set(
    THREE.MathUtils.degToRad(modelRotationSettings.modelRotationX),
    THREE.MathUtils.degToRad(modelRotationSettings.modelRotationY),
    THREE.MathUtils.degToRad(modelRotationSettings.modelRotationZ)
  );
}

function applyModelPosition() {
  const nextPosition = new THREE.Vector3(
    modelPositionSettings.modelPositionX,
    modelPositionSettings.modelPositionY,
    modelPositionSettings.modelPositionZ
  );
  const offset = nextPosition.clone().sub(modelRoot.position);
  if (offset.lengthSq() === 0) return;

  TWEEN.removeAll();
  modelRoot.position.copy(nextPosition);
  modelRoot.updateMatrixWorld(true);
  focusPoint.add(offset);
  if (modelLoaded) {
    modelBounds.setFromObject(modelRoot);
    updateTargetSliderRanges(modelBounds);
    controls.targetValue.value = `${getActiveModelLabel()} focus`;
  }
  updateTargetControls();
  updateFocusUniform();
}

function getSliderPosition(input, value) {
  const min = Number(input.min);
  const max = Number(input.max);

  return THREE.MathUtils.clamp(value, min, max);
}

function formatCompactValue(value) {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function updateTargetSliderRanges(box) {
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const axes = [
    ['x', controls.targetX],
    ['y', controls.targetY],
    ['z', controls.targetZ]
  ];

  axes.forEach(([axis, input]) => {
    const halfRange = Math.max(size[axis] * 0.65, 2.25);

    input.min = (center[axis] - halfRange).toFixed(2);
    input.max = (center[axis] + halfRange).toFixed(2);
  });
}

function getTargetLabel(object, point) {
  const label = object.name || `${getActiveModelLabel()} surface`;

  return `${label} (${point.x.toFixed(2)}, ${point.y.toFixed(2)}, ${point.z.toFixed(2)})`;
}

function getActiveModelLabel() {
  return modelAssets[activeModelKey]?.label || 'model';
}

function loadModel(key) {
  if (modelCache.has(key)) return modelCache.get(key);

  const asset = modelAssets[key];
  const loading = gltfLoader.loadAsync(asset.url, (event) => {
    if (requestedModelKey === key && activeModelKey !== key && event.total > 0) {
      const percent = Math.round((event.loaded / event.total) * 100);
      controls.targetValue.value = `loading ${asset.label} ${percent}%`;
    }
  }).then((gltf) => {
    const bounds = new THREE.Box3().setFromObject(gltf.scene);
    const center = bounds.getCenter(new THREE.Vector3());
    const size = bounds.getSize(new THREE.Vector3());
    const largestSide = Math.max(size.x, size.y, size.z);
    if (!Number.isFinite(largestSide) || largestSide <= 0) throw new Error('Model has no usable bounds');

    // Normalize each asset locally; shared settings stay on modelRoot.
    const model = new THREE.Group();
    model.add(gltf.scene);
    const scale = modelTargetSize / largestSide;
    model.scale.setScalar(scale);
    model.position.copy(center).multiplyScalar(-scale);
    model.traverse((child) => {
      if (!child.isMesh) return;
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      materials.forEach((material) => {
        if (material) material.side = THREE.DoubleSide;
      });
    });
    return model;
  }).catch((error) => {
    modelCache.delete(key);
    throw error;
  });
  modelCache.set(key, loading);
  return loading;
}

async function switchModel(key) {
  if (!Object.prototype.hasOwnProperty.call(modelAssets, key)) return;

  const requestId = ++modelRequestId;
  requestedModelKey = key;
  if (activeModelKey === key) {
    controls.targetValue.value = `${getActiveModelLabel()} focus`;
    return;
  }
  controls.targetValue.value = `loading ${modelAssets[key].label}`;

  try {
    const model = await loadModel(key);
    // Rapid key presses must activate only the most recently requested model.
    if (requestId !== modelRequestId) return;

    modelRoot.clear();
    modelRoot.add(model);
    modelRoot.updateMatrixWorld(true);
    activeModelKey = key;
    modelLoaded = true;
    focusTargets.length = 0;
    model.traverse((child) => {
      if (child.isMesh) focusTargets.push(child);
    });
    modelBounds.setFromObject(modelRoot);
    updateTargetSliderRanges(modelBounds);
    updateTargetControls();
    updateFocusUniform();
    controls.targetValue.value = `${getActiveModelLabel()} focus`;
  } catch (error) {
    if (requestId !== modelRequestId) return;
    controls.targetValue.value = `${modelAssets[key].label} load failed`;
    console.error(`Unable to load ${modelAssets[key].url}`, error);
  }
}

renderer.setAnimationLoop(animate);
