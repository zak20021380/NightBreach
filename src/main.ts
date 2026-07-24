import './style.css'
import { type AnimationGroup } from '@babylonjs/core/Animations/animationGroup'
import { type AssetContainer } from '@babylonjs/core/assetContainer'
import { TargetCamera } from '@babylonjs/core/Cameras/targetCamera'
import { UniversalCamera } from '@babylonjs/core/Cameras/universalCamera'
import '@babylonjs/core/Collisions/collisionCoordinator'
import { Ray } from '@babylonjs/core/Culling/ray'
import { Engine } from '@babylonjs/core/Engines/engine'
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight'
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight'
import { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator'
import { ImageProcessingConfiguration } from '@babylonjs/core/Materials/imageProcessingConfiguration'
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial'
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial'
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture'
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color'
import { Frustum } from '@babylonjs/core/Maths/math.frustum'
import { Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector'
import { type AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh'
import '@babylonjs/core/Meshes/instancedMesh'
import { Mesh } from '@babylonjs/core/Meshes/mesh'
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder'
import { TransformNode } from '@babylonjs/core/Meshes/transformNode'
import { Scene } from '@babylonjs/core/scene'
import {
  ASSET_CONFIG,
  type AssetMaterialSettings,
  type Vector3Tuple,
} from './assets/assetConfig'
import {
  type AssetProgressSnapshot,
  LocalAssetManager,
} from './assets/localAssetManager'

function getElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector)
  if (!element) throw new Error(`Missing required element: ${selector}`)
  return element
}

const canvas = getElement<HTMLCanvasElement>('#renderCanvas')
const assetLoading = getElement<HTMLDivElement>('#assetLoading')
const assetLoadingLabel = getElement<HTMLSpanElement>('#assetLoadingLabel')
const assetLoadingProgress = getElement<HTMLProgressElement>('#assetLoadingProgress')
const ammoDisplay = getElement<HTMLDivElement>('#ammo')
const instructions = getElement<HTMLButtonElement>('#instructions')
const crosshair = getElement<HTMLDivElement>('#crosshair')
const hitMarker = getElement<HTMLDivElement>('#hitMarker')
const headshotIndicator = getElement<HTMLDivElement>('#headshotIndicator')
const damageIndicator = getElement<HTMLDivElement>('#damageIndicator')
const healthHud = getElement<HTMLDivElement>('#healthHud')
const healthValue = getElement<HTMLSpanElement>('#healthValue')
const healthFill = getElement<HTMLDivElement>('#healthFill')
const retryOverlay = getElement<HTMLDivElement>('#retryOverlay')
const retryButton = getElement<HTMLButtonElement>('#retryButton')
const lookArea = getElement<HTMLDivElement>('#lookArea')
const movementControl = getElement<HTMLDivElement>('#movementControl')
const joystickKnob = getElement<HTMLDivElement>('#joystickKnob')
const fireButton = getElement<HTMLButtonElement>('#fireButton')
const adsButton = getElement<HTMLButtonElement>('#adsButton')
const reloadButton = getElement<HTMLButtonElement>('#reloadButton')
const assetLoadingStartedAt = performance.now()
let assetLoadingHideTimer: number | undefined

function updateAssetLoadingIndicator(snapshot: AssetProgressSnapshot) {
  assetLoadingProgress.value = snapshot.ratio
  assetLoadingLabel.textContent = snapshot.completed === snapshot.total
    ? 'Local assets ready'
    : `Loading local assets ${snapshot.completed}/${snapshot.total}`

  if (snapshot.completed !== snapshot.total || snapshot.total === 0) return
  if (assetLoadingHideTimer !== undefined) return
  const minimumDisplayTime = Math.max(0, 450 - (performance.now() - assetLoadingStartedAt))
  assetLoadingHideTimer = window.setTimeout(() => {
    assetLoading.classList.add('complete')
    window.setTimeout(() => {
      assetLoading.hidden = true
    }, 200)
  }, minimumDisplayTime)
}
const isTouchDevice = navigator.maxTouchPoints > 0
  || window.matchMedia('(pointer: coarse)').matches
const isMobile = isTouchDevice || window.innerWidth < 768
const isDesktop = !isTouchDevice
  && window.matchMedia('(hover: hover) and (pointer: fine)').matches
const hardwareThreadCount = navigator.hardwareConcurrency || 4
const deviceMemoryGb = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 4
const isLowEndMobile = isMobile && (hardwareThreadCount <= 4 || deviceMemoryGb <= 4)

document.body.classList.toggle('touch-device', isTouchDevice)
canvas.dataset.performanceTier = isLowEndMobile ? 'mobile-low' : isMobile ? 'mobile' : 'desktop'
if (isTouchDevice) {
  instructions.innerHTML = 'Tap to deploy<br /><span>Left stick to move &middot; swipe to aim</span>'
}

const TOUCH_CONFIG = {
  lookSensitivity: 0.00215,
  adsLookSensitivityMultiplier: 0.72,
  joystickDeadZone: 0.08,
  automaticFireInterval: 0.1,
  hipFov: 72 * Math.PI / 180,
  adsFov: 56 * Math.PI / 180,
  hipSpread: 0.0035,
  adsSpread: 0.00075,
}

let gameReady = false
let deployed = false
let deployRequested = false
let gameOver = false
// Start active even when mobile Safari transiently reports `document.hidden`
// during module evaluation. A later visibilitychange/pagehide event remains the
// authority for pausing an actually backgrounded page.
let webViewActive = true
let startCameraControls: () => void = () => undefined
let stopCameraControls: () => void = () => undefined
let fireWeapon: () => void = () => undefined
let reloadWeapon: () => void = () => undefined
let equipWeapon: () => void = () => undefined
let cancelMobileInput: () => void = () => undefined
let stopZombieWaveTimers: () => void = () => undefined
let startZombieWave: () => void = () => undefined
let portraitInputPaused = isTouchDevice && window.innerHeight > window.innerWidth

function gameplayInputEnabled() {
  return gameReady && deployed && webViewActive && !portraitInputPaused && !gameOver
}

function updateOrientationState() {
  portraitInputPaused = isTouchDevice && window.innerHeight > window.innerWidth
  document.body.classList.toggle('portrait-blocked', portraitInputPaused)
  if (portraitInputPaused) cancelMobileInput()
}

function requestLandscapeSafely() {
  if (!isTouchDevice || !screen.orientation) return
  const orientation = screen.orientation as ScreenOrientation & {
    lock?: (orientation: string) => Promise<void>
  }
  if (typeof orientation.lock !== 'function') return
  try {
    void orientation.lock('landscape').catch((error: unknown) => {
      logRuntimeWarning('Landscape orientation lock was unavailable.', error)
    })
  } catch (error) {
    logRuntimeWarning('Landscape orientation lock request failed.', error)
  }
}

updateOrientationState()
window.addEventListener('orientationchange', updateOrientationState)
screen.orientation?.addEventListener('change', updateOrientationState)

if (import.meta.env.PROD) {
  document.addEventListener('contextmenu', (event) => event.preventDefault())
} else {
  console.info('[Night Breach][Debug] Development browser debugging enabled: context menu and DevTools shortcuts are available.')
}
document.addEventListener('dragstart', (event) => event.preventDefault())
document.addEventListener('dblclick', (event) => {
  if (isTouchDevice) event.preventDefault()
}, { passive: false })
document.addEventListener('gesturestart', (event) => {
  if (isTouchDevice) event.preventDefault()
}, { passive: false })

function describeRuntimeError(error: unknown) {
  if (error instanceof Error) return error.stack ?? `${error.name}: ${error.message}`
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

function logRuntimeError(context: string, error: unknown) {
  console.error(`[Night Breach] ${context}\n${describeRuntimeError(error)}`, error)
}

function logRuntimeWarning(context: string, error: unknown) {
  console.warn(`[Night Breach] ${context}\n${describeRuntimeError(error)}`, error)
}

function requestPointerLockSafely() {
  if (!isDesktop || document.pointerLockElement === canvas) return

  try {
    Promise.resolve(canvas.requestPointerLock()).catch((error: unknown) => {
      logRuntimeWarning('Pointer lock was unavailable; drag aiming remains active.', error)
    })
  } catch (error) {
    logRuntimeWarning('Pointer lock request failed; continuing without it.', error)
  }
}

function deployGame() {
  if (deployed) return
  if (!gameReady) {
    deployRequested = true
    console.info('[Night Breach][Deploy] Activation queued until scene initialization completes.')
    return
  }

  deployed = true
  deployRequested = false
  equipWeapon()
  document.body.classList.add('game-deployed')
  instructions.hidden = true
  instructions.setAttribute('aria-hidden', 'true')
  instructions.remove()
  startCameraControls()
  canvas.focus()
  requestLandscapeSafely()
  requestPointerLockSafely()
  startZombieWave()
  console.info(`[Night Breach][Deploy] Active with ${isTouchDevice ? 'mobile' : 'desktop'} controls.`)
}

instructions.addEventListener('click', () => {
  console.info('[Night Breach][Deploy] Click received.')
  deployGame()
})
instructions.addEventListener('pointerup', (event) => {
  if (event.pointerType === 'mouse') return
  event.preventDefault()
  console.info(`[Night Breach][Deploy] ${event.pointerType || 'touch'} activation received.`)
  deployGame()
}, { passive: false })

canvas.addEventListener('pointerdown', (event) => {
  if (!isDesktop || !gameplayInputEnabled() || event.button !== 0) return
  requestPointerLockSafely()
  fireWeapon()
})

window.addEventListener('keydown', (event) => {
  const isDevToolsShortcut = event.key === 'F12'
    || (event.ctrlKey && event.shiftKey && (event.code === 'KeyI' || event.code === 'KeyJ'))
  if (isDevToolsShortcut) return
  if (!isDesktop || !gameplayInputEnabled()) return
  if (event.code === 'KeyR' && !event.repeat) reloadWeapon()
  if (event.code === 'KeyR' || event.code.startsWith('Key')) event.preventDefault()
})

window.addEventListener('error', (event) => {
  logRuntimeError('Unhandled browser error:', event.error ?? event.message)
})

window.addEventListener('unhandledrejection', (event) => {
  logRuntimeError('Unhandled promise rejection:', event.reason)
})

try {
  console.info('[Night Breach][Scene] Startup started; creating the engine and gameplay scene.')

  let engine: Engine
  try {
    engine = new Engine(canvas, true, {
      preserveDrawingBuffer: false,
      stencil: false,
    })
  } catch (error) {
    logRuntimeWarning('Antialiased WebGL initialization failed; retrying safely.', error)
    engine = new Engine(canvas, false, {
      preserveDrawingBuffer: false,
      stencil: false,
    })
  }

  try {
    engine.setHardwareScalingLevel(isLowEndMobile ? 1.45 : isMobile ? 1.2 : 1)
  } catch (error) {
    logRuntimeWarning('Device render scaling was unavailable; using the engine default.', error)
  }

  const scene = new Scene(engine)
const localAssetManager = new LocalAssetManager(
  scene,
  ASSET_CONFIG.assets,
  updateAssetLoadingIndicator,
)
scene.clearColor = new Color4(0.56, 0.63, 0.65, 1)
scene.collisionsEnabled = true
scene.gravity = new Vector3(0, -0.24, 0)
scene.fogEnabled = true
scene.fogMode = Scene.FOGMODE_LINEAR
scene.fogStart = 38
scene.fogEnd = 88
scene.fogColor = new Color3(0.56, 0.63, 0.65)
try {
  scene.imageProcessingConfiguration.exposure = 1.12
  scene.imageProcessingConfiguration.contrast = 1.05
  scene.imageProcessingConfiguration.toneMappingEnabled = true
  scene.imageProcessingConfiguration.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_ACES
} catch (error) {
  logRuntimeWarning('Image processing enhancements were skipped.', error)
}
scene.skipPointerMovePicking = true

const camera = new UniversalCamera('playerCamera', new Vector3(0, 1.7, -18), scene)
const PLAYER_START_POSITION = camera.position.clone()
const PLAYER_START_TARGET = new Vector3(0, PLAYER_START_POSITION.y, 0)
camera.minZ = 0.05
camera.maxZ = 100
camera.fov = TOUCH_CONFIG.hipFov
camera.speed = 0.32
camera.inertia = 0.18
camera.angularSensibility = 3400
camera.applyGravity = true
camera.checkCollisions = true
camera.ellipsoid = new Vector3(0.45, 0.85, 0.45)
camera.ellipsoidOffset = new Vector3(0, -0.85, 0)
camera.keysUp = [87]
camera.keysDown = [83]
camera.keysLeft = [65]
camera.keysRight = [68]
camera.setTarget(PLAYER_START_TARGET)
scene.activeCamera = camera
console.info(
  `[Night Breach][Camera] Ready at (${camera.position.x.toFixed(1)}, ${camera.position.y.toFixed(1)}, ${camera.position.z.toFixed(1)}), facing the map center.`,
)
startCameraControls = () => {
  if (!isDesktop) {
    canvas.dataset.controlsAttached = 'mobile'
    return
  }
  try {
    camera.attachControl(canvas, true)
    canvas.dataset.controlsAttached = 'true'
  } catch (error) {
    logRuntimeError('Camera controls could not be attached:', error)
  }
}
stopCameraControls = () => {
  if (!isDesktop) return
  try {
    camera.detachControl()
    canvas.dataset.controlsAttached = 'false'
  } catch (error) {
    logRuntimeError('Camera controls could not be detached:', error)
  }
}

const PLAYER_MAX_HEALTH = 100
let playerHealth = PLAYER_MAX_HEALTH
let damageIndicatorTimer: number | undefined

function updateHealthDisplay() {
  const healthPercent = playerHealth / PLAYER_MAX_HEALTH * 100
  healthValue.textContent = String(playerHealth)
  healthFill.style.width = `${healthPercent}%`
  healthHud.setAttribute('aria-valuenow', String(playerHealth))
  healthHud.classList.toggle('critical', playerHealth <= 30)
}

function damagePlayer(amount: number, attackerPosition: Vector3) {
  if (gameOver || playerHealth <= 0) return

  const attackerYaw = Math.atan2(
    attackerPosition.x - camera.position.x,
    attackerPosition.z - camera.position.z,
  )
  const relativeYaw = Math.atan2(
    Math.sin(attackerYaw - camera.rotation.y),
    Math.cos(attackerYaw - camera.rotation.y),
  )

  playerHealth = Math.max(0, playerHealth - amount)
  updateHealthDisplay()

  damageIndicator.style.setProperty('--damage-angle', `${relativeYaw}rad`)
  damageIndicator.classList.remove('visible')
  void damageIndicator.offsetWidth
  damageIndicator.classList.add('visible')
  if (damageIndicatorTimer !== undefined) window.clearTimeout(damageIndicatorTimer)
  damageIndicatorTimer = window.setTimeout(hideDamageIndicator, 360)

  // A restrained impulse gives the hit weight without disorienting aim.
  camera.cameraRotation.x -= 0.006
  camera.cameraRotation.y += clamp(Math.sin(relativeYaw) * 0.006, -0.006, 0.006)

  if (playerHealth > 0) return

  gameOver = true
  stopZombieWaveTimers()
  cancelMobileInput()
  stopAutomaticFire()
  releaseAds()
  reloadElapsed = -1
  reloadButton.disabled = true
  muzzleFlashRemaining = 0
  muzzleFlash.isVisible = false
  stopCameraControls()
  document.body.classList.add('game-over')
  retryOverlay.setAttribute('aria-hidden', 'false')
  try {
    document.exitPointerLock()
  } catch (error) {
    logRuntimeWarning('Pointer-lock exit was unavailable after game over.', error)
  }
  window.setTimeout(focusRetryButton, 0)
}

function hideDamageIndicator() {
  damageIndicator.classList.remove('visible')
}

function focusRetryButton() {
  retryButton.focus()
}

updateHealthDisplay()

const skyLight = new HemisphericLight('overcastSkyLight', new Vector3(0, 1, 0), scene)
skyLight.intensity = 1.08
skyLight.diffuse = new Color3(0.91, 0.94, 0.93)
skyLight.specular = new Color3(0.2, 0.22, 0.21)
skyLight.groundColor = new Color3(0.38, 0.42, 0.36)

const sunLight = new DirectionalLight('sunLight', new Vector3(-0.55, -1, 0.35), scene)
sunLight.position = new Vector3(22, 35, -24)
sunLight.intensity = 1.35
sunLight.diffuse = new Color3(1, 0.96, 0.87)
sunLight.specular = new Color3(0.38, 0.36, 0.3)
sunLight.autoCalcShadowZBounds = true

const enableSoftShadows = !isLowEndMobile && (!isMobile || hardwareThreadCount >= 6)
let shadowGenerator: ShadowGenerator | null = null

if (enableSoftShadows) {
  try {
    shadowGenerator = new ShadowGenerator(isMobile ? 512 : 1024, sunLight)
    shadowGenerator.usePercentageCloserFiltering = true
    shadowGenerator.filteringQuality = ShadowGenerator.QUALITY_LOW
    shadowGenerator.bias = 0.0015
    shadowGenerator.normalBias = 0.025
  } catch (error) {
    shadowGenerator?.dispose()
    shadowGenerator = null
    logRuntimeWarning('Soft shadows were disabled after initialization failed.', error)
  }
}

type SurfaceMaterial = PBRMaterial | StandardMaterial
const NO_EMISSIVE_COLOR = Color3.Black()

function createMaterial(
  name: string,
  color: Color3,
  roughness: number,
  metallic = 0,
): SurfaceMaterial {
  try {
    const material = new PBRMaterial(name, scene)
    material.albedoColor = color.clone()
    material.roughness = roughness
    material.metallic = metallic
    material.environmentIntensity = 0.45
    return material
  } catch (error) {
    logRuntimeWarning(`PBR material "${name}" failed; using a standard fallback.`, error)
    const fallback = new StandardMaterial(`${name}Fallback`, scene)
    fallback.diffuseColor = color.clone()
    fallback.specularColor = metallic > 0.5
      ? new Color3(0.28, 0.28, 0.26)
      : new Color3(0.04, 0.04, 0.04)
    return fallback
  }
}

function setMaterialColor(
  material: SurfaceMaterial,
  color: Color3,
  emissive = NO_EMISSIVE_COLOR,
) {
  if (material instanceof PBRMaterial) {
    material.albedoColor.copyFrom(color)
  } else {
    material.diffuseColor.copyFrom(color)
  }
  material.emissiveColor.copyFrom(emissive)
}

function vector3FromTuple(value: Vector3Tuple) {
  return new Vector3(value[0], value[1], value[2])
}

function applyImportedMaterialSettings(
  meshes: readonly AbstractMesh[],
  settings: AssetMaterialSettings,
) {
  const materials = new Set(meshes.map((mesh) => mesh.material).filter((material) => material !== null))
  for (const material of materials) {
    if (settings.mode === 'source') {
      if (material instanceof PBRMaterial) {
        const isTransparentDetail = material.alpha < 0.999
          || /glass|lens|optic|scope/i.test(material.name)
        if (!isTransparentDetail && settings.minimumRoughness !== undefined) {
          material.roughness = Math.max(
            material.roughness ?? settings.minimumRoughness,
            settings.minimumRoughness,
          )
        }
        if (settings.maximumEnvironmentIntensity !== undefined) {
          material.environmentIntensity = Math.min(
            material.environmentIntensity,
            settings.maximumEnvironmentIntensity,
          )
        }
      }
      continue
    }

    if (settings.alpha !== undefined) material.alpha = settings.alpha
    if (settings.backFaceCulling !== undefined) {
      material.backFaceCulling = settings.backFaceCulling
    }

    if (material instanceof PBRMaterial) {
      if (settings.albedoColor) material.albedoColor = Color3.FromHexString(settings.albedoColor)
      if (settings.emissiveColor) material.emissiveColor = Color3.FromHexString(settings.emissiveColor)
      if (settings.roughness !== undefined) material.roughness = settings.roughness
      if (settings.metallic !== undefined) material.metallic = settings.metallic
      if (settings.environmentIntensity !== undefined) {
        material.environmentIntensity = settings.environmentIntensity
      }
    } else if (material instanceof StandardMaterial) {
      if (settings.albedoColor) material.diffuseColor = Color3.FromHexString(settings.albedoColor)
      if (settings.emissiveColor) material.emissiveColor = Color3.FromHexString(settings.emissiveColor)
      if (settings.roughness !== undefined) {
        material.specularPower = Math.max(1, (1 - settings.roughness) * 128)
      }
    }
  }
}

const concreteMaterial = createMaterial(
  'roughConcrete',
  Color3.FromHexString('#73776f'),
  0.96,
)
const groundMaterial = createMaterial(
  'compactedGround',
  Color3.FromHexString('#596153'),
  0.98,
)
const wornBrownMaterial = createMaterial(
  'wornBrownWood',
  Color3.FromHexString('#6a5238'),
  0.93,
  0.02,
)
const sandbagMaterial = createMaterial(
  'weatheredCanvas',
  Color3.FromHexString('#81765e'),
  1,
)
const darkMetalMaterial = createMaterial(
  'darkOxidizedMetal',
  Color3.FromHexString('#252b29'),
  0.7,
  0.72,
)

const proceduralEnvironmentMeshes: AbstractMesh[] = []

function prepareWorldMesh(
  mesh: Mesh,
  collisions = true,
  castsShadow = true,
  registerAsEnvironment = true,
) {
  mesh.checkCollisions = collisions
  mesh.receiveShadows = true
  if (castsShadow) shadowGenerator?.addShadowCaster(mesh)
  if (registerAsEnvironment) proceduralEnvironmentMeshes.push(mesh)
  return mesh
}

function createSharedMesh(source: Mesh, name: string) {
  try {
    const instance = source.createInstance(name)
    proceduralEnvironmentMeshes.push(instance)
    return instance
  } catch (error) {
    logRuntimeWarning(`Instancing "${name}" failed; using a shared clone.`, error)
    const clone = source.clone(name)
    if (!clone) throw new Error(`Could not create fallback mesh: ${name}`)
    proceduralEnvironmentMeshes.push(clone)
    return clone
  }
}

const ground = MeshBuilder.CreateGround('ground', { width: 52, height: 52 }, scene)
ground.material = groundMaterial
ground.checkCollisions = true
ground.receiveShadows = true
proceduralEnvironmentMeshes.push(ground)

function createWall(name: string, position: Vector3, width: number, depth: number) {
  const wall = MeshBuilder.CreateBox(name, { width, height: 4.4, depth }, scene)
  wall.position = position
  wall.material = concreteMaterial
  return prepareWorldMesh(wall)
}

createWall('northWall', new Vector3(0, 2.2, 26), 52, 0.8)
createWall('southWall', new Vector3(0, 2.2, -26), 52, 0.8)
createWall('eastWall', new Vector3(26, 2.2, 0), 0.8, 52)
createWall('westWall', new Vector3(-26, 2.2, 0), 0.8, 52)

const crateLayouts = [
  { position: new Vector3(-9, 1, -7), size: new Vector3(4, 2, 3) },
  { position: new Vector3(8, 1.5, -4), size: new Vector3(3, 3, 3) },
  { position: new Vector3(-13, 1.25, 8), size: new Vector3(5, 2.5, 3) },
  { position: new Vector3(10, 1, 10), size: new Vector3(6, 2, 2.5) },
  { position: new Vector3(0, 0.75, 4), size: new Vector3(2.5, 1.5, 4) },
  { position: new Vector3(17, 2, 1), size: new Vector3(2, 4, 5) },
]

const crateSource = MeshBuilder.CreateBox('crate1', { size: 1 }, scene)
crateSource.material = wornBrownMaterial
crateSource.position.copyFrom(crateLayouts[0].position)
crateSource.scaling.copyFrom(crateLayouts[0].size)
prepareWorldMesh(crateSource)

crateLayouts.slice(1).forEach(({ position, size }, index) => {
  const crate = createSharedMesh(crateSource, `crate${index + 2}`)
  crate.position.copyFrom(position)
  crate.scaling.copyFrom(size)
  crate.checkCollisions = true
  crate.receiveShadows = true
})

const pillarPositions = [
  new Vector3(-20, 2.25, -20),
  new Vector3(20, 2.25, -20),
  new Vector3(-20, 2.25, 20),
  new Vector3(20, 2.25, 20),
  new Vector3(-4, 2.25, 25.2),
  new Vector3(12, 2.25, 25.2),
]
const pillarSource = MeshBuilder.CreateBox('concretePillar1', { size: 1 }, scene)
pillarSource.material = concreteMaterial
pillarSource.position.copyFrom(pillarPositions[0])
pillarSource.scaling.set(1.15, 4.5, 1.15)
prepareWorldMesh(pillarSource)

pillarPositions.slice(1).forEach((position, index) => {
  const pillar = createSharedMesh(pillarSource, `concretePillar${index + 2}`)
  pillar.position.copyFrom(position)
  pillar.scaling.set(1.15, 4.5, 1.15)
  pillar.checkCollisions = true
  pillar.receiveShadows = true
})

const damagedWallLayouts = [
  { position: new Vector3(2.2, 1.45, 8.2), size: new Vector3(3.8, 2.9, 0.65), rotation: 0.05 },
  { position: new Vector3(5.5, 0.9, 8.3), size: new Vector3(2.6, 1.8, 0.65), rotation: 0.05 },
  { position: new Vector3(7.6, 0.55, 8.4), size: new Vector3(1.4, 1.1, 0.65), rotation: 0.05 },
  { position: new Vector3(-15.2, 1.5, -13), size: new Vector3(0.7, 3, 4.4), rotation: -0.12 },
  { position: new Vector3(-15, 0.65, -9.6), size: new Vector3(0.7, 1.3, 2.3), rotation: -0.12 },
]
const damagedWallSource = MeshBuilder.CreateBox('damagedWall1', { size: 1 }, scene)
damagedWallSource.material = concreteMaterial
damagedWallSource.position.copyFrom(damagedWallLayouts[0].position)
damagedWallSource.scaling.copyFrom(damagedWallLayouts[0].size)
damagedWallSource.rotation.y = damagedWallLayouts[0].rotation
prepareWorldMesh(damagedWallSource)

damagedWallLayouts.slice(1).forEach(({ position, size, rotation }, index) => {
  const wallPiece = createSharedMesh(damagedWallSource, `damagedWall${index + 2}`)
  wallPiece.position.copyFrom(position)
  wallPiece.scaling.copyFrom(size)
  wallPiece.rotation.y = rotation
  wallPiece.checkCollisions = true
  wallPiece.receiveShadows = true
})

const barrierLayouts = [
  { position: new Vector3(-4.5, 0, -12), rotation: 0.06 },
  { position: new Vector3(11.5, 0, -8), rotation: -0.28 },
  { position: new Vector3(-9, 0, 13), rotation: 0.2 },
  { position: new Vector3(14, 0, 15), rotation: -0.15 },
]
const barrierBase = MeshBuilder.CreateBox(
  'barrierBase1',
  { width: 3.6, height: 0.42, depth: 0.95 },
  scene,
)
barrierBase.material = concreteMaterial
barrierBase.position.set(
  barrierLayouts[0].position.x,
  0.21,
  barrierLayouts[0].position.z,
)
barrierBase.rotation.y = barrierLayouts[0].rotation
prepareWorldMesh(barrierBase)

const barrierTop = MeshBuilder.CreateBox(
  'barrierTop1',
  { width: 3.2, height: 0.72, depth: 0.48 },
  scene,
)
barrierTop.material = concreteMaterial
barrierTop.position.set(
  barrierLayouts[0].position.x,
  0.78,
  barrierLayouts[0].position.z,
)
barrierTop.rotation.y = barrierLayouts[0].rotation
prepareWorldMesh(barrierTop)

barrierLayouts.slice(1).forEach(({ position, rotation }, index) => {
  const base = createSharedMesh(barrierBase, `barrierBase${index + 2}`)
  base.position.set(position.x, 0.21, position.z)
  base.rotation.y = rotation
  base.checkCollisions = true
  base.receiveShadows = true

  const top = createSharedMesh(barrierTop, `barrierTop${index + 2}`)
  top.position.set(position.x, 0.78, position.z)
  top.rotation.y = rotation
  top.checkCollisions = true
  top.receiveShadows = true
})

const sandbagLayouts = [
  new Vector3(-20, 0.22, -7.8),
  new Vector3(-18.9, 0.22, -7.8),
  new Vector3(-17.8, 0.22, -7.8),
  new Vector3(-16.7, 0.22, -7.8),
  new Vector3(-19.45, 0.58, -7.8),
  new Vector3(-18.35, 0.58, -7.8),
  new Vector3(-17.25, 0.58, -7.8),
  new Vector3(11.8, 0.22, 4.8),
  new Vector3(12.9, 0.22, 4.65),
  new Vector3(14, 0.22, 4.5),
  new Vector3(15.1, 0.22, 4.35),
  new Vector3(12.4, 0.58, 4.7),
  new Vector3(13.5, 0.58, 4.55),
  new Vector3(14.6, 0.58, 4.4),
]
const sandbagSource = MeshBuilder.CreateSphere(
  'sandbag1',
  { diameter: 1, segments: 8 },
  scene,
)
sandbagSource.material = sandbagMaterial
sandbagSource.position.copyFrom(sandbagLayouts[0])
sandbagSource.scaling.set(1.18, 0.38, 0.52)
sandbagSource.rotation.y = 0.04
prepareWorldMesh(sandbagSource, false)

sandbagLayouts.slice(1).forEach((position, index) => {
  const sandbag = createSharedMesh(sandbagSource, `sandbag${index + 2}`)
  sandbag.position.copyFrom(position)
  sandbag.scaling.set(1.18, 0.38, 0.52)
  sandbag.rotation.y = index < 6 ? 0.04 : -0.14
  sandbag.receiveShadows = true
})

function createInvisibleCollider(
  name: string,
  position: Vector3,
  size: Vector3,
  rotationY = 0,
) {
  const collider = MeshBuilder.CreateBox(
    name,
    { width: size.x, height: size.y, depth: size.z },
    scene,
  )
  collider.position.copyFrom(position)
  collider.rotation.y = rotationY
  collider.visibility = 0
  collider.isPickable = false
  collider.checkCollisions = true
}

createInvisibleCollider(
  'westSandbagCollider',
  new Vector3(-18.35, 0.45, -7.8),
  new Vector3(4.8, 0.9, 0.75),
  0.04,
)
createInvisibleCollider(
  'eastSandbagCollider',
  new Vector3(13.45, 0.45, 4.55),
  new Vector3(4.8, 0.9, 0.75),
  -0.14,
)

canvas.dataset.mapReady = 'true'
console.info(
  `[Night Breach][Map] Procedural map ready (${proceduralEnvironmentMeshes.length} visible meshes plus gameplay colliders).`,
)

const ENVIRONMENT_ASSET_CONFIG = ASSET_CONFIG.assets.environment

async function initializeLocalEnvironment() {
  const result = await localAssetManager.load('environment')
  if (result.status === 'fallback') {
    canvas.dataset.environmentSource = 'procedural'
    console.info('[Night Breach] Environment source: existing procedural fallback active.')
    return
  }

  try {
    const entries = result.container.instantiateModelsToScene(
      (sourceName) => `environment_${sourceName}`,
      false,
      { doNotInstantiate: false },
    )
    const root = new TransformNode('localEnvironmentRoot', scene)
    for (const rootNode of entries.rootNodes) rootNode.parent = root
    root.position.copyFrom(vector3FromTuple(ENVIRONMENT_ASSET_CONFIG.transform.position))
    root.rotation.copyFrom(vector3FromTuple(ENVIRONMENT_ASSET_CONFIG.transform.rotation))
    root.scaling.copyFrom(vector3FromTuple(ENVIRONMENT_ASSET_CONFIG.transform.scale))

    const modelMeshes = root.getChildMeshes(false)
    if (modelMeshes.length === 0) {
      entries.dispose()
      root.dispose()
      throw new Error('The environment GLB did not instantiate any renderable meshes.')
    }

    for (const mesh of modelMeshes) {
      // Gameplay continues to use the existing map geometry and colliders. The
      // imported environment supplies production visuals only.
      mesh.isPickable = false
      mesh.checkCollisions = false
      mesh.receiveShadows = true
      if (!isLowEndMobile) shadowGenerator?.addShadowCaster(mesh)
    }
    applyImportedMaterialSettings(modelMeshes, ENVIRONMENT_ASSET_CONFIG.material)

    for (const animation of entries.animationGroups) {
      animation.speedRatio = ENVIRONMENT_ASSET_CONFIG.animation.speed
      if (ENVIRONMENT_ASSET_CONFIG.animation.autoplay) {
        animation.start(
          ENVIRONMENT_ASSET_CONFIG.animation.loop,
          ENVIRONMENT_ASSET_CONFIG.animation.speed,
        )
      }
    }

    for (const mesh of proceduralEnvironmentMeshes) {
      mesh.visibility = 0
      // Intentionally retain collision and picking behavior so cover, movement,
      // zombie steering, and bullet occlusion stay identical to the fallback map.
    }

    canvas.dataset.environmentSource = 'glb'
    console.info(
      `[Night Breach] Environment source: local GLB active (${modelMeshes.length} visual meshes); procedural collision layout preserved.`,
    )
  } catch (error) {
    canvas.dataset.environmentSource = 'procedural'
    logRuntimeWarning(
      'Environment source: existing procedural fallback active after GLB setup failed.',
      error,
    )
  }
}

canvas.dataset.environmentSource = 'procedural'
void initializeLocalEnvironment().catch((error) => {
  canvas.dataset.environmentSource = 'procedural'
  logRuntimeWarning('Environment source: procedural fallback active.', error)
})

interface TargetState {
  root: TransformNode
  meshes: Mesh[]
  material: SurfaceMaterial
  hits: number
  flashTimer?: number
}

const dummyColor = Color3.FromHexString('#696b50')
const dummyHitColor = Color3.White()
const dummyHitEmissive = new Color3(0.16, 0.16, 0.16)
const targets = new Map<Mesh, TargetState>()
const targetPositions = [
  new Vector3(-17, 0, -1),
  new Vector3(-7, 0, 16),
  new Vector3(4, 0, 19),
  new Vector3(16, 0, 16),
  new Vector3(18, 0, -13),
]

function createTrainingDummy(position: Vector3, index: number) {
  const root = new TransformNode(`trainingDummy${index}`, scene)
  root.position.copyFrom(position)
  const material = createMaterial(`dummyMaterial${index}`, dummyColor, 0.9, 0.04)
  const meshes: Mesh[] = []

  function addPart(mesh: Mesh, localPosition: Vector3) {
    mesh.parent = root
    mesh.position.copyFrom(localPosition)
    mesh.material = material
    prepareWorldMesh(mesh, true, true, false)
    meshes.push(mesh)
  }

  addPart(
    MeshBuilder.CreateSphere(`dummyHead${index}`, { diameter: 0.42, segments: 8 }, scene),
    new Vector3(0, 2.55, 0),
  )
  addPart(
    MeshBuilder.CreateBox(
      `dummyTorso${index}`,
      { width: 0.86, height: 1.18, depth: 0.34 },
      scene,
    ),
    new Vector3(0, 1.68, 0),
  )
  addPart(
    MeshBuilder.CreateBox(
      `dummyLeftLeg${index}`,
      { width: 0.25, height: 0.86, depth: 0.28 },
      scene,
    ),
    new Vector3(-0.23, 0.66, 0),
  )
  addPart(
    MeshBuilder.CreateBox(
      `dummyRightLeg${index}`,
      { width: 0.25, height: 0.86, depth: 0.28 },
      scene,
    ),
    new Vector3(0.23, 0.66, 0),
  )

  const state: TargetState = { root, meshes, material, hits: 0 }
  meshes.forEach((mesh) => targets.set(mesh, state))
}

targetPositions.forEach((position, index) => createTrainingDummy(position, index + 1))
canvas.dataset.trainingTargets = String(targetPositions.length)

type ZombieState = 'idle' | 'chasing' | 'attacking' | 'hit' | 'dead'
type ZombieAnimationName = 'idle' | 'walk' | 'run' | 'attack' | 'hit' | 'death'
type ZombieAnimationMap = Partial<Record<ZombieAnimationName, AnimationGroup>>

type ZombieAudioName = 'idle' | 'chase' | 'attack' | 'hit' | 'death'
type ZombieAudioHook = (zombieId: number) => void

// These no-op callbacks are intentional integration points for future local audio.
// They never create an Audio element, fetch a file, or fail when assets are absent.
const zombieAudioHooks: Readonly<Record<ZombieAudioName, ZombieAudioHook>> = {
  idle: () => undefined,
  chase: () => undefined,
  attack: () => undefined,
  hit: () => undefined,
  death: () => undefined,
}

function callZombieAudioHook(hook: ZombieAudioHook, zombieId: number) {
  try {
    hook(zombieId)
  } catch (error) {
    logRuntimeWarning(`Zombie ${zombieId} audio hook was skipped.`, error)
  }
}

function playZombieIdleSound(zombieId: number) {
  callZombieAudioHook(zombieAudioHooks.idle, zombieId)
}

function playZombieChaseSound(zombieId: number) {
  callZombieAudioHook(zombieAudioHooks.chase, zombieId)
}

function playZombieAttackSound(zombieId: number) {
  callZombieAudioHook(zombieAudioHooks.attack, zombieId)
}

function playZombieHitSound(zombieId: number) {
  callZombieAudioHook(zombieAudioHooks.hit, zombieId)
}

function playZombieDeathSound(zombieId: number) {
  callZombieAudioHook(zombieAudioHooks.death, zombieId)
}

interface ProceduralZombieParts {
  head: Mesh
  torso: Mesh
  leftArm: Mesh
  rightArm: Mesh
  leftLeg: Mesh
  rightLeg: Mesh
}

interface ZombieVisual {
  root: TransformNode
  animationGroups: AnimationGroup[]
  animations: ZombieAnimationMap
  proceduralParts: ProceduralZombieParts | null
  dispose: () => void
}

interface ZombieVisualFactory {
  readonly source: 'glb' | 'procedural'
  create: (name: string) => ZombieVisual
}

const ZOMBIE_ASSET_DEFINITION = ASSET_CONFIG.assets.zombie
const ZOMBIE_ASSET_CONFIG = {
  position: vector3FromTuple(ZOMBIE_ASSET_DEFINITION.transform.position),
  rotation: vector3FromTuple(ZOMBIE_ASSET_DEFINITION.transform.rotation),
  scale: vector3FromTuple(ZOMBIE_ASSET_DEFINITION.transform.scale),
  height: ZOMBIE_ASSET_DEFINITION.normalizedHeight,
  animationSpeed: ZOMBIE_ASSET_DEFINITION.animation.speed,
  material: ZOMBIE_ASSET_DEFINITION.material,
}

const ZOMBIE_AI_CONFIG = {
  detectionRange: 28,
  loseInterestRange: 32,
  attackDistance: 1.55,
  walkSpeed: 1.05,
  runSpeed: 1.55,
  runDistance: 10,
  rotationSpeed: 4.2,
  steeringResponse: 8,
  obstacleProbeDistance: 1.45,
  obstacleTurnAngle: 0.72,
  nearThinkInterval: 0.14,
  midThinkInterval: isMobile ? 0.3 : 0.24,
  farThinkInterval: isMobile ? 0.52 : 0.38,
  nearThinkDistance: 14,
  midThinkDistance: 24,
}

type ZombieHitZoneType = 'head' | 'torso' | 'limbs'

const ZOMBIE_COMBAT_CONFIG = {
  maxHealth: 100,
  headDamage: 65,
  torsoDamage: 34,
  limbDamage: 20,
  hitReactionDuration: 0.18,
  hitPushDistance: 0.045,
  headHitPushMultiplier: 1.35,
  attackDamage: 14,
  attackCooldown: 1.15,
  attackDuration: 0.82,
  attackDamageMoment: 0.43,
  fallbackDeathDuration: 0.95,
  corpseHoldDuration: 3.5,
}

const zombieHitZoneMaterial = new StandardMaterial('zombieHitZoneMaterial', scene)
zombieHitZoneMaterial.alpha = 0
zombieHitZoneMaterial.disableLighting = true
zombieHitZoneMaterial.disableColorWrite = true
zombieHitZoneMaterial.disableDepthWrite = true

interface BloodBurstSnapshot {
  activeParticles: number
  burstCount: number
  decalLimit: number
  activeDecals: number
  headshot: boolean
  origin: Vector3
  particleCount: number
  poolCapacity: number
}

type BloodLayer = 'splash' | 'spray' | 'mist'

interface BloodParticle {
  active: boolean
  age: number
  lifetime: number
  rotationSpeed: number
  startSize: number
  endSize: number
  drag: number
  gravity: number
  mesh: Mesh
  velocity: Vector3
}

interface BloodDecal {
  active: boolean
  age: number
  lifetime: number
  mesh: Mesh
}

class BloodEffectPool {
  private readonly particleMaterials: Record<BloodLayer, StandardMaterial[]>
  private readonly particles: BloodParticle[] = []
  private readonly decals: BloodDecal[] = []
  private readonly lastOrigin = Vector3.Zero()
  private readonly decalRay = new Ray(Vector3.Zero(), Vector3.Forward(), 8)
  private readonly decalNormal = Vector3.Forward()
  private readonly decalRotation = Quaternion.Identity()
  private readonly direction = Vector3.Forward()
  private readonly perpendicular = Vector3.Right()
  private readonly secondaryPerpendicular = Vector3.Up()
  private readonly decalCapacity: number
  private readonly particleCapacity: number
  private nextParticle = 0
  private nextDecal = 0
  private burstCount = 0
  private lastHeadshot = false
  private lastParticleCount = 0

  constructor() {
    this.particleCapacity = isLowEndMobile ? 96 : isMobile ? 128 : 192
    this.decalCapacity = isLowEndMobile ? 12 : isMobile ? 16 : 24
    this.particleMaterials = this.createMaterials()

    for (let index = 0; index < this.particleCapacity; index += 1) {
      const mesh = MeshBuilder.CreatePlane(`bloodParticle${index}`, { size: 1 }, scene)
      mesh.billboardMode = Mesh.BILLBOARDMODE_ALL
      mesh.isPickable = false
      mesh.receiveShadows = false
      mesh.renderingGroupId = 0
      mesh.visibility = 0
      this.particles.push({
        active: false,
        age: 0,
        lifetime: 0,
        rotationSpeed: 0,
        startSize: 0,
        endSize: 0,
        drag: 0,
        gravity: 0,
        mesh,
        velocity: Vector3.Zero(),
      })
    }

    for (let index = 0; index < this.decalCapacity; index += 1) {
      const mesh = MeshBuilder.CreatePlane(`bloodDecal${index}`, { size: 1 }, scene)
      mesh.isPickable = false
      mesh.receiveShadows = false
      mesh.renderingGroupId = 0
      mesh.rotationQuaternion = Quaternion.Identity()
      mesh.visibility = 0
      this.decals.push({ active: false, age: 0, lifetime: 0, mesh })
    }

    scene.onBeforeRenderObservable.add(() => this.update(Math.min(engine.getDeltaTime() / 1000, 0.05)))
  }

  spawn(hitPoint: Vector3, bulletDirection: Vector3, headshot: boolean) {
    this.lastOrigin.copyFrom(hitPoint)
    this.lastHeadshot = headshot
    this.burstCount += 1
    this.direction.copyFrom(bulletDirection)
    if (this.direction.lengthSquared() <= 0.000001) this.direction.copyFromFloats(0, 0, 1)
    this.direction.normalize()
    Vector3.CrossToRef(this.direction, Vector3.Up(), this.perpendicular)
    if (this.perpendicular.lengthSquared() < 0.001) this.perpendicular.copyFromFloats(1, 0, 0)
    else this.perpendicular.normalize()
    Vector3.CrossToRef(this.perpendicular, this.direction, this.secondaryPerpendicular)

    const countMultiplier = headshot ? 1.6 : 1
    const splashCount = Math.round(2 * countMultiplier)
    const sprayCount = Math.round(10 * countMultiplier)
    const mistCount = Math.round(5 * countMultiplier)
    this.lastParticleCount = splashCount + sprayCount + mistCount
    const splashScale = headshot ? 1.4 : 1
    for (let index = 0; index < splashCount; index += 1) {
      this.spawnParticle('splash', hitPoint, 0.10 * splashScale, 0.35 * splashScale, 0.12, 0.20,
        0, 0, 0, 0, 0)
    }
    for (let index = 0; index < sprayCount; index += 1) {
      const lateral = (Math.random() - 0.5) * 0.34
      const vertical = (Math.random() - 0.5) * 0.26
      const power = (headshot ? 3.8 : 2.65) + Math.random() * (headshot ? 2.2 : 1.65)
      this.spawnParticle('spray', hitPoint, 0.06, 0.13, 0.35, 0.70,
        this.direction.x * power + this.perpendicular.x * lateral + this.secondaryPerpendicular.x * vertical,
        this.direction.y * power + this.perpendicular.y * lateral + this.secondaryPerpendicular.y * vertical,
        this.direction.z * power + this.perpendicular.z * lateral + this.secondaryPerpendicular.z * vertical,
        5.7, 2.6)
    }
    for (let index = 0; index < mistCount; index += 1) {
      this.spawnParticle('mist', hitPoint, 0.18 * splashScale, 0.52 * splashScale, 0.15, 0.30,
        this.direction.x * 0.22, this.direction.y * 0.22, this.direction.z * 0.22, 0, 0.6)
    }
    this.spawnDecal(hitPoint)
  }

  reset() {
    for (let index = 0; index < this.particles.length; index += 1) this.deactivateParticle(this.particles[index])
    for (let index = 0; index < this.decals.length; index += 1) this.deactivateDecal(this.decals[index])
  }

  snapshot(): BloodBurstSnapshot {
    let activeParticles = 0
    let activeDecals = 0
    for (let index = 0; index < this.particles.length; index += 1) if (this.particles[index].active) activeParticles += 1
    for (let index = 0; index < this.decals.length; index += 1) if (this.decals[index].active) activeDecals += 1
    return {
      activeParticles,
      activeDecals,
      burstCount: this.burstCount,
      decalLimit: this.decalCapacity,
      headshot: this.lastHeadshot,
      origin: this.lastOrigin,
      particleCount: this.lastParticleCount,
      poolCapacity: this.particleCapacity,
    }
  }

  private createMaterials(): Record<BloodLayer, StandardMaterial[]> {
    const colors: Record<BloodLayer, readonly string[]> = {
      splash: ['#5c0508', '#7d0710', '#280103'],
      spray: ['#65050a', '#8d0812', '#320104'],
      mist: ['#4b0307', '#67060c', '#210102'],
    }
    const materials = { splash: [] as StandardMaterial[], spray: [] as StandardMaterial[], mist: [] as StandardMaterial[] }
    for (let variation = 0; variation < 5; variation += 1) {
      const texture = this.createBloodTexture(variation)
      for (const layer of ['splash', 'spray', 'mist'] as const) {
        const material = new StandardMaterial(`blood${layer}${variation}`, scene)
        material.diffuseTexture = texture
        material.diffuseColor = Color3.FromHexString(colors[layer][variation % colors[layer].length])
        material.emissiveColor = material.diffuseColor.scale(layer === 'mist' ? 0.15 : 0.07)
        material.disableLighting = true
        material.useAlphaFromDiffuseTexture = true
        material.transparencyMode = StandardMaterial.MATERIAL_ALPHABLEND
        material.alpha = layer === 'mist' ? 0.38 : layer === 'splash' ? 0.96 : 0.9
        material.backFaceCulling = false
        material.disableDepthWrite = true
        materials[layer].push(material)
      }
    }
    return materials
  }

  private createBloodTexture(variation: number) {
    const texture = new DynamicTexture(`bloodShape${variation}`, { width: 64, height: 64 }, scene, false)
    const context = texture.getContext()
    const center = 32
    const seed = variation * 19 + 7
    context.clearRect(0, 0, 64, 64)
    context.fillStyle = '#ffffff'
    context.beginPath()
    for (let point = 0; point < 14; point += 1) {
      const angle = point / 14 * Math.PI * 2
      const radius = 20 + ((seed + point * 11) % 15) - (point % 4 === 0 ? 7 : 0)
      const x = center + Math.cos(angle) * radius
      const y = center + Math.sin(angle) * radius * (0.72 + ((seed + point) % 4) * 0.08)
      if (point === 0) context.moveTo(x, y)
      else context.lineTo(x, y)
    }
    context.closePath()
    context.fill()
    for (let speck = 0; speck < 4; speck += 1) {
      const angle = (seed + speck * 83) * Math.PI / 180
      const distance = 20 + speck * 5
      context.beginPath()
      context.arc(
        center + Math.cos(angle) * distance,
        center + Math.sin(angle) * distance,
        2 + speck % 2,
        0,
        Math.PI * 2,
      )
      context.fill()
    }
    texture.update(false)
    return texture
  }

  private spawnParticle(
    layer: BloodLayer, origin: Vector3, startSize: number, endSize: number,
    minimumLifetime: number, maximumLifetime: number, velocityX: number, velocityY: number,
    velocityZ: number, gravity: number, drag: number,
  ) {
    const particle = this.acquireParticle()
    particle.active = true
    particle.age = 0
    particle.lifetime = minimumLifetime + Math.random() * (maximumLifetime - minimumLifetime)
    particle.startSize = startSize * (0.82 + Math.random() * 0.32)
    particle.endSize = endSize * (0.86 + Math.random() * 0.28)
    particle.rotationSpeed = (Math.random() - 0.5) * 13
    particle.gravity = gravity
    particle.drag = drag
    particle.velocity.set(velocityX, velocityY, velocityZ)
    particle.mesh.position.copyFrom(origin)
    particle.mesh.rotation.z = Math.random() * Math.PI * 2
    particle.mesh.scaling.set(particle.startSize, particle.startSize * (layer === 'spray' ? 1.35 : 1), 1)
    particle.mesh.material = this.particleMaterials[layer][Math.floor(Math.random() * 5)]
    particle.mesh.visibility = 1
  }

  private spawnDecal(hitPoint: Vector3) {
    this.decalRay.origin.copyFrom(hitPoint).addInPlace(this.direction.scale(0.12))
    this.decalRay.direction.copyFrom(this.direction)
    let hit = scene.pickWithRay(this.decalRay, (mesh) => proceduralEnvironmentMeshes.includes(mesh), true)
    if (!hit?.hit || !hit.pickedPoint) {
      this.decalRay.origin.copyFrom(hitPoint)
      this.decalRay.direction.copyFromFloats(0, -1, 0)
      hit = scene.pickWithRay(this.decalRay, (mesh) => proceduralEnvironmentMeshes.includes(mesh), true)
    }
    if (!hit?.hit || !hit.pickedPoint) return
    const decal = this.acquireDecal()
    this.decalNormal.copyFrom(hit.getNormal(true) ?? this.direction)
    if (!hit.getNormal(true)) this.decalNormal.scaleInPlace(-1)
    if (this.decalNormal.lengthSquared() < 0.001) return
    this.decalNormal.normalize()
    Quaternion.FromUnitVectorsToRef(Vector3.Forward(), this.decalNormal, this.decalRotation)
    decal.active = true
    decal.age = 0
    decal.lifetime = 6 + Math.random() * 4
    decal.mesh.position.copyFrom(hit.pickedPoint)
    decal.mesh.position.x += this.decalNormal.x * 0.012
    decal.mesh.position.y += this.decalNormal.y * 0.012
    decal.mesh.position.z += this.decalNormal.z * 0.012
    decal.mesh.rotationQuaternion?.copyFrom(this.decalRotation)
    decal.mesh.rotation.z = Math.random() * Math.PI * 2
    const size = 0.24 + Math.random() * 0.18
    decal.mesh.scaling.set(size, size * (0.72 + Math.random() * 0.32), 1)
    decal.mesh.material = this.particleMaterials.splash[Math.floor(Math.random() * 5)]
    decal.mesh.visibility = 0.86
  }

  private acquireParticle() {
    const particle = this.particles[this.nextParticle]
    this.nextParticle = (this.nextParticle + 1) % this.particleCapacity
    return particle
  }

  private acquireDecal() {
    const decal = this.decals[this.nextDecal]
    this.nextDecal = (this.nextDecal + 1) % this.decalCapacity
    return decal
  }

  private update(deltaSeconds: number) {
    for (let index = 0; index < this.particles.length; index += 1) {
      const particle = this.particles[index]
      if (!particle.active) continue
      particle.age += deltaSeconds
      const progress = particle.age / particle.lifetime
      if (progress >= 1) {
        this.deactivateParticle(particle)
        continue
      }
      const drag = Math.max(0, 1 - particle.drag * deltaSeconds)
      particle.velocity.scaleInPlace(drag)
      particle.velocity.y -= particle.gravity * deltaSeconds
      particle.mesh.position.x += particle.velocity.x * deltaSeconds
      particle.mesh.position.y += particle.velocity.y * deltaSeconds
      particle.mesh.position.z += particle.velocity.z * deltaSeconds
      particle.mesh.rotation.z += particle.rotationSpeed * deltaSeconds
      const size = particle.startSize + (particle.endSize - particle.startSize) * progress
      particle.mesh.scaling.x = size
      particle.mesh.scaling.y = size * (particle.gravity > 0 ? 1.35 : 1)
      particle.mesh.visibility = 1 - progress
    }
    for (let index = 0; index < this.decals.length; index += 1) {
      const decal = this.decals[index]
      if (!decal.active) continue
      decal.age += deltaSeconds
      const progress = decal.age / decal.lifetime
      if (progress >= 1) this.deactivateDecal(decal)
      else decal.mesh.visibility = Math.min(0.86, (1 - progress) * 1.6)
    }
  }

  private deactivateParticle(particle: BloodParticle) {
    particle.active = false
    particle.mesh.visibility = 0
  }

  private deactivateDecal(decal: BloodDecal) {
    decal.active = false
    decal.mesh.visibility = 0
  }
}

const bloodEffectPool = new BloodEffectPool()

const ZOMBIE_SPAWN_POSITIONS = [
  new Vector3(-20, 0, 6),
  new Vector3(-4, 0, -2),
  new Vector3(14, 0, -8),
] as const
const ZOMBIE_SPAWN_FALLBACK_POSITIONS = [
  new Vector3(-22, 0, -22),
  new Vector3(22, 0, 22),
  new Vector3(22, 0, -22),
  new Vector3(-22, 0, 22),
] as const
const ZOMBIE_WAVE_CONFIG = {
  baseZombieCount: 4,
  zombiesAddedPerWave: 1,
  zombieHealthScalePerWave: 0.05,
  zombieMovementSpeedScalePerWave: 0.03,
  maximumZombieCount: 10,
  maximumZombieHealth: 150,
  maximumZombieMovementSpeed: 2,
  minimumSpawnDistanceFromPlayer: 12,
  spawnPlacementAttempts: 6,
  spawnClearanceRadius: 0.7,
  spawnInterval: 1_000,
  timeBetweenWaves: 3_000,
} as const

const zombieAnimationAliases: Readonly<Record<ZombieAnimationName, readonly string[]>> = {
  idle: ['idle'],
  walk: ['walk'],
  run: ['run', 'sprint'],
  attack: ['attack', 'bite', 'claw'],
  hit: ['hit', 'hurt', 'damage', 'impact'],
  death: ['death', 'die', 'dying'],
}

function detectZombieAnimations(groups: AnimationGroup[]): ZombieAnimationMap {
  const animations: ZombieAnimationMap = {}
  const animationNames = Object.keys(zombieAnimationAliases) as ZombieAnimationName[]

  for (const group of groups) {
    const normalizedName = group.name.toLowerCase().replace(/[\s_-]+/g, '')
    for (const animationName of animationNames) {
      if (animations[animationName]) continue
      const aliases = zombieAnimationAliases[animationName]
      if (aliases.some((alias) => normalizedName.includes(alias))) {
        animations[animationName] = group
        break
      }
    }
  }

  // This asset has one locomotion clip. Reusing the independently cloned
  // Walk1 group at a higher playback rate gives each zombie a run/chase state
  // without altering the authored skeleton or any skinned mesh transforms.
  animations.run ??= animations.walk
  return animations
}

function describeZombieAnimationMapping(animations: ZombieAnimationMap) {
  const animationNames = Object.keys(zombieAnimationAliases) as ZombieAnimationName[]
  return animationNames.map((name) => (
    `${name}:${animations[name]?.name ?? `${name}-root-fallback`}`
  )).join(',')
}

function configureZombieVisualMesh(mesh: AbstractMesh, allowShadows: boolean) {
  mesh.isPickable = false
  mesh.checkCollisions = false
  mesh.receiveShadows = allowShadows
  if (allowShadows) shadowGenerator?.addShadowCaster(mesh)
}

function cloneSkinnedZombieInstance(container: AssetContainer, name: string) {
  // Babylon's equivalent of Three.js SkeletonUtils.clone(): skinned meshes,
  // skeletons, linked bone nodes, and animation groups are cloned together,
  // while immutable geometry, materials, and textures remain shared.
  return container.instantiateModelsToScene(
    (sourceName) => `${name}_${sourceName}`,
    false,
    { doNotInstantiate: false },
  )
}

function createGlbZombieFactory(
  container: AssetContainer,
): ZombieVisualFactory {
  return {
    source: 'glb',
    create(name: string) {
      const entries = cloneSkinnedZombieInstance(container, name)
      const root = new TransformNode(`${name}VisualRoot`, scene)
      try {
        for (const rootNode of entries.rootNodes) rootNode.parent = root

        // Presentation correction is isolated to this complete instance root.
        // Loader nodes, bones, and skinned meshes keep their authored transforms.
        root.rotation.copyFrom(ZOMBIE_ASSET_CONFIG.rotation)
        root.scaling.copyFrom(ZOMBIE_ASSET_CONFIG.scale)
        const modelMeshes = root.getChildMeshes(false)
        const renderableMeshes = modelMeshes.filter((mesh) => mesh.getTotalVertices() > 0)
        const skinnedMeshes = renderableMeshes.filter((mesh) => mesh.skeleton !== null)
        if (entries.skeletons.length === 0 || skinnedMeshes.length !== renderableMeshes.length) {
          throw new Error(
            `Zombie skin clone was incomplete (${entries.skeletons.length} skeletons; ${skinnedMeshes.length}/${renderableMeshes.length} skinned meshes).`,
          )
        }
        modelMeshes.forEach((mesh) => {
          configureZombieVisualMesh(mesh, shadowGenerator !== null)
        })
        applyImportedMaterialSettings(modelMeshes, ZOMBIE_ASSET_CONFIG.material)

        root.computeWorldMatrix(true)
        modelMeshes.forEach((mesh) => mesh.computeWorldMatrix(true))
        const initialBounds = root.getHierarchyBoundingVectors(true)
        const initialHeight = initialBounds.max.y - initialBounds.min.y
        if (!Number.isFinite(initialHeight) || initialHeight <= 0.001) {
          throw new Error(`Zombie clone returned an invalid height: ${initialHeight}.`)
        }
        if (Math.abs(initialHeight - ZOMBIE_ASSET_CONFIG.height) > 0.03) {
          throw new Error(
            `Zombie parent scale no longer resolves to ${ZOMBIE_ASSET_CONFIG.height}m (measured ${initialHeight.toFixed(3)}m).`,
          )
        }
        root.position.y -= initialBounds.min.y
        root.position.addInPlace(ZOMBIE_ASSET_CONFIG.position)

        const animationGroups = [...entries.animationGroups]
        for (const group of animationGroups) {
          group.speedRatio = ZOMBIE_ASSET_CONFIG.animationSpeed
        }
        const animations = detectZombieAnimations(animationGroups)
        if (!animations.idle || !animations.walk || !animations.attack) {
          throw new Error(
            `Zombie animation clone lost a required clip (${describeZombieAnimationMapping(animations)}).`,
          )
        }

        canvas.dataset.zombieFinalScale = root.scaling.x.toFixed(6)
        canvas.dataset.zombieFinalRotation = [root.rotation.x, root.rotation.y, root.rotation.z]
          .map((value) => value.toFixed(6))
          .join(',')

        return {
          root,
          animationGroups,
          animations,
          proceduralParts: null,
          dispose: () => {
            entries.dispose()
            root.dispose()
          },
        }
      } catch (error) {
        entries.dispose()
        root.dispose()
        throw error
      }
    },
  }
}

function createProceduralZombieFactory(): ZombieVisualFactory {
  const templateRoot = new TransformNode('proceduralZombieTemplates', scene)
  const skinMaterial = createMaterial(
    'zombieSkinShared',
    Color3.FromHexString('#626858'),
    0.96,
  )
  const uniformMaterial = createMaterial(
    'zombieUniformShared',
    Color3.FromHexString('#424a3e'),
    0.94,
  )
  const trouserMaterial = createMaterial(
    'zombieTrouserShared',
    Color3.FromHexString('#353a34'),
    0.98,
  )

  function makeTemplate(
    key: keyof ProceduralZombieParts,
    mesh: Mesh,
    material: SurfaceMaterial,
    position: Vector3,
  ) {
    mesh.name = `zombieTemplate_${key}`
    mesh.parent = templateRoot
    mesh.position.copyFrom(position)
    mesh.material = material
    configureZombieVisualMesh(mesh, false)
    return mesh
  }

  const height = ZOMBIE_ASSET_CONFIG.height
  const templates: ProceduralZombieParts = {
    head: makeTemplate(
      'head',
      MeshBuilder.CreateSphere('zombieHeadTemplate', { diameter: height * 0.23, segments: 7 }, scene),
      skinMaterial,
      new Vector3(0, height * 0.88, 0),
    ),
    torso: makeTemplate(
      'torso',
      MeshBuilder.CreateBox(
        'zombieTorsoTemplate',
        { width: height * 0.39, height: height * 0.43, depth: height * 0.2 },
        scene,
      ),
      uniformMaterial,
      new Vector3(0, height * 0.59, 0),
    ),
    leftArm: makeTemplate(
      'leftArm',
      MeshBuilder.CreateBox(
        'zombieLeftArmTemplate',
        { width: height * 0.105, height: height * 0.4, depth: height * 0.105 },
        scene,
      ),
      skinMaterial,
      new Vector3(-height * 0.25, height * 0.58, 0),
    ),
    rightArm: makeTemplate(
      'rightArm',
      MeshBuilder.CreateBox(
        'zombieRightArmTemplate',
        { width: height * 0.105, height: height * 0.4, depth: height * 0.105 },
        scene,
      ),
      skinMaterial,
      new Vector3(height * 0.25, height * 0.58, 0),
    ),
    leftLeg: makeTemplate(
      'leftLeg',
      MeshBuilder.CreateBox(
        'zombieLeftLegTemplate',
        { width: height * 0.14, height: height * 0.43, depth: height * 0.16 },
        scene,
      ),
      trouserMaterial,
      new Vector3(-height * 0.12, height * 0.22, 0),
    ),
    rightLeg: makeTemplate(
      'rightLeg',
      MeshBuilder.CreateBox(
        'zombieRightLegTemplate',
        { width: height * 0.14, height: height * 0.43, depth: height * 0.16 },
        scene,
      ),
      trouserMaterial,
      new Vector3(height * 0.12, height * 0.22, 0),
    ),
  }
  templateRoot.setEnabled(false)

  return {
    source: 'procedural',
    create(name: string) {
      const root = new TransformNode(`${name}VisualRoot`, scene)
      const parts = {} as ProceduralZombieParts

      for (const key of Object.keys(templates) as (keyof ProceduralZombieParts)[]) {
        const clone = templates[key].clone(`${name}_${key}`, root)
        if (!clone) throw new Error(`Could not clone procedural zombie part: ${key}`)
        clone.setEnabled(true)
        clone.isPickable = false
        clone.checkCollisions = false
        clone.receiveShadows = false
        parts[key] = clone
      }

      parts.leftArm.rotation.z = -0.07
      parts.rightArm.rotation.z = 0.07

      return {
        root,
        animationGroups: [],
        animations: {},
        proceduralParts: parts,
        dispose: () => root.dispose(),
      }
    },
  }
}

let zombieFactoryPromise: Promise<ZombieVisualFactory> | null = null

function markProceduralZombieSource() {
  canvas.dataset.zombieSource = 'procedural'
  canvas.dataset.zombieSharing = 'shared-geometry-materials'
  canvas.dataset.zombieClipNames = 'none'
  canvas.dataset.zombieAnimationMapping = 'procedural-root-animation'
  canvas.dataset.zombieSkeletonCount = '0'
  canvas.dataset.zombieBoneCount = '0'
  canvas.dataset.zombieMeshCount = '0'
  canvas.dataset.zombieSkinnedMeshCount = '0'
  canvas.dataset.zombieFinalScale = '0'
  canvas.dataset.zombieFinalRotation = 'procedural'
}

function getZombieVisualFactory() {
  if (zombieFactoryPromise) return zombieFactoryPromise

  zombieFactoryPromise = (async () => {
    const result = await localAssetManager.load('zombie')
    if (result.status === 'fallback') {
      console.info('[Night Breach] Zombie source: shared procedural fallback active.')
      markProceduralZombieSource()
      return createProceduralZombieFactory()
    }

    try {
      const container = result.container
      const detected = detectZombieAnimations(container.animationGroups)
      const clipNames = container.animationGroups.map((animation) => animation.name)
      const renderableMeshes = container.meshes.filter((mesh) => mesh.getTotalVertices() > 0)
      const skinnedMeshes = renderableMeshes.filter((mesh) => mesh.skeleton !== null)
      const boneCount = container.skeletons.reduce(
        (total, skeleton) => total + skeleton.bones.length,
        0,
      )
      if (container.skeletons.length === 0 || skinnedMeshes.length !== renderableMeshes.length) {
        throw new Error(
          `Zombie GLB rig is incomplete (${container.skeletons.length} skeletons; ${skinnedMeshes.length}/${renderableMeshes.length} skinned meshes).`,
        )
      }
      if (!detected.idle || !detected.walk || !detected.attack) {
        throw new Error(
          `Zombie GLB is missing a required authored clip (${describeZombieAnimationMapping(detected)}).`,
        )
      }
      console.info(
        `[Night Breach] Zombie source: local GLB loaded once (${renderableMeshes.length} skinned meshes; ${container.skeletons.length} skeleton/${boneCount} bones; clips: ${clipNames.join(', ')}; mapping: ${describeZombieAnimationMapping(detected)}).`,
      )
      canvas.dataset.zombieSource = 'glb'
      canvas.dataset.zombieSharing = 'cloned-skeletons-shared-geometry-materials-textures'
      canvas.dataset.zombieClipNames = clipNames.join(',')
      canvas.dataset.zombieAnimationMapping = describeZombieAnimationMapping(detected)
      canvas.dataset.zombieSkeletonCount = String(container.skeletons.length)
      canvas.dataset.zombieBoneCount = String(boneCount)
      canvas.dataset.zombieMeshCount = String(renderableMeshes.length)
      canvas.dataset.zombieSkinnedMeshCount = String(skinnedMeshes.length)
      return createGlbZombieFactory(container)
    } catch (error) {
      logRuntimeWarning(
        'Zombie source: shared procedural fallback (local GLB unavailable).',
        error,
      )
      markProceduralZombieSource()
      return createProceduralZombieFactory()
    }
  })()

  return zombieFactoryPromise
}

function isZombieObstacle(mesh: AbstractMesh) {
  return mesh.checkCollisions
    && mesh.isEnabled()
    && mesh.metadata?.zombieCollider !== true
}

class Zombie {
  readonly id: number
  readonly root: Mesh
  readonly visual: ZombieVisual
  readonly maxHealth: number
  private _state: ZombieState = 'idle'
  private health: number
  private readonly movementSpeedMultiplier: number
  private activeAnimation: AnimationGroup | null = null
  private activeAnimationSpeed = 0
  private animationPaused = false
  private proceduralTime: number
  private proceduralBaseY: number
  private proceduralBaseRotationX: number
  private proceduralBaseRotationZ: number
  private thinkTimeRemaining: number
  private cachedDistanceSquared = Number.POSITIVE_INFINITY
  private desiredDirectionX = 0
  private desiredDirectionZ = 0
  private currentDirectionX = 0
  private currentDirectionZ = 0
  private targetSpeed = 0
  private locomotion: 'walk' | 'run' = 'walk'
  private readonly obstacleRay: Ray
  private readonly movementDelta = new Vector3()
  private readonly hitZoneMeshes: Mesh[] = []
  private readonly upperBodyImpactRoot: TransformNode
  private readonly upperBodyImpactBasePosition = Vector3.Zero()
  private readonly upperBodyImpactDirection = Vector3.Forward()
  private upperBodyImpactDistance = 0
  private resumeStateAfterHit: 'idle' | 'chasing' = 'idle'
  private hitReactionRemaining = 0
  private attackElapsed = 0
  private attackCooldownRemaining = 0
  private attackDamageApplied = false
  private deathElapsed = 0
  private deathAnimationDuration = ZOMBIE_COMBAT_CONFIG.fallbackDeathDuration
  private disposed = false

  constructor(
    id: number,
    spawnPosition: Vector3,
    factory: ZombieVisualFactory,
    maxHealth: number,
    movementSpeedMultiplier: number,
  ) {
    this.id = id
    this.maxHealth = maxHealth
    this.health = maxHealth
    this.movementSpeedMultiplier = movementSpeedMultiplier
    this.root = MeshBuilder.CreateBox(
      `zombie${id}`,
      {
        width: 0.72,
        height: ZOMBIE_ASSET_CONFIG.height,
        depth: 0.72,
      },
      scene,
    )
    this.root.position.set(
      spawnPosition.x,
      ZOMBIE_ASSET_CONFIG.height * 0.5,
      spawnPosition.z,
    )
    this.root.visibility = 0
    this.root.isPickable = false
    this.root.checkCollisions = true
    this.root.receiveShadows = false
    this.root.ellipsoid = new Vector3(0.36, ZOMBIE_ASSET_CONFIG.height * 0.5, 0.36)
    this.root.ellipsoidOffset = Vector3.Zero()
    this.root.metadata = { zombieCollider: true }

    this.visual = factory.create(`zombie${id}`)
    this.visual.root.parent = this.root
    this.visual.root.position.y -= ZOMBIE_ASSET_CONFIG.height * 0.5
    this.upperBodyImpactRoot = this.createUpperBodyImpactRoot()
    this.upperBodyImpactBasePosition.copyFrom(this.upperBodyImpactRoot.position)
    this.proceduralBaseY = this.visual.root.position.y
    this.proceduralBaseRotationX = this.visual.root.rotation.x
    this.proceduralBaseRotationZ = this.visual.root.rotation.z
    this.proceduralTime = id * 0.73
    this.thinkTimeRemaining = id * 0.045
    this.obstacleRay = new Ray(
      new Vector3(),
      new Vector3(0, 0, 1),
      ZOMBIE_AI_CONFIG.obstacleProbeDistance,
    )
    this.createHitZones()
    this.playStateAnimation()
    playZombieIdleSound(this.id)
  }

  get state(): ZombieState {
    return this._state
  }

  get currentHealth() {
    return this.health
  }

  get activeAnimationName() {
    if (this.activeAnimation) return this.activeAnimation.name
    if (this.visual.proceduralParts) return 'procedural'
    if (this._state === 'hit') return 'hit-root-fallback'
    if (this._state === 'dead') return 'death-root-fallback'
    return 'none'
  }

  get upperBodyPushAmount() {
    return Vector3.Distance(
      this.upperBodyImpactRoot.position,
      this.upperBodyImpactBasePosition,
    )
  }

  get corpseGrounded() {
    return this._state === 'dead' && this.deathElapsed >= this.deathAnimationDuration
  }

  applyHit(zone: ZombieHitZoneType, bulletDirection = Vector3.Forward()) {
    if (this.disposed || this._state === 'dead') return false

    const damage = zone === 'head'
      ? ZOMBIE_COMBAT_CONFIG.headDamage
      : zone === 'torso'
        ? ZOMBIE_COMBAT_CONFIG.torsoDamage
        : ZOMBIE_COMBAT_CONFIG.limbDamage
    this.health = Math.max(0, this.health - damage)

    if (this.health <= 0) {
      this.die()
      return true
    }

    playZombieHitSound(this.id)
    const wasAlreadyReacting = this._state === 'hit'
    if (!wasAlreadyReacting) {
      this.resumeStateAfterHit = this._state === 'chasing' ? 'chasing' : 'idle'
    }
    this.hitReactionRemaining = ZOMBIE_COMBAT_CONFIG.hitReactionDuration
    this.beginUpperBodyImpact(bulletDirection, zone === 'head')
    this.setState('hit')
    if (wasAlreadyReacting) this.restartHitAnimation()
    return true
  }

  setState(nextState: ZombieState) {
    if (this.disposed || this._state === nextState) return
    this._state = nextState
    if (nextState !== 'chasing') {
      this.desiredDirectionX = 0
      this.desiredDirectionZ = 0
      this.targetSpeed = 0
    }
    this.playStateAnimation()
    if (nextState === 'idle') playZombieIdleSound(this.id)
    else if (nextState === 'chasing') playZombieChaseSound(this.id)
    else if (nextState === 'attacking') playZombieAttackSound(this.id)
  }

  setPaused(paused: boolean) {
    if (this.disposed || this.animationPaused === paused) return
    if (paused) this.activeAnimation?.pause()
    else {
      this.activeAnimation?.restart()
      this.thinkTimeRemaining = 0
    }
    this.animationPaused = paused
  }

  update(deltaSeconds: number, paused: boolean, playerPosition: Vector3) {
    if (this.disposed) return

    if (paused) {
      this.setPaused(true)
      return
    }

    this.setPaused(false)

    if (this._state === 'dead') {
      this.deathElapsed += deltaSeconds
      this.updateProceduralAnimation(deltaSeconds)
      if (this.deathElapsed >= (
        this.deathAnimationDuration + ZOMBIE_COMBAT_CONFIG.corpseHoldDuration
      )) this.dispose()
      return
    }

    this.attackCooldownRemaining = Math.max(
      0,
      this.attackCooldownRemaining - deltaSeconds,
    )

    if (this._state === 'attacking') {
      this.updateAttack(deltaSeconds, playerPosition)
      this.updateProceduralAnimation(deltaSeconds)
      return
    }

    if (this._state === 'hit') {
      this.hitReactionRemaining -= deltaSeconds
      this.applyUpperBodyImpact(clamp(
        this.hitReactionRemaining / ZOMBIE_COMBAT_CONFIG.hitReactionDuration,
        0,
        1,
      ) ** 2)
      if (this.hitReactionRemaining <= 0) {
        this.applyUpperBodyImpact(0)
        this.setState(this.resumeStateAfterHit)
        this.thinkTimeRemaining = 0
      }
    }

    if (this._state !== 'hit') {
      this.thinkTimeRemaining -= deltaSeconds
      if (this.thinkTimeRemaining <= 0) {
        this.updateAwarenessAndSteering(playerPosition)
        if (this.cachedDistanceSquared
          <= ZOMBIE_AI_CONFIG.nearThinkDistance * ZOMBIE_AI_CONFIG.nearThinkDistance) {
          this.thinkTimeRemaining = ZOMBIE_AI_CONFIG.nearThinkInterval
        } else if (this.cachedDistanceSquared
          <= ZOMBIE_AI_CONFIG.midThinkDistance * ZOMBIE_AI_CONFIG.midThinkDistance) {
          this.thinkTimeRemaining = ZOMBIE_AI_CONFIG.midThinkInterval
        } else {
          this.thinkTimeRemaining = ZOMBIE_AI_CONFIG.farThinkInterval
        }
      }

      this.updateMovement(deltaSeconds, playerPosition)
    }

    this.updateProceduralAnimation(deltaSeconds)
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.activeAnimation?.stop()
    this.disableHitZones()
    this.visual.dispose()
    this.root.dispose()
    unregisterActiveZombie()
  }

  private createHitZones() {
    const height = ZOMBIE_ASSET_CONFIG.height
    this.registerHitZone(
      MeshBuilder.CreateSphere(
        `zombie${this.id}HeadHitZone`,
        { diameter: height * 0.27, segments: 6 },
        scene,
      ),
      'head',
      0,
      height * 0.39,
      0,
    )
    this.registerHitZone(
      MeshBuilder.CreateBox(
        `zombie${this.id}TorsoHitZone`,
        { width: height * 0.45, height: height * 0.48, depth: height * 0.27 },
        scene,
      ),
      'torso',
      0,
      height * 0.08,
      0,
    )
    this.registerHitZone(
      MeshBuilder.CreateBox(
        `zombie${this.id}LegHitZone`,
        { width: height * 0.32, height: height * 0.47, depth: height * 0.24 },
        scene,
      ),
      'limbs',
      0,
      -height * 0.28,
      0,
    )
    this.registerHitZone(
      MeshBuilder.CreateBox(
        `zombie${this.id}LeftArmHitZone`,
        { width: height * 0.13, height: height * 0.43, depth: height * 0.18 },
        scene,
      ),
      'limbs',
      -height * 0.27,
      height * 0.07,
      0,
    )
    this.registerHitZone(
      MeshBuilder.CreateBox(
        `zombie${this.id}RightArmHitZone`,
        { width: height * 0.13, height: height * 0.43, depth: height * 0.18 },
        scene,
      ),
      'limbs',
      height * 0.27,
      height * 0.07,
      0,
    )
  }

  private registerHitZone(
    mesh: Mesh,
    zone: ZombieHitZoneType,
    positionX: number,
    positionY: number,
    positionZ: number,
  ) {
    mesh.parent = this.root
    mesh.position.set(positionX, positionY, positionZ)
    mesh.material = zombieHitZoneMaterial
    mesh.visibility = 0.001
    mesh.isVisible = true
    mesh.isPickable = true
    mesh.checkCollisions = false
    mesh.receiveShadows = false
    this.hitZoneMeshes.push(mesh)
    zombieHitZones.set(mesh, { zombie: this, zone })
  }

  private disableHitZones() {
    for (let index = 0; index < this.hitZoneMeshes.length; index += 1) {
      const mesh = this.hitZoneMeshes[index]
      mesh.isPickable = false
      zombieHitZones.delete(mesh)
    }
  }

  private createUpperBodyImpactRoot() {
    const impactRoot = new TransformNode(`zombie${this.id}UpperBodyImpact`, scene)
    const parts = this.visual.proceduralParts
    if (parts) {
      impactRoot.parent = this.visual.root
      parts.head.parent = impactRoot
      parts.torso.parent = impactRoot
      parts.leftArm.parent = impactRoot
      parts.rightArm.parent = impactRoot
      return impactRoot
    }

    const upperSpineNode = this.visual.root.getChildTransformNodes(false).find((node) => {
      const normalizedName = node.name.toLowerCase().replace(/[\s_.-]+/g, '')
      return normalizedName.includes('spine03')
    })
    if (!upperSpineNode) {
      // A transform above the full visual is a safe fallback for future rigs
      // whose upper-spine node does not follow the current naming convention.
      impactRoot.parent = this.visual.root
      return impactRoot
    }

    impactRoot.parent = upperSpineNode.parent
    upperSpineNode.parent = impactRoot
    return impactRoot
  }

  private beginUpperBodyImpact(bulletDirection: Vector3, headshot: boolean) {
    const parent = this.upperBodyImpactRoot.parent
    const localDirection = parent
      ? Vector3.TransformNormal(
          bulletDirection,
          parent.getWorldMatrix().clone().invert(),
        )
      : bulletDirection.clone()
    if (localDirection.lengthSquared() <= 0.000001) localDirection.copyFromFloats(0, 0, 1)
    localDirection.normalize()
    this.upperBodyImpactDirection.copyFrom(localDirection)
    this.upperBodyImpactDistance = ZOMBIE_COMBAT_CONFIG.hitPushDistance
      * (headshot ? ZOMBIE_COMBAT_CONFIG.headHitPushMultiplier : 1)
    this.applyUpperBodyImpact(1)
  }

  private applyUpperBodyImpact(strength: number) {
    const distance = this.upperBodyImpactDistance * strength
    this.upperBodyImpactRoot.position.copyFrom(this.upperBodyImpactBasePosition)
    this.upperBodyImpactRoot.position.addInPlaceFromFloats(
      this.upperBodyImpactDirection.x * distance,
      this.upperBodyImpactDirection.y * distance,
      this.upperBodyImpactDirection.z * distance,
    )
  }

  private restartHitAnimation() {
    if (!this.visual.animations.hit) return
    this.activeAnimation?.stop()
    this.activeAnimation = null
    this.activeAnimationSpeed = 0
    this.playStateAnimation()
  }

  private die() {
    if (this._state === 'dead') return
    this.health = 0
    this.deathElapsed = 0
    this.hitReactionRemaining = 0
    this.attackDamageApplied = true
    this.attackElapsed = 0
    this.deathAnimationDuration = this.getDeathAnimationDuration()
    this.applyUpperBodyImpact(0)
    this.setState('dead')
    playZombieDeathSound(this.id)
    this.currentDirectionX = 0
    this.currentDirectionZ = 0
    this.root.checkCollisions = false
    this.disableHitZones()
    onZombieDied()
    console.info(`[Night Breach] Zombie ${this.id} eliminated; hit detection disabled.`)
  }

  private getDeathAnimationDuration() {
    const animation = this.visual.animations.death
    if (!animation) return ZOMBIE_COMBAT_CONFIG.fallbackDeathDuration
    const framesPerSecond = animation.targetedAnimations[0]?.animation.framePerSecond ?? 30
    const duration = (animation.to - animation.from)
      / framesPerSecond
      / ZOMBIE_ASSET_CONFIG.animationSpeed
    return Math.max(ZOMBIE_COMBAT_CONFIG.fallbackDeathDuration, duration)
  }

  private updateAwarenessAndSteering(playerPosition: Vector3) {
    const toPlayerX = playerPosition.x - this.root.position.x
    const toPlayerZ = playerPosition.z - this.root.position.z
    this.cachedDistanceSquared = toPlayerX * toPlayerX + toPlayerZ * toPlayerZ

    const awarenessRange = this._state === 'chasing'
      ? ZOMBIE_AI_CONFIG.loseInterestRange
      : ZOMBIE_AI_CONFIG.detectionRange
    if (this.cachedDistanceSquared > awarenessRange * awarenessRange) {
      this.setState('idle')
      return
    }

    if (this.cachedDistanceSquared
      <= ZOMBIE_AI_CONFIG.attackDistance * ZOMBIE_AI_CONFIG.attackDistance) {
      if (this.attackCooldownRemaining <= 0) this.beginAttack()
      else this.setState('idle')
      return
    }

    const distance = Math.sqrt(this.cachedDistanceSquared)
    this.desiredDirectionX = toPlayerX / distance
    this.desiredDirectionZ = toPlayerZ / distance

    const nextLocomotion = distance >= ZOMBIE_AI_CONFIG.runDistance ? 'run' : 'walk'
    if (nextLocomotion !== this.locomotion) {
      this.locomotion = nextLocomotion
      if (this._state === 'chasing') this.playStateAnimation()
    }
    this.targetSpeed = this.locomotion === 'run'
      ? ZOMBIE_AI_CONFIG.runSpeed * this.movementSpeedMultiplier
      : ZOMBIE_AI_CONFIG.walkSpeed * this.movementSpeedMultiplier
    this.setState('chasing')

    this.obstacleRay.origin.set(
      this.root.position.x,
      this.root.position.y,
      this.root.position.z,
    )
    this.obstacleRay.direction.set(
      this.desiredDirectionX,
      0,
      this.desiredDirectionZ,
    )
    const obstacle = scene.pickWithRay(this.obstacleRay, isZombieObstacle, true)
    if (!obstacle?.hit) return

    const turnDirection = this.id % 2 === 0 ? 1 : -1
    const turnAngle = ZOMBIE_AI_CONFIG.obstacleTurnAngle * turnDirection
    const turnCosine = Math.cos(turnAngle)
    const turnSine = Math.sin(turnAngle)
    const steeredX = this.desiredDirectionX * turnCosine
      - this.desiredDirectionZ * turnSine
    this.desiredDirectionZ = this.desiredDirectionX * turnSine
      + this.desiredDirectionZ * turnCosine
    this.desiredDirectionX = steeredX
  }

  private updateMovement(deltaSeconds: number, playerPosition: Vector3) {
    const response = 1 - Math.exp(-ZOMBIE_AI_CONFIG.steeringResponse * deltaSeconds)
    this.currentDirectionX += (this.desiredDirectionX - this.currentDirectionX) * response
    this.currentDirectionZ += (this.desiredDirectionZ - this.currentDirectionZ) * response

    if (this._state !== 'chasing') return

    const directionLength = Math.hypot(this.currentDirectionX, this.currentDirectionZ)
    if (directionLength < 0.001) return
    this.currentDirectionX /= directionLength
    this.currentDirectionZ /= directionLength

    const desiredYaw = Math.atan2(this.currentDirectionX, this.currentDirectionZ)
    const yawDifference = Math.atan2(
      Math.sin(desiredYaw - this.root.rotation.y),
      Math.cos(desiredYaw - this.root.rotation.y),
    )
    const maximumTurn = ZOMBIE_AI_CONFIG.rotationSpeed * deltaSeconds
    this.root.rotation.y += clamp(yawDifference, -maximumTurn, maximumTurn)

    const playerOffsetX = playerPosition.x - this.root.position.x
    const playerOffsetZ = playerPosition.z - this.root.position.z
    const playerDistance = Math.hypot(playerOffsetX, playerOffsetZ)
    const availableDistance = Math.max(
      0,
      playerDistance - ZOMBIE_AI_CONFIG.attackDistance,
    )
    const movementDistance = Math.min(
      this.targetSpeed * deltaSeconds,
      availableDistance,
    )
    if (movementDistance <= 0) return

    this.movementDelta.set(
      this.currentDirectionX * movementDistance,
      0,
      this.currentDirectionZ * movementDistance,
    )
    this.root.moveWithCollisions(this.movementDelta)
  }

  private beginAttack() {
    if (
      this.disposed
      || this._state === 'dead'
      || this.attackCooldownRemaining > 0
    ) return

    this.attackElapsed = 0
    this.attackDamageApplied = false
    this.attackCooldownRemaining = ZOMBIE_COMBAT_CONFIG.attackCooldown
    this.setState('attacking')
  }

  private updateAttack(deltaSeconds: number, playerPosition: Vector3) {
    if (this._state !== 'attacking' || this.disposed) return

    this.attackElapsed += deltaSeconds
    const toPlayerX = playerPosition.x - this.root.position.x
    const toPlayerZ = playerPosition.z - this.root.position.z
    const distanceSquared = toPlayerX * toPlayerX + toPlayerZ * toPlayerZ
    const desiredYaw = Math.atan2(toPlayerX, toPlayerZ)
    const yawDifference = Math.atan2(
      Math.sin(desiredYaw - this.root.rotation.y),
      Math.cos(desiredYaw - this.root.rotation.y),
    )
    const maximumTurn = ZOMBIE_AI_CONFIG.rotationSpeed * deltaSeconds
    this.root.rotation.y += clamp(yawDifference, -maximumTurn, maximumTurn)

    if (
      !this.attackDamageApplied
      && this.attackElapsed >= ZOMBIE_COMBAT_CONFIG.attackDamageMoment
    ) {
      // Consume the damage window even on a miss so one swing can never hit twice.
      this.attackDamageApplied = true
      if (
        distanceSquared
        <= ZOMBIE_AI_CONFIG.attackDistance * ZOMBIE_AI_CONFIG.attackDistance
      ) {
        damagePlayer(ZOMBIE_COMBAT_CONFIG.attackDamage, this.root.position)
      }
    }

    if (this.attackElapsed >= ZOMBIE_COMBAT_CONFIG.attackDuration) {
      this.setState('idle')
      this.thinkTimeRemaining = 0
    }
  }

  private updateProceduralAnimation(deltaSeconds: number) {
    if (this._state === 'dead' && !this.visual.animations.death) {
      this.visual.root.rotation.x = Math.min(
        this.proceduralBaseRotationX + Math.PI * 0.48,
        this.visual.root.rotation.x + deltaSeconds * 1.6,
      )
      this.visual.root.rotation.z = damp(
        this.visual.root.rotation.z,
        this.proceduralBaseRotationZ,
        10,
        deltaSeconds,
      )
    } else {
      this.visual.root.rotation.x = damp(
        this.visual.root.rotation.x,
        this.proceduralBaseRotationX,
        12,
        deltaSeconds,
      )
      this.visual.root.rotation.z = damp(
        this.visual.root.rotation.z,
        this.proceduralBaseRotationZ,
        12,
        deltaSeconds,
      )
    }

    const parts = this.visual.proceduralParts
    if (!parts) return

    const locomotionRate = this.locomotion === 'run' ? 7.2 : 5.2
    this.proceduralTime += deltaSeconds * ZOMBIE_ASSET_CONFIG.animationSpeed
    const cycle = Math.sin(this.proceduralTime * locomotionRate)
    const idleCycle = Math.sin(this.proceduralTime * 1.7)

    if (this._state === 'chasing') {
      const stride = this.locomotion === 'run' ? 0.42 : 0.29
      parts.leftArm.rotation.x = damp(parts.leftArm.rotation.x, cycle * stride, 14, deltaSeconds)
      parts.rightArm.rotation.x = damp(parts.rightArm.rotation.x, -cycle * stride, 14, deltaSeconds)
      parts.leftLeg.rotation.x = damp(parts.leftLeg.rotation.x, -cycle * stride * 0.84, 14, deltaSeconds)
      parts.rightLeg.rotation.x = damp(parts.rightLeg.rotation.x, cycle * stride * 0.84, 14, deltaSeconds)
      this.visual.root.position.y = this.proceduralBaseY
        + Math.abs(cycle) * (this.locomotion === 'run' ? 0.018 : 0.011)
      this.visual.root.rotation.z = damp(
        this.visual.root.rotation.z,
        0,
        12,
        deltaSeconds,
      )
      this.visual.root.rotation.x = damp(
        this.visual.root.rotation.x,
        this.proceduralBaseRotationX,
        12,
        deltaSeconds,
      )
      return
    }

    parts.leftLeg.rotation.x = damp(parts.leftLeg.rotation.x, 0, 11, deltaSeconds)
    parts.rightLeg.rotation.x = damp(parts.rightLeg.rotation.x, 0, 11, deltaSeconds)
    const attackProgress = clamp(
      this.attackElapsed / ZOMBIE_COMBAT_CONFIG.attackDuration,
      0,
      1,
    )
    const attackStrike = Math.sin(attackProgress * Math.PI)
    parts.leftArm.rotation.x = damp(parts.leftArm.rotation.x, this._state === 'attacking'
      ? -0.28 - attackStrike * 0.86
      : idleCycle * 0.025, 11, deltaSeconds)
    parts.rightArm.rotation.x = damp(parts.rightArm.rotation.x, this._state === 'attacking'
      ? -0.28 - attackStrike * 0.86
      : -idleCycle * 0.025, 11, deltaSeconds)
    this.visual.root.position.y = damp(
      this.visual.root.position.y,
      this.proceduralBaseY + idleCycle * 0.003,
      8,
      deltaSeconds,
    )
    this.visual.root.rotation.z = damp(
      this.visual.root.rotation.z,
      this.proceduralBaseRotationZ,
      10,
      deltaSeconds,
    )
    if (this._state !== 'dead') {
      this.visual.root.rotation.x = damp(
        this.visual.root.rotation.x,
        this.proceduralBaseRotationX,
        10,
        deltaSeconds,
      )
    }
  }

  private playStateAnimation() {
    const animation = this.animationForState()
    const animationSpeed = animation ? this.animationSpeedForState(animation) : 0
    if (animation === this.activeAnimation
      && Math.abs(animationSpeed - this.activeAnimationSpeed) < 0.001) return
    this.activeAnimation?.stop()
    this.activeAnimation = animation
    this.activeAnimationSpeed = animationSpeed
    if (!animation) return

    const loops = this._state === 'idle' || this._state === 'chasing'
    animation.start(
      loops,
      animationSpeed,
      animation.from,
      animation.to,
      false,
    )
  }

  private animationSpeedForState(animation: AnimationGroup) {
    if (this._state === 'chasing' && this.locomotion === 'run') {
      return ZOMBIE_ASSET_CONFIG.animationSpeed * 1.35
    }
    if (this._state !== 'attacking') return ZOMBIE_ASSET_CONFIG.animationSpeed

    const framesPerSecond = animation.targetedAnimations[0]?.animation.framePerSecond ?? 30
    const clipDuration = (animation.to - animation.from) / framesPerSecond
    return Math.max(
      ZOMBIE_ASSET_CONFIG.animationSpeed,
      clipDuration / ZOMBIE_COMBAT_CONFIG.attackDuration,
    )
  }

  private animationForState() {
    const animations = this.visual.animations
    switch (this._state) {
      case 'idle':
        return animations.idle ?? null
      case 'chasing':
        return this.locomotion === 'run'
          ? animations.run ?? animations.walk ?? null
          : animations.walk ?? animations.run ?? null
      case 'attacking':
        return animations.attack ?? null
      case 'hit':
        return animations.hit ?? null
      case 'dead':
        return animations.death ?? null
    }
  }
}

interface ZombieHitZone {
  zombie: Zombie
  zone: ZombieHitZoneType
}

const zombieHitZones = new Map<Mesh, ZombieHitZone>()
const zombies: Zombie[] = []
let activeZombieFactory: ZombieVisualFactory | null = null
let activeZombieCount = 0
let nextZombieId = 1
let zombieSpawnTimer: number | undefined
let nextWaveTimer: number | undefined

type WaveStatus = 'waiting' | 'active' | 'complete'

interface WaveState {
  currentWave: number
  scheduledZombies: number
  spawnedZombies: number
  aliveZombies: number
  status: WaveStatus
}

interface WaveZombieStats {
  maxHealth: number
  movementSpeedMultiplier: number
}

const waveState: WaveState = {
  currentWave: 0,
  scheduledZombies: 0,
  spawnedZombies: 0,
  aliveZombies: 0,
  status: 'waiting',
}

function updateWaveDisplay() {
  canvas.dataset.wave = String(waveState.currentWave)
  canvas.dataset.waveScheduledZombies = String(waveState.scheduledZombies)
  canvas.dataset.waveSpawnedZombies = String(waveState.spawnedZombies)
  canvas.dataset.waveAliveZombies = String(waveState.aliveZombies)
  canvas.dataset.waveStatus = waveState.status
}

function getWaveZombieStats(wave: number): WaveZombieStats {
  const waveProgress = Math.max(0, wave - 1)
  const maxHealth = Math.min(
    ZOMBIE_COMBAT_CONFIG.maxHealth * (
      1 + waveProgress * ZOMBIE_WAVE_CONFIG.zombieHealthScalePerWave
    ),
    ZOMBIE_WAVE_CONFIG.maximumZombieHealth,
  )
  const maximumSpeedMultiplier = ZOMBIE_WAVE_CONFIG.maximumZombieMovementSpeed
    / ZOMBIE_AI_CONFIG.runSpeed
  const movementSpeedMultiplier = Math.min(
    1 + waveProgress * ZOMBIE_WAVE_CONFIG.zombieMovementSpeedScalePerWave,
    maximumSpeedMultiplier,
  )
  return { maxHealth, movementSpeedMultiplier }
}

function isSpawnPositionFarEnoughFromPlayer(position: Vector3) {
  const distanceX = position.x - camera.position.x
  const distanceZ = position.z - camera.position.z
  return distanceX * distanceX + distanceZ * distanceZ
    >= ZOMBIE_WAVE_CONFIG.minimumSpawnDistanceFromPlayer
      * ZOMBIE_WAVE_CONFIG.minimumSpawnDistanceFromPlayer
}

function isSpawnPositionClearOfGeometry(position: Vector3) {
  const radius = ZOMBIE_WAVE_CONFIG.spawnClearanceRadius
  const height = ZOMBIE_ASSET_CONFIG.height
  for (const mesh of proceduralEnvironmentMeshes) {
    if (!mesh.checkCollisions || !mesh.isEnabled()) continue
    const bounds = mesh.getBoundingInfo().boundingBox
    if (
      position.x + radius >= bounds.minimumWorld.x
      && position.x - radius <= bounds.maximumWorld.x
      && position.z + radius >= bounds.minimumWorld.z
      && position.z - radius <= bounds.maximumWorld.z
      && height >= bounds.minimumWorld.y + 0.05
      && 0.05 <= bounds.maximumWorld.y
    ) return false
  }
  return true
}

function isSpawnPositionOutsideCameraView(position: Vector3) {
  const spawnCenter = new Vector3(
    position.x,
    ZOMBIE_ASSET_CONFIG.height * 0.5,
    position.z,
  )
  return Frustum.GetPlanes(camera.getTransformationMatrix())
    .some((plane) => plane.dotCoordinate(spawnCenter) < 0)
}

function isValidZombieSpawnPosition(position: Vector3) {
  return isSpawnPositionFarEnoughFromPlayer(position)
    && isSpawnPositionClearOfGeometry(position)
    && isSpawnPositionOutsideCameraView(position)
}

function selectZombieSpawnPosition(spawnIndex: number) {
  const candidateCount = ZOMBIE_SPAWN_POSITIONS.length
  for (let attempt = 0; attempt < ZOMBIE_WAVE_CONFIG.spawnPlacementAttempts; attempt += 1) {
    const position = ZOMBIE_SPAWN_POSITIONS[(spawnIndex + attempt) % candidateCount]
    if (isValidZombieSpawnPosition(position)) return position
  }

  for (let index = 0; index < ZOMBIE_SPAWN_FALLBACK_POSITIONS.length; index += 1) {
    const position = ZOMBIE_SPAWN_FALLBACK_POSITIONS[
      (spawnIndex + index) % ZOMBIE_SPAWN_FALLBACK_POSITIONS.length
    ]
    if (isValidZombieSpawnPosition(position)) {
      return position
    }
  }

  return ZOMBIE_SPAWN_FALLBACK_POSITIONS[
    spawnIndex % ZOMBIE_SPAWN_FALLBACK_POSITIONS.length
  ]
}

stopZombieWaveTimers = () => {
  if (zombieSpawnTimer !== undefined) {
    window.clearInterval(zombieSpawnTimer)
    zombieSpawnTimer = undefined
  }
  if (nextWaveTimer !== undefined) {
    window.clearTimeout(nextWaveTimer)
    nextWaveTimer = undefined
  }
}

function updateActiveZombieCount() {
  canvas.dataset.activeZombieCount = String(activeZombieCount)
}

function registerActiveZombie() {
  activeZombieCount += 1
  updateActiveZombieCount()
}

function unregisterActiveZombie() {
  activeZombieCount = Math.max(0, activeZombieCount - 1)
  updateActiveZombieCount()
}

function spawnNextWaveZombie() {
  const factory = activeZombieFactory
  if (!factory || gameOver || waveState.status !== 'active') {
    stopZombieWaveTimers()
    return
  }
  if (waveState.spawnedZombies >= waveState.scheduledZombies) {
    if (zombieSpawnTimer !== undefined) {
      window.clearInterval(zombieSpawnTimer)
      zombieSpawnTimer = undefined
    }
    return
  }

  const spawnPosition = selectZombieSpawnPosition(waveState.spawnedZombies)
  const stats = getWaveZombieStats(waveState.currentWave)
  const zombie = new Zombie(
    nextZombieId,
    spawnPosition,
    factory,
    stats.maxHealth,
    stats.movementSpeedMultiplier,
  )
  nextZombieId += 1
  zombie.setPaused(!webViewActive || !deployed || gameOver)
  zombies.push(zombie)
  waveState.spawnedZombies += 1
  waveState.aliveZombies += 1
  registerActiveZombie()
  canvas.dataset.zombieCount = String(zombies.length)
  updateWaveDisplay()

  if (waveState.spawnedZombies === waveState.scheduledZombies && zombieSpawnTimer !== undefined) {
    window.clearInterval(zombieSpawnTimer)
    zombieSpawnTimer = undefined
  }
}

function completeWaveIfReady() {
  if (gameOver || waveState.status !== 'active'
    || waveState.spawnedZombies !== waveState.scheduledZombies
    || waveState.aliveZombies !== 0) return

  stopZombieWaveTimers()
  waveState.status = 'complete'
  updateWaveDisplay()
  nextWaveTimer = window.setTimeout(() => {
    nextWaveTimer = undefined
    startNextZombieWave()
  }, ZOMBIE_WAVE_CONFIG.timeBetweenWaves)
}

function onZombieDied() {
  if (waveState.status !== 'active' || waveState.aliveZombies === 0) return
  waveState.aliveZombies -= 1
  updateWaveDisplay()
  completeWaveIfReady()
}

function startNextZombieWave() {
  if (!activeZombieFactory || gameOver || !deployed || waveState.status === 'active'
    || nextWaveTimer !== undefined) return

  stopZombieWaveTimers()
  waveState.currentWave += 1
  waveState.scheduledZombies = Math.min(
    ZOMBIE_WAVE_CONFIG.baseZombieCount
      + (waveState.currentWave - 1) * ZOMBIE_WAVE_CONFIG.zombiesAddedPerWave,
    ZOMBIE_WAVE_CONFIG.maximumZombieCount,
  )
  waveState.spawnedZombies = 0
  waveState.aliveZombies = 0
  waveState.status = 'active'
  updateWaveDisplay()
  console.info(`[Night Breach][Waves] Wave ${waveState.currentWave} started with ${waveState.scheduledZombies} zombies.`)

  spawnNextWaveZombie()
  if (waveState.spawnedZombies < waveState.scheduledZombies) {
    zombieSpawnTimer = window.setInterval(
      spawnNextWaveZombie,
      ZOMBIE_WAVE_CONFIG.spawnInterval,
    )
  }
}

startZombieWave = startNextZombieWave

updateActiveZombieCount()

async function initializeZombies() {
  console.info('[Night Breach][Zombies] Initialization started.')
  let factory: ZombieVisualFactory
  try {
    factory = await getZombieVisualFactory()
  } catch (error) {
    logRuntimeWarning(
      '[Zombies] Imported setup failed; switching to shared procedural zombies.',
      error,
    )
    factory = createProceduralZombieFactory()
    markProceduralZombieSource()
  }

  try {
    activeZombieFactory = factory
    if (deployed) startNextZombieWave()
  } catch (error) {
    if (factory.source === 'procedural') throw error
    logRuntimeWarning(
      '[Zombies] Imported instances failed; spawning procedural zombies instead.',
      error,
    )
    for (const zombie of zombies) zombie.dispose()
    zombies.length = 0
    factory = createProceduralZombieFactory()
    activeZombieFactory = factory
    markProceduralZombieSource()
    if (deployed) startNextZombieWave()
  }

  console.info(
    `[Night Breach][Zombies] Ready: ${zombies.length} active using the ${factory.source} source with combat hit zones.`,
  )
}

function resetZombieWave() {
  stopZombieWaveTimers()
  for (let index = 0; index < zombies.length; index += 1) zombies[index].dispose()
  zombies.length = 0
  activeZombieCount = 0
  nextZombieId = 1
  waveState.currentWave = 0
  waveState.scheduledZombies = 0
  waveState.spawnedZombies = 0
  waveState.aliveZombies = 0
  waveState.status = 'waiting'
  updateActiveZombieCount()
  updateWaveDisplay()
}

updateWaveDisplay()
scene.onDisposeObservable.add(stopZombieWaveTimers)
void initializeZombies().catch((error) => {
  logRuntimeError('[Zombies] Initialization failed:', error)
})

scene.onBeforeRenderObservable.add(() => {
  const deltaSeconds = Math.min(engine.getDeltaTime() / 1000, 0.05)
  let pauseZombieAI = !deployed || gameOver || !webViewActive || portraitInputPaused
  for (let index = 0; index < zombies.length; index += 1) {
    zombies[index].update(deltaSeconds, pauseZombieAI, camera.position)
    if (gameOver) pauseZombieAI = true
  }
})

const WEAPON_VIEW_CONFIG = {
  fov: 78 * Math.PI / 180,
  position: new Vector3(0.31, -0.38, 0.32),
  rotation: new Vector3(-0.02, -0.09, 0.01),
  adsPosition: new Vector3(0, -0.15, 0.35),
  adsRotation: new Vector3(-0.006, 0, 0),
  muzzlePosition: new Vector3(0, 0.155, 0.69),
}

const RIFLE_ASSET_DEFINITION = ASSET_CONFIG.assets.rifle
const RIFLE_ASSET_CONFIG = {
  position: vector3FromTuple(RIFLE_ASSET_DEFINITION.transform.position),
  rotation: vector3FromTuple(RIFLE_ASSET_DEFINITION.transform.rotation),
  scaling: vector3FromTuple(RIFLE_ASSET_DEFINITION.transform.scale),
  animationSpeed: RIFLE_ASSET_DEFINITION.animation.speed,
  material: RIFLE_ASSET_DEFINITION.material,
}

try {
  scene.setRenderingAutoClearDepthStencil(1, true, true, false)
} catch (error) {
  logRuntimeWarning('Dedicated first-person depth clearing was unavailable.', error)
}

const WORLD_RENDER_LAYER_MASK = 0x0fffffff
const VIEW_MODEL_RENDER_LAYER_MASK = 0x10000000

camera.layerMask = WORLD_RENDER_LAYER_MASK
const weaponViewCamera = new TargetCamera('weaponViewCamera', Vector3.Zero(), scene, false)
weaponViewCamera.parent = camera
weaponViewCamera.minZ = 0.008
weaponViewCamera.maxZ = 10
weaponViewCamera.fov = WEAPON_VIEW_CONFIG.fov
weaponViewCamera.layerMask = VIEW_MODEL_RENDER_LAYER_MASK
weaponViewCamera.viewport = camera.viewport
scene.activeCamera = camera
scene.activeCameras = [camera, weaponViewCamera]
scene.cameraToUseForPointers = camera

// This is the only node animated by hip/ADS/recoil/sway/bob/reload. The GLB's
// complete hierarchy remains static beneath it, so loader nodes can never
// overwrite the presentation pose.
const viewModelPivot = new TransformNode('viewModelPivot', scene)
viewModelPivot.parent = weaponViewCamera

function configureFirstPersonMesh(mesh: AbstractMesh) {
  mesh.isPickable = false
  mesh.checkCollisions = false
  mesh.receiveShadows = false
  mesh.renderingGroupId = 1
  mesh.layerMask = VIEW_MODEL_RENDER_LAYER_MASK
  mesh.alwaysSelectAsActiveMesh = true
}

function optimizeImportedRifle(meshes: readonly AbstractMesh[]) {
  const materials = new Set(meshes.map((mesh) => mesh.material).filter((material) => material !== null))
  const anisotropy = isLowEndMobile ? 2 : isMobile ? 4 : 8
  for (const material of materials) {
    if (material instanceof PBRMaterial || material instanceof StandardMaterial) {
      material.maxSimultaneousLights = 2
    }
    for (const texture of material.getActiveTextures()) {
      texture.anisotropicFilteringLevel = Math.min(
        texture.anisotropicFilteringLevel,
        anisotropy,
      )
    }
  }
}

function inspectImportedRifleBounds(
  hierarchyRoot: TransformNode,
  meshes: readonly AbstractMesh[],
) {
  for (const mesh of meshes) mesh.computeWorldMatrix(true)
  const { min, max } = hierarchyRoot.getHierarchyBoundingVectors(true)
  const size = max.subtract(min)
  const center = min.add(max).scale(0.5)
  const values = [
    min.x, min.y, min.z,
    max.x, max.y, max.z,
    size.x, size.y, size.z,
    center.x, center.y, center.z,
  ]

  if (values.some((value) => !Number.isFinite(value) || Math.abs(value) > 1_000)) {
    throw new Error('The rifle GLB returned invalid authored bounds.')
  }
  if (size.x <= 0 || size.y <= 0 || size.z <= 0) {
    throw new Error('The rifle GLB returned empty authored bounds.')
  }
  const dominantAxis = size.x >= size.y && size.x >= size.z
    ? '+X'
    : size.y >= size.z ? '+Y' : '+Z'
  if (dominantAxis !== '+Z') {
    throw new Error(
      `The rifle GLB barrel must resolve to +Z after its authored wrappers; measured dominant axis ${dominantAxis}.`,
    )
  }

  console.info(
    `[Night Breach][Rifle] Complete authored bounds ${size.x.toFixed(3)} x ${size.y.toFixed(3)} x ${size.z.toFixed(3)} centered at (${center.x.toFixed(3)}, ${center.y.toFixed(3)}, ${center.z.toFixed(3)}); dominant/barrel axis ${dominantAxis}.`,
  )

  return { center, max, min, size }
}

function getUniformRifleScale() {
  const { x, y, z } = RIFLE_ASSET_CONFIG.scaling
  if (Math.abs(x - y) > 0.000001 || Math.abs(x - z) > 0.000001 || x <= 0) {
    throw new Error('The first-person rifle must use one positive uniform scale.')
  }
  return x
}

async function validateImportedRifleRendering(meshes: readonly AbstractMesh[]) {
  const compilationTasks: Promise<void>[] = []
  for (const mesh of meshes) {
    if (!mesh.material) continue
    compilationTasks.push(mesh.material.forceCompilationAsync(mesh, {
      useInstances: true,
    }))
  }

  let timeoutId: number | undefined
  try {
    await Promise.race([
      Promise.all(compilationTasks),
      new Promise<never>((_resolve, reject) => {
        timeoutId = window.setTimeout(() => {
          reject(new Error('Rifle material validation timed out.'))
        }, isMobile ? 30_000 : 15_000)
      }),
    ])
  } finally {
    if (timeoutId !== undefined) window.clearTimeout(timeoutId)
  }
}

function createProceduralRifle(parent: TransformNode) {
  const rifle = new TransformNode('proceduralRifle', scene)
  rifle.parent = parent

  const gunMetal = createMaterial(
    'rifleGunmetal',
    Color3.FromHexString('#202625'),
    0.46,
    0.86,
  )
  const coatedMetal = createMaterial(
    'rifleCoatedMetal',
    Color3.FromHexString('#303634'),
    0.62,
    0.64,
  )
  const polymer = createMaterial(
    'riflePolymer',
    Color3.FromHexString('#303630'),
    0.84,
    0.04,
  )
  const rubber = createMaterial(
    'rifleRubber',
    Color3.FromHexString('#171b19'),
    0.96,
  )
  const glass = createMaterial(
    'rifleSightGlass',
    Color3.FromHexString('#71898a'),
    0.14,
    0.06,
  )
  glass.alpha = 0.42
  glass.backFaceCulling = false

  function attachPart(
    mesh: Mesh,
    material: SurfaceMaterial,
    position: Vector3,
    rotation?: Vector3,
  ) {
    mesh.parent = rifle
    mesh.material = material
    mesh.position.copyFrom(position)
    if (rotation) mesh.rotation.copyFrom(rotation)
    configureFirstPersonMesh(mesh)
    return mesh
  }

  attachPart(
    MeshBuilder.CreateBox(
      'rifleReceiver',
      { width: 0.15, height: 0.12, depth: 0.34 },
      scene,
    ),
    gunMetal,
    new Vector3(0, 0.01, 0),
  )
  attachPart(
    MeshBuilder.CreateBox(
      'rifleHandguard',
      { width: 0.132, height: 0.11, depth: 0.34 },
      scene,
    ),
    polymer,
    new Vector3(0, 0.015, 0.32),
  )
  attachPart(
    MeshBuilder.CreateCylinder(
      'rifleBarrel',
      { height: 0.32, diameter: 0.038, tessellation: 10 },
      scene,
    ),
    gunMetal,
    new Vector3(0, 0.035, 0.65),
    new Vector3(Math.PI / 2, 0, 0),
  )
  attachPart(
    MeshBuilder.CreateCylinder(
      'rifleMuzzle',
      { height: 0.085, diameter: 0.06, tessellation: 10 },
      scene,
    ),
    coatedMetal,
    new Vector3(0, 0.035, 0.85),
    new Vector3(Math.PI / 2, 0, 0),
  )
  attachPart(
    MeshBuilder.CreateBox(
      'riflePistolGrip',
      { width: 0.09, height: 0.22, depth: 0.11 },
      scene,
    ),
    rubber,
    new Vector3(0, -0.15, -0.095),
    new Vector3(-0.2, 0, 0),
  )
  attachPart(
    MeshBuilder.CreateBox(
      'rifleMagazine',
      { width: 0.105, height: 0.24, depth: 0.135 },
      scene,
    ),
    coatedMetal,
    new Vector3(0, -0.17, 0.105),
    new Vector3(0.19, 0, 0),
  )
  attachPart(
    MeshBuilder.CreateBox(
      'rifleStock',
      { width: 0.13, height: 0.14, depth: 0.28 },
      scene,
    ),
    polymer,
    new Vector3(0, -0.005, -0.31),
  )
  attachPart(
    MeshBuilder.CreateBox(
      'rifleButtPad',
      { width: 0.145, height: 0.16, depth: 0.035 },
      scene,
    ),
    rubber,
    new Vector3(0, -0.005, -0.468),
  )
  attachPart(
    MeshBuilder.CreateBox(
      'rifleTopRail',
      { width: 0.105, height: 0.018, depth: 0.5 },
      scene,
    ),
    coatedMetal,
    new Vector3(0, 0.09, 0.16),
  )
  attachPart(
    MeshBuilder.CreateBox(
      'reflexSightBase',
      { width: 0.105, height: 0.035, depth: 0.115 },
      scene,
    ),
    gunMetal,
    new Vector3(0, 0.12, -0.015),
  )
  attachPart(
    MeshBuilder.CreateBox(
      'reflexSightFrame',
      { width: 0.11, height: 0.095, depth: 0.035 },
      scene,
    ),
    coatedMetal,
    new Vector3(0, 0.18, 0.015),
  )
  attachPart(
    MeshBuilder.CreatePlane('reflexSightGlass', { width: 0.07, height: 0.055 }, scene),
    glass,
    new Vector3(0, 0.18, -0.004),
  )

  return rifle
}

function createEmergencyRifle(parent: TransformNode) {
  const rifle = new TransformNode('emergencyRifle', scene)
  rifle.parent = parent
  const body = MeshBuilder.CreateBox(
    'emergencyRifleBody',
    { width: 0.14, height: 0.12, depth: 0.72 },
    scene,
  )
  body.parent = rifle
  body.position.z = 0.2
  body.material = darkMetalMaterial
  configureFirstPersonMesh(body)
  return rifle
}

let proceduralRifle: TransformNode | null = null

function ensureProceduralRifle() {
  if (proceduralRifle && !proceduralRifle.isDisposed()) {
    proceduralRifle.setEnabled(true)
    return proceduralRifle
  }

  try {
    proceduralRifle = createProceduralRifle(viewModelPivot)
    console.info('[Night Breach][Rifle] Procedural fallback ready.')
  } catch (error) {
    logRuntimeWarning('Procedural rifle creation failed; using emergency geometry.', error)
    scene.getTransformNodeByName('proceduralRifle')?.dispose()
    proceduralRifle = createEmergencyRifle(viewModelPivot)
    console.info('[Night Breach][Rifle] Emergency procedural fallback ready.')
  }
  canvas.dataset.weaponSource = 'procedural'
  canvas.dataset.rifleReady = 'procedural'
  canvas.dataset.weaponActiveAnimation = 'procedural'
  canvas.dataset.weaponClipNames = 'none'
  canvas.dataset.weaponSkeletonCount = '0'
  canvas.dataset.weaponBoneCount = '0'
  canvas.dataset.weaponSkinnedMeshCount = '0'
  canvas.dataset.proceduralRifle = 'active'
  canvas.dataset.visibleRifleHierarchies = '1'
  return proceduralRifle
}

ensureProceduralRifle()
console.info('[Night Breach][Rifle] Local GLB loading started with procedural fallback active.')

const muzzleFlashMaterial = new StandardMaterial('muzzleFlashMaterial', scene)
muzzleFlashMaterial.diffuseColor = new Color3(1, 0.62, 0.22)
muzzleFlashMaterial.emissiveColor = new Color3(1, 0.48, 0.12)
muzzleFlashMaterial.disableLighting = true
muzzleFlashMaterial.alpha = 0.88
muzzleFlashMaterial.disableDepthWrite = true

const muzzleFlash = MeshBuilder.CreatePlane(
  'muzzleFlash',
  { width: 0.11, height: 0.11 },
  scene,
)
muzzleFlash.parent = viewModelPivot
muzzleFlash.position.copyFrom(WEAPON_VIEW_CONFIG.muzzlePosition)
muzzleFlash.rotation.z = Math.PI / 4
muzzleFlash.material = muzzleFlashMaterial
muzzleFlash.isVisible = false
configureFirstPersonMesh(muzzleFlash)

type WeaponAnimationName = 'idle' | 'fire' | 'reload' | 'equip' | 'ads'
type WeaponAnimationMap = Partial<Record<WeaponAnimationName, AnimationGroup>>

const PROCEDURAL_RELOAD_DURATION_SECONDS = 1.05
const RELOAD_AMMO_PROGRESS = 0.56
const RELOAD_COMPLETION_GRACE_SECONDS = 0.15
const WEAPON_ANIMATION_BLEND_SPEED = 0.16

let importedAnimationGroups: AnimationGroup[] = []
let importedWeaponAnimations: WeaponAnimationMap = {}
let activeImportedWeaponAnimation: AnimationGroup | null = null
let importedRifleRoot: TransformNode | null = null
let importedRifleMeshes: AbstractMesh[] = []
let importedHierarchyRootNames: string[] = []
let disposeImportedRifleResources: (() => void) | null = null
let pendingImportedRifleFirstFrame = false

const weaponAnimationAliases: Readonly<Record<WeaponAnimationName, readonly string[]>> = {
  idle: ['idle', 'rest', 'readyloop'],
  fire: ['fire', 'shoot', 'shot', 'recoil', 'attack'],
  reload: ['reload', 'magchange', 'magazinechange', 'swapmag'],
  equip: ['equip', 'draw', 'deploy', 'raise', 'pullout'],
  ads: ['ads', 'aimdownsight', 'aim', 'scope'],
}

function detectWeaponAnimations(groups: AnimationGroup[]) {
  const detected: WeaponAnimationMap = {}
  const animationNames = Object.keys(weaponAnimationAliases) as WeaponAnimationName[]

  for (const group of groups) {
    const normalizedName = group.name.toLowerCase().replace(/[\s_.-]+/g, '')
    for (const animationName of animationNames) {
      if (detected[animationName]) continue
      const aliases = weaponAnimationAliases[animationName]
      if (aliases.some((alias) => normalizedName.includes(alias))) {
        detected[animationName] = group
      }
    }
  }
  return detected
}

function getImportedAnimationDurationSeconds(animation: AnimationGroup) {
  let durationSeconds = 0
  const speed = Math.max(0.001, Math.abs(RIFLE_ASSET_CONFIG.animationSpeed))
  for (const targetedAnimation of animation.targetedAnimations) {
    const framesPerSecond = targetedAnimation.animation.framePerSecond
    if (!Number.isFinite(framesPerSecond) || framesPerSecond <= 0) continue
    durationSeconds = Math.max(
      durationSeconds,
      Math.abs(animation.to - animation.from) / framesPerSecond / speed,
    )
  }
  return durationSeconds
}

function enableImportedAnimationBlending(animation: AnimationGroup) {
  for (const targetedAnimation of animation.targetedAnimations) {
    targetedAnimation.animation.enableBlending = true
    targetedAnimation.animation.blendingSpeed = WEAPON_ANIMATION_BLEND_SPEED
  }
}

async function loadLocalRifleModel(parent: TransformNode) {
  const result = await localAssetManager.load('rifle')
  if (result.status === 'fallback') {
    console.info('[Night Breach][Rifle] Local GLB unavailable; procedural fallback remains active.')
    return null
  }

  let entries: ReturnType<AssetContainer['instantiateModelsToScene']> | null = null
  let modelRoot: TransformNode | null = null
  try {
    entries = result.container.instantiateModelsToScene(
      (sourceName) => sourceName,
      false,
      { doNotInstantiate: false },
    )

    modelRoot = new TransformNode('localRifleModelRoot', scene)
    // Never expose an unvalidated imported model to the main render pass.
    modelRoot.setEnabled(false)
    const boundsOffsetRoot = new TransformNode('localRifleBoundsOffset', scene)
    boundsOffsetRoot.parent = modelRoot

    // Keep every loader-created node, including Babylon's __root__ handedness
    // conversion, intact. Only this dedicated offset node recenters the known
    // authored bounds; no imported node transform is normalized or rewritten.
    for (const rootNode of entries.rootNodes) rootNode.parent = boundsOffsetRoot
    const modelMeshes = boundsOffsetRoot.getChildMeshes(false)
    if (modelMeshes.length === 0) {
      throw new Error('The rifle GLB did not instantiate any renderable meshes.')
    }
    const renderableMeshCount = modelMeshes.filter((mesh) => mesh.getTotalVertices() > 0).length
    const skinnedMeshCount = modelMeshes.filter(
      (mesh) => mesh.getTotalVertices() > 0 && mesh.skeleton !== null,
    ).length

    const authoredBounds = inspectImportedRifleBounds(boundsOffsetRoot, modelMeshes)
    // Recenter only this wrapper. Every loader-created node, bone, skin, mesh,
    // and animation target keeps its exact authored local transform.
    boundsOffsetRoot.position.copyFrom(authoredBounds.center).scaleInPlace(-1)
    modelRoot.position.copyFrom(RIFLE_ASSET_CONFIG.position)
    // Model-axis correction is applied exactly once here. Hip/ADS motion lives
    // exclusively on viewModelPivot and never touches this static hierarchy.
    modelRoot.rotationQuaternion = Quaternion.FromEulerAngles(
      RIFLE_ASSET_CONFIG.rotation.x,
      RIFLE_ASSET_CONFIG.rotation.y,
      RIFLE_ASSET_CONFIG.rotation.z,
    )
    modelRoot.scaling.setAll(getUniformRifleScale())
    modelRoot.parent = parent

    modelMeshes.forEach(configureFirstPersonMesh)
    applyImportedMaterialSettings(modelMeshes, RIFLE_ASSET_CONFIG.material)
    optimizeImportedRifle(modelMeshes)
    await validateImportedRifleRendering(modelMeshes)

    importedAnimationGroups = [...entries.animationGroups]
    for (const animation of importedAnimationGroups) {
      animation.speedRatio = RIFLE_ASSET_CONFIG.animationSpeed
    }
    importedWeaponAnimations = detectWeaponAnimations(importedAnimationGroups)
    for (const animation of importedAnimationGroups) {
      enableImportedAnimationBlending(animation)
      animation.onAnimationGroupEndObservable.add(handleImportedWeaponAnimationEnd)
    }
    const reloadAnimation = importedWeaponAnimations.reload
    const detectedReloadDuration = reloadAnimation
      ? getImportedAnimationDurationSeconds(reloadAnimation)
      : 0
    reloadDurationSeconds = detectedReloadDuration > 0
      ? detectedReloadDuration
      : PROCEDURAL_RELOAD_DURATION_SECONDS
    const detectedAnimationNames = (Object.keys(importedWeaponAnimations) as WeaponAnimationName[])
    const fallbackAnimationNames = (Object.keys(weaponAnimationAliases) as WeaponAnimationName[])
      .filter((name) => !importedWeaponAnimations[name])
    const clipNames = importedAnimationGroups.map((animation) => animation.name)
    const skeletonBoneCount = entries.skeletons.reduce(
      (total, skeleton) => total + skeleton.bones.length,
      0,
    )
    if (entries.skeletons.length > 0 && skinnedMeshCount !== renderableMeshCount) {
      throw new Error(
        `The animated rifle rig detached from its meshes (${skinnedMeshCount}/${renderableMeshCount} skinned).`,
      )
    }
    const hierarchyNodes = entries.rootNodes.flatMap((rootNode) => [
      rootNode,
      ...rootNode.getDescendants(false),
    ])
    if (entries.rootNodes.some((rootNode) => rootNode.parent !== boundsOffsetRoot)) {
      throw new Error('The imported rifle hierarchy was not preserved beneath its viewmodel root.')
    }
    const activatedEntries = entries
    const activatedRoot = modelRoot
    importedRifleRoot = activatedRoot
    importedRifleMeshes = [...modelMeshes]
    importedHierarchyRootNames = entries.rootNodes.map((rootNode) => rootNode.name)
    disposeImportedRifleResources = () => {
      activatedEntries.dispose()
      if (!activatedRoot.isDisposed()) activatedRoot.dispose()
    }
    pendingImportedRifleFirstFrame = true
    canvas.dataset.weaponSource = 'glb-pending'
    canvas.dataset.rifleReady = 'validating-first-frame'
    canvas.dataset.weaponAnimations = detectedAnimationNames.join(',') || 'none'
    canvas.dataset.weaponAnimationFallbacks = fallbackAnimationNames.join(',') || 'none'
    canvas.dataset.weaponClipNames = clipNames.join(',') || 'none'
    canvas.dataset.weaponReloadDuration = reloadDurationSeconds.toFixed(6)
    canvas.dataset.weaponSkeletonCount = String(entries.skeletons.length)
    canvas.dataset.weaponBoneCount = String(skeletonBoneCount)
    canvas.dataset.weaponHierarchyNodeCount = String(hierarchyNodes.length)
    canvas.dataset.weaponMeshCount = String(renderableMeshCount)
    canvas.dataset.weaponSkinnedMeshCount = String(skinnedMeshCount)
    if (reloadElapsed >= 0) playImportedWeaponAnimation('reload')
    else if (deployed && playImportedWeaponAnimation('equip')) {
      // The equip clip returns to the appropriate idle/ADS state on completion.
    } else playImportedWeaponAnimation('idle', true)
    // Swap atomically before the next render: the procedural standby and GLB
    // are never submitted in the same frame.
    proceduralRifle?.setEnabled(false)
    activatedRoot.setEnabled(true)
    assertSingleVisibleRifleHierarchy()

    const visibleControlMesh = modelMeshes.reduce((largest, mesh) => (
      mesh.getTotalVertices() > largest.getTotalVertices() ? mesh : largest
    ))
    console.info(
      `[Night Breach][Rifle] Complete imported hierarchy:\n${hierarchyNodes.map((node) => `  ${node.name} <- ${node.parent?.name ?? '(scene)'}`).join('\n')}\n[Night Breach][Rifle] Dominant visible mesh=${visibleControlMesh.name}; authored controller=${visibleControlMesh.parent?.name ?? 'none'}; dynamic controller=${viewModelPivot.name}.`,
    )

    console.info(
      `[Night Breach][Rifle] GLB validated (${renderableMeshCount} renderable/${skinnedMeshCount} skinned meshes; ${entries.skeletons.length} skeletons/${skeletonBoneCount} bones; clips: ${clipNames.join(', ')}; mapped actions: ${detectedAnimationNames.join(', ') || 'procedural fallbacks'}); awaiting one successful render before fallback retirement.`,
    )
    return modelRoot
  } catch (error) {
    if (importedRifleRoot === modelRoot) {
      importedRifleRoot = null
      importedRifleMeshes = []
      importedHierarchyRootNames = []
      disposeImportedRifleResources = null
      pendingImportedRifleFirstFrame = false
    }
    for (const animation of importedAnimationGroups) animation.stop(true)
    importedAnimationGroups = []
    importedWeaponAnimations = {}
    activeImportedWeaponAnimation = null
    try {
      entries?.dispose()
      modelRoot?.dispose()
    } catch (disposeError) {
      logRuntimeWarning('[Rifle] Partial GLB cleanup was skipped.', disposeError)
    }
    ensureProceduralRifle()
    canvas.dataset.weaponSource = 'procedural'
    canvas.dataset.rifleReady = 'procedural'
    logRuntimeWarning('[Rifle] GLB setup failed; procedural fallback remains active.', error)
    return null
  }
}

void loadLocalRifleModel(viewModelPivot).catch((error) => {
  canvas.dataset.weaponSource = 'procedural'
  canvas.dataset.rifleReady = 'procedural'
  logRuntimeWarning('[Rifle] Unexpected load failure; procedural fallback remains active.', error)
})

function activateProceduralRifleFallback(context: string, error: unknown) {
  importedRifleRoot?.setEnabled(false)
  for (const animation of importedAnimationGroups) animation.stop(true)
  try {
    disposeImportedRifleResources?.()
  } catch (disposeError) {
    logRuntimeWarning('[Rifle] Failed GLB cleanup was skipped.', disposeError)
  }
  importedRifleRoot = null
  importedRifleMeshes = []
  importedHierarchyRootNames = []
  disposeImportedRifleResources = null
  pendingImportedRifleFirstFrame = false
  importedAnimationGroups = []
  importedWeaponAnimations = {}
  activeImportedWeaponAnimation = null
  ensureProceduralRifle()
  canvas.dataset.weaponSource = 'procedural'
  canvas.dataset.rifleReady = 'procedural'
  canvas.dataset.weaponAnimations = 'none'
  canvas.dataset.weaponAnimationFallbacks = 'idle,fire,reload,equip,ads'
  assertSingleVisibleRifleHierarchy()
  logRuntimeWarning(`[Rifle] ${context}; procedural fallback restored.`, error)
}

function assertSingleVisibleRifleHierarchy() {
  const visibleRoots: string[] = []
  if (proceduralRifle?.isEnabled() && !proceduralRifle.isDisposed()) {
    visibleRoots.push(proceduralRifle.name)
  }
  if (importedRifleRoot?.isEnabled()) visibleRoots.push(importedRifleRoot.name)
  canvas.dataset.visibleRifleHierarchies = String(visibleRoots.length)
  if (visibleRoots.length !== 1) {
    throw new Error(
      `Expected exactly one visible rifle hierarchy; found ${visibleRoots.length} (${visibleRoots.join(', ') || 'none'}).`,
    )
  }
  return visibleRoots[0]
}

function measureImportedRifleScreenBounds() {
  if (importedRifleMeshes.length === 0) return null

  weaponViewCamera.computeWorldMatrix()
  weaponViewCamera.getViewMatrix()
  weaponViewCamera.getProjectionMatrix(true)
  const viewport = weaponViewCamera.viewport.toGlobal(
    engine.getRenderWidth(),
    engine.getRenderHeight(),
  )
  const cameraTransform = weaponViewCamera.getTransformationMatrix()
  let minimumX = Number.POSITIVE_INFINITY
  let minimumY = Number.POSITIVE_INFINITY
  let maximumX = Number.NEGATIVE_INFINITY
  let maximumY = Number.NEGATIVE_INFINITY

  for (const mesh of importedRifleMeshes) {
    const positions = mesh.getVerticesData('position')
    if (!positions) continue
    const world = mesh.computeWorldMatrix(true)
    for (let index = 0; index < positions.length; index += 3) {
      const projected = Vector3.Project(
        new Vector3(positions[index], positions[index + 1], positions[index + 2]),
        world,
        cameraTransform,
        viewport,
      )
      if (!Number.isFinite(projected.x)
        || !Number.isFinite(projected.y)
        || projected.z < 0
        || projected.z > 1) continue
      minimumX = Math.min(minimumX, projected.x)
      minimumY = Math.min(minimumY, projected.y)
      maximumX = Math.max(maximumX, projected.x)
      maximumY = Math.max(maximumY, projected.y)
    }
  }

  if (![minimumX, minimumY, maximumX, maximumY].every(Number.isFinite)) return null
  const visibleMinimumX = Math.max(viewport.x, minimumX)
  const visibleMinimumY = Math.max(viewport.y, minimumY)
  const visibleMaximumX = Math.min(viewport.x + viewport.width, maximumX)
  const visibleMaximumY = Math.min(viewport.y + viewport.height, maximumY)
  return {
    x: visibleMinimumX,
    y: visibleMinimumY,
    width: Math.max(0, visibleMaximumX - visibleMinimumX),
    height: Math.max(0, visibleMaximumY - visibleMinimumY),
    widthPercent: Math.max(0, visibleMaximumX - visibleMinimumX) / viewport.width * 100,
  }
}

function formatTransformVector(value: Vector3) {
  return `(${value.x.toFixed(3)}, ${value.y.toFixed(3)}, ${value.z.toFixed(3)})`
}

function logFinalImportedRiflePresentation() {
  const activeRoot = importedRifleRoot
  const screenBounds = measureImportedRifleScreenBounds()
  if (!activeRoot || !screenBounds) return
  const activeRootRotation = activeRoot.rotationQuaternion?.toEulerAngles()
    ?? activeRoot.rotation
  const visibleRoot = assertSingleVisibleRifleHierarchy()
  canvas.dataset.rifleScreenWidth = screenBounds.widthPercent.toFixed(1)
  console.info(
    `[Night Breach][Rifle] Final active rifle root=${activeRoot.name}; GLB roots=${importedHierarchyRootNames.join(', ')}; root position=${formatTransformVector(activeRoot.position)} rotation=${formatTransformVector(activeRootRotation)} scale=${formatTransformVector(activeRoot.scaling)}; controller=${viewModelPivot.name} position=${formatTransformVector(viewModelPivot.position)} rotation=${formatTransformVector(viewModelPivot.rotation)} scale=${formatTransformVector(viewModelPivot.scaling)}; screen bounds=(${screenBounds.x.toFixed(1)}, ${screenBounds.y.toFixed(1)}, ${screenBounds.width.toFixed(1)}, ${screenBounds.height.toFixed(1)}) ${screenBounds.widthPercent.toFixed(1)}% width; visible hierarchy=${visibleRoot}.`,
  )
}

function playImportedWeaponAnimation(
  name: WeaponAnimationName,
  loop = false,
  reverse = false,
  resetBeforeStart = false,
) {
  const animation = importedWeaponAnimations[name]
  if (!animation) return false

  for (const group of importedAnimationGroups) {
    if (group.isStarted) group.stop(true)
  }
  // AnimationGroup.reset() rewinds every authored track before a fresh action.
  // This is especially important for repeat reloads after the prior group ended.
  if (resetBeforeStart) animation.reset()
  animation.start(
    loop,
    reverse ? -RIFLE_ASSET_CONFIG.animationSpeed : RIFLE_ASSET_CONFIG.animationSpeed,
    animation.from,
    animation.to,
    false,
  )
  activeImportedWeaponAnimation = animation
  canvas.dataset.weaponActiveAnimation = animation.name
  return true
}

function playImportedWeaponRestAnimation() {
  if (adsHeld && playImportedWeaponAnimation('ads')) return
  playImportedWeaponAnimation('idle', true)
}

function handleImportedWeaponAnimationEnd(animation: AnimationGroup) {
  if (activeImportedWeaponAnimation !== animation) return
  activeImportedWeaponAnimation = null

  if (animation === importedWeaponAnimations.reload) {
    completeReload()
    return
  }
  if (animation === importedWeaponAnimations.ads) {
    if (!adsHeld) playImportedWeaponAnimation('idle', true)
    return
  }
  if (reloadElapsed >= 0) return
  if (animation === importedWeaponAnimations.fire
    || animation === importedWeaponAnimations.equip) {
    playImportedWeaponRestAnimation()
  }
}

equipWeapon = () => {
  if (!playImportedWeaponAnimation('equip')) playImportedWeaponRestAnimation()
}

let magazineAmmo = 30
let reserveAmmo = 120
let recoilAmount = 0
let muzzleFlashRemaining = 0
let reloadElapsed = -1
let reloadApplied = false
let reloadDurationSeconds = PROCEDURAL_RELOAD_DURATION_SECONDS
let crosshairTimer: number | undefined
let hitMarkerTimer: number | undefined
let headshotTimer: number | undefined
let movementPointerId: number | null = null
let aimPointerId: number | null = null
let firePointerId: number | null = null
let adsPointerId: number | null = null
let moveInputX = 0
let moveInputY = 0
let joystickCenterX = 0
let joystickCenterY = 0
let joystickRadius = 1
let aimLastX = 0
let aimLastY = 0
let automaticFireHeld = false
let automaticFireCooldown = 0
let adsHeld = false
let adsBlend = 0
const weaponRay = new Ray(Vector3.Zero(), Vector3.Forward(), 100)

function updateAmmoDisplay() {
  ammoDisplay.textContent = `${magazineAmmo}/${reserveAmmo}`
}

function pulseCrosshair() {
  crosshair.classList.remove('firing')
  void crosshair.offsetWidth
  crosshair.classList.add('firing')
  if (crosshairTimer !== undefined) window.clearTimeout(crosshairTimer)
  crosshairTimer = window.setTimeout(hideCrosshairPulse, 75)
}

function hideCrosshairPulse() {
  crosshair.classList.remove('firing')
}

function showHitMarker() {
  hitMarker.classList.remove('visible')
  void hitMarker.offsetWidth
  hitMarker.classList.add('visible')
  if (hitMarkerTimer !== undefined) window.clearTimeout(hitMarkerTimer)
  hitMarkerTimer = window.setTimeout(hideHitMarker, 95)
}

function hideHitMarker() {
  hitMarker.classList.remove('visible')
}

function showHeadshotIndicator() {
  headshotIndicator.classList.remove('visible')
  void headshotIndicator.offsetWidth
  headshotIndicator.classList.add('visible')
  if (headshotTimer !== undefined) window.clearTimeout(headshotTimer)
  headshotTimer = window.setTimeout(hideHeadshotIndicator, 260)
}

function hideHeadshotIndicator() {
  headshotIndicator.classList.remove('visible')
}

function hitZombieWithBullet(
  hitZone: ZombieHitZone,
  hitPoint: Vector3,
  bulletDirection: Vector3,
) {
  if (!hitZone.zombie.applyHit(hitZone.zone, bulletDirection)) return false
  const headshot = hitZone.zone === 'head'
  bloodEffectPool.spawn(hitPoint, bulletDirection, headshot)
  showHitMarker()
  if (headshot) {
    showHeadshotIndicator()
    // Keep the headshot impulse beneath a single mobile render frame.
    camera.cameraRotation.x -= 0.0035
    camera.cameraRotation.y += (Math.random() - 0.5) * 0.004
  }
  return true
}

function beginReload() {
  if (gameOver || reloadElapsed >= 0 || magazineAmmo >= 30 || reserveAmmo <= 0) return
  stopAutomaticFire()
  reloadElapsed = 0
  reloadApplied = false
  reloadButton.disabled = true
  if (!playImportedWeaponAnimation('reload', false, false, true)) {
    reloadDurationSeconds = PROCEDURAL_RELOAD_DURATION_SECONDS
  }
}

function applyReloadAmmo() {
  if (reloadApplied) return
  const needed = 30 - magazineAmmo
  const loaded = Math.min(needed, reserveAmmo)
  magazineAmmo += loaded
  reserveAmmo -= loaded
  reloadApplied = true
  updateAmmoDisplay()
}

function completeReload() {
  if (reloadElapsed < 0) return
  applyReloadAmmo()
  const reloadAnimation = importedWeaponAnimations.reload
  if (reloadAnimation?.isStarted) reloadAnimation.stop(true)
  reloadElapsed = -1
  reloadButton.disabled = false
  // Idle's authored tracks have blending enabled, so they interpolate from the
  // last reload frame instead of leaving the rig clamped in that pose.
  playImportedWeaponRestAnimation()
}

function hitTarget(target: TargetState) {
  target.hits += 1
  setMaterialColor(target.material, dummyHitColor, dummyHitEmissive)
  showHitMarker()

  if (target.flashTimer !== undefined) window.clearTimeout(target.flashTimer)

  if (target.hits >= 3) {
    for (let index = 0; index < target.meshes.length; index += 1) {
      targets.delete(target.meshes[index])
    }
    target.flashTimer = window.setTimeout(disposeTrainingTarget, 90, target)
    return
  }

  target.flashTimer = window.setTimeout(restoreTrainingTarget, 120, target)
}

function restoreTrainingTarget(target: TargetState) {
  setMaterialColor(target.material, dummyColor)
}

function disposeTrainingTarget(target: TargetState) {
  target.root.dispose()
  target.material.dispose()
}

function fire() {
  if (gameOver || magazineAmmo <= 0 || reloadElapsed >= 0) return

  magazineAmmo -= 1
  if (!playImportedWeaponAnimation('fire')) {
    const recoilScale = 1 - adsBlend * 0.28
    recoilAmount = Math.min(0.038, recoilAmount + 0.026 * recoilScale)
  }
  muzzleFlashRemaining = 0.045
  muzzleFlash.isVisible = true
  pulseCrosshair()
  updateAmmoDisplay()

  camera.getForwardRayToRef(weaponRay, 100)
  if (isTouchDevice) {
    const spread = TOUCH_CONFIG.hipSpread
      + (TOUCH_CONFIG.adsSpread - TOUCH_CONFIG.hipSpread) * adsBlend
    weaponRay.direction.x += (Math.random() * 2 - 1) * spread
    weaponRay.direction.y += (Math.random() * 2 - 1) * spread
    weaponRay.direction.z += (Math.random() * 2 - 1) * spread
    weaponRay.direction.normalize()
  }
  const result = scene.pickWithRay(weaponRay)
  if (!result?.hit || !result.pickedMesh) return

  const zombieHit = zombieHitZones.get(result.pickedMesh as Mesh)
  if (zombieHit && hitZombieWithBullet(
    zombieHit,
    result.pickedPoint ?? result.pickedMesh.getAbsolutePosition(),
    weaponRay.direction,
  )) {
    return
  }

  const target = targets.get(result.pickedMesh as Mesh)
  if (target) hitTarget(target)
}

fireWeapon = fire
reloadWeapon = beginReload

function capturePointerSafely(element: HTMLElement, pointerId: number) {
  try {
    element.setPointerCapture(pointerId)
  } catch (error) {
    logRuntimeWarning('Pointer capture was unavailable in this browser.', error)
  }
}

function updateJoystick(clientX: number, clientY: number) {
  let offsetX = clientX - joystickCenterX
  let offsetY = clientY - joystickCenterY
  const distance = Math.hypot(offsetX, offsetY)
  if (distance > joystickRadius) {
    const limitScale = joystickRadius / distance
    offsetX *= limitScale
    offsetY *= limitScale
  }

  joystickKnob.style.setProperty('--stick-x', `${offsetX}px`)
  joystickKnob.style.setProperty('--stick-y', `${offsetY}px`)

  const limitedDistance = Math.min(distance, joystickRadius)
  const normalizedDistance = limitedDistance / joystickRadius
  if (normalizedDistance <= TOUCH_CONFIG.joystickDeadZone || distance === 0) {
    moveInputX = 0
    moveInputY = 0
    return
  }

  const strength = (normalizedDistance - TOUCH_CONFIG.joystickDeadZone)
    / (1 - TOUCH_CONFIG.joystickDeadZone)
  moveInputX = offsetX / Math.max(limitedDistance, 0.001) * strength
  moveInputY = -offsetY / Math.max(limitedDistance, 0.001) * strength
}

function resetJoystick(pointerId?: number) {
  if (pointerId !== undefined && pointerId !== movementPointerId) return
  movementPointerId = null
  moveInputX = 0
  moveInputY = 0
  joystickKnob.classList.add('returning')
  joystickKnob.style.setProperty('--stick-x', '0px')
  joystickKnob.style.setProperty('--stick-y', '0px')
}

function stopAutomaticFire(pointerId?: number) {
  if (pointerId !== undefined && pointerId !== firePointerId) return
  firePointerId = null
  automaticFireHeld = false
  automaticFireCooldown = 0
  fireButton.classList.remove('active')
}

function releaseAds(pointerId?: number) {
  if (pointerId !== undefined && pointerId !== adsPointerId) return
  adsPointerId = null
  adsHeld = false
  playImportedWeaponAnimation('ads', false, true)
  adsButton.classList.remove('active')
  document.body.classList.remove('ads-active')
}

cancelMobileInput = () => {
  resetJoystick()
  aimPointerId = null
  stopAutomaticFire()
  releaseAds()
}

movementControl.addEventListener('pointerdown', (event) => {
  if (!isTouchDevice || !gameplayInputEnabled() || movementPointerId !== null) return
  event.preventDefault()
  event.stopPropagation()
  movementPointerId = event.pointerId
  capturePointerSafely(movementControl, event.pointerId)
  const bounds = movementControl.getBoundingClientRect()
  joystickCenterX = bounds.left + bounds.width * 0.5
  joystickCenterY = bounds.top + bounds.height * 0.5
  joystickRadius = Math.max(1, bounds.width * 0.28)
  joystickKnob.classList.remove('returning')
  updateJoystick(event.clientX, event.clientY)
}, { passive: false })

movementControl.addEventListener('pointermove', (event) => {
  if (event.pointerId !== movementPointerId) return
  event.preventDefault()
  updateJoystick(event.clientX, event.clientY)
}, { passive: false })

const endJoystick = (event: PointerEvent) => {
  if (event.pointerId !== movementPointerId) return
  event.preventDefault()
  resetJoystick(event.pointerId)
}
movementControl.addEventListener('pointerup', endJoystick, { passive: false })
movementControl.addEventListener('pointercancel', endJoystick, { passive: false })
movementControl.addEventListener('lostpointercapture', endJoystick)

lookArea.addEventListener('pointerdown', (event) => {
  if (!isTouchDevice || !gameplayInputEnabled() || aimPointerId !== null) return
  event.preventDefault()
  aimPointerId = event.pointerId
  aimLastX = event.clientX
  aimLastY = event.clientY
  capturePointerSafely(lookArea, event.pointerId)
}, { passive: false })

lookArea.addEventListener('pointermove', (event) => {
  if (event.pointerId !== aimPointerId || !gameplayInputEnabled()) return
  event.preventDefault()
  const deltaX = event.clientX - aimLastX
  const deltaY = event.clientY - aimLastY
  aimLastX = event.clientX
  aimLastY = event.clientY
  const sensitivity = TOUCH_CONFIG.lookSensitivity
    * (1 - adsBlend * (1 - TOUCH_CONFIG.adsLookSensitivityMultiplier))
  camera.rotation.y += deltaX * sensitivity
  camera.rotation.x = clamp(
    camera.rotation.x + deltaY * sensitivity,
    -Math.PI * 0.47,
    Math.PI * 0.47,
  )
}, { passive: false })

const endAim = (event: PointerEvent) => {
  if (event.pointerId !== aimPointerId) return
  event.preventDefault()
  aimPointerId = null
}
lookArea.addEventListener('pointerup', endAim, { passive: false })
lookArea.addEventListener('pointercancel', endAim, { passive: false })
lookArea.addEventListener('lostpointercapture', endAim)

fireButton.addEventListener('pointerdown', (event) => {
  if (!isTouchDevice || !gameplayInputEnabled() || firePointerId !== null) return
  event.preventDefault()
  event.stopPropagation()
  firePointerId = event.pointerId
  automaticFireHeld = true
  automaticFireCooldown = TOUCH_CONFIG.automaticFireInterval
  fireButton.classList.add('active')
  capturePointerSafely(fireButton, event.pointerId)
  fireWeapon()
}, { passive: false })

const endAutomaticFire = (event: PointerEvent) => {
  if (event.pointerId !== firePointerId) return
  event.preventDefault()
  stopAutomaticFire(event.pointerId)
}
fireButton.addEventListener('pointerup', endAutomaticFire, { passive: false })
fireButton.addEventListener('pointercancel', endAutomaticFire, { passive: false })
fireButton.addEventListener('lostpointercapture', endAutomaticFire)

adsButton.addEventListener('pointerdown', (event) => {
  if (!isTouchDevice || !gameplayInputEnabled() || adsPointerId !== null) return
  event.preventDefault()
  event.stopPropagation()
  adsPointerId = event.pointerId
  adsHeld = true
  playImportedWeaponAnimation('ads')
  adsButton.classList.add('active')
  document.body.classList.add('ads-active')
  capturePointerSafely(adsButton, event.pointerId)
}, { passive: false })

const endAds = (event: PointerEvent) => {
  if (event.pointerId !== adsPointerId) return
  event.preventDefault()
  releaseAds(event.pointerId)
}
adsButton.addEventListener('pointerup', endAds, { passive: false })
adsButton.addEventListener('pointercancel', endAds, { passive: false })
adsButton.addEventListener('lostpointercapture', endAds)

reloadButton.addEventListener('pointerdown', (event) => {
  if (!isTouchDevice || !gameplayInputEnabled() || reloadButton.disabled) return
  event.preventDefault()
  event.stopPropagation()
  reloadButton.classList.add('active')
  reloadWeapon()
  window.setTimeout(deactivateReloadButton, 90)
}, { passive: false })

function deactivateReloadButton() {
  reloadButton.classList.remove('active')
}

const previousCameraPosition = camera.position.clone()
const previousCameraRotation = camera.rotation.clone()
let swayX = 0
let swayY = 0
let bobBlend = 0
let bobTime = 0

function damp(current: number, target: number, speed: number, deltaSeconds: number) {
  return current + (target - current) * (1 - Math.exp(-speed * deltaSeconds))
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value))
}

function restartPrototype() {
  if (!gameOver) return

  resetZombieWave()
  bloodEffectPool.reset()
  playerHealth = PLAYER_MAX_HEALTH
  updateHealthDisplay()
  magazineAmmo = 30
  reserveAmmo = 120
  reloadElapsed = -1
  reloadApplied = false
  recoilAmount = 0
  muzzleFlashRemaining = 0
  muzzleFlash.isVisible = false
  reloadButton.disabled = false
  updateAmmoDisplay()
  if (!playImportedWeaponAnimation('equip')) playImportedWeaponRestAnimation()

  if (damageIndicatorTimer !== undefined) window.clearTimeout(damageIndicatorTimer)
  damageIndicator.classList.remove('visible')
  hitMarker.classList.remove('visible')
  headshotIndicator.classList.remove('visible')
  crosshair.classList.remove('firing')

  camera.position.copyFrom(PLAYER_START_POSITION)
  camera.setTarget(PLAYER_START_TARGET)
  camera.cameraDirection.set(0, 0, 0)
  camera.cameraRotation.set(0, 0)
  previousCameraPosition.copyFrom(camera.position)
  previousCameraRotation.copyFrom(camera.rotation)
  swayX = 0
  swayY = 0
  bobBlend = 0
  bobTime = 0

  gameOver = false
  startZombieWave()
  document.body.classList.remove('game-over')
  retryOverlay.setAttribute('aria-hidden', 'true')
  startCameraControls()
  canvas.focus()
  requestLandscapeSafely()
  requestPointerLockSafely()
}

retryButton.addEventListener('click', restartPrototype)

scene.onBeforeRenderObservable.add(() => {
  const deltaSeconds = Math.min(engine.getDeltaTime() / 1000, 0.05)
  const inputEnabled = gameplayInputEnabled()

  adsBlend = damp(adsBlend, adsHeld && inputEnabled ? 1 : 0, 12, deltaSeconds)
  camera.fov = damp(
    camera.fov,
    TOUCH_CONFIG.hipFov + (TOUCH_CONFIG.adsFov - TOUCH_CONFIG.hipFov) * adsBlend,
    11,
    deltaSeconds,
  )

  if (isTouchDevice && inputEnabled) {
    if (automaticFireHeld) {
      automaticFireCooldown -= deltaSeconds
      if (automaticFireCooldown <= 0) {
        fireWeapon()
        automaticFireCooldown += TOUCH_CONFIG.automaticFireInterval
      }
    }

    if (moveInputX !== 0 || moveInputY !== 0) {
      const yawSine = Math.sin(camera.rotation.y)
      const yawCosine = Math.cos(camera.rotation.y)
      const movementScale = camera.speed * Math.min(deltaSeconds * 60, 1.5)
      camera.cameraDirection.x += (
        yawCosine * moveInputX + yawSine * moveInputY
      ) * movementScale
      camera.cameraDirection.z += (
        -yawSine * moveInputX + yawCosine * moveInputY
      ) * movementScale
    }
  }

  const yawDelta = Math.atan2(
    Math.sin(camera.rotation.y - previousCameraRotation.y),
    Math.cos(camera.rotation.y - previousCameraRotation.y),
  )
  const pitchDelta = camera.rotation.x - previousCameraRotation.x
  previousCameraRotation.copyFrom(camera.rotation)

  swayX = damp(swayX, clamp(-yawDelta * 0.75, -0.018, 0.018), 13, deltaSeconds)
  swayY = damp(swayY, clamp(pitchDelta * 0.65, -0.012, 0.012), 13, deltaSeconds)

  const horizontalMovement = Math.hypot(
    camera.position.x - previousCameraPosition.x,
    camera.position.z - previousCameraPosition.z,
  )
  previousCameraPosition.copyFrom(camera.position)
  const moving = deployed && horizontalMovement > 0.0005
  bobBlend = damp(bobBlend, moving ? 1 : 0, 8, deltaSeconds)
  if (moving) bobTime += deltaSeconds * 8.2

  const bobX = Math.sin(bobTime) * 0.006 * bobBlend
  const bobY = -Math.abs(Math.cos(bobTime)) * 0.005 * bobBlend

  recoilAmount = damp(recoilAmount, 0, 19, deltaSeconds)
  muzzleFlashRemaining = Math.max(0, muzzleFlashRemaining - deltaSeconds)
  muzzleFlash.isVisible = muzzleFlashRemaining > 0

  let reloadPositionX = 0
  let reloadPositionY = 0
  let reloadRotationX = 0
  let reloadRotationZ = 0
  if (reloadElapsed >= 0) {
    reloadElapsed += deltaSeconds
    const progress = clamp(reloadElapsed / reloadDurationSeconds, 0, 1)
    const arc = Math.sin(progress * Math.PI)
    if (!importedWeaponAnimations.reload) {
      reloadPositionX = 0.018 * arc
      reloadPositionY = -0.065 * arc
      reloadRotationX = 0.075 * arc
      reloadRotationZ = 0.16 * arc
    }
    if (progress >= RELOAD_AMMO_PROGRESS) applyReloadAmmo()
    if (!importedWeaponAnimations.reload && progress >= 1) {
      completeReload()
    } else if (reloadElapsed
      >= reloadDurationSeconds + RELOAD_COMPLETION_GRACE_SECONDS) {
      // The AnimationGroup end observable is authoritative. This duration-based
      // watchdog prevents a suspended/malformed clip from locking reload state.
      completeReload()
    }
  }

  const basePositionX = WEAPON_VIEW_CONFIG.position.x
    + (WEAPON_VIEW_CONFIG.adsPosition.x - WEAPON_VIEW_CONFIG.position.x) * adsBlend
  const basePositionY = WEAPON_VIEW_CONFIG.position.y
    + (WEAPON_VIEW_CONFIG.adsPosition.y - WEAPON_VIEW_CONFIG.position.y) * adsBlend
  const basePositionZ = WEAPON_VIEW_CONFIG.position.z
    + (WEAPON_VIEW_CONFIG.adsPosition.z - WEAPON_VIEW_CONFIG.position.z) * adsBlend
  const baseRotationX = WEAPON_VIEW_CONFIG.rotation.x
    + (WEAPON_VIEW_CONFIG.adsRotation.x - WEAPON_VIEW_CONFIG.rotation.x) * adsBlend
  const baseRotationY = WEAPON_VIEW_CONFIG.rotation.y
    + (WEAPON_VIEW_CONFIG.adsRotation.y - WEAPON_VIEW_CONFIG.rotation.y) * adsBlend
  const baseRotationZ = WEAPON_VIEW_CONFIG.rotation.z
    + (WEAPON_VIEW_CONFIG.adsRotation.z - WEAPON_VIEW_CONFIG.rotation.z) * adsBlend
  const adsStability = 1 - adsBlend * 0.58

  viewModelPivot.position.set(
    basePositionX + (swayX + bobX) * adsStability + reloadPositionX,
    basePositionY + (swayY + bobY) * adsStability + reloadPositionY,
    basePositionZ - recoilAmount * 0.8,
  )
  viewModelPivot.rotation.set(
    baseRotationX - recoilAmount * 0.9 + reloadRotationX,
    baseRotationY + swayX * 1.25 * adsStability,
    baseRotationZ - bobX * 1.6 * adsStability + reloadRotationZ,
  )
})

let renderRecoveryAttempted = false
let renderLoopRunning = false
let firstFrameRendered = false
let renderFailureCount = 0
const pausedWeaponAnimations: AnimationGroup[] = []

function renderFrame() {
  try {
    scene.render()
    renderFailureCount = 0
    if (!firstFrameRendered) {
      firstFrameRendered = true
      canvas.dataset.firstFrameRendered = 'true'
      console.info('[Night Breach][Render] First scene frame rendered successfully.')
    }
    if (pendingImportedRifleFirstFrame) {
      pendingImportedRifleFirstFrame = false
      canvas.dataset.weaponSource = 'glb'
      canvas.dataset.rifleReady = 'glb'
      proceduralRifle?.dispose()
      proceduralRifle = null
      canvas.dataset.proceduralRifle = 'disposed'
      assertSingleVisibleRifleHierarchy()
      logFinalImportedRiflePresentation()
      console.info('[Night Breach][Rifle] First GLB frame succeeded; procedural rifle removed from the scene.')
    }
  } catch (error) {
    renderFailureCount += 1
    if (importedRifleRoot) {
      activateProceduralRifleFallback('Imported GLB caused a render failure', error)
      return
    }

    if (!renderRecoveryAttempted && shadowGenerator) {
      renderRecoveryAttempted = true
      logRuntimeWarning('Rendering failed with shadows; disabling shadows and retrying.', error)
      shadowGenerator.dispose()
      shadowGenerator = null
      return
    }

    if (renderFailureCount === 1 || renderFailureCount % 120 === 0) {
      logRuntimeError('Render frame failed; the render loop remains active for recovery:', error)
    }
  }
}

function setRenderLoopActive(active: boolean) {
  if (active === renderLoopRunning) return
  if (active) {
    engine.runRenderLoop(renderFrame)
    console.info('[Night Breach][Render] Render loop started.')
  } else {
    engine.stopRenderLoop(renderFrame)
    console.info('[Night Breach][Render] Render loop paused by page lifecycle.')
  }
  renderLoopRunning = active
  canvas.dataset.renderLoop = active ? 'running' : 'paused'
}

function setWebViewActive(active: boolean) {
  const nextActive = active
  if (nextActive === webViewActive) return

  webViewActive = nextActive
  canvas.dataset.webViewActive = String(nextActive)

  if (!nextActive) {
    cancelMobileInput()
    if (isDesktop && deployed && !gameOver) stopCameraControls()
    for (let index = 0; index < zombies.length; index += 1) {
      zombies[index].setPaused(true)
    }
    pausedWeaponAnimations.length = 0
    for (let index = 0; index < importedAnimationGroups.length; index += 1) {
      const animation = importedAnimationGroups[index]
      if (!animation.isPlaying) continue
      animation.pause()
      pausedWeaponAnimations.push(animation)
    }
  } else {
    for (let index = 0; index < zombies.length; index += 1) {
      zombies[index].setPaused(!deployed || gameOver)
    }
    for (let index = 0; index < pausedWeaponAnimations.length; index += 1) {
      pausedWeaponAnimations[index].restart()
    }
    pausedWeaponAnimations.length = 0
    if (isDesktop && deployed && !gameOver) startCameraControls()
  }

  setRenderLoopActive(nextActive)
}

function handleWebViewBlur() {
  // Mobile Safari can blur the page while its browser chrome is focused even
  // though the game remains fully visible. Visibility/pagehide handle real
  // mobile backgrounding without leaving a visible canvas permanently paused.
  if (isDesktop) setWebViewActive(false)
}

function handleWebViewFocus() {
  setWebViewActive(true)
}

function handleVisibilityChange() {
  setWebViewActive(!document.hidden)
}

window.addEventListener('blur', handleWebViewBlur)
window.addEventListener('focus', handleWebViewFocus)
window.addEventListener('pagehide', () => setWebViewActive(false))
window.addEventListener('pageshow', handleWebViewFocus)
document.addEventListener('visibilitychange', handleVisibilityChange)

canvas.dataset.webViewActive = String(webViewActive)
// Do not gate the first frame on an occasionally stale mobile visibility flag.
setRenderLoopActive(true)

// Vite removes this entire block from production. It gives the runtime smoke
// test read-only state plus narrowly scoped combat setup helpers in development.
if (import.meta.env.DEV) {
  Object.defineProperty(window, '__nightBreachTest', {
    configurable: true,
    value: {
      snapshot() {
        const blood = bloodEffectPool.snapshot()
        return {
          activeZombieCount,
          adsHeld,
          aimPointerId,
          ammo: `${magazineAmmo}/${reserveAmmo}`,
          automaticFireHeld,
          blood: {
            activeParticles: blood.activeParticles,
            activeDecals: blood.activeDecals,
            burstCount: blood.burstCount,
            decalLimit: blood.decalLimit,
            headshot: blood.headshot,
            origin: {
              x: blood.origin.x,
              y: blood.origin.y,
              z: blood.origin.z,
            },
            particleCount: blood.particleCount,
            poolCapacity: blood.poolCapacity,
          },
          cameraPitch: camera.rotation.x,
          cameraPosition: {
            x: camera.position.x,
            y: camera.position.y,
            z: camera.position.z,
          },
          cameraYaw: camera.rotation.y,
          deployed,
          firePointerId,
          gameOver,
          health: playerHealth,
          wave: { ...waveState },
          movementPointerId,
          moveInputX,
          moveInputY,
          mapReady: canvas.dataset.mapReady === 'true',
          reloadElapsed,
          reloadDuration: reloadDurationSeconds,
          reloadEndObserverCount:
            importedWeaponAnimations.reload?.onAnimationGroupEndObservable.observers.length ?? 0,
          renderLoop: canvas.dataset.renderLoop,
          rifleReady: canvas.dataset.rifleReady,
          zombieAnimationMapping: canvas.dataset.zombieAnimationMapping ?? 'none',
          zombieBoneCount: Number(canvas.dataset.zombieBoneCount ?? 0),
          zombieClipNames: canvas.dataset.zombieClipNames ?? 'none',
          zombieFinalRotation: canvas.dataset.zombieFinalRotation ?? 'none',
          zombieFinalScale: Number(canvas.dataset.zombieFinalScale ?? 0),
          zombieMeshCount: Number(canvas.dataset.zombieMeshCount ?? 0),
          zombieSkeletonCount: Number(canvas.dataset.zombieSkeletonCount ?? 0),
          zombieSkinnedMeshCount: Number(canvas.dataset.zombieSkinnedMeshCount ?? 0),
          weaponActiveAnimation: canvas.dataset.weaponActiveAnimation,
          weaponBoneCount: Number(canvas.dataset.weaponBoneCount ?? 0),
          weaponClipNames: canvas.dataset.weaponClipNames ?? 'none',
          weaponHierarchyNodeCount: Number(canvas.dataset.weaponHierarchyNodeCount ?? 0),
          weaponMeshCount: Number(canvas.dataset.weaponMeshCount ?? 0),
          weaponSkeletonCount: Number(canvas.dataset.weaponSkeletonCount ?? 0),
          weaponSkinnedMeshCount: Number(canvas.dataset.weaponSkinnedMeshCount ?? 0),
          viewModelPosition: {
            x: viewModelPivot.position.x,
            y: viewModelPivot.position.y,
            z: viewModelPivot.position.z,
          },
          viewModelRotation: {
            x: viewModelPivot.rotation.x,
            y: viewModelPivot.rotation.y,
            z: viewModelPivot.rotation.z,
          },
          visibleRifleHierarchies: Number(canvas.dataset.visibleRifleHierarchies ?? 0),
          weaponSource: canvas.dataset.weaponSource,
          webViewActive,
          zombies: zombies.map((zombie) => ({
            animation: zombie.activeAnimationName,
            corpseGrounded: zombie.corpseGrounded,
            disposed: zombie.root.isDisposed(),
            health: zombie.currentHealth,
            position: {
              x: zombie.root.position.x,
              z: zombie.root.position.z,
            },
            state: zombie.state,
            upperBodyPush: zombie.upperBodyPushAmount,
          })),
        }
      },
      damagePlayer(amount: number, zombieIndex = 0) {
        const attacker = zombies[zombieIndex]
        if (attacker) damagePlayer(amount, attacker.root.position)
      },
      deploy: deployGame,
      hitZombie(zombieIndex: number, zone: ZombieHitZoneType) {
        const zombie = zombies[zombieIndex]
        if (!zombie) return false
        const direction = zombie.root.position.subtract(camera.position)
        if (direction.lengthSquared() > 0.000001) direction.normalize()
        else direction.copyFromFloats(0, 0, 1)
        const zoneOffsetY = zone === 'head'
          ? ZOMBIE_ASSET_CONFIG.height * 0.39
          : zone === 'torso'
            ? ZOMBIE_ASSET_CONFIG.height * 0.08
            : -ZOMBIE_ASSET_CONFIG.height * 0.28
        const hitPoint = zombie.root.position.add(new Vector3(0, zoneOffsetY, 0))
        return hitZombieWithBullet({ zombie, zone }, hitPoint, direction)
      },
      hitZombieAtAim() {
        camera.getForwardRayToRef(weaponRay, 100)
        const result = scene.pickWithRay(weaponRay)
        const hitZone = result?.pickedMesh
          ? zombieHitZones.get(result.pickedMesh as Mesh)
          : undefined
        const point = result?.pickedPoint ?? null
        const hit = Boolean(hitZone && point && hitZombieWithBullet(
          hitZone,
          point,
          weaponRay.direction,
        ))
        return {
          hit,
          point: point ? { x: point.x, y: point.y, z: point.z } : null,
          zone: hitZone?.zone ?? null,
          zombieId: hitZone?.zombie.id ?? null,
        }
      },
      probeAim() {
        camera.getForwardRayToRef(weaponRay, 100)
        const result = scene.pickWithRay(weaponRay)
        const hitZone = result?.pickedMesh
          ? zombieHitZones.get(result.pickedMesh as Mesh)
          : undefined
        return {
          direction: {
            x: weaponRay.direction.x,
            y: weaponRay.direction.y,
            z: weaponRay.direction.z,
          },
          mesh: result?.pickedMesh?.name ?? null,
          zone: hitZone?.zone ?? null,
          zombieId: hitZone?.zombie.id ?? null,
        }
      },
      restart: restartPrototype,
      setCameraRotation(pitch: number, yaw: number) {
        camera.rotation.set(pitch, yaw, 0)
        camera.cameraRotation.set(0, 0)
      },
      setPlayerPosition(x: number, z: number) {
        camera.position.set(x, PLAYER_START_POSITION.y, z)
        camera.cameraDirection.set(0, 0, 0)
      },
      setZombiePosition(zombieIndex: number, x: number, z: number) {
        const zombie = zombies[zombieIndex]
        if (!zombie || zombie.root.isDisposed()) return false
        zombie.root.position.set(x, ZOMBIE_ASSET_CONFIG.height * 0.5, z)
        zombie.root.computeWorldMatrix(true)
        for (const child of zombie.root.getChildMeshes(false)) {
          child.computeWorldMatrix(true)
        }
        return true
      },
      zombieFacingDot(zombieIndex: number) {
        const zombie = zombies[zombieIndex]
        if (!zombie || zombie.root.isDisposed()) return -1
        zombie.visual.root.computeWorldMatrix(true)
        const forward = Vector3.TransformNormal(
          Vector3.Forward(),
          zombie.visual.root.getWorldMatrix(),
        )
        forward.y = 0
        const toPlayer = camera.position.subtract(zombie.root.position)
        toPlayer.y = 0
        if (forward.lengthSquared() < 0.000001 || toPlayer.lengthSquared() < 0.000001) return 1
        return Vector3.Dot(forward.normalize(), toPlayer.normalize())
      },
      verifyProceduralSharing() {
        const firstParts = zombies[0]?.visual.proceduralParts
        if (!firstParts) return canvas.dataset.zombieSource !== 'procedural'
        const partNames = Object.keys(firstParts) as (keyof ProceduralZombieParts)[]
        for (let zombieIndex = 1; zombieIndex < zombies.length; zombieIndex += 1) {
          const parts = zombies[zombieIndex].visual.proceduralParts
          if (!parts) return false
          for (let partIndex = 0; partIndex < partNames.length; partIndex += 1) {
            const partName = partNames[partIndex]
            if (parts[partName].geometry !== firstParts[partName].geometry
              || parts[partName].material !== firstParts[partName].material) return false
          }
        }
        return true
      },
      verifyZombieCloneIsolation() {
        if (canvas.dataset.zombieSource !== 'glb' || zombies.length < 2) return false
        const instances = zombies.map((zombie) => {
          const meshes = zombie.visual.root.getChildMeshes(false)
            .filter((mesh): mesh is Mesh => mesh instanceof Mesh && mesh.getTotalVertices() > 0)
          const skeletons = [...new Set(meshes.map((mesh) => mesh.skeleton).filter(Boolean))]
          return { meshes, skeletons }
        })
        if (instances.some((instance) => (
          instance.meshes.length !== Number(canvas.dataset.zombieMeshCount)
          || instance.skeletons.length !== Number(canvas.dataset.zombieSkeletonCount)
        ))) return false
        for (let index = 1; index < instances.length; index += 1) {
          if (instances[index].skeletons[0] === instances[0].skeletons[0]) return false
          for (let meshIndex = 0; meshIndex < instances[0].meshes.length; meshIndex += 1) {
            const firstMesh = instances[0].meshes[meshIndex]
            const comparedMesh = instances[index].meshes[meshIndex]
            if (comparedMesh.geometry !== firstMesh.geometry
              || comparedMesh.material !== firstMesh.material) return false
          }
        }
        return true
      },
    },
  })
}

  window.addEventListener('resize', () => {
    updateOrientationState()
    engine.resize()
  })

  gameReady = true
  canvas.dataset.sceneReady = 'true'
  console.info(
    `[Night Breach][Scene] Ready: ${scene.meshes.length} meshes, ${scene.lights.length} lights, map=${canvas.dataset.mapReady}, zombies=${canvas.dataset.zombieSource ?? 'loading'}, rifle=${canvas.dataset.weaponSource}.`,
  )
  if (deployRequested) deployGame()
} catch (error) {
  logRuntimeError('Startup failed:', error)
  instructions.disabled = true
  instructions.classList.add('error')
  instructions.textContent = 'STARTUP FAILED - CHECK BROWSER CONSOLE'
}
