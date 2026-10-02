import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { Pass, FullScreenQuad } from "three/addons/postprocessing/Pass.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import TWEEN from "three/addons/libs/tween.module.js";

// DOF RENDERING: Custom postprocessing pass that blends sharp and blurred pixels by depth.
class SimpleDepthOfFieldPass extends Pass {
  // Build the shader and its adjustable focus/blur values.
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
      cameraFar: { value: camera.far },
    };

    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: `
        varying vec2 vUv;

        // Draw the fullscreen image and pass its texture coordinates to the fragment shader.
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

        // Convert the depth texture into distance along the camera's viewing direction.
        float getViewDistance(vec2 uv) {
          float depth = texture2D(tDepth, uv).x;
          float viewZ = perspectiveDepthToViewZ(depth, cameraNear, cameraFar);

          return -viewZ;
        }

        // Combine nine nearby samples to create the blurred color.
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

        // Increase blur as the pixel moves outside the selected focus distance range.
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
      `,
    });
    this.fsQuad = new FullScreenQuad(this.material);
  }

  // Apply DOF to the composer's current color and depth textures.
  render(renderer, writeBuffer, readBuffer) {
    this.uniforms.tDiffuse.value = readBuffer.texture;
    this.uniforms.tDepth.value = readBuffer.depthTexture;
    this.uniforms.cameraNear.value = this.camera.near;
    this.uniforms.cameraFar.value = this.camera.far;

    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    if (this.clear) renderer.clear();
    this.fsQuad.render(renderer);
  }

  // Keep the blur radius consistent when the render size changes.
  setSize(width, height) {
    this.uniforms.resolution.value.set(width, height);
  }

  // Release this pass's GPU resources when it is no longer needed.
  dispose() {
    this.material.dispose();
    this.fsQuad.dispose();
  }
}

// SCENE SETUP: Camera, mouse controls, lighting, and the shared model container.
const canvas = document.querySelector("#c");
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);

const camera = new THREE.PerspectiveCamera(
  45,
  window.innerWidth / window.innerHeight,
  0.1,
  100,
);
camera.position.set(5, 4, 10);
camera.lookAt(0, 0, 0);
const defaultCameraFar = camera.far;

