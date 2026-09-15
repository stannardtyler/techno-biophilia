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
const focusTargets = [];
const initialFocusPoint = new THREE.Vector3();
const modelTargetSize = 4.5;
const modelCenterPosition = new THREE.Vector3(0, 0, 0);
// Change these defaults if you want Reset to return to different DOF values.
const dofSettingDefaults = {
  minDistance: 1,
  maxDistance: 3,
  blurSize: 2,
  blurSpread: 4
};
const modelBounds = new THREE.Box3();
const modelCenter = new THREE.Vector3();
const modelSize = new THREE.Vector3();
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
let focusPoint = new THREE.Vector3(0, 0, 0);

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

const controls = {
  panel: document.querySelector('.settings'),
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
  'targetZ'
];
const targetControlAxes = {
  targetX: 'x',
  targetY: 'y',
  targetZ: 'z'
};
let activeManualControl = null;

function updateDof() {
  dofPass.enabled = controls.enabled.checked;
  dofPass.uniforms.minDistance.value = dofSettings.minDistance;
  dofPass.uniforms.maxDistance.value = dofSettings.maxDistance;
  dofPass.uniforms.blurSize.value = dofSettings.blurSize;
  dofPass.uniforms.blurSpread.value = dofSettings.blurSpread;

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
  Object.assign(dofSettings, dofSettingDefaults);
  focusPoint.copy(initialFocusPoint);
  controls.targetValue.value = modelLoaded ? 'tree scan center' : 'model center';
  syncDofSliders();
  updateTargetControls();
  updateDof();
});
syncDofSliders();
updateTargetControls();
updateDof();
loadTreeScan();

canvas.addEventListener('pointerdown', onPointerDown);
document.addEventListener('keydown', onDocumentKeyDown);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
});

function animate() {
  TWEEN.update();
  cameraControls.update();
  updateFocusUniform();
  composer.render();
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
  const activeTag = document.activeElement.tagName.toLowerCase();
  const isTyping = ['input', 'textarea', 'select'].includes(activeTag);

  if (isTyping || event.key.toLowerCase() !== 'h') return;

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
  controls.focusValue.value = focus.toFixed(2);
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

function updateTargetControls() {
  controls.targetX.value = getSliderPosition(controls.targetX, focusPoint.x);
  controls.targetY.value = getSliderPosition(controls.targetY, focusPoint.y);
  controls.targetZ.value = getSliderPosition(controls.targetZ, focusPoint.z);
  controls.targetXValue.value = focusPoint.x.toFixed(2);
  controls.targetYValue.value = focusPoint.y.toFixed(2);
  controls.targetZValue.value = focusPoint.z.toFixed(2);
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

  return targetAxis ? focusPoint[targetAxis] : dofSettings[controlName];
}

function setActualControlValue(controlName, value) {
  const targetAxis = targetControlAxes[controlName];

  if (targetAxis) {
    TWEEN.removeAll();
    focusPoint[targetAxis] = value;
    controls.targetValue.value = 'manual target';
    updateTargetControls();
    return;
  }

  dofSettings[controlName] = value;
  syncDofSliders();
  updateDof();
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
  const label = object.name || 'tree scan surface';

  return `${label} (${point.x.toFixed(2)}, ${point.y.toFixed(2)}, ${point.z.toFixed(2)})`;
}

function loadTreeScan() {
  gltfLoader.load(
    './treeScan.glb',
    (gltf) => {
      const model = gltf.scene;
      const originalBounds = new THREE.Box3().setFromObject(model);

      originalBounds.getCenter(modelCenter);
      originalBounds.getSize(modelSize);

      const largestSide = Math.max(modelSize.x, modelSize.y, modelSize.z);
      const scale = largestSide > 0 ? modelTargetSize / largestSide : 1;

      model.scale.setScalar(scale);
      model.position.copy(modelCenter).multiplyScalar(-scale).add(modelCenterPosition);

      focusTargets.length = 0;
      model.traverse((child) => {
        if (child.isMesh) {
          focusTargets.push(child);

          if (Array.isArray(child.material)) {
            child.material.forEach((material) => {
              material.side = THREE.DoubleSide;
            });
          } else if (child.material) {
            child.material.side = THREE.DoubleSide;
          }
        }
      });

      modelRoot.add(model);
      modelRoot.updateMatrixWorld(true);
      modelBounds.setFromObject(modelRoot);
      modelBounds.getCenter(initialFocusPoint);

      focusPoint.copy(initialFocusPoint);
      cameraControls.target.copy(initialFocusPoint);
      cameraControls.update();
      updateTargetSliderRanges(modelBounds);
      updateTargetControls();
      updateFocusUniform();

      modelLoaded = true;
      controls.targetValue.value = 'tree scan center';
    },
    (event) => {
      if (event.total > 0) {
        const percent = Math.round((event.loaded / event.total) * 100);

        controls.targetValue.value = `loading ${percent}%`;
      }
    },
    (error) => {
      controls.targetValue.value = 'model load failed';
      console.error('Unable to load treeScan.glb', error);
    }
  );
}

renderer.setAnimationLoop(animate);