const renderer = new THREE.WebGLRenderer({ antialias: true, canvas });
const pixelRatio = Math.min(window.devicePixelRatio, 2);
renderer.setPixelRatio(pixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.NeutralToneMapping;

const cameraControls = new OrbitControls(camera, canvas);
cameraControls.enabled = false; // Wait for the published preset before accepting camera input.
cameraControls.target.set(0, 0, 0);
cameraControls.enableDamping = true;
cameraControls.update();

const modelRoot = new THREE.Group();
// MODEL QUEUE: Add a key/file entry here for both keyboard selection and automatic cycling.
const modelAssets = {
  1: { url: "./treeScan.glb", label: "tree scan" },
  2: { url: "./treeHole.glb", label: "tree hole" },
  3: { url: "./anotherTreeScan.glb", label: "another tree scan" },
  4: { url: "./percaderoRock.glb", label: "percadero rock" },
};
const modelCache = new Map();
let activeModelKey = null;
let requestedModelKey = "1";
let modelRequestId = 0;
let modelLoading = false;
let automaticModelRequest = false;
const focusTargets = [];
const initialFocusPoint = new THREE.Vector3();
// MODEL DEFAULTS: Largest model dimension and starting X/Y/Z position, in scene units.
const modelTargetSize = 4.5;
const modelCenterPosition = new THREE.Vector3(0, 0, 0);
modelRoot.position.copy(modelCenterPosition);
initialFocusPoint.copy(modelCenterPosition);
cameraControls.target.copy(initialFocusPoint);
cameraControls.update();
const modelPositionDefaults = {
  modelPositionX: modelCenterPosition.x,
  modelPositionY: modelCenterPosition.y,
  modelPositionZ: modelCenterPosition.z,
};
const modelPositionSettings = { ...modelPositionDefaults };
const modelRotationDefaults = {
  modelRotationX: 0,
  modelRotationY: 0,
  modelRotationZ: 0,
};
const modelRotationSettings = { ...modelRotationDefaults };
// ZOOM EVENTS: Delays are seconds; speed is degrees/second, multiplied by each signed axis amount.
const zoomBehaviorDefaults = {
  modelSwitchDelay: 30,
  rotationDelay: 2,
  rotationSpeed: 6,
  rotationAxisX: 0,
  rotationAxisY: 1,
  rotationAxisZ: 0,
};
const zoomBehaviorSettings = { ...zoomBehaviorDefaults };
const zoomBehaviorToggleDefaults = {
  modelCycleEnabled: true,
  proximityRotationEnabled: true,
};
const zoomBehaviorToggles = { ...zoomBehaviorToggleDefaults };
const zoomBehaviorState = {
  atMax: false,
  atMin: false,
  maxElapsed: 0,
  minElapsed: 0,
  rotationPhase: "idle",
  rotationOffset: new THREE.Quaternion(),
  returnFrom: new THREE.Quaternion(),
  returnElapsed: 0,
};
// A small arrival tolerance accommodates the sensor's eased zoom; return time is independently editable.
const zoomArrivalTolerance = 0.02;
const rotationReturnSeconds = 1.5;
const rotationIdentity = new THREE.Quaternion();
const rotationStep = new THREE.Quaternion();
const rotationAxis = new THREE.Vector3();
// Change these defaults if you want Reset to return to different DOF values.
const dofSettingDefaults = {
  minDistance: 1,
  maxDistance: 3,
  blurSize: 2,
  blurSpread: 4,
};
// FILTER DEFAULTS: Opacity is 0..1; hue is degrees, and color adjustments are neutral at zero.
const postProcessingDefaults = {
  noiseStrength: 0.08,
  noiseOpacity: 1,
  noiseSize: 1,
  noiseSpeed: 1,
  vignetteStrength: 0.65,
  vignetteRadius: 0.35,
  vignetteSoftness: 0.6,
  vignetteOpacity: 1,
  bloomStrength: 0.4,
  bloomRadius: 0.4,
  bloomThreshold: 0.85,
  bloomOpacity: 1,
  colorHue: 0,
  colorSaturation: 0,
  colorBrightness: 0,
  colorOpacity: 1,
};
const postProcessingSettings = { ...postProcessingDefaults };
// New filters start off; saved presets can enable them for future visits.
const postProcessingToggleDefaults = {
  noiseEnabled: false,
  vignetteEnabled: false,
  bloomEnabled: false,
  colorEnabled: false,
};
const postProcessingToggles = { ...postProcessingToggleDefaults };
const optionalControlDefaults = { ...zoomBehaviorDefaults, ...postProcessingDefaults };
// ZOOM-BASED BLUR: Adjust how much blur changes between near and far focus distances.
const cameraDistanceBlurSettings = {
  enabled: true,
  nearFocusDistance: 3,
  farFocusDistance: 12,
  nearBlurMultiplier: 0.35,
  farBlurMultiplier: 1.8,
};
// SENSOR DEFAULTS: Sensor distances are centimeters; camera distances are Three.js scene units.
// Values beyond nearCm/farCm hold the corresponding camera distance.
// Smoothing values use seconds; zoomOutHoldMs and staleAfterMs use milliseconds.
const sensorZoomDefaults = {
  baudRate: 115200,
  nearCm: 20,
  farCm: 160,
  nearCameraDistance: 4,
  farCameraDistance: 14,
  sensitivity: 1, // Higher values increase how strongly approaching affects zoom.
  zoomInSpeed: 1,
  zoomOutSpeed: 1,
  targetSmoothingSeconds: 0.6,
  smoothingSeconds: 1.2,
  zoomOutHoldMs: 3000,
  zoomOutSmoothingSeconds: 3.5,
  maxZoomSpeed: 3, // Maximum camera movement in scene units per second.
  staleAfterMs: 1000,
};
const sensorZoomSettings = { ...sensorZoomDefaults };
let zoomOutStartedAt = null;
let smoothedSensorTarget = null;
const serialSupported = window.isSecureContext && "serial" in navigator;
// SERIAL RECOVERY: Times are milliseconds. Silence triggers a restart, not an unchanged distance.
const serialRecoverySettings = {
  checkIntervalMs: 500,
  silentAfterMs: 5000,
  retryDelaysMs: [0, 2000, 5000, 10000, 30000],
};
const serialState = {
  selectedPort: null,
  port: null,
  reader: null,
  cancelTask: null,
  readTask: null,
  busy: false,
  connectionWanted: false,
  restartRequested: false,
  retryTimer: null,
  retryResolve: null,
  nextRetryAt: 0,
  retryAttempt: 0,
  reconnectAttempts: 0,
  distanceCm: null,
  openedAt: 0,
  lastReadingAt: null,
  status: serialSupported
    ? "Disconnected"
    : "Use Chrome or Edge on localhost or HTTPS",
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

const renderTarget = new THREE.WebGLRenderTarget(
  window.innerWidth,
  window.innerHeight,
);
renderTarget.depthTexture = new THREE.DepthTexture(
  window.innerWidth,
  window.innerHeight,
);
renderTarget.depthTexture.type = THREE.UnsignedShortType;

const composer = new EffectComposer(renderer, renderTarget);
composer.addPass(new RenderPass(scene, camera));
const dofSettings = { ...dofSettingDefaults };

const dofDefaults = {
  focus: getFocusDistance(focusPoint),
  ...dofSettingDefaults,
};

const dofPass = new SimpleDepthOfFieldPass(camera, dofDefaults);
composer.addPass(dofPass);
// Keep DOF next to RenderPass so its depth texture still describes the original scene.
const bloomPass = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.4, 0.4, 0.85);
bloomPass.enabled = false;
composer.addPass(bloomPass);
composer.addPass(new OutputPass());
// Color adjustments and film finishing operate on display colors, after tone mapping.
const colorAdjustmentPass = createColorAdjustmentPass();
const noiseVignettePass = createNoiseVignettePass();
colorAdjustmentPass.enabled = false;
noiseVignettePass.enabled = false;
composer.addPass(colorAdjustmentPass);
composer.addPass(noiseVignettePass);
composer.setSize(window.innerWidth, window.innerHeight);

const gltfLoader = new GLTFLoader();

// Keep sensor calibration UI and behavior entirely on the JavaScript side.
const sensorCalibrationControl = document.createElement("label");
sensorCalibrationControl.className = "control";
sensorCalibrationControl.htmlFor = "sensorSensitivity";
sensorCalibrationControl.innerHTML = `
  <span>
    sensitivity
    <output id="sensorSensitivityValue" class="editable-value" for="sensorSensitivity" data-control="sensorSensitivity" tabindex="0" aria-label="Set sensor sensitivity manually">1.00x</output>
  </span>
  <input id="sensorSensitivity" type="range" min="0.25" max="3" step="0.05" value="1">
`;
document.querySelector("#sensorSettings").append(sensorCalibrationControl);

// Keep the connection diagnostics in main.js, using the existing settings layout.
const sensorDiagnostics = document.createElement("div");
sensorDiagnostics.innerHTML = `
  <p class="target">
    <span>last message</span>
    <output id="sensorLastMessageValue" aria-live="off">-- s</output>
  </p>
  <p class="target">
    <span>reconnect attempts</span>
    <output id="sensorReconnectValue" aria-live="off">0</output>
  </p>
`;
document.querySelector("#sensorSettings").append(sensorDiagnostics);

// Build the new collapsible groups here so index.html and style.css remain unchanged.
const zoomBehaviorInputs = createZoomBehaviorControls();
const postProcessingInputs = createPostProcessingControls();
const controls = {
  ...zoomBehaviorInputs,
  ...postProcessingInputs,
  panel: document.querySelector(".settings"),
  sensorZoomEnabled: document.querySelector("#sensorZoomEnabled"),
  sensorZoomState: document.querySelector("#sensorZoomState"),
  sensorStatus: document.querySelector("#sensorStatus"),
  sensorDistanceValue: document.querySelector("#sensorDistanceValue"),
  sensorLastMessageValue: document.querySelector("#sensorLastMessageValue"),
  sensorReconnectValue: document.querySelector("#sensorReconnectValue"),
  connectSensor: document.querySelector("#connectSensor"),
  sensorSensitivity: document.querySelector("#sensorSensitivity"),
  sensorSensitivityValue: document.querySelector("#sensorSensitivityValue"),
  zoomInSpeed: document.querySelector("#zoomInSpeed"),
  zoomInSpeedValue: document.querySelector("#zoomInSpeedValue"),
  zoomOutSpeed: document.querySelector("#zoomOutSpeed"),
  zoomOutSpeedValue: document.querySelector("#zoomOutSpeedValue"),
  zoomOutDelay: document.querySelector("#zoomOutDelay"),
  zoomOutDelayValue: document.querySelector("#zoomOutDelayValue"),
  cameraXValue: document.querySelector("#cameraXValue"),
  cameraYValue: document.querySelector("#cameraYValue"),
  cameraZValue: document.querySelector("#cameraZValue"),
  cameraMinDistance: document.querySelector("#cameraMinDistance"),
  cameraMinDistanceValue: document.querySelector("#cameraMinDistanceValue"),
  cameraMaxDistance: document.querySelector("#cameraMaxDistance"),
  cameraMaxDistanceValue: document.querySelector("#cameraMaxDistanceValue"),
  enabled: document.querySelector("#dofEnabled"),
  state: document.querySelector("#dofState"),
  minDistance: document.querySelector("#minDistance"),
  minDistanceValue: document.querySelector("#minDistanceValue"),
  maxDistance: document.querySelector("#maxDistance"),
  maxDistanceValue: document.querySelector("#maxDistanceValue"),
  blurSize: document.querySelector("#blurSize"),
  blurSizeValue: document.querySelector("#blurSizeValue"),
  blurSpread: document.querySelector("#blurSpread"),
  blurSpreadValue: document.querySelector("#blurSpreadValue"),
  focusValue: document.querySelector("#focusValue"),
  targetValue: document.querySelector("#targetValue"),
  targetX: document.querySelector("#targetX"),
  targetXValue: document.querySelector("#targetXValue"),
  targetY: document.querySelector("#targetY"),
  targetYValue: document.querySelector("#targetYValue"),
  targetZ: document.querySelector("#targetZ"),
  targetZValue: document.querySelector("#targetZValue"),
  modelPositionX: document.querySelector("#modelPositionX"),
  modelPositionXValue: document.querySelector("#modelPositionXValue"),
  modelPositionY: document.querySelector("#modelPositionY"),
  modelPositionYValue: document.querySelector("#modelPositionYValue"),
  modelPositionZ: document.querySelector("#modelPositionZ"),
  modelPositionZValue: document.querySelector("#modelPositionZValue"),
  modelRotationX: document.querySelector("#modelRotationX"),
  modelRotationXValue: document.querySelector("#modelRotationXValue"),
  modelRotationY: document.querySelector("#modelRotationY"),
  modelRotationYValue: document.querySelector("#modelRotationYValue"),
  modelRotationZ: document.querySelector("#modelRotationZ"),
  modelRotationZValue: document.querySelector("#modelRotationZValue"),
  valueEditor: document.querySelector("#valueEditor"),
  valueEditorLabel: document.querySelector("#valueEditorLabel"),
  manualValue: document.querySelector("#manualValue"),
  cancelValueEdit: document.querySelector("#cancelValueEdit"),
  exportSettings: document.querySelector("#exportSettings"),
  settingsStatus: document.querySelector("#settingsStatus"),
  reset: document.querySelector("#resetDof"),
};

const editableControls = [
  "minDistance",
  "maxDistance",
  "blurSize",
  "blurSpread",
  "targetX",
  "targetY",
  "targetZ",
  "modelPositionX",
  "modelPositionY",
  "modelPositionZ",
  "sensorSensitivity",
  "zoomInSpeed",
  "zoomOutSpeed",
  "zoomOutDelay",
  "cameraMinDistance",
  "cameraMaxDistance",
  "modelRotationX",
  "modelRotationY",
  "modelRotationZ",
  ...Object.keys(optionalControlDefaults),
];
const targetControlAxes = {
  targetX: "x",
  targetY: "y",
  targetZ: "z",
};
const modelRotationControlAxes = {
  modelRotationX: "x",
  modelRotationY: "y",
  modelRotationZ: "z",
};
const modelPositionControlAxes = {
  modelPositionX: "x",
  modelPositionY: "y",
  modelPositionZ: "z",
};
const sensorSpeedControls = ["zoomInSpeed", "zoomOutSpeed"];
const cameraZoomControls = {
  cameraMinDistance: "nearCameraDistance",
  cameraMaxDistance: "farCameraDistance",
};
let activeManualControl = null;

// Apply DOF settings to the shader and refresh the displayed blur values.
function updateDof() {
  dofPass.enabled = controls.enabled.checked;
  dofPass.uniforms.minDistance.value = dofSettings.minDistance;
  dofPass.uniforms.maxDistance.value = dofSettings.maxDistance;
  applyCameraDistanceBlur(getFocusDistance(focusPoint));

  controls.state.textContent = controls.enabled.checked ? "On" : "Off";
  controls.minDistanceValue.value = dofSettings.minDistance.toFixed(2);
  controls.maxDistanceValue.value = dofSettings.maxDistance.toFixed(2);
  controls.blurSizeValue.value = formatCompactValue(dofSettings.blurSize);
  controls.blurSpreadValue.value = formatCompactValue(dofSettings.blurSpread);
}

// UI EVENTS: Route sliders and toggles to their setting handlers.
controls.enabled.addEventListener("change", updateDof);
controls.minDistance.addEventListener("input", () =>
  updateDofSettingFromSlider("minDistance"),
);
controls.maxDistance.addEventListener("input", () =>
  updateDofSettingFromSlider("maxDistance"),
);
controls.blurSize.addEventListener("input", () =>
  updateDofSettingFromSlider("blurSize"),
);
controls.blurSpread.addEventListener("input", () =>
  updateDofSettingFromSlider("blurSpread"),
);
controls.targetX.addEventListener("input", () =>
  updateTargetAxisFromSlider("x", controls.targetX),
);
controls.targetY.addEventListener("input", () =>
  updateTargetAxisFromSlider("y", controls.targetY),
);
controls.targetZ.addEventListener("input", () =>
  updateTargetAxisFromSlider("z", controls.targetZ),
);
controls.modelRotationX.addEventListener("input", () =>
  updateModelRotationFromSlider("modelRotationX"),
);
controls.modelRotationY.addEventListener("input", () =>
  updateModelRotationFromSlider("modelRotationY"),
);
controls.modelRotationZ.addEventListener("input", () =>
  updateModelRotationFromSlider("modelRotationZ"),
);
Object.keys(modelPositionControlAxes).forEach((controlName) => {
  controls[controlName].addEventListener("input", () => {
    setActualControlValue(controlName, Number(controls[controlName].value));
  });
});
controls.sensorSensitivity.addEventListener("input", () => {
  setActualControlValue(
    "sensorSensitivity",
    Number(controls.sensorSensitivity.value),
  );
});
sensorSpeedControls.forEach((controlName) => {
  controls[controlName].addEventListener("input", () => {
    setActualControlValue(controlName, Number(controls[controlName].value));
  });
});
controls.zoomOutDelay.addEventListener("input", () => {
  setActualControlValue("zoomOutDelay", Number(controls.zoomOutDelay.value));
});
Object.keys(cameraZoomControls).forEach((controlName) => {
  controls[controlName].addEventListener("input", () => {
    setActualControlValue(controlName, Number(controls[controlName].value));
  });
});
Object.keys(zoomBehaviorDefaults).forEach((controlName) => {
  controls[controlName].addEventListener("input", () => {
    setActualControlValue(controlName, Number(controls[controlName].value));
  });
});
Object.keys(zoomBehaviorToggleDefaults).forEach((controlName) => {
  controls[controlName].addEventListener("change", () => {
    zoomBehaviorToggles[controlName] = controls[controlName].checked;
    resetZoomBehaviorTimers(
      controlName === "modelCycleEnabled" ? "max" : "min",
    );
    if (
      controlName === "modelCycleEnabled" &&
      !zoomBehaviorToggles.modelCycleEnabled
    ) {
      cancelAutomaticModelSwitch();
    }
    if (!zoomBehaviorToggles.proximityRotationEnabled) beginRotationReturn();
    updateZoomBehaviorControls();
  });
});
Object.keys(postProcessingDefaults).forEach((controlName) => {
  controls[controlName].addEventListener("input", () => {
    setActualControlValue(controlName, Number(controls[controlName].value));
  });
});
Object.keys(postProcessingToggleDefaults).forEach((controlName) => {
  controls[controlName].addEventListener("change", () => {
    postProcessingToggles[controlName] = controls[controlName].checked;
    updatePostProcessing();
  });
});
controls.connectSensor.addEventListener("click", toggleSerialConnection);
controls.sensorZoomEnabled.addEventListener("change", updateSensorZoomMode);
if (serialSupported) {
  // Device loss should recover automatically; only the Disconnect button cancels that intent.
  navigator.serial.addEventListener("disconnect", (event) => {
    if (event.target === serialState.selectedPort)
      requestSerialRestart("Device disconnected");
  });
}
// Make value readouts editable by mouse click or keyboard activation.
editableControls.forEach((controlName) => {
  const output = controls[`${controlName}Value`];

  output.addEventListener("click", (event) => {
    event.preventDefault();
    openValueEditor(controlName);
  });
  output.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openValueEditor(controlName);
    }
  });
});
controls.valueEditor.addEventListener("submit", applyManualValue);
controls.cancelValueEdit.addEventListener("click", closeValueEditor);
controls.exportSettings.addEventListener("click", exportSettings);
// RESET: Restore setting defaults and center focus without switching the active model.
controls.reset.addEventListener("click", () => {
  TWEEN.removeAll();
  closeValueEditor();
  controls.enabled.checked = true;
  controls.sensorZoomEnabled.checked = false;
  updateSensorZoomMode();
  Object.assign(dofSettings, dofSettingDefaults);
  Object.assign(modelRotationSettings, modelRotationDefaults);
  Object.assign(modelPositionSettings, modelPositionDefaults);
  Object.assign(zoomBehaviorSettings, zoomBehaviorDefaults);
  Object.assign(zoomBehaviorToggles, zoomBehaviorToggleDefaults);
  Object.assign(postProcessingSettings, postProcessingDefaults);
  Object.assign(postProcessingToggles, postProcessingToggleDefaults);
  noiseVignettePass.uniforms.noiseTime.value = 0;
  cancelAutomaticModelSwitch();
  resetZoomBehaviorTimers();
  resetAnimatedRotation();
  sensorZoomSettings.sensitivity = sensorZoomDefaults.sensitivity;
  sensorZoomSettings.zoomOutHoldMs = sensorZoomDefaults.zoomOutHoldMs;
  Object.values(cameraZoomControls).forEach((settingName) => {
    sensorZoomSettings[settingName] = sensorZoomDefaults[settingName];
  });
  sensorSpeedControls.forEach((controlName) => {
    sensorZoomSettings[controlName] = sensorZoomDefaults[controlName];
  });
  applyModelPosition();
  focusPoint.copy(initialFocusPoint);
  cameraControls.target.copy(initialFocusPoint);
  applyModelRotation();
  updateCameraZoomLimits();
  controls.targetValue.value = `${getActiveModelLabel()} center`;
  syncDofSliders();
  updateTargetControls();
  updateModelRotationControls();
  updateModelPositionControls();
  updateSensorCalibrationControl();
  updateSensorSpeedControls();
  updateSensorDelayControl();
  updateZoomBehaviorControls();
  updateDof();
  controls.settingsStatus.textContent = "Default controls restored";
  updatePostProcessing();
});
// STARTUP: Load the published JSON before enabling input or choosing the first model.
const startupModelKey = await loadPublishedSettings();
syncDofSliders();
updateTargetControls();
updateModelRotationControls();
updateModelPositionControls();
updateSensorCalibrationControl();
updateSensorSpeedControls();
updateSensorDelayControl();
updateZoomBehaviorControls();
updateCameraZoomLimits();
updateDof();
updatePostProcessing();
updateSensorZoomMode();
updateCameraPositionControls();
cameraControls.enabled = true;
controls.panel.inert = false;
switchModel(startupModelKey);

canvas.addEventListener("pointerdown", onPointerDown);
document.addEventListener("keydown", onDocumentKeyDown);
// Hidden tabs pause the experience instead of expiring timers or jumping ahead on return.
document.addEventListener("visibilitychange", () => {
  previousFrameTime = performance.now();
  resetZoomBehaviorTimers();
});

// Check serial health independently of the render loop, including when the page becomes visible.
if (serialSupported) {
  setInterval(monitorSerialConnection, serialRecoverySettings.checkIntervalMs);
  document.addEventListener("visibilitychange", monitorSerialConnection);
}

// Resize the camera view, renderer, and postprocessing buffers together.
window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
});

// SETTINGS EXPORT: Capture applied values, not clamped slider thumbs or live USB state.
function collectSettingsPreset() {
  return {
    schemaVersion: 1,
    model: activeModelKey || requestedModelKey,
    dofEnabled: controls.enabled.checked,
    zoomBehaviors: { ...zoomBehaviorToggles },
    postProcessing: { ...postProcessingToggles },
    controls: Object.fromEntries(
      editableControls.map((name) => [name, getActualControlValue(name)]),
    ),
    camera: {
      position: {
        x: camera.position.x,
        y: camera.position.y,
        z: camera.position.z,
      },
      target: {
        x: cameraControls.target.x,
        y: cameraControls.target.y,
        z: cameraControls.target.z,
      },
    },
  };
}

// Download a readable settings.json; publishing still requires replacing the file in the repo.
function exportSettings() {
  let url;
  const link = document.createElement("a");
  try {
    const preset = collectSettingsPreset();
    validateSettingsPreset(preset);
    const json = `${JSON.stringify(preset, null, 2)}\n`;
    url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
    link.href = url;
    link.download = "settings.json";
    document.body.append(link);
    link.click();
    controls.settingsStatus.textContent = "Settings download started";
  } catch (error) {
    controls.settingsStatus.textContent = "Export failed";
    console.error("Unable to export settings", error);
  } finally {
    link.remove();
    // Give the browser time to start reading the download before releasing its URL.
    if (url) setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

// Reject incomplete or invalid presets before changing any scene settings.
function validateSettingsPreset(preset) {
  if (
    preset?.schemaVersion !== 1 ||
    typeof preset.dofEnabled !== "boolean" ||
    typeof preset.model !== "string" ||
    !Object.hasOwn(modelAssets, preset.model)
  ) {
    throw new Error("Unsupported settings format or model");
  }
  for (const name of editableControls) {
    // Older presets omit newer controls; use defaults without rewriting the existing JSON.
    if (
      Object.hasOwn(optionalControlDefaults, name) &&
      preset.controls?.[name] === undefined
    )
      continue;
    if (!Number.isFinite(preset.controls?.[name]))
      throw new Error(`Invalid setting: ${name}`);
    if (Object.hasOwn(postProcessingDefaults, name) && !Number.isFinite(Math.fround(preset.controls[name]))) {
      throw new Error(`Filter setting exceeds GPU numeric range: ${name}`);
    }
  }
  if (preset.zoomBehaviors !== undefined) {
    for (const name of Object.keys(zoomBehaviorToggleDefaults)) {
      if (typeof preset.zoomBehaviors?.[name] !== "boolean")
        throw new Error(`Invalid toggle: ${name}`);
    }
  }
  if (preset.postProcessing !== undefined) {
    for (const name of Object.keys(postProcessingToggleDefaults)) {
      if (typeof preset.postProcessing?.[name] !== "boolean") throw new Error(`Invalid toggle: ${name}`);
    }
  }
  for (const vector of ["position", "target"]) {
    for (const axis of ["x", "y", "z"]) {
      if (!Number.isFinite(preset.camera?.[vector]?.[axis])) {
        throw new Error(`Invalid camera ${vector}.${axis}`);
      }
    }
  }
  const min = preset.controls.cameraMinDistance;
  const max = preset.controls.cameraMaxDistance;
  if (
    min < camera.near * 2 ||
    max < min ||
    !Number.isFinite(max * 1.1 + modelTargetSize) ||
    !Number.isFinite(preset.controls.zoomOutDelay * 1000)
  ) {
    throw new Error("Invalid camera limits or return delay");
  }
  const { position, target } = preset.camera;
  const distance = Math.hypot(
    position.x - target.x,
    position.y - target.y,
    position.z - target.z,
  );
  if (!Number.isFinite(distance) || distance === 0)
    throw new Error("Invalid camera view");
}

// Apply model transforms first, then the saved world-space focus point and camera view.
function applySettingsPreset(preset) {
  validateSettingsPreset(preset);
  TWEEN.removeAll();
  cancelAutomaticModelSwitch();
  resetZoomBehaviorTimers();
  resetAnimatedRotation();
  Object.assign(
    zoomBehaviorToggles,
    preset.zoomBehaviors ?? zoomBehaviorToggleDefaults,
  );
  for (const name of Object.keys(postProcessingToggleDefaults)) {
    postProcessingToggles[name] = preset.postProcessing?.[name] ?? postProcessingToggleDefaults[name];
  }
  noiseVignettePass.uniforms.noiseTime.value = 0;
  controls.enabled.checked = preset.dofEnabled;
  for (const name of editableControls) {
    if (!Object.hasOwn(targetControlAxes, name)) {
      setActualControlValue(
        name,
        preset.controls[name] ?? optionalControlDefaults[name],
      );
    }
  }
  // Moving the model also moves focus, so restore the exact saved target last.
  for (const name of Object.keys(targetControlAxes)) {
    setActualControlValue(name, preset.controls[name]);
  }
  const { position, target } = preset.camera;
  cameraControls.target.set(target.x, target.y, target.z);
  camera.position.set(position.x, position.y, position.z);
  cameraControls.update();
  updateCameraPositionControls();
  updateFocusUniform();
  updateDof();
  updateZoomBehaviorControls();
  updatePostProcessing();
}

// PUBLISHED PRESET: Read beside main.js (also works under a GitHub Pages repository path).
// A missing, invalid, or slow response leaves the original code defaults in place.
async function loadPublishedSettings() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(new URL("./settings.json", import.meta.url), {
      cache: "no-store",
      signal: controller.signal,
    });
    if (response.status === 404) {
      controls.settingsStatus.textContent = "No preset; using defaults";
      return "1";
    }
    if (!response.ok)
      throw new Error(`Settings request failed: ${response.status}`);
    const preset = await response.json();
    applySettingsPreset(preset);
    controls.settingsStatus.textContent = "Published settings loaded";
    return preset.model;
  } catch (error) {
    controls.settingsStatus.textContent = "Preset unavailable; using defaults";
    console.warn("Unable to load settings.json; using code defaults", error);
    return "1";
  } finally {
    clearTimeout(timeout);
  }
}

// FRAME LOOP: Update motion, live readouts, and focus before drawing the scene.
function animate() {
  const now = performance.now();
  const elapsedSeconds = Math.max(0, (now - previousFrameTime) / 1000);
  const deltaSeconds = Math.min(elapsedSeconds, 0.1);
  previousFrameTime = now;

  TWEEN.update();
  applySensorZoom(now, deltaSeconds);
  cameraControls.update();
  updateZoomBehaviors(elapsedSeconds, deltaSeconds);
  updateCameraPositionControls();
  updateFocusUniform();
  // Advance grain only while visible; bounded time remains stable during long gallery runs.
  if (noiseVignettePass.enabled && noiseVignettePass.uniforms.noiseAmount.value > 0 && !document.hidden) {
    const time = noiseVignettePass.uniforms.noiseTime;
    time.value = (time.value + deltaSeconds * postProcessingSettings.noiseSpeed) % 4096;
  }
  composer.render(deltaSeconds);
}

// FILTER SHADERS: A shared full-screen setup, with no extra depth or tone-mapping work.
function createFilterPass(name, uniforms, fragmentShader) {
  const pass = new ShaderPass({
    name,
    uniforms: { tDiffuse: { value: null }, ...uniforms },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = vec4(position.xy, 0.0, 1.0);
      }
    `,
    fragmentShader,
  });
  pass.material.depthTest = false;
  pass.material.depthWrite = false;
  pass.material.toneMapped = false;
  return pass;
}

// Combine grain and vignette in one draw; zero-amount branches omit each effect's calculations.
function createNoiseVignettePass() {
  return createFilterPass("NoiseVignette", {
    noiseAmount: { value: 0 },
    noiseSize: { value: 1 },
    noiseTime: { value: 0 },
    vignetteAmount: { value: 0 },
    vignetteRadius: { value: 0.35 },
    vignetteSoftness: { value: 0.6 },
  }, `
    uniform sampler2D tDiffuse;
    uniform float noiseAmount;
    uniform float noiseSize;
    uniform float noiseTime;
    uniform float vignetteAmount;
    uniform float vignetteRadius;
    uniform float vignetteSoftness;
    varying vec2 vUv;

    void main() {
      vec4 texel = texture2D(tDiffuse, vUv);
      vec3 color = texel.rgb;
      if (noiseAmount > 0.0) {
        vec2 cell = floor(gl_FragCoord.xy / noiseSize);
        float frame = floor(noiseTime * 24.0);
        float grain = fract(sin(dot(cell, vec2(12.9898, 78.233)) + frame * 37.719) * 43758.5453);
        color += (grain - 0.5) * noiseAmount;
      }
      if (vignetteAmount > 0.0) {
        float distanceFromCenter = length((vUv - 0.5) * 1.41421356);
        float edge = smoothstep(vignetteRadius, vignetteRadius + vignetteSoftness, distanceFromCenter);
        color *= 1.0 - edge * vignetteAmount;
      }
      gl_FragColor = vec4(clamp(color, 0.0, 1.0), texel.a);
    }
  `);
}

// Hue rotation follows Three.js HueSaturationShader (MIT; see library/THREE-LICENSE.txt).
// Saturation uses a continuous gray-to-color blend; brightness is an additive display-color offset.
function createColorAdjustmentPass() {
  return createFilterPass("ColorAdjustment", {
    hue: { value: 0 },
    saturation: { value: 0 },
    brightness: { value: 0 },
    opacity: { value: 1 },
  }, `
    uniform sampler2D tDiffuse;
    uniform float hue;
    uniform float saturation;
    uniform float brightness;
    uniform float opacity;
    varying vec2 vUv;

    void main() {
      vec4 texel = texture2D(tDiffuse, vUv);
      float s = sin(hue), c = cos(hue);
      vec3 weights = (vec3(2.0 * c, -sqrt(3.0) * s - c, sqrt(3.0) * s - c) + 1.0) / 3.0;
      vec3 color = vec3(dot(texel.rgb, weights.xyz), dot(texel.rgb, weights.zxy), dot(texel.rgb, weights.yzx));
      float average = (color.r + color.g + color.b) / 3.0;
      color = mix(vec3(average), color, 1.0 + saturation);
      color = clamp(color + brightness, 0.0, 1.0);
      gl_FragColor = vec4(mix(texel.rgb, color, opacity), texel.a);
    }
  `);
}

// FILTER UI: Keep the four collapsible sections in main.js and reuse existing manual number entry.
function createPostProcessingControls() {
  const sliders = {
    noiseStrength: ["strength", 0, 1, 0.01],
    noiseOpacity: ["opacity", 0, 1, 0.01],
    noiseSize: ["grain size", 1, 8, 0.25],
    noiseSpeed: ["animation speed", 0, 3, 0.05],
    vignetteStrength: ["strength", 0, 1, 0.01],
    vignetteRadius: ["radius", 0, 1, 0.01],
    vignetteSoftness: ["softness", 0.01, 1, 0.01],
    vignetteOpacity: ["opacity", 0, 1, 0.01],
    bloomStrength: ["strength", 0, 3, 0.05],
    bloomRadius: ["radius", 0, 1, 0.01],
    bloomThreshold: ["threshold", 0, 2, 0.01],
    bloomOpacity: ["opacity", 0, 1, 0.01],
    colorHue: ["hue", -180, 180, 1],
    colorSaturation: ["saturation", -1, 1, 0.01],
    colorBrightness: ["brightness", -1, 1, 0.01],
    colorOpacity: ["opacity", 0, 1, 0.01],
  };
  const groups = [
    ["Noise", "noiseEnabled", ["noiseStrength", "noiseOpacity", "noiseSize", "noiseSpeed"]],
    ["Vignette", "vignetteEnabled", ["vignetteStrength", "vignetteRadius", "vignetteSoftness", "vignetteOpacity"]],
    ["Bloom", "bloomEnabled", ["bloomStrength", "bloomRadius", "bloomThreshold", "bloomOpacity"]],
    ["Color", "colorEnabled", ["colorHue", "colorSaturation", "colorBrightness", "colorOpacity"]],
  ];
  let previousGroup = document.querySelector("#blurSpread").closest("details");
  const inputs = {};
  for (const [title, toggle, names] of groups) {
    const group = document.createElement("details");
    group.className = "settings-group";
    group.innerHTML = `
      <summary>${title}</summary>
      <div class="sensor-mode">
        <span>enabled</span>
        <label class="toggle">
          <input id="${toggle}" type="checkbox" role="switch" aria-label="Enable ${title}">
          <span id="${toggle}State">Off</span>
        </label>
      </div>
      ${names.map((name) => {
        const [label, min, max, step] = sliders[name];
        return `
          <label class="control" for="${name}">
            <span>${label}
              <output id="${name}Value" class="editable-value" for="${name}" data-control="${name}" tabindex="0" aria-label="Set ${title} ${label} manually"></output>
            </span>
            <input id="${name}" type="range" min="${min}" max="${max}" step="${step}" value="${postProcessingDefaults[name]}">
          </label>`;
      }).join("")}`;
    previousGroup.after(group);
    previousGroup = group;
    for (const id of [toggle, `${toggle}State`, ...names.flatMap((name) => [name, `${name}Value`])]) {
      inputs[id] = document.querySelector(`#${id}`);
    }
  }
  return inputs;
}

// Keep opacity/radii bounded; manual hue, bloom strength, grain size, and speed can exceed sliders.
function normalizePostProcessingValue(name, value) {
  if (!Number.isFinite(value) || !Number.isFinite(Math.fround(value))) return null;
  if (name.endsWith("Opacity") || ["noiseStrength", "vignetteStrength", "vignetteRadius", "bloomRadius"].includes(name)) {
    return THREE.MathUtils.clamp(value, 0, 1);
  }
  if (name === "colorSaturation" || name === "colorBrightness") return THREE.MathUtils.clamp(value, -1, 1);
  if (name === "colorHue") return value;
  if (name === "noiseSize") return Math.max(0.25, value);
  if (name === "vignetteSoftness") return THREE.MathUtils.clamp(value, 0.001, 1);
  return Math.max(0, value);
}

// Apply uniforms and skip whole passes when disabled, transparent, or mathematically neutral.
function updatePostProcessing() {
  const settings = postProcessingSettings;
  const toggles = postProcessingToggles;
  const film = noiseVignettePass.uniforms;
  film.noiseAmount.value = toggles.noiseEnabled ? settings.noiseStrength * settings.noiseOpacity : 0;
  film.noiseSize.value = settings.noiseSize;
  film.vignetteAmount.value = toggles.vignetteEnabled ? settings.vignetteStrength * settings.vignetteOpacity : 0;
  film.vignetteRadius.value = settings.vignetteRadius;
  film.vignetteSoftness.value = settings.vignetteSoftness;
  noiseVignettePass.enabled = film.noiseAmount.value > 0 || film.vignetteAmount.value > 0;

  bloomPass.strength = settings.bloomStrength * settings.bloomOpacity;
  bloomPass.radius = settings.bloomRadius;
  bloomPass.threshold = settings.bloomThreshold;
  bloomPass.enabled = toggles.bloomEnabled && bloomPass.strength > 0;
  // Bloom needs unclipped highlights. Restore the original buffer format when bloom is off.
  const textureType = bloomPass.enabled ? THREE.HalfFloatType : THREE.UnsignedByteType;
  for (const target of [composer.renderTarget1, composer.renderTarget2]) {
    if (target.texture.type !== textureType) {
      target.texture.type = textureType;
      target.dispose();
    }
  }

  const color = colorAdjustmentPass.uniforms;
  color.hue.value = THREE.MathUtils.degToRad(settings.colorHue % 360);
  color.saturation.value = settings.colorSaturation;
  color.brightness.value = settings.colorBrightness;
  color.opacity.value = settings.colorOpacity;
  colorAdjustmentPass.enabled = toggles.colorEnabled && settings.colorOpacity > 0
    && (color.hue.value !== 0 || settings.colorSaturation !== 0 || settings.colorBrightness !== 0);

  for (const [name, value] of Object.entries(settings)) {
    const unit = name === "colorHue" ? " deg" : name === "noiseSize" ? " px" : name === "noiseSpeed" ? "x" : "";
    controls[name].value = getSliderPosition(controls[name], value);
    controls[`${name}Value`].value = `${formatCompactValue(value)}${unit}`;
  }
  for (const [name, enabled] of Object.entries(toggles)) {
    controls[name].checked = enabled;
    controls[`${name}State`].textContent = enabled ? "On" : "Off";
  }
}

// SETTINGS UI: Reuse the existing slider, manual-entry, toggle, and collapsible styles.
function createZoomBehaviorControls() {
  const sliders = {
    modelSwitchDelay: ["switch delay", 1, 120, 1],
    rotationDelay: ["rotation delay", 0, 15, 0.1],
    rotationSpeed: ["rotation speed", 0, 30, 0.5],
    rotationAxisX: ["x rotation", -1, 1, 0.05],
    rotationAxisY: ["y rotation", -1, 1, 0.05],
    rotationAxisZ: ["z rotation", -1, 1, 0.05],
  };
  const groups = [
    [
      "Model Cycle",
      "modelCycleEnabled",
      "at max distance",
      "modelCycleStatus",
      ["modelSwitchDelay"],
    ],
    [
      "Proximity Rotation",
      "proximityRotationEnabled",
      "at min distance",
      "proximityRotationStatus",
      [
        "rotationDelay",
        "rotationSpeed",
        "rotationAxisX",
        "rotationAxisY",
        "rotationAxisZ",
      ],
    ],
  ];
  let previousGroup = document
    .querySelector("#cameraMaxDistance")
    .closest("details");
  const inputs = {};
  for (const [title, toggle, label, status, names] of groups) {
    const group = document.createElement("details");
    group.className = "settings-group";
    group.open = true;
    group.innerHTML = `
      <summary>${title}</summary>
      <div class="sensor-mode">
        <span>${label}</span>
        <label class="toggle">
          <input id="${toggle}" type="checkbox" role="switch" aria-label="Enable ${title}">
          <span id="${toggle}State">On</span>
        </label>
      </div>
      ${names
        .map((name) => {
          const [text, min, max, step] = sliders[name];
          return `
          <label class="control" for="${name}">
            <span>${text}
              <output id="${name}Value" class="editable-value" for="${name}" data-control="${name}" tabindex="0" aria-label="Set ${text} manually"></output>
            </span>
            <input id="${name}" type="range" min="${min}" max="${max}" step="${step}" value="${zoomBehaviorDefaults[name]}">
          </label>`;
        })
        .join("")}
      <p class="target sensor-status">
        <span>status</span><output id="${status}" aria-live="off"></output>
      </p>`;
    previousGroup.after(group);
    previousGroup = group;
    for (const id of [
      toggle,
      `${toggle}State`,
      status,
      ...names.flatMap((name) => [name, `${name}Value`]),
    ]) {
      inputs[id] = document.querySelector(`#${id}`);
    }
  }
  return inputs;
}

// Refresh stored event settings; live animation never overwrites the manual starting rotation.
function updateZoomBehaviorControls() {
  for (const [name, value] of Object.entries(zoomBehaviorSettings)) {
    const unit = name.endsWith("Delay")
      ? " s"
      : name === "rotationSpeed"
        ? " deg/s"
        : "x";
    controls[name].value = getSliderPosition(controls[name], value);
    controls[`${name}Value`].value = `${formatCompactValue(value)}${unit}`;
  }
  for (const [name, enabled] of Object.entries(zoomBehaviorToggles)) {
    controls[name].checked = enabled;
    controls[`${name}State`].textContent = enabled ? "On" : "Off";
  }
  updateZoomBehaviorReadouts();
}

// Show countdowns and activity without repeatedly announcing per-frame changes to screen readers.
function updateZoomBehaviorReadouts() {
  const state = zoomBehaviorState;
  let cycle = "Waiting for max";
  let rotation = "Waiting for min";
  if (!zoomBehaviorToggles.modelCycleEnabled) cycle = "Off";
  else if (modelLoading) cycle = "Loading model";
  else if (Object.keys(modelAssets).length < 2) cycle = "Single model";
  else if (state.atMax)
    cycle = `${Math.max(0, zoomBehaviorSettings.modelSwitchDelay - state.maxElapsed).toFixed(1)} s`;
  if (state.rotationPhase === "returning") rotation = "Returning to start";
  else if (!zoomBehaviorToggles.proximityRotationEnabled) rotation = "Off";
  else if (modelLoading) rotation = "Loading model";
  else if (state.rotationPhase === "rotating") rotation = "Rotating";
  else if (state.atMin)
    rotation = `${Math.max(0, zoomBehaviorSettings.rotationDelay - state.minElapsed).toFixed(1)} s`;
  if (controls.modelCycleStatus.value !== cycle)
    controls.modelCycleStatus.value = cycle;
  if (controls.proximityRotationStatus.value !== rotation)
    controls.proximityRotationStatus.value = rotation;
}

// Restart one or both arrival countdowns without interrupting an already-active rotation.
function resetZoomBehaviorTimers(boundary = "both") {
  if (boundary !== "min") {
    zoomBehaviorState.atMax = false;
    zoomBehaviorState.maxElapsed = 0;
  }
  if (boundary !== "max") {
    zoomBehaviorState.atMin = false;
    zoomBehaviorState.minElapsed = 0;
  }
}

// Reset only the animation offset, preserving the user's model position and starting angles.
function resetAnimatedRotation() {
  zoomBehaviorState.rotationOffset.identity();
  zoomBehaviorState.rotationPhase = "idle";
  zoomBehaviorState.returnElapsed = 0;
  applyModelRotation();
}

// Capture the current orientation for a smooth, shortest-path return to the starting angles.
// Reference: https://threejs.org/docs/pages/Quaternion.html#slerpQuaternions
function beginRotationReturn() {
  const state = zoomBehaviorState;
  if (state.rotationPhase !== "rotating") return;
  state.returnFrom.copy(state.rotationOffset);
  state.returnElapsed = 0;
  state.rotationPhase = "returning";
  state.minElapsed = 0;
}

// Cancel only an automatic load; keyboard selections always retain priority.
function cancelAutomaticModelSwitch() {
  if (!automaticModelRequest) return;
  modelRequestId++;
  automaticModelRequest = false;
  modelLoading = false;
  requestedModelKey = activeModelKey || "1";
  controls.targetValue.value = `${getActiveModelLabel()} focus`;
}

// Follow the registry order, including future entries; a failed asset cannot trap the queue.
function advanceModelQueue() {
  const keys = Object.keys(modelAssets);
  if (keys.length < 2) return;
  const index = keys.indexOf(requestedModelKey);
  void switchModel(keys[(index + 1) % keys.length], { automatic: true });
}

// ZOOM EVENTS: Use the same camera-to-orbit-target distance for mouse and sensor input.
// Reference: https://threejs.org/docs/pages/OrbitControls.html#getDistance
function updateZoomBehaviors(elapsedSeconds, deltaSeconds) {
  if (document.hidden) return;
  const state = zoomBehaviorState;
  if (!modelLoaded || modelLoading) {
    resetZoomBehaviorTimers();
    updateZoomBehaviorReadouts();
    return;
  }
  const min = cameraControls.minDistance;
  const max = cameraControls.maxDistance;
  const distance = cameraControls.getDistance();
  const span = max - min;
  const tolerance = Math.min(zoomArrivalTolerance, span * 0.05);
  const wasAtMax = state.atMax;
  const wasAtMin = state.atMin;
  // Slight hysteresis avoids restarting a timer because of tiny eased-motion fluctuations.
  state.atMax = span > 0 && distance >= max - tolerance * (wasAtMax ? 2 : 1);
  state.atMin = span > 0 && distance <= min + tolerance * (wasAtMin ? 2 : 1);

  if (
    zoomBehaviorToggles.modelCycleEnabled &&
    state.atMax &&
    Object.keys(modelAssets).length > 1
  ) {
    state.maxElapsed += wasAtMax ? elapsedSeconds : 0;
    if (state.maxElapsed >= zoomBehaviorSettings.modelSwitchDelay) {
      advanceModelQueue();
      updateZoomBehaviorReadouts();
      return;
    }
  } else state.maxElapsed = 0;

  let rotationDelta = deltaSeconds;
  if (
    !zoomBehaviorToggles.proximityRotationEnabled ||
    span <= 0 ||
    distance >= min + span / 2
  ) {
    state.minElapsed = 0;
    beginRotationReturn();
  } else if (state.rotationPhase === "idle" && state.atMin) {
    state.minElapsed += wasAtMin ? elapsedSeconds : 0;
    if (state.minElapsed >= zoomBehaviorSettings.rotationDelay) {
      state.rotationPhase = "rotating";
      rotationDelta = Math.min(
        deltaSeconds,
        state.minElapsed - zoomBehaviorSettings.rotationDelay,
      );
    }
  } else if (!state.atMin) state.minElapsed = 0;

  if (state.rotationPhase === "rotating") {
    rotationAxis.set(
      zoomBehaviorSettings.rotationAxisX,
      zoomBehaviorSettings.rotationAxisY,
      zoomBehaviorSettings.rotationAxisZ,
    );
    const amount = Math.hypot(rotationAxis.x, rotationAxis.y, rotationAxis.z);
    const angle =
      THREE.MathUtils.degToRad(zoomBehaviorSettings.rotationSpeed) *
      amount *
      rotationDelta;
    if (amount > 0 && Number.isFinite(angle)) {
      rotationAxis.divideScalar(amount);
      rotationStep.setFromAxisAngle(rotationAxis, angle % (Math.PI * 2));
      state.rotationOffset.multiply(rotationStep).normalize();
      applyModelRotation();
    }
  } else if (state.rotationPhase === "returning") {
    state.returnElapsed += deltaSeconds;
    const progress = Math.min(1, state.returnElapsed / rotationReturnSeconds);
    const eased = progress * progress * (3 - 2 * progress);
    state.rotationOffset.slerpQuaternions(
      state.returnFrom,
      rotationIdentity,
      eased,
    );
    if (progress === 1) resetAnimatedRotation();
    else applyModelRotation();
  }
  updateZoomBehaviorReadouts();
}

// Show the camera's current world X/Y/Z coordinates to two decimal places.
function updateCameraPositionControls() {
  for (const axis of ["x", "y", "z"]) {
    const output = controls[`camera${axis.toUpperCase()}Value`];
    const value = camera.position[axis].toFixed(2);
    if (output.value !== value) output.value = value;
  }
}

// Refresh connection controls, zoom mode, and the latest sensor distance in centimeters.
function updateSensorUI() {
  const canDisconnect =
    serialState.connectionWanted || serialState.port !== null;
  controls.connectSensor.textContent = canDisconnect
    ? "Disconnect Sensor"
    : serialState.busy
      ? serialState.status
      : "Connect Sensor";
  // Allow an intentional disconnect even while opening or waiting to retry.
  controls.connectSensor.disabled =
    !serialSupported || (!serialState.connectionWanted && serialState.busy);
  controls.sensorZoomEnabled.disabled = !serialState.connectionWanted;
  controls.sensorZoomState.textContent = controls.sensorZoomEnabled.checked
    ? "Sensor"
    : "Mouse";
  if (controls.sensorStatus.value !== serialState.status) {
    controls.sensorStatus.value = serialState.status;
  }
  controls.sensorDistanceValue.value =
    serialState.distanceCm === null
      ? "-- cm"
      : `${serialState.distanceCm.toFixed(1)} cm`;
  updateSensorDiagnostics();
}

// Show time since an actual message and total automatic reopen attempts for this connection.
function updateSensorDiagnostics() {
  const age =
    serialState.lastReadingAt === null
      ? "-- s"
      : `${Math.max(0, (performance.now() - serialState.lastReadingAt) / 1000).toFixed(1)} s`;
  if (controls.sensorLastMessageValue.value !== age)
    controls.sensorLastMessageValue.value = age;
  controls.sensorReconnectValue.value = String(serialState.reconnectAttempts);
}

// Switch between sensor and mouse zoom, clearing any pending sensor movement.
function updateSensorZoomMode() {
  zoomOutStartedAt = null;
  smoothedSensorTarget = null;
  cameraControls.enableZoom = !controls.sensorZoomEnabled.checked;
  updateSensorUI();
}

// USB CONNECTION: Ask for permission only on a user click; retries reuse this exact port.
async function toggleSerialConnection() {
  if (!serialSupported) return;
  if (serialState.connectionWanted || serialState.port) {
    await disconnectSerialSensor();
    return;
  }
  if (serialState.busy) return;

  serialState.busy = true;
  serialState.status = "Connecting...";
  updateSensorUI();

  try {
    const port = await navigator.serial.requestPort();
    serialState.selectedPort = port;
    serialState.connectionWanted = true;
    serialState.distanceCm = null;
    serialState.lastReadingAt = null;
    serialState.retryAttempt = 0;
    serialState.reconnectAttempts = 0;
    serialState.readTask = runSerialConnection(port);
  } catch (error) {
    serialState.status =
      error.name === "NotFoundError"
        ? "Disconnected"
        : "Cannot connect. Close Serial Monitor and retry.";
    if (error.name !== "NotFoundError")
      console.error("Serial connection failed", error);
  } finally {
    if (!serialState.connectionWanted) serialState.busy = false;
    updateSensorUI();
  }
}

// SERIAL LIFECYCLE: One task owns all open/read/close operations, preventing overlapping retries.
async function runSerialConnection(port) {
  let retry = false;
  try {
    while (serialState.connectionWanted) {
      if (retry) {
        await waitForSerialRetry();
        if (!serialState.connectionWanted) break;
        serialState.reconnectAttempts++;
      }
      serialState.busy = true;
      serialState.restartRequested = false;
      serialState.distanceCm = null;
      serialState.status = retry ? "Reconnecting..." : "Connecting...";
      updateSensorUI();
      try {
        // If a prior close failed, finish it before attempting another open.
        await closeSerialPort();
        if (!serialState.connectionWanted) break;
        await port.open({ baudRate: sensorZoomSettings.baudRate });
        serialState.port = port;
        if (!serialState.connectionWanted) break;
        serialState.openedAt = performance.now();
        serialState.busy = false;
        serialState.status = "Waiting for data";
        updateSensorUI();
        await readSerialSensor(port);
      } catch (error) {
        if (serialState.connectionWanted)
          console.warn("Sensor connection interrupted; retrying", error);
      } finally {
        serialState.busy = true;
        serialState.distanceCm = null;
        serialState.status = serialState.connectionWanted
          ? "Reconnecting..."
          : "Disconnecting...";
        updateSensorUI();
        try {
          await closeSerialPort();
        } catch (error) {
          console.warn(
            "Serial port close failed; will retry closing before reopening",
            error,
          );
        }
      }
      retry = true;
    }
  } finally {
    serialState.readTask = null;
    serialState.busy = false;
    serialState.restartRequested = false;
    if (!serialState.port) serialState.selectedPort = null;
    serialState.status = serialState.port
      ? "Close failed; retry Disconnect"
      : "Disconnected";
    updateSensorUI();
  }
}

// Back off after repeated failures; a recognized message resets the delay sequence.
async function waitForSerialRetry() {
  const delays = serialRecoverySettings.retryDelaysMs;
  const delay = delays[Math.min(serialState.retryAttempt++, delays.length - 1)];
  serialState.busy = false;
  serialState.nextRetryAt = performance.now() + delay;
  serialState.status = delay
    ? `Retrying in ${Math.ceil(delay / 1000)} s`
    : "Reconnecting...";
  updateSensorUI();
  if (delay === 0) return;
  await new Promise((resolve) => {
    serialState.retryResolve = resolve;
    serialState.retryTimer = setTimeout(cancelSerialRetry, delay);
  });
}

// Wake a pending retry wait immediately, including when Disconnect was clicked intentionally.
function cancelSerialRetry() {
  clearTimeout(serialState.retryTimer);
  serialState.retryTimer = null;
  serialState.nextRetryAt = 0;
  const resolve = serialState.retryResolve;
  serialState.retryResolve = null;
  if (resolve) resolve();
}

// Close only after the reader has released its lock; keep the port reference if cleanup fails.
async function closeSerialPort() {
  if (serialState.cancelTask) await serialState.cancelTask;
  const port = serialState.port;
  if (!port) return;
  try {
    await port.close();
  } catch (error) {
    if (error.name !== "InvalidStateError" || port.readable || port.writable)
      throw error;
  }
  serialState.port = null;
}

// Read newline-separated JSON until stopped; lifecycle cleanup owns closing and reopening.
async function readSerialSensor(port) {
  const decoder = new TextDecoder();
  let buffer = "";
  let reader;

  try {
    reader = port.readable.getReader();
    serialState.reader = reader;

    while (serialState.connectionWanted && !serialState.restartRequested) {
      const { value, done } = await reader.read();
      if (done || !serialState.connectionWanted || serialState.restartRequested)
        break;

      // USB chunks may contain part of a line or several complete readings.
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop();
      lines.forEach(handleSensorLine);
      if (buffer.length > 4096) buffer = "";
    }
  } finally {
    try {
      if (reader) reader.releaseLock();
    } finally {
      serialState.reader = null;
    }
  }
}

// Cancel a pending read so the lifecycle task can release the stream and close its port.
async function cancelSerialReader() {
  if (serialState.cancelTask) return serialState.cancelTask;
  const reader = serialState.reader;
  if (!reader) return;
  // Share one cancellation and let closeSerialPort() wait for it to finish.
  serialState.cancelTask = reader.cancel().catch((error) => {
    console.warn("Serial reader cancellation failed", error);
    // Releasing a failed reader also rejects any pending read instead of leaving it waiting.
    try {
      reader.releaseLock();
    } catch (releaseError) {
      console.warn("Serial reader release failed", releaseError);
    }
  });
  try {
    await serialState.cancelTask;
  } finally {
    serialState.cancelTask = null;
  }
}

// Stop automatic recovery first, then finish any in-flight open/read/close before disconnecting.
async function disconnectSerialSensor() {
  serialState.connectionWanted = false;
  cancelSerialRetry();
  serialState.busy = true;
  serialState.distanceCm = null;
  serialState.status = "Disconnecting...";
  controls.sensorZoomEnabled.checked = false;
  updateSensorZoomMode();
  await cancelSerialReader();
  if (serialState.readTask) await serialState.readTask;
  try {
    await closeSerialPort();
  } catch (error) {
    console.warn("Serial disconnect could not close the port", error);
  } finally {
    serialState.busy = false;
    if (!serialState.port) serialState.selectedPort = null;
    serialState.status = serialState.port
      ? "Close failed; retry Disconnect"
      : "Disconnected";
    updateSensorUI();
  }
}

// Ask the current read to end; the existing lifecycle task performs the restart exactly once.
function requestSerialRestart(reason) {
  if (
    !serialState.connectionWanted ||
    serialState.busy ||
    serialState.restartRequested
  )
    return;
  serialState.restartRequested = true;
  serialState.distanceCm = null;
  serialState.status = "Reconnecting...";
  console.warn(`Restarting sensor serial connection: ${reason}`);
  updateSensorUI();
  void cancelSerialReader();
}

// HEALTH CHECK: Count messages, not movement; valid:false is still a healthy heartbeat.
function monitorSerialConnection() {
  const now = performance.now();
  if (serialState.connectionWanted) {
    if (serialState.retryTimer !== null) {
      const seconds = Math.max(
        0,
        Math.ceil((serialState.nextRetryAt - now) / 1000),
      );
      serialState.status = `Retrying in ${seconds} s`;
      updateSensorUI();
    } else if (
      serialState.port &&
      serialState.reader &&
      !serialState.busy &&
      !serialState.restartRequested
    ) {
      // Give each newly opened port a full startup window, even after a long outage.
      const age =
        now -
        Math.max(
          serialState.openedAt,
          serialState.lastReadingAt ?? serialState.openedAt,
        );
      if (age > sensorZoomSettings.staleAfterMs) {
        serialState.distanceCm = null;
        serialState.status = "No data";
        updateSensorUI();
      }
      if (age >= serialRecoverySettings.silentAfterMs)
        requestSerialRestart("No data");
    }
  }
  updateSensorDiagnostics();
}

// Accept { valid, cm } readings from 2-400 cm; ignore non-sensor startup messages.
function handleSensorLine(line) {
  let reading;
  try {
    reading = JSON.parse(line.trim());
  } catch {
    return; // Ignore ESP32 startup messages and incomplete/garbled JSON.
  }
  if (
    !reading ||
    typeof reading.valid !== "boolean" ||
    (reading.valid && !Number.isFinite(reading.cm))
  )
    return;

  serialState.lastReadingAt = performance.now();
  serialState.retryAttempt = 0;
  const valid =
    reading.valid &&
    Number.isFinite(reading.cm) &&
    reading.cm >= 2 &&
    reading.cm <= 400;
  serialState.distanceCm = valid ? reading.cm : null;
  serialState.status = valid ? "Live" : "No valid echo";
  updateSensorUI();
}

// SENSOR ZOOM: Map centimeters to camera distance, then smooth and speed-limit movement.
// Outward motion uses the hold delay; missing readings request the far camera limit.
function applySensorZoom(now, deltaSeconds) {
  // Preserve the delayed return while reconnecting; missing data always targets the far limit.
  if (
    !modelLoaded ||
    !controls.sensorZoomEnabled.checked ||
    !serialState.connectionWanted
  ) {
    zoomOutStartedAt = null;
    smoothedSensorTarget = null;
    return;
  }

  const range = sensorZoomSettings.farCm - sensorZoomSettings.nearCm;
  // No echo or a silent stream requests a delayed return; unchanged valid readings remain active.
  const rawAmount =
    serialState.distanceCm === null
      ? 1
      : range === 0
        ? 0
        : THREE.MathUtils.clamp(
            (serialState.distanceCm - sensorZoomSettings.nearCm) / range,
            0,
            1,
          );
  const amount =
    1 -
    THREE.MathUtils.clamp(
      (1 - rawAmount) * Math.max(0, sensorZoomSettings.sensitivity),
      0,
      1,
    );
  const targetDistance = THREE.MathUtils.clamp(
    THREE.MathUtils.lerp(
      sensorZoomSettings.nearCameraDistance,
      sensorZoomSettings.farCameraDistance,
      amount,
    ),
    Math.max(camera.near * 2, cameraControls.minDistance),
    cameraControls.maxDistance,
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
    Math.max(currentDistance, targetDistance),
  );
  // Smooth the destination first, then ease the camera toward it each frame.
  const speed = Math.max(
    0,
    zoomingOut
      ? sensorZoomSettings.zoomOutSpeed
      : sensorZoomSettings.zoomInSpeed,
  );
  const motionDelta = deltaSeconds * speed;
  if (motionDelta <= 0) return;
  const targetBlend =
    sensorZoomSettings.targetSmoothingSeconds > 0
      ? 1 - Math.exp(-motionDelta / sensorZoomSettings.targetSmoothingSeconds)
      : 1;
  smoothedSensorTarget = THREE.MathUtils.lerp(
    smoothedSensorTarget,
    targetDistance,
    targetBlend,
  );
  const smoothingSeconds =
    smoothedSensorTarget > currentDistance
      ? sensorZoomSettings.zoomOutSmoothingSeconds
      : sensorZoomSettings.smoothingSeconds;
  const blend =
    smoothingSeconds > 0 ? 1 - Math.exp(-motionDelta / smoothingSeconds) : 1;
  const nextDistance = THREE.MathUtils.lerp(
    currentDistance,
    smoothedSensorTarget,
    blend,
  );
  const maxStep = Math.max(0, sensorZoomSettings.maxZoomSpeed) * motionDelta;
  const distance =
    currentDistance +
    THREE.MathUtils.clamp(nextDistance - currentDistance, -maxStep, maxStep);
  if (currentDistance === 0)
    camera.getWorldDirection(sensorCameraOffset).negate();
  sensorCameraOffset.setLength(distance);
  camera.position.copy(cameraControls.target).add(sensorCameraOffset);
}

// CLICK TO FOCUS: Raycast the active model and ease focus toward the clicked surface.
function onPointerDown(event) {
  if (event.target !== canvas) return;

  const rect = canvas.getBoundingClientRect();
  pointerCoords.set(
    ((event.clientX - rect.left) / rect.width) * 2 - 1,
    -((event.clientY - rect.top) / rect.height) * 2 + 1,
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

// Handle registered model keys and H for settings; leave text and numeric editing alone.
function onDocumentKeyDown(event) {
  const activeElement = document.activeElement;
  const activeTag = activeElement?.tagName.toLowerCase();
  const isTyping =
    activeElement?.isContentEditable ||
    ["textarea", "select"].includes(activeTag) ||
    (activeTag === "input" &&
      !["range", "checkbox", "radio"].includes(activeElement.type));

  if (
    isTyping ||
    event.repeat ||
    event.isComposing ||
    event.ctrlKey ||
    event.metaKey ||
    event.altKey
  )
    return;

  if (Object.prototype.hasOwnProperty.call(modelAssets, event.key)) {
    event.preventDefault();
    switchModel(event.key);
    return;
  }

  if (event.key.toLowerCase() !== "h") return;

  controls.panel.classList.toggle("is-hidden");
  controls.panel.setAttribute(
    "aria-hidden",
    controls.panel.classList.contains("is-hidden"),
  );
}

// Measure focus depth along the camera's view axis, not straight-line distance.
function getFocusDistance(point) {
  camera.updateMatrixWorld();
  const viewPoint = point.clone().applyMatrix4(camera.matrixWorldInverse);

  return -viewPoint.z;
}

// Keep the shader and live focus readout aligned with camera/target movement.
function updateFocusUniform() {
  const focus = getFocusDistance(focusPoint);

  dofPass.uniforms.focus.value = focus;
  applyCameraDistanceBlur(focus);
  controls.focusValue.value = focus.toFixed(2);
}

// Scale the base blur settings with camera distance without changing their stored values.
function applyCameraDistanceBlur(focus) {
  const multiplier = getCameraDistanceBlurMultiplier(focus);

  dofPass.uniforms.blurSize.value = Math.max(
    0,
    dofSettings.blurSize * multiplier,
  );
  dofPass.uniforms.blurSpread.value = Math.max(
    0,
    dofSettings.blurSpread * multiplier,
  );
}

// Smoothly blend near/far blur strengths from cameraDistanceBlurSettings.
function getCameraDistanceBlurMultiplier(focus) {
  if (!cameraDistanceBlurSettings.enabled) return 1;

  const range =
    cameraDistanceBlurSettings.farFocusDistance -
    cameraDistanceBlurSettings.nearFocusDistance;
  const rawAmount =
    range === 0
      ? 1
      : (focus - cameraDistanceBlurSettings.nearFocusDistance) / range;
  const amount = THREE.MathUtils.smoothstep(rawAmount, 0, 1);

  return THREE.MathUtils.lerp(
    cameraDistanceBlurSettings.nearBlurMultiplier,
    cameraDistanceBlurSettings.farBlurMultiplier,
    amount,
  );
}

// Replace any focus animation with a half-second transition to the selected point.
function tweenFocusTo(point) {
  TWEEN.removeAll();

  new TWEEN.Tween(focusPoint)
    .to({ x: point.x, y: point.y, z: point.z }, 500)
    .easing(TWEEN.Easing.Cubic.InOut)
    .onUpdate(updateTargetControls)
    .start();
}

// Stop animated focus and refresh the manually positioned target controls.
function updateTargetFromSliders() {
  TWEEN.removeAll();
  controls.targetValue.value = "manual target";
  updateTargetControls();
}

// Store a blur slider's numeric value and apply it to the DOF effect.
function updateDofSettingFromSlider(controlName) {
  dofSettings[controlName] = Number(controls[controlName].value);
  updateDof();
}

// Move one focus-target axis directly, overriding any focus animation.
function updateTargetAxisFromSlider(axis, input) {
  TWEEN.removeAll();
  focusPoint[axis] = Number(input.value);
  updateTargetFromSliders();
}

// Store a rotation slider value in degrees and update the active model.
function updateModelRotationFromSlider(controlName) {
  modelRotationSettings[controlName] = Number(controls[controlName].value);
  applyModelRotation();
  updateModelRotationControls();
}

// Refresh target X/Y/Z readouts; clamp only the slider thumbs, not the actual coordinates.
function updateTargetControls() {
  controls.targetX.value = getSliderPosition(controls.targetX, focusPoint.x);
  controls.targetY.value = getSliderPosition(controls.targetY, focusPoint.y);
  controls.targetZ.value = getSliderPosition(controls.targetZ, focusPoint.z);
  controls.targetXValue.value = focusPoint.x.toFixed(2);
  controls.targetYValue.value = focusPoint.y.toFixed(2);
  controls.targetZValue.value = focusPoint.z.toFixed(2);
}

// Refresh model rotation sliders and their degree readouts.
function updateModelRotationControls() {
  Object.keys(modelRotationControlAxes).forEach((controlName) => {
    controls[controlName].value = getSliderPosition(
      controls[controlName],
      modelRotationSettings[controlName],
    );
    controls[`${controlName}Value`].value =
      modelRotationSettings[controlName].toFixed(1);
  });
}

// Refresh model position sliders and their scene-unit readouts.
function updateModelPositionControls() {
  Object.keys(modelPositionControlAxes).forEach((controlName) => {
    controls[controlName].value = getSliderPosition(
      controls[controlName],
      modelPositionSettings[controlName],
    );
    controls[`${controlName}Value`].value =
      modelPositionSettings[controlName].toFixed(2);
  });
}

// Display the current sensor sensitivity multiplier.
function updateSensorCalibrationControl() {
  controls.sensorSensitivity.value = getSliderPosition(
    controls.sensorSensitivity,
    sensorZoomSettings.sensitivity,
  );
  controls.sensorSensitivityValue.value = `${sensorZoomSettings.sensitivity.toFixed(2)}x`;
}

// Display the independent inward and outward camera speed multipliers.
function updateSensorSpeedControls() {
  sensorSpeedControls.forEach((controlName) => {
    const value = sensorZoomSettings[controlName];
    controls[controlName].value = getSliderPosition(
      controls[controlName],
      value,
    );
    controls[`${controlName}Value`].value = `${value.toFixed(2)}x`;
  });
}

// Display the stored millisecond hold delay in seconds.
function updateSensorDelayControl() {
  const seconds = sensorZoomSettings.zoomOutHoldMs / 1000;
  controls.zoomOutDelay.value = getSliderPosition(
    controls.zoomOutDelay,
    seconds,
  );
  controls.zoomOutDelayValue.value = `${seconds.toFixed(2)} s`;
}

// ZOOM LIMITS: Apply shared sensor/mouse distance bounds and refresh camera readouts.
function updateCameraZoomLimits() {
  resetZoomBehaviorTimers();
  cameraControls.minDistance = sensorZoomSettings.nearCameraDistance;
  cameraControls.maxDistance = sensorZoomSettings.farCameraDistance;
  // Manual values can exceed the sliders; keep distant models inside the clipping plane.
  camera.far = Math.max(
    defaultCameraFar,
    cameraControls.maxDistance * 1.1 + modelTargetSize,
  );
  camera.updateProjectionMatrix();
  cameraControls.update();
  smoothedSensorTarget = null;

  Object.entries(cameraZoomControls).forEach(([controlName, settingName]) => {
    const value = sensorZoomSettings[settingName];
    controls[controlName].value = getSliderPosition(
      controls[controlName],
      value,
    );
    controls[`${controlName}Value`].value = value.toFixed(2);
  });
  updateCameraPositionControls();
  updateFocusUniform();
}

// Position DOF slider thumbs without truncating manually entered setting values.
function syncDofSliders() {
  Object.keys(dofSettingDefaults).forEach((controlName) => {
    controls[controlName].value = getSliderPosition(
      controls[controlName],
      dofSettings[controlName],
    );
  });
}

// MANUAL ENTRY: Open the shared numeric editor without the slider's min/max restrictions.
function openValueEditor(controlName) {
  const output = controls[`${controlName}Value`];

  activeManualControl = controlName;
  controls.valueEditorLabel.textContent = output.parentElement.textContent
    .replace(output.textContent, "")
    .trim();
  controls.manualValue.removeAttribute("min");
  controls.manualValue.removeAttribute("max");
  controls.manualValue.step = "any";
  controls.manualValue.value = getActualControlValue(controlName);
  controls.valueEditor.hidden = false;
  controls.manualValue.focus();
  controls.manualValue.select();
}

// Validate and apply the submitted number, then close the editor.
function applyManualValue(event) {
  event.preventDefault();

  if (!activeManualControl) return;

  const nextValue = parseManualValue(controls.manualValue.value);

  if (nextValue === null) return;

  setActualControlValue(activeManualControl, nextValue);

  closeValueEditor();
}

// Hide the numeric editor and clear its active setting.
function closeValueEditor() {
  controls.valueEditor.hidden = true;
  activeManualControl = null;
}

// Convert input to a finite number; return null for invalid or infinite values.
function parseManualValue(value) {
  const rawValue = Number(value);

  return Number.isFinite(rawValue) ? rawValue : null;
}

// Read a setting's stored value rather than its potentially clamped slider value.
function getActualControlValue(controlName) {
  const targetAxis = targetControlAxes[controlName];

  if (Object.hasOwn(postProcessingSettings, controlName)) return postProcessingSettings[controlName];
  if (Object.hasOwn(zoomBehaviorSettings, controlName))
    return zoomBehaviorSettings[controlName];
  if (targetAxis) return focusPoint[targetAxis];
  if (controlName === "sensorSensitivity")
    return sensorZoomSettings.sensitivity;
  if (controlName === "zoomOutDelay")
    return sensorZoomSettings.zoomOutHoldMs / 1000;
  if (Object.prototype.hasOwnProperty.call(cameraZoomControls, controlName)) {
    return sensorZoomSettings[cameraZoomControls[controlName]];
  }
  if (sensorSpeedControls.includes(controlName))
    return sensorZoomSettings[controlName];
  if (
    Object.prototype.hasOwnProperty.call(modelPositionControlAxes, controlName)
  )
    return modelPositionSettings[controlName];
  if (isModelRotationControl(controlName))
    return modelRotationSettings[controlName];

  return dofSettings[controlName];
}

// SETTINGS ROUTER: Store a slider/manual edit and update the matching scene controls.
// Camera limits stay positive and ordered; other manual values can exceed slider ranges.
function setActualControlValue(controlName, value) {
  const targetAxis = targetControlAxes[controlName];

  if (Object.hasOwn(postProcessingSettings, controlName)) {
    const normalized = normalizePostProcessingValue(controlName, value);
    if (normalized === null) return;
    postProcessingSettings[controlName] = normalized;
    updatePostProcessing();
    return;
  }

  if (Object.hasOwn(zoomBehaviorSettings, controlName)) {
    // Delays stay nonnegative; the short cycle floor prevents an immediate loading loop.
    if (controlName === "modelSwitchDelay") value = Math.max(0.1, value);
    if (controlName === "rotationDelay") value = Math.max(0, value);
    zoomBehaviorSettings[controlName] = value;
    if (controlName === "modelSwitchDelay") resetZoomBehaviorTimers("max");
    if (controlName === "rotationDelay") resetZoomBehaviorTimers("min");
    updateZoomBehaviorControls();
    return;
  }

  if (Object.prototype.hasOwnProperty.call(cameraZoomControls, controlName)) {
    const distance = Math.max(camera.near * 2, value);
    if (controlName === "cameraMinDistance") {
      sensorZoomSettings.nearCameraDistance = distance;
      sensorZoomSettings.farCameraDistance = Math.max(
        sensorZoomSettings.farCameraDistance,
        distance,
      );
    } else {
      sensorZoomSettings.farCameraDistance = distance;
      sensorZoomSettings.nearCameraDistance = Math.min(
        sensorZoomSettings.nearCameraDistance,
        distance,
      );
    }
    updateCameraZoomLimits();
    return;
  }

  if (controlName === "zoomOutDelay") {
    sensorZoomSettings.zoomOutHoldMs = value * 1000;
    updateSensorDelayControl();
    return;
  }

  if (sensorSpeedControls.includes(controlName)) {
    sensorZoomSettings[controlName] = value;
    updateSensorSpeedControls();
    return;
  }

  if (controlName === "sensorSensitivity") {
    sensorZoomSettings.sensitivity = value;
    zoomOutStartedAt = null;
    smoothedSensorTarget = null;
    updateSensorCalibrationControl();
    return;
  }

  if (
    Object.prototype.hasOwnProperty.call(modelPositionControlAxes, controlName)
  ) {
    modelPositionSettings[controlName] = value;
    applyModelPosition();
    updateModelPositionControls();
    return;
  }

  if (targetAxis) {
    TWEEN.removeAll();
    focusPoint[targetAxis] = value;
    controls.targetValue.value = "manual target";
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

// Identify controls belonging to the model's X/Y/Z rotation settings.
function isModelRotationControl(controlName) {
  return Object.prototype.hasOwnProperty.call(
    modelRotationControlAxes,
    controlName,
  );
}

// Apply the manual starting angles plus a separate, temporary animation offset.
function applyModelRotation() {
  modelRoot.rotation.set(
    THREE.MathUtils.degToRad(modelRotationSettings.modelRotationX),
    THREE.MathUtils.degToRad(modelRotationSettings.modelRotationY),
    THREE.MathUtils.degToRad(modelRotationSettings.modelRotationZ),
  );
  modelRoot.quaternion.multiply(zoomBehaviorState.rotationOffset);
  modelRoot.updateMatrixWorld(true);
}

// Move the model container and focus point together, then refresh focus-target bounds.
function applyModelPosition() {
  const nextPosition = new THREE.Vector3(
    modelPositionSettings.modelPositionX,
    modelPositionSettings.modelPositionY,
    modelPositionSettings.modelPositionZ,
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

// Clamp a slider's displayed position while leaving the stored setting unchanged.
function getSliderPosition(input, value) {
  const min = Number(input.min);
  const max = Number(input.max);

  return THREE.MathUtils.clamp(value, min, max);
}

// Show whole numbers without decimals and fractional values with two decimal places.
function formatCompactValue(value) {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

// Fit target X/Y/Z slider ranges around the active model's world-space bounds.
function updateTargetSliderRanges(box) {
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const axes = [
    ["x", controls.targetX],
    ["y", controls.targetY],
    ["z", controls.targetZ],
  ];

  axes.forEach(([axis, input]) => {
    const halfRange = Math.max(size[axis] * 0.65, 2.25);

    input.min = (center[axis] - halfRange).toFixed(2);
    input.max = (center[axis] + halfRange).toFixed(2);
  });
}

// Format the clicked surface name and world coordinates for the target readout.
function getTargetLabel(object, point) {
  const label = object.name || `${getActiveModelLabel()} surface`;

  return `${label} (${point.x.toFixed(2)}, ${point.y.toFixed(2)}, ${point.z.toFixed(2)})`;
}

// Return the selected model's readable name, or a fallback before loading completes.
function getActiveModelLabel() {
  return modelAssets[activeModelKey]?.label || "model";
}

// MODEL LOADING: Cache each GLB load, center it, and scale its largest side to modelTargetSize.
// Failed loads are removed from the cache so the same model key can retry.
function loadModel(key) {
  if (modelCache.has(key)) return modelCache.get(key);

  const asset = modelAssets[key];
  const loading = gltfLoader
    .loadAsync(asset.url, (event) => {
      if (
        requestedModelKey === key &&
        activeModelKey !== key &&
        event.total > 0
      ) {
        const percent = Math.round((event.loaded / event.total) * 100);
        controls.targetValue.value = `loading ${asset.label} ${percent}%`;
      }
    })
    .then((gltf) => {
      const bounds = new THREE.Box3().setFromObject(gltf.scene);
      const center = bounds.getCenter(new THREE.Vector3());
      const size = bounds.getSize(new THREE.Vector3());
      const largestSide = Math.max(size.x, size.y, size.z);
      if (!Number.isFinite(largestSide) || largestSide <= 0)
        throw new Error("Model has no usable bounds");

      // Normalize each asset locally; shared settings stay on modelRoot.
      const model = new THREE.Group();
      model.add(gltf.scene);
      const scale = modelTargetSize / largestSide;
      model.scale.setScalar(scale);
      model.position.copy(center).multiplyScalar(-scale);
      model.traverse((child) => {
        if (!child.isMesh) return;
        const materials = Array.isArray(child.material)
          ? child.material
          : [child.material];
        materials.forEach((material) => {
          if (material) material.side = THREE.DoubleSide;
        });
      });
      return model;
    })
    .catch((error) => {
      modelCache.delete(key);
      throw error;
    });
  modelCache.set(key, loading);
  return loading;
}

// MODEL SWITCHING: Show only the requested model while retaining shared scene settings.
// Keep the current model visible during loading; ignore results from superseded requests.
async function switchModel(key, { automatic = false } = {}) {
  if (!Object.prototype.hasOwnProperty.call(modelAssets, key)) return;

  const requestId = ++modelRequestId;
  requestedModelKey = key;
  automaticModelRequest = automatic;
  modelLoading = false;
  resetZoomBehaviorTimers();
  if (activeModelKey === key) {
    automaticModelRequest = false;
    resetAnimatedRotation();
    controls.targetValue.value = `${getActiveModelLabel()} focus`;
    return;
  }
  modelLoading = true;
  controls.targetValue.value = `loading ${modelAssets[key].label}`;

  try {
    const model = await loadModel(key);
    // Rapid key presses must activate only the most recently requested model.
    if (requestId !== modelRequestId) return;

    modelRoot.clear();
    modelRoot.add(model);
    resetAnimatedRotation();
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
  } finally {
    if (requestId === modelRequestId) {
      modelLoading = false;
      automaticModelRequest = false;
      resetZoomBehaviorTimers();
      updateZoomBehaviorReadouts();
    }
  }
}

renderer.setAnimationLoop(animate);
