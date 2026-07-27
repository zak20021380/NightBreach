import './style.css'
import { type AnimationGroup } from '@babylonjs/core/Animations/animationGroup'
import { type AssetContainer } from '@babylonjs/core/assetContainer'
import { VertexBuffer } from '@babylonjs/core/Buffers/buffer'
import { TargetCamera } from '@babylonjs/core/Cameras/targetCamera'
import { UniversalCamera } from '@babylonjs/core/Cameras/universalCamera'
import '@babylonjs/core/Collisions/collisionCoordinator'
import { Ray } from '@babylonjs/core/Culling/ray'
import { Engine } from '@babylonjs/core/Engines/engine'
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight'
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight'
import { PointLight } from '@babylonjs/core/Lights/pointLight'
import { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator'
import { ImageProcessingConfiguration } from '@babylonjs/core/Materials/imageProcessingConfiguration'
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial'
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial'
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture'
import { Space } from '@babylonjs/core/Maths/math.axis'
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color'
import { Frustum } from '@babylonjs/core/Maths/math.frustum'
import { type Matrix, Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector'
import { type AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh'
import '@babylonjs/core/Meshes/instancedMesh'
import { Mesh } from '@babylonjs/core/Meshes/mesh'
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder'
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData'
import { TransformNode } from '@babylonjs/core/Meshes/transformNode'
import { Scene } from '@babylonjs/core/scene'
import {
  type ArmMaterialMatchSettings,
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
const weaponSwitchButton = getElement<HTMLButtonElement>('#weaponSwitchButton')
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
let switchWeaponSlot: (weaponId: 'rifle' | 'shotgun') => boolean = () => false
let unlockShotgunAudio: () => void = () => undefined
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
  // Resume the already-preloaded Web Audio graph inside the activation gesture.
  // This is required by mobile autoplay policies and keeps later pump/reload
  // cues available even though they begin after the original pointer event.
  unlockShotgunAudio()
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
  // gameplayInputEnabled() already excludes the game-over state, so a downed
  // player can neither reload nor swap weapons.
  if (!isDesktop || !gameplayInputEnabled()) return
  if (event.code === 'KeyR' && !event.repeat) reloadWeapon()
  if (event.code === 'Digit1' && !event.repeat) switchWeaponSlot('rifle')
  if (event.code === 'Digit2' && !event.repeat) switchWeaponSlot('shotgun')
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

// The first-person eye height is taken from the zombie the player actually
// stands in front of rather than picked by feel: once the imported model is
// grounded its idle stance measures 1.904m to the crown with its eye line at
// 1.72m, so the camera sits level with their faces.
const PLAYER_EYE_HEIGHT = ASSET_CONFIG.assets.zombie.eyeHeight
// A camera positions its collision ellipsoid at
//   position - (0, ellipsoid.y, 0) + ellipsoidOffset
// so the half height alone already stands the capsule on the floor: the camera
// rides its top and the base lands at position.y - 2 * ellipsoid.y. The offset
// is therefore left at zero. Adding a second -half-height there sank the lower
// half of the capsule through the ground, and the collision response lifted the
// camera a little further out of the floor on every step, so the eye height
// crept upward the whole time the player moved.
//
// Meshes use the opposite convention (absolutePosition + ellipsoidOffset),
// which is why the zombie collider pairs a half-height radius with a zero
// offset around a body-centred origin.
const PLAYER_COLLISION_RADIUS = 0.45
const PLAYER_COLLISION_HALF_HEIGHT = PLAYER_EYE_HEIGHT / 2
const camera = new UniversalCamera('playerCamera', new Vector3(0, PLAYER_EYE_HEIGHT, -18), scene)
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
camera.ellipsoid = new Vector3(
  PLAYER_COLLISION_RADIUS,
  PLAYER_COLLISION_HALF_HEIGHT,
  PLAYER_COLLISION_RADIUS,
)
camera.ellipsoidOffset = Vector3.Zero()
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
  // Death interrupts the shotgun exactly like a weapon switch: the reload
  // clip stops cleanly and its unfinished shell transfer is dropped.
  shotgunAudio.stopAll()
  cancelShotgunReload()
  cancelShotgunShotCycle()
  reloadButton.disabled = true
  muzzleFlashRemaining = 0
  weaponFireEffects.reset()
  shotgunShellEjectionPool?.reset()
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

function describeArmMaterial(material: PBRMaterial) {
  return `${material.name}: albedoColor=${material.albedoColor.toHexString()} roughness=${material.roughness?.toFixed(3) ?? 'null'} metallic=${material.metallic?.toFixed(3) ?? 'null'} metallicRoughnessMap=${material.metallicTexture?.name ?? 'none'}`
}

// Retunes only the named arm materials of an imported first-person weapon so its
// authored hands read as the same player as the reference weapon's. Nothing but
// those materials is written to: the meshes, their skeletons, bone weights,
// animations and every other material in the same import are left exactly as
// the loader produced them, and every guard below fails safe by leaving the
// arms authored rather than by touching something it was not asked to.
function matchImportedArmMaterials(
  logTag: string,
  meshes: readonly AbstractMesh[],
  settings: ArmMaterialMatchSettings,
) {
  const armMeshes = meshes.filter((mesh) => settings.meshNames.includes(mesh.name)
    && mesh.getTotalVertices() > 0)
  if (armMeshes.length !== settings.meshNames.length) {
    console.warn(
      `[Night Breach][${logTag}] Arm meshes ${settings.meshNames.join(', ')} were not all found (${armMeshes.length}/${settings.meshNames.length}); the authored arm materials stay as imported.`,
    )
    return false
  }

  const armMaterials = new Set<PBRMaterial>()
  for (const mesh of armMeshes) {
    if (!(mesh.material instanceof PBRMaterial)) {
      console.warn(
        `[Night Breach][${logTag}] Arm mesh ${mesh.name} is not using a PBR material; the authored arm materials stay as imported.`,
      )
      return false
    }
    armMaterials.add(mesh.material)
  }

  // The weapon body and its shells share this import. If any of them were ever
  // to share a material with the arms, retuning it would recolour the gun too,
  // so that case is refused outright instead of half-applied.
  const sharedWithWeapon = meshes.filter((mesh) => !armMeshes.includes(mesh)
    && mesh.material instanceof PBRMaterial
    && armMaterials.has(mesh.material))
  if (sharedWithWeapon.length > 0) {
    console.warn(
      `[Night Breach][${logTag}] Arm materials are shared with ${sharedWithWeapon.map((mesh) => mesh.name).join(', ')}; the authored arm materials stay as imported so the weapon cannot be recoloured.`,
    )
    return false
  }

  // The measured values only describe the GLB they were measured on, so a
  // re-exported model with different material names is left alone.
  const foundNames = [...armMaterials].map((material) => material.name).sort()
  const expectedNames = [...settings.materialNames].sort()
  if (foundNames.join('|') !== expectedNames.join('|')) {
    console.warn(
      `[Night Breach][${logTag}] Arm materials changed (found ${foundNames.join(', ')}, expected ${expectedNames.join(', ')}); the authored arm materials stay as imported.`,
    )
    return false
  }

  const albedoTint = Color3.FromHexString(settings.albedoColor)
  const before: string[] = []
  const after: string[] = []
  for (const material of armMaterials) {
    before.push(describeArmMaterial(material))
    // A multiply rather than an assignment: the authored albedo texture keeps
    // every stitch, fold and wear pattern and is only brought down onto the
    // reference brightness and hue.
    material.albedoColor = material.albedoColor.multiply(albedoTint)
    material.roughness = settings.roughness
    material.metallic = settings.metallic
    // Ambient occlusion is read out of the same map when the exporter packed it
    // there, so the map is only dropped when nothing else still needs it.
    if (settings.dropMetallicRoughnessTexture
      && material.metallicTexture
      && !material.useAmbientOcclusionFromMetallicTextureRed) {
      material.metallicTexture = null
    }
    after.push(describeArmMaterial(material))
  }

  const untouched = meshes
    .filter((mesh) => !armMeshes.includes(mesh) && mesh.getTotalVertices() > 0)
    .map((mesh) => `${mesh.name}/${mesh.material?.name ?? 'none'}`)
  console.info(
    `[Night Breach][${logTag}] Arms matched to ${settings.reference}.\n  before: ${before.join('\n  before: ')}\n  after:  ${after.join('\n  after:  ')}\n  untouched meshes: ${untouched.join(', ') || 'none'}`,
  )
  return true
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
  groundContactOffset: ZOMBIE_ASSET_DEFINITION.groundContactOffset,
  animationSpeed: ZOMBIE_ASSET_DEFINITION.animation.speed,
  material: ZOMBIE_ASSET_DEFINITION.material,
}

const ZOMBIE_AI_CONFIG = {
  detectionRange: 28,
  loseInterestRange: 32,
  attackDistance: 1.55,
  // The mover must stop INSIDE its own reach. Parking at exactly attackDistance
  // left every zombie balanced on the knife-edge of its own hit test, so any
  // sub-centimetre drift during the swing turned a contact hit into a miss.
  attackStopDistance: 1.3,
  // Melee reach at the damage frame. The grace over attackDistance covers the
  // player's 0.45 collision ellipsoid plus the small amount of sliding a player
  // can do along a zombie's side during the 0.82s attack animation.
  attackReachDistance: 2.05,
  // Vertical band around the zombie's centre. Melee is a horizontal check, but
  // a player on a crate overhead should still be out of reach.
  attackReachHeight: 2.1,
  walkSpeed: 2.1,
  runSpeed: 3.3,
  runDistance: 3.5,
  rotationSpeed: 6.5,
  steeringResponse: 8,
  obstacleProbeDistance: 1.45,
  obstacleTurnAngle: 0.72,
  nearThinkInterval: 0.14,
  midThinkInterval: isMobile ? 0.3 : 0.24,
  farThinkInterval: isMobile ? 0.52 : 0.38,
  nearThinkDistance: 14,
  midThinkDistance: 24,
}

/**
 * Swarm shaping for the chase. Kept separate from ZOMBIE_AI_CONFIG so the way a
 * group spreads out can be tuned without touching speeds, melee, or waves.
 *
 * Every zombie used to seek the player's exact centre, so a pack solved for one
 * identical goal point and their paths converged by construction. Nothing pushed
 * them apart until their colliders actually touched, which is a contact response
 * rather than steering: the leader then blocked the follower and the group
 * resolved into a single-file line. These constants add the two missing terms --
 * a stable per-zombie approach lane, and lateral separation that runs for the
 * whole chase instead of only at melee range.
 */
const ZOMBIE_SWARM_CONFIG = {
  // Sectors around the player. Eight is coarse enough that claiming a lane costs
  // a small course correction rather than a lap, while still reading as a
  // surround once several zombies have arrived.
  approachSlotCount: 8,
  // How far off the player's centre a lane anchor sits. This is the standoff the
  // pack fans out to on the way in; it is faded back out again before melee.
  approachRingRadius: 1.5,
  // The lane offset is at full strength beyond this distance from the player...
  approachBlendFarDistance: 7,
  // ...and gone entirely inside this one, where the zombie aims at the real
  // player. Must stay above attackDistance (1.55) so a swing is never aimed at
  // an offset point and the existing melee system sees an unchanged approach.
  approachBlendNearDistance: 2.3,
  // An already-claimed lane costs this much extra angular error, so a latecomer
  // arriving on the same bearing is pushed into a neighbouring sector instead of
  // doubling up. Waves can exceed the ring size, so lanes are never forbidden.
  approachSlotOccupancyPenalty: Math.PI * 0.55,
  // Neighbour radius for separation. Bodies are 0.72 wide, so reacting at 2.3
  // starts the spread well before contact instead of after the collider has
  // already blocked the path.
  separationRadius: 2.3,
  separationStrength: 1.15,
  // Hard cap on the separation vector. The seek direction is unit length, so
  // 0.85 bounds any deviation to ~40 degrees: enough to unstack a pack, never
  // enough to turn the chase into a sidestep or an orbit.
  separationMaxPush: 0.85,
  // Separation is never switched off in melee -- that is where stacking is worst
  // -- but it is eased so zombies cannot shove each other out of their own reach.
  separationMeleeScale: 0.45,
  // Converts a neighbour blocking the path head-on into a sidestep. Without it a
  // follower's push points almost straight backwards, cancels against its own
  // forward motion, and the pair stays nose-to-tail: the single-file case.
  lineBreakGain: 0.9,
} as const

/**
 * Approach lane ledger. Each living zombie holds one sector for its whole life,
 * so the group commits to different sides of the player instead of converging on
 * one point. Claims happen once, on the first chase tick, and are never re-rolled
 * per frame -- re-picking a lane every tick is what makes swarms jitter.
 */
const zombieApproachSlotUsage = new Uint8Array(ZOMBIE_SWARM_CONFIG.approachSlotCount)

function getApproachSlotAngle(slotIndex: number) {
  return (slotIndex / ZOMBIE_SWARM_CONFIG.approachSlotCount) * Math.PI * 2
}

function signedAngleDifference(from: number, to: number) {
  const difference = to - from
  return Math.atan2(Math.sin(difference), Math.cos(difference))
}

/**
 * Picks the cheapest lane for a zombie arriving on the given bearing: closest
 * free sector wins, and occupancy is a cost rather than a hard block so a wave
 * larger than the ring still spreads evenly instead of failing to place.
 */
function claimApproachSlot(bearing: number) {
  let bestSlot = 0
  let bestCost = Number.POSITIVE_INFINITY
  for (let slotIndex = 0; slotIndex < ZOMBIE_SWARM_CONFIG.approachSlotCount; slotIndex += 1) {
    const angularError = Math.abs(
      signedAngleDifference(bearing, getApproachSlotAngle(slotIndex)),
    )
    const cost = angularError
      + zombieApproachSlotUsage[slotIndex] * ZOMBIE_SWARM_CONFIG.approachSlotOccupancyPenalty
    if (cost < bestCost) {
      bestCost = cost
      bestSlot = slotIndex
    }
  }
  zombieApproachSlotUsage[bestSlot] += 1
  return bestSlot
}

function releaseApproachSlot(slotIndex: number) {
  if (slotIndex < 0 || slotIndex >= zombieApproachSlotUsage.length) return
  if (zombieApproachSlotUsage[slotIndex] > 0) zombieApproachSlotUsage[slotIndex] -= 1
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
        // Lighting is disabled below, so the visible color is the emissive color
        // alone. Scale the dark-red palette up so impacts, sprays, mist, and
        // decals read as visibly dark red instead of near-black; mist stays the
        // brightest layer to keep its translucent haze readable.
        material.emissiveColor = material.diffuseColor.scale(layer === 'mist' ? 1.0 : 0.7)
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
  new Vector3(18, 0, -14),
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
  zombieMovementSpeedScalePerWave: 0.1,
  maximumZombieCount: 10,
  maximumZombieHealth: 150,
  maximumZombieMovementSpeed: 6.6,
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

interface ZombieRestPoseCalibration {
  readonly groundOffsetY: number
  readonly referenceHeight: number
  readonly scale: number
}

/**
 * Measures the imported zombie once, from the container originals, before any
 * clone exists.
 *
 * The container's meshes are never parented into the scene and never animated,
 * so they still carry the bind-pose bounding boxes the glTF loader computed
 * with the skeleton applied. That bind pose is the silhouette `normalizedHeight`
 * describes, and it is the only measurement that does not depend on which
 * animation frame a clone happens to hold, so it is taken once and the result
 * is reused for every zombie.
 *
 * It is deliberately NOT used to ground the model. The bind pose is a rigging
 * pose whose feet do not sit where the character stands; the floor comes from
 * the authored clips instead, via `groundContactOffset`.
 */
function calibrateZombieRestPose(container: AssetContainer): ZombieRestPoseCalibration {
  let minimumY = Number.POSITIVE_INFINITY
  let maximumY = Number.NEGATIVE_INFINITY
  for (const node of container.rootNodes) node.computeWorldMatrix(true)
  for (const mesh of container.meshes) {
    if (mesh.getTotalVertices() === 0) continue
    mesh.computeWorldMatrix(true)
    const box = mesh.getBoundingInfo().boundingBox
    minimumY = Math.min(minimumY, box.minimumWorld.y)
    maximumY = Math.max(maximumY, box.maximumWorld.y)
  }

  const { x: authoredScale, y: authoredScaleY, z: authoredScaleZ } = ZOMBIE_ASSET_CONFIG.scale
  if (
    authoredScale <= 0
    || Math.abs(authoredScale - authoredScaleY) > 0.000001
    || Math.abs(authoredScale - authoredScaleZ) > 0.000001
  ) {
    throw new Error('The zombie must use one positive uniform scale.')
  }

  const referenceHeight = (maximumY - minimumY) * authoredScale
  if (!Number.isFinite(referenceHeight) || referenceHeight <= 0.001) {
    throw new Error(`The zombie GLB returned an invalid reference height: ${referenceHeight}.`)
  }

  // The authored scale is expected to already resolve the model to
  // normalizedHeight. Correcting it here keeps a re-exported GLB correctly
  // sized without editing the asset config, and the correction is a single
  // shared value so every zombie in the pack stays identical.
  return {
    groundOffsetY: ZOMBIE_ASSET_CONFIG.groundContactOffset,
    referenceHeight,
    scale: authoredScale * (ZOMBIE_ASSET_CONFIG.height / referenceHeight),
  }
}

function createGlbZombieFactory(
  container: AssetContainer,
): ZombieVisualFactory {
  const calibration = calibrateZombieRestPose(container)
  console.info(
    `[Night Breach][Zombies] Reference pose measured once: ${calibration.referenceHeight.toFixed(3)}m at the authored scale; using scale ${calibration.scale.toFixed(6)} and a ${calibration.groundOffsetY.toFixed(4)}m ground offset for every clone.`,
  )

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
        root.scaling.setAll(calibration.scale)
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

        // Every clone is sized and grounded from the one shared calibration.
        // Re-measuring per clone used to read whichever animation frame the
        // freshly cloned skeleton held, so the pack drifted in size, and it
        // grounded against the bind pose, which stands higher than the
        // character actually does and buried the soles in the floor.
        root.position.set(0, -calibration.groundOffsetY, 0)
        root.position.addInPlace(ZOMBIE_ASSET_CONFIG.position)
        root.computeWorldMatrix(true)
        modelMeshes.forEach((mesh) => mesh.computeWorldMatrix(true))

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
  // Approach lane around the player, claimed once on the first chase tick and
  // held until death. -1 means "not yet claimed".
  private approachSlot = -1
  private targetSpeed = 0
  private locomotion: 'walk' | 'run' = 'walk'
  private readonly obstacleRay: Ray
  // Reused per swing so the melee line-of-sight probe allocates nothing.
  private readonly meleeProbeRay = new Ray(Vector3.Zero(), Vector3.Forward(), 1)
  private readonly meleeProbeOrigin = Vector3.Zero()
  private readonly meleeProbeDirection = Vector3.Forward()
  private readonly movementDelta = new Vector3()
  // Reused every steering tick so separation allocates nothing per frame.
  private readonly separationResult = { x: 0, z: 0 }
  private readonly hitZoneMeshes: Mesh[] = []
  private readonly upperBodyImpactRoot: TransformNode
  private readonly upperBodyImpactBasePosition = Vector3.Zero()
  private readonly upperBodyImpactDirection = Vector3.Forward()
  private upperBodyImpactDistance = 0
  private resumeStateAfterHit: 'idle' | 'chasing' = 'idle'
  private hitReactionRemaining = 0
  // Ordinary rifle hits decay over the configured reaction window; a shotgun
  // blast may stretch it so the heavier stagger also recovers more slowly.
  private activeHitReactionDuration = ZOMBIE_COMBAT_CONFIG.hitReactionDuration
  // Shotgun knockback: one horizontal impulse with a bounded lifetime. It is
  // integrated through moveWithCollisions, so walls always stay solid.
  private knockbackDirectionX = 0
  private knockbackDirectionZ = 0
  private knockbackSpeed = 0
  private knockbackRemaining = 0
  // A lethal close blast hands its already-aggregated horizontal momentum to
  // this separate corpse mover. Death animation and wave state remain owned by
  // the normal death path; only the root translation continues briefly.
  private deathImpulseDirectionX = 0
  private deathImpulseDirectionZ = 0
  private deathImpulseSpeed = 0
  private deathImpulseRemaining = 0
  private pendingDeathImpulseMinimumSpeed = 0
  private readonly deathBackFallAxis = Vector3.Right()
  private readonly deathBackFallForward = Vector3.Forward()
  private deathBackFallActive = false
  private deathBackFallElapsed = 0
  private deathBackFallAppliedAngle = 0
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

  get eliminated() {
    return this.disposed || this._state === 'dead'
  }

  applyHit(zone: ZombieHitZoneType, bulletDirection = Vector3.Forward()) {
    const damage = zone === 'head'
      ? ZOMBIE_COMBAT_CONFIG.headDamage
      : zone === 'torso'
        ? ZOMBIE_COMBAT_CONFIG.torsoDamage
        : ZOMBIE_COMBAT_CONFIG.limbDamage
    return this.applyDamage(
      damage,
      zone === 'head',
      bulletDirection,
      ZOMBIE_COMBAT_CONFIG.hitReactionDuration,
    )
  }

  // One aggregated call per shotgun blast: every pellet's damage lands at once
  // so the zombie plays a single controlled reaction instead of up to eight
  // competing ones. Returns false when the zombie was already dead or disposed,
  // which is what keeps a blast from re-staggering a corpse.
  applyShotgunBlast(
    totalDamage: number,
    headshot: boolean,
    flinchDirection: Vector3,
    staggerSeconds: number,
  ) {
    return this.applyDamage(totalDamage, headshot, flinchDirection, staggerSeconds)
  }

  // Horizontal initial speed in world units per second. The caller derives it
  // from aggregated pellet force and distance; direction only needs to point
  // away from the shooter. Dead or disposed zombies never accept an impulse.
  applyKnockback(
    directionX: number,
    directionZ: number,
    initialSpeed: number,
    deathImpulseMinimumSpeed = 0,
  ) {
    if (this.disposed || this._state === 'dead' || initialSpeed <= 0) return
    const length = Math.hypot(directionX, directionZ)
    if (length < 0.001) return
    this.knockbackDirectionX = directionX / length
    this.knockbackDirectionZ = directionZ / length
    this.knockbackSpeed = Math.min(
      initialSpeed,
      SHOTGUN_COMBAT_CONFIG.knockback.maxSpeed,
    )
    this.knockbackRemaining = SHOTGUN_COMBAT_CONFIG.knockback.durationSeconds
    this.pendingDeathImpulseMinimumSpeed = deathImpulseMinimumSpeed
  }

  get knockbackAmount() {
    return this._state === 'dead' ? this.deathImpulseSpeed : this.knockbackSpeed
  }

  get deathImpulseAmount() {
    return this.deathImpulseSpeed
  }

  get deathBackFallAngle() {
    return this.deathBackFallAppliedAngle
  }

  get chestUpAmount() {
    if (this.disposed || this.visual.root.isDisposed()) return 0
    this.visual.root.computeWorldMatrix(true)
    Vector3.TransformNormalToRef(
      Vector3.Forward(),
      this.visual.root.getWorldMatrix(),
      this.deathBackFallForward,
    )
    if (this.deathBackFallForward.lengthSquared() < 0.000001) return 0
    this.deathBackFallForward.normalize()
    return this.deathBackFallForward.y
  }

  private applyDamage(
    damage: number,
    headshot: boolean,
    flinchDirection: Vector3,
    staggerSeconds: number,
  ) {
    if (this.disposed || this._state === 'dead') return false

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
    // The stagger window is also the decay window of the upper-body flinch, so
    // heavier hits both push further and recover later.
    this.activeHitReactionDuration = Math.max(
      ZOMBIE_COMBAT_CONFIG.hitReactionDuration,
      staggerSeconds,
    )
    this.hitReactionRemaining = this.activeHitReactionDuration
    this.beginUpperBodyImpact(flinchDirection, headshot)
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
      this.updateDeathImpulse(deltaSeconds)
      this.updateDeathBackFall(deltaSeconds)
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

    // The knockback slide runs only for living zombies: the dead branch above
    // has already returned. moveWithCollisions is the same pipe the chase uses,
    // so an impulse can never push a zombie through a wall or off the map.
    const knockbackActive = this.knockbackRemaining > 0 && this.knockbackSpeed > 0
    if (knockbackActive) {
      const movementSeconds = Math.min(deltaSeconds, this.knockbackRemaining)
      this.movementDelta.set(
        this.knockbackDirectionX * this.knockbackSpeed * movementSeconds,
        0,
        this.knockbackDirectionZ * this.knockbackSpeed * movementSeconds,
      )
      this.root.moveWithCollisions(this.movementDelta)
      this.knockbackSpeed *= Math.exp(
        -SHOTGUN_COMBAT_CONFIG.knockback.decayPerSecond * movementSeconds,
      )
      this.knockbackRemaining = Math.max(0, this.knockbackRemaining - deltaSeconds)
      if (this.knockbackRemaining === 0) {
        this.knockbackSpeed = 0
        this.pendingDeathImpulseMinimumSpeed = 0
      }
    }

    if (this._state === 'hit') {
      this.hitReactionRemaining -= deltaSeconds
      this.applyUpperBodyImpact(clamp(
        this.hitReactionRemaining / this.activeHitReactionDuration,
        0,
        1,
      ) ** 2)
      if (this.hitReactionRemaining <= 0) {
        this.applyUpperBodyImpact(0)
        this.setState(this.resumeStateAfterHit)
        this.thinkTimeRemaining = 0
      }
    }

    // Do not let chase or attack movement counteract an active blast. Hit
    // reaction timing and animation still advance above, so AI resumes cleanly
    // on the first frame after the configured knockback window.
    if (knockbackActive) {
      this.updateProceduralAnimation(deltaSeconds)
      return
    }

    if (this._state === 'attacking') {
      this.updateAttack(deltaSeconds, playerPosition)
      this.updateProceduralAnimation(deltaSeconds)
      return
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
    // Covers zombies removed without dying (wave reset, teardown); die() has
    // already released, and the guard makes a second call a no-op.
    this.releaseApproachSlotIfHeld()
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
    // Free the lane immediately so the rest of the wave can redistribute into
    // the gap instead of the sector staying reserved by a corpse.
    this.releaseApproachSlotIfHeld()
    this.currentDirectionX = 0
    this.currentDirectionZ = 0
    // The shotgun applies its aggregated impulse before damage is resolved.
    // Preserve that direction/speed across a lethal hit instead of clearing it:
    // the death animation continues while the collision-aware root is thrown.
    if (this.knockbackSpeed > 0 && this.knockbackRemaining > 0) {
      this.deathImpulseDirectionX = this.knockbackDirectionX
      this.deathImpulseDirectionZ = this.knockbackDirectionZ
      this.deathImpulseSpeed = Math.min(
        Math.max(this.knockbackSpeed, this.pendingDeathImpulseMinimumSpeed),
        SHOTGUN_COMBAT_CONFIG.knockback.deathMaxSpeed,
      )
      this.deathImpulseRemaining = SHOTGUN_COMBAT_CONFIG.knockback.deathDurationSeconds
      this.root.checkCollisions = true
      this.beginDeathBackFall()
    } else {
      this.root.checkCollisions = false
    }
    this.disableHitZones()
    onZombieDied()
    console.info(`[Night Breach] Zombie ${this.id} eliminated; hit detection disabled.`)
  }

  private updateDeathImpulse(deltaSeconds: number) {
    if (this.deathImpulseRemaining <= 0 || this.deathImpulseSpeed <= 0) return
    const movementSeconds = Math.min(deltaSeconds, this.deathImpulseRemaining)
    this.movementDelta.set(
      this.deathImpulseDirectionX * this.deathImpulseSpeed * movementSeconds,
      0,
      this.deathImpulseDirectionZ * this.deathImpulseSpeed * movementSeconds,
    )
    this.root.moveWithCollisions(this.movementDelta)
    this.deathImpulseSpeed *= Math.exp(
      -SHOTGUN_COMBAT_CONFIG.knockback.deathDecayPerSecond * movementSeconds,
    )
    this.deathImpulseRemaining = Math.max(
      0,
      this.deathImpulseRemaining - deltaSeconds,
    )
    if (this.deathImpulseRemaining > 0) return
    this.deathImpulseSpeed = 0
    this.knockbackSpeed = 0
    this.knockbackRemaining = 0
    this.pendingDeathImpulseMinimumSpeed = 0
    this.root.checkCollisions = false
  }

  private beginDeathBackFall() {
    // The imported character's configured face/chest axis is +Z, but derive
    // its current world direction from the live hierarchy so yaw, future asset
    // corrections, and either visual factory cannot invert the fall.
    this.visual.root.computeWorldMatrix(true)
    Vector3.TransformNormalToRef(
      Vector3.Forward(),
      this.visual.root.getWorldMatrix(),
      this.deathBackFallForward,
    )
    this.deathBackFallForward.y = 0
    if (this.deathBackFallForward.lengthSquared() < 0.000001) return
    this.deathBackFallForward.normalize()

    // Rotating around forward x up takes the measured chest direction toward
    // +Y. That places the measured back direction toward the ground without a
    // guessed Euler sign.
    Vector3.CrossToRef(
      this.deathBackFallForward,
      Vector3.Up(),
      this.deathBackFallAxis,
    )
    if (this.deathBackFallAxis.lengthSquared() < 0.000001) return
    this.deathBackFallAxis.normalize()
    this.deathBackFallActive = true
    this.deathBackFallElapsed = 0
    this.deathBackFallAppliedAngle = 0
  }

  private updateDeathBackFall(deltaSeconds: number) {
    if (!this.deathBackFallActive) return
    const { deathBackFallDurationSeconds, deathBackFallAngleRadians } =
      SHOTGUN_COMBAT_CONFIG.knockback
    this.deathBackFallElapsed = Math.min(
      deathBackFallDurationSeconds,
      this.deathBackFallElapsed + deltaSeconds,
    )
    const progress = clamp(
      this.deathBackFallElapsed / deathBackFallDurationSeconds,
      0,
      1,
    )
    const easedProgress = progress * progress * (3 - 2 * progress)
    const nextAngle = deathBackFallAngleRadians * easedProgress
    const angleStep = nextAngle - this.deathBackFallAppliedAngle
    if (angleStep > 0.000001) {
      this.visual.root.rotate(this.deathBackFallAxis, angleStep, Space.WORLD)
      this.deathBackFallAppliedAngle = nextAngle
    }
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

  /** Idempotent: releasing twice (die then dispose) must not corrupt the ledger. */
  private releaseApproachSlotIfHeld() {
    if (this.approachSlot < 0) return
    releaseApproachSlot(this.approachSlot)
    this.approachSlot = -1
  }

  /**
   * Builds the chase direction from three parts: the seek toward the player's
   * approach ring, a stable per-zombie lane offset, and separation from nearby
   * zombies. All three run for the entire chase, which is what makes the pack
   * fan out on the way in rather than untangling itself on arrival.
   *
   * Horizontal only (X/Z) -- the vertical axis never participates in steering.
   */
  private updateChaseDirection(
    playerPosition: Vector3,
    toPlayerX: number,
    toPlayerZ: number,
    distance: number,
  ) {
    // Bearing of this zombie as seen from the player. Claimed once so the group
    // keeps its shape; re-picking a lane every tick is what causes jitter.
    if (this.approachSlot < 0) {
      this.approachSlot = claimApproachSlot(Math.atan2(-toPlayerX, -toPlayerZ))
    }

    // Full lane offset out at range, fading to zero before melee so the final
    // steps and the swing itself are aimed at the real player position.
    const approachWeight = clamp(
      (distance - ZOMBIE_SWARM_CONFIG.approachBlendNearDistance)
        / (ZOMBIE_SWARM_CONFIG.approachBlendFarDistance
          - ZOMBIE_SWARM_CONFIG.approachBlendNearDistance),
      0,
      1,
    )

    let goalX = playerPosition.x
    let goalZ = playerPosition.z
    if (approachWeight > 0) {
      const slotAngle = getApproachSlotAngle(this.approachSlot)
      const ringOffset = ZOMBIE_SWARM_CONFIG.approachRingRadius * approachWeight
      goalX += Math.sin(slotAngle) * ringOffset
      goalZ += Math.cos(slotAngle) * ringOffset
    }

    let directionX = goalX - this.root.position.x
    let directionZ = goalZ - this.root.position.z
    const goalDistance = Math.hypot(directionX, directionZ)
    if (goalDistance > 0.001) {
      directionX /= goalDistance
      directionZ /= goalDistance
    } else {
      // Standing on the lane anchor: fall back to the true player bearing so the
      // zombie always has a valid heading and never stalls on its own offset.
      directionX = toPlayerX / distance
      directionZ = toPlayerZ / distance
    }

    // Separation is eased rather than disabled in melee: stacking is worst at
    // the player's feet, but a full-strength push there would shove attackers
    // out of their own reach.
    const separationScale = distance <= ZOMBIE_AI_CONFIG.attackReachDistance
      ? ZOMBIE_SWARM_CONFIG.separationMeleeScale
      : 1
    const separation = this.computeSeparation(directionX, directionZ, separationScale)

    directionX += separation.x
    directionZ += separation.z
    const steeredLength = Math.hypot(directionX, directionZ)
    if (steeredLength > 0.001) {
      this.desiredDirectionX = directionX / steeredLength
      this.desiredDirectionZ = directionZ / steeredLength
      return
    }

    // Separation exactly cancelled the seek. Keep chasing rather than freeze.
    this.desiredDirectionX = toPlayerX / distance
    this.desiredDirectionZ = toPlayerZ / distance
  }

  /**
   * Inverse-distance-weighted push away from nearby living zombies, plus a
   * tangential nudge for neighbours sitting directly ahead.
   *
   * The tangential term is the part that actually breaks a conga line. A pure
   * radial push from a zombie straight ahead points straight back, cancels
   * against this zombie's own forward motion, and leaves the pair nose-to-tail
   * at walking pace. Converting that head-on case into a sidestep makes the
   * follower step around rather than brake.
   *
   * Cost is O(living zombies) against a cap of ten, evaluated on the existing
   * think schedule (~0.14-0.52s) rather than per frame, and allocates nothing.
   * No scene queries and no navmesh, so it stays cheap inside a mobile WebView.
   */
  private computeSeparation(seekX: number, seekZ: number, scale: number) {
    const result = this.separationResult
    result.x = 0
    result.z = 0
    if (scale <= 0) return result

    const radius = ZOMBIE_SWARM_CONFIG.separationRadius
    const radiusSquared = radius * radius
    let pushX = 0
    let pushZ = 0

    for (let index = 0; index < zombies.length; index += 1) {
      const other = zombies[index]
      // Dead and disposed zombies are ignored: corpses must not steer the pack.
      if (other === this || other.eliminated || !other.root.isEnabled()) continue

      const offsetX = this.root.position.x - other.root.position.x
      const offsetZ = this.root.position.z - other.root.position.z
      const distanceSquared = offsetX * offsetX + offsetZ * offsetZ
      if (distanceSquared >= radiusSquared) continue

      if (distanceSquared < 0.0001) {
        // Exactly co-located (a spawn overlap). Derive a deterministic direction
        // from the id pair so the two never mirror each other into a standoff.
        const tieAngle = (this.id - other.id) * 1.7
        pushX += Math.sin(tieAngle)
        pushZ += Math.cos(tieAngle)
        continue
      }

      const distance = Math.sqrt(distanceSquared)
      // Linear falloff: full strength on contact, nothing at the radius edge.
      const falloff = (radius - distance) / radius
      const normalX = offsetX / distance
      const normalZ = offsetZ / distance
      pushX += normalX * falloff
      pushZ += normalZ * falloff

      // Neighbour ahead of us and roughly on our line? Add a sideways component
      // so we go around instead of queueing behind them.
      const alignment = -(normalX * seekX + normalZ * seekZ)
      if (alignment > 0.35) {
        // Perpendicular to the seek direction, signed so each zombie of a pair
        // consistently peels to its own side and they do not swap every tick.
        const sideSign = (normalZ * seekX - normalX * seekZ) >= 0 ? 1 : -1
        const lineBreak = alignment * falloff * ZOMBIE_SWARM_CONFIG.lineBreakGain * sideSign
        pushX += -seekZ * lineBreak
        pushZ += seekX * lineBreak
      }
    }

    if (pushX === 0 && pushZ === 0) return result

    pushX *= ZOMBIE_SWARM_CONFIG.separationStrength * scale
    pushZ *= ZOMBIE_SWARM_CONFIG.separationStrength * scale

    // Clamping the magnitude (rather than each axis) keeps the push direction
    // intact and bounds how far the chase can ever be bent off course.
    const pushLength = Math.hypot(pushX, pushZ)
    const maximumPush = ZOMBIE_SWARM_CONFIG.separationMaxPush * scale
    if (pushLength > maximumPush) {
      const limit = maximumPush / pushLength
      pushX *= limit
      pushZ *= limit
    }

    result.x = pushX
    result.z = pushZ
    return result
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
    this.updateChaseDirection(playerPosition, toPlayerX, toPlayerZ, distance)

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
      playerDistance - ZOMBIE_AI_CONFIG.attackStopDistance,
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

  /**
   * Melee reach test. Deliberately omnidirectional: a bite connects on contact
   * regardless of where the player happens to be looking, so this measures only
   * the zombie's own relationship to the player.
   *
   * Horizontal distance is used so camera pitch (looking up or down) can never
   * change melee validity, with a separate vertical band so a player standing
   * on top of geometry is still safely out of reach.
   */
  private isPlayerWithinMeleeReach(playerPosition: Vector3) {
    const toPlayerX = playerPosition.x - this.root.position.x
    const toPlayerZ = playerPosition.z - this.root.position.z
    const horizontalDistanceSquared = toPlayerX * toPlayerX + toPlayerZ * toPlayerZ
    if (
      horizontalDistanceSquared
      > ZOMBIE_AI_CONFIG.attackReachDistance * ZOMBIE_AI_CONFIG.attackReachDistance
    ) return false

    const verticalDistance = Math.abs(playerPosition.y - this.root.position.y)
    if (verticalDistance > ZOMBIE_AI_CONFIG.attackReachHeight) return false

    return this.hasLineOfSightToPlayer(playerPosition, horizontalDistanceSquared)
  }

  /**
   * Blocks damage through walls. The probe runs between chest heights so a low
   * kerb or debris never shields the player, while a real wall always does.
   */
  private hasLineOfSightToPlayer(playerPosition: Vector3, horizontalDistanceSquared: number) {
    const chestHeight = ZOMBIE_ASSET_CONFIG.height * 0.25
    this.meleeProbeOrigin.set(
      this.root.position.x,
      this.root.position.y + chestHeight,
      this.root.position.z,
    )
    this.meleeProbeDirection.set(
      playerPosition.x - this.meleeProbeOrigin.x,
      playerPosition.y - this.meleeProbeOrigin.y,
      playerPosition.z - this.meleeProbeOrigin.z,
    )
    const probeLength = this.meleeProbeDirection.length()
    if (probeLength < 0.001) return true
    this.meleeProbeDirection.scaleInPlace(1 / probeLength)

    this.meleeProbeRay.origin.copyFrom(this.meleeProbeOrigin)
    this.meleeProbeRay.direction.copyFrom(this.meleeProbeDirection)
    // Stop just short of the player so their own collider is never the blocker.
    this.meleeProbeRay.length = Math.max(
      0.05,
      Math.min(probeLength, Math.sqrt(horizontalDistanceSquared)) - 0.15,
    )

    const blocker = scene.pickWithRay(this.meleeProbeRay, isZombieObstacle, true)
    return !blocker?.hit
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

    // Keep turning toward the player for the whole swing. A player circling to
    // the flank is tracked instead of being swung at in the old direction, which
    // is what makes a side approach read naturally rather than looking blind.
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
      // Range is judged only at the hit frame, from the zombie's own position.
      // Whether the player is facing the zombie is irrelevant to contact.
      if (this.isPlayerWithinMeleeReach(playerPosition)) {
        damagePlayer(ZOMBIE_COMBAT_CONFIG.attackDamage, this.root.position)
      }
    }

    if (this.attackElapsed >= ZOMBIE_COMBAT_CONFIG.attackDuration) {
      // Always leave the attack state when the animation ends, hit or miss, so a
      // whiffed swing can never leave the zombie parked in 'attacking'. Clearing
      // the think timer makes it re-evaluate (chase or swing again) immediately.
      this.setState('idle')
      this.thinkTimeRemaining = 0
    }
  }

  private updateProceduralAnimation(deltaSeconds: number) {
    if (this._state === 'dead'
      && !this.visual.animations.death
      && !this.deathBackFallActive) {
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

function selectZombieSpawnPosition(spawnIndex: number): Vector3 | null {
  const candidateCount = ZOMBIE_SPAWN_POSITIONS.length
  for (let attempt = 0; attempt < ZOMBIE_WAVE_CONFIG.spawnPlacementAttempts; attempt += 1) {
    const position = ZOMBIE_SPAWN_POSITIONS[(spawnIndex + attempt) % candidateCount]
    if (isValidZombieSpawnPosition(position)) return position
  }

  // The fallback ring must clear the same distance, geometry, and camera-view
  // checks as the primary candidates. Nothing is ever forced into an unsafe
  // spot: if every fallback also fails, return null so the caller defers this
  // zombie and retries on the next spawn tick.
  for (let index = 0; index < ZOMBIE_SPAWN_FALLBACK_POSITIONS.length; index += 1) {
    const position = ZOMBIE_SPAWN_FALLBACK_POSITIONS[
      (spawnIndex + index) % ZOMBIE_SPAWN_FALLBACK_POSITIONS.length
    ]
    if (isValidZombieSpawnPosition(position)) {
      return position
    }
  }

  return null
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
    // Only retire the spawn interval here. Clearing every wave timer also
    // cancels a pending next-wave timeout and stalls the loop permanently.
    if (zombieSpawnTimer !== undefined) {
      window.clearInterval(zombieSpawnTimer)
      zombieSpawnTimer = undefined
    }
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
  if (!spawnPosition) {
    // Every primary and fallback candidate failed the distance, geometry, or
    // camera-view checks this tick. Leave the spawn counters unchanged so the
    // spawn interval retries on the next tick once the player has moved or the
    // camera has turned, rather than forcing this zombie into an unsafe spot.
    return
  }
  const stats = getWaveZombieStats(waveState.currentWave)
  let zombie: Zombie
  try {
    zombie = new Zombie(
      nextZombieId,
      spawnPosition,
      factory,
      stats.maxHealth,
      stats.movementSpeedMultiplier,
    )
  } catch (error) {
    // A failed instance must never escape this tick. Throwing here would abort
    // the spawn interval setup in startNextZombieWave and stall the wave loop.
    nextZombieId += 1
    waveState.spawnedZombies += 1
    updateWaveDisplay()
    logRuntimeWarning('[Zombies] Spawn skipped after instance creation failed.', error)
    if (waveState.spawnedZombies >= waveState.scheduledZombies
      && zombieSpawnTimer !== undefined) {
      window.clearInterval(zombieSpawnTimer)
      zombieSpawnTimer = undefined
    }
    completeWaveIfReady()
    return
  }
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

function countLivingWaveZombies() {
  let living = 0
  for (let index = 0; index < zombies.length; index += 1) {
    if (!zombies[index].eliminated) living += 1
  }
  return living
}

function completeWaveIfReady() {
  if (gameOver || waveState.status !== 'active') return

  // The zombie list is the source of truth. A drifted counter (an unreachable
  // zombie, a failed instance) must never be able to wedge the wave loop.
  const living = countLivingWaveZombies()
  if (living !== waveState.aliveZombies) {
    waveState.aliveZombies = living
    updateWaveDisplay()
  }
  if (waveState.spawnedZombies !== waveState.scheduledZombies
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
  if (waveState.status !== 'active') return
  waveState.aliveZombies = Math.max(0, waveState.aliveZombies - 1)
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
  // Disposal already releases each lane; zeroing here guarantees a restart can
  // never inherit a stale count and skew the first wave's spread.
  zombieApproachSlotUsage.fill(0)
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
  if (!pauseZombieAI) completeWaveIfReady()
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

const SHOTGUN_ASSET_DEFINITION = ASSET_CONFIG.assets.shotgun
const SHOTGUN_ASSET_CONFIG = {
  position: vector3FromTuple(SHOTGUN_ASSET_DEFINITION.transform.position),
  rotation: vector3FromTuple(SHOTGUN_ASSET_DEFINITION.transform.rotation),
  scaling: vector3FromTuple(SHOTGUN_ASSET_DEFINITION.transform.scale),
  animationSpeed: SHOTGUN_ASSET_DEFINITION.animation.speed,
  material: SHOTGUN_ASSET_DEFINITION.material,
  arms: SHOTGUN_ASSET_DEFINITION.arms,
}

// Every gameplay number for the pump-action shotgun lives here. The rifle's
// combat values are untouched; this block only ever feeds the shotgun paths.
const SHOTGUN_COMBAT_CONFIG = {
  magazineCapacity: 8,
  startingLoadedShells: 8,
  startingReserveShells: 32,
  pelletsPerShot: 8,
  damagePerPellet: 12,
  // Pellet rays stop at maxRange; damage is full inside fullDamageRange and
  // falls off linearly to the minimum multiplier at maxRange.
  maxRange: 28,
  fullDamageRange: 8,
  minDamageMultiplierAtMaxRange: 0.35,
  // Cone half-angles. ADS blends between them through the shared adsBlend.
  hipSpreadDegrees: 4.5,
  adsSpreadDegrees: 2.5,
  // Zone scaling is derived from the existing zombie damage table so the
  // shotgun follows the exact same head/torso/limb rules as the rifle:
  // pellet damage is the torso baseline scaled by the authored zone ratios.
  zoneDamageMultipliers: {
    head: ZOMBIE_COMBAT_CONFIG.headDamage / ZOMBIE_COMBAT_CONFIG.torsoDamage,
    torso: 1,
    limbs: ZOMBIE_COMBAT_CONFIG.limbDamage / ZOMBIE_COMBAT_CONFIG.torsoDamage,
  },
  // The shotgun rides the same recoilAmount channel and camera-kick pattern as
  // the rifle, just with a much harder shove. Values are additive on top of the
  // small built-in kick weaponFireEffects.trigger applies for every weapon.
  recoil: {
    viewModelKick: 0.075,
    viewModelKickCap: 0.09,
    cameraKickPitch: 0.03,
    cameraKickYaw: 0.012,
    adsRecoilReduction: 0.32,
    muzzleFlashStrength: 1.25,
  },
  // One aggregated impulse per zombie per blast. forcePerPellet is converted
  // to initial horizontal speed after the distance curve and capped at
  // maxSpeed. Movement lasts durationSeconds and decays exponentially.
  knockback: {
    forcePerPellet: 2.1,
    fullForceRange: 5,
    weakForceRange: 8,
    weakForceMultiplier: 0.3,
    longRangeForceMultiplier: 0.015,
    minimumForce: 0.15,
    durationSeconds: 0.72,
    decayPerSecond: 1.5,
    maxSpeed: 11.5,
    // A close lethal hit keeps enough of the pre-applied blast to travel
    // 3–5 units even at the four-pellet eligibility threshold.
    deathLaunchRange: 6,
    deathLaunchMinimumPellets: 4,
    deathMinimumSpeed: 7.2,
    deathDurationSeconds: 0.9,
    deathDecayPerSecond: 2,
    deathMaxSpeed: 11.2,
    deathBackFallDurationSeconds: 0.78,
    deathBackFallAngleRadians: 82 * Math.PI / 180,
  },
  // Blood bursts per zombie per blast. Every pellet still deals damage; the cap
  // only keeps eight simultaneous bursts from churning the pooled particles.
  maxBloodBurstsPerZombie: 3,
  // Barrel tip in viewModelPivot space. Measured off the loaded, posed rig
  // (skinned vertex positions of the farthest +Z slice average to
  // (0.032, 0.219, 0.845); the runtime harness re-checks this via
  // measureShotgunMuzzle), not eyeballed.
  muzzleOffset: new Vector3(0.032, 0.219, 0.845),
  // Watchdog fallbacks matching the authored clip lengths (59 and 409 frames
  // at 60 fps), used only if a clip cannot be resolved or fails to complete.
  shotCycleFallbackSeconds: 59 / 60,
  reloadFallbackSeconds: 409 / 60,
}

type ShotgunSoundName = 'shot' | 'pump' | 'reload'

// Audio offsets are authored-animation seconds at speed 1. The pump offset is
// the first frame where Slide_059 leaves its rest position in SG_FPS_Shot.
// Reload offsets are the four frames where a new 12ge_low_062 shell begins its
// handling pass in SG_FPS_Reload. Both offsets and playback rate scale with the
// animation speed, so changing the view-model speed preserves synchronization.
const SHOTGUN_AUDIO_CONFIG = {
  masterVolume: 1,
  volumes: {
    shot: 0.9,
    pump: 0.72,
    reload: 0.68,
  } satisfies Readonly<Record<ShotgunSoundName, number>>,
  files: {
    shot: '/assets/audio/weapons/shotgun/shot.wav',
    pump: '/assets/audio/weapons/shotgun/pump.wav',
    reload: '/assets/audio/weapons/shotgun/reload.wav',
  } satisfies Readonly<Record<ShotgunSoundName, string>>,
  pumpOffsetSeconds: 23 / 60,
  reloadOffsetsSeconds: [39 / 60, 120 / 60, 200 / 60, 279 / 60],
} as const

// One AudioContext, three decoded buffers and three persistent gain nodes keep
// playback cheap on mobile. AudioBufferSourceNodes are intentionally one-shot,
// but every live/scheduled source is tracked so an action can never duplicate
// itself and weapon switches, death, restart or page suspension can stop it.
class ShotgunAudioController {
  private context: AudioContext | null = null
  private masterGain: GainNode | null = null
  private readonly gains: Partial<Record<ShotgunSoundName, GainNode>> = {}
  private readonly buffers = new Map<ShotgunSoundName, AudioBuffer>()
  private readonly activeSources: Record<ShotgunSoundName, Set<AudioBufferSourceNode>> = {
    shot: new Set(),
    pump: new Set(),
    reload: new Set(),
  }
  private preloadPromise: Promise<void> | null = null
  private audioUnavailableLogged = false

  private ensureContext() {
    if (this.context) return this.context
    if (typeof AudioContext === 'undefined') {
      if (!this.audioUnavailableLogged) {
        this.audioUnavailableLogged = true
        console.warn('[Night Breach][Shotgun Audio] Web Audio is unavailable in this browser.')
      }
      canvas.dataset.shotgunAudioReady = 'unavailable'
      return null
    }

    this.context = new AudioContext({ latencyHint: 'interactive' })
    this.masterGain = this.context.createGain()
    this.masterGain.gain.value = SHOTGUN_AUDIO_CONFIG.masterVolume
    this.masterGain.connect(this.context.destination)

    for (const soundName of Object.keys(SHOTGUN_AUDIO_CONFIG.files) as ShotgunSoundName[]) {
      const gain = this.context.createGain()
      gain.gain.value = SHOTGUN_AUDIO_CONFIG.volumes[soundName]
      gain.connect(this.masterGain)
      this.gains[soundName] = gain
    }
    return this.context
  }

  preload() {
    if (this.preloadPromise) return this.preloadPromise
    const context = this.ensureContext()
    if (!context) return Promise.resolve()

    canvas.dataset.shotgunAudioReady = 'loading'
    this.preloadPromise = Promise.all(
      (Object.entries(SHOTGUN_AUDIO_CONFIG.files) as [ShotgunSoundName, string][])
        .map(async ([soundName, path]) => {
          try {
            const response = await fetch(path, { cache: 'force-cache' })
            if (!response.ok) {
              throw new Error(`${response.status} ${response.statusText}`)
            }
            const buffer = await context.decodeAudioData(await response.arrayBuffer())
            this.buffers.set(soundName, buffer)
          } catch (error) {
            logRuntimeWarning(`[Shotgun Audio] Could not preload ${path}.`, error)
          }
        }),
    ).then(() => {
      canvas.dataset.shotgunAudioReady = this.buffers.size === 3 ? 'ready' : 'partial'
    })
    return this.preloadPromise
  }

  async unlock() {
    const context = this.ensureContext()
    if (!context) return

    // Resume immediately while the browser still considers this call part of
    // the deployment gesture; decoding may finish asynchronously afterward.
    if (context.state === 'suspended') {
      try {
        await context.resume()
      } catch (error) {
        logRuntimeWarning('[Shotgun Audio] AudioContext resume was unavailable.', error)
      }
    }
    await this.preload()
  }

  private stop(soundName: ShotgunSoundName) {
    const sources = this.activeSources[soundName]
    for (const source of sources) {
      source.onended = null
      try {
        source.stop()
      } catch {
        // A source that ended between iteration and stop is already harmless.
      }
      source.disconnect()
    }
    sources.clear()
  }

  private schedule(
    soundName: ShotgunSoundName,
    authoredOffsetsSeconds: readonly number[],
    animationSpeed: number,
    baseTime: number,
  ) {
    const context = this.context
    const buffer = this.buffers.get(soundName)
    const gain = this.gains[soundName]
    if (!context || !buffer || !gain) return

    const speed = Math.max(0.001, Math.abs(animationSpeed))
    for (const authoredOffset of authoredOffsetsSeconds) {
      const source = context.createBufferSource()
      source.buffer = buffer
      source.playbackRate.value = speed
      source.connect(gain)
      this.activeSources[soundName].add(source)
      source.onended = () => {
        this.activeSources[soundName].delete(source)
        source.disconnect()
      }
      source.start(baseTime + authoredOffset / speed)
    }
  }

  startShotCycle(animationSpeed: number) {
    const context = this.context
    if (!context) return
    if (context.state === 'suspended') void context.resume()

    // A single source per cue means held fire can never stack an old shot or
    // pump tail on top of the next authored fire-and-pump cycle.
    this.stop('reload')
    this.stop('shot')
    this.stop('pump')
    const baseTime = context.currentTime
    this.schedule('shot', [0], animationSpeed, baseTime)
    this.schedule(
      'pump',
      [SHOTGUN_AUDIO_CONFIG.pumpOffsetSeconds],
      animationSpeed,
      baseTime,
    )
  }

  startReload(animationSpeed: number) {
    const context = this.context
    if (!context) return
    if (context.state === 'suspended') void context.resume()

    // Reload cannot begin until the shot cycle gate clears, but explicitly
    // retire any remaining shot/pump tail so mechanical cues never overlap.
    this.stop('shot')
    this.stop('pump')
    this.stop('reload')
    this.schedule(
      'reload',
      SHOTGUN_AUDIO_CONFIG.reloadOffsetsSeconds,
      animationSpeed,
      context.currentTime,
    )
  }

  resumeShotCycle(elapsedSeconds: number, animationSpeed: number) {
    const context = this.context
    if (!context) return
    if (context.state === 'suspended') void context.resume()

    this.stop('pump')
    const speed = Math.max(0.001, Math.abs(animationSpeed))
    const authoredElapsed = elapsedSeconds * speed
    if (authoredElapsed >= SHOTGUN_AUDIO_CONFIG.pumpOffsetSeconds) return
    this.schedule(
      'pump',
      [SHOTGUN_AUDIO_CONFIG.pumpOffsetSeconds - authoredElapsed],
      speed,
      context.currentTime,
    )
  }

  resumeReload(elapsedSeconds: number, animationSpeed: number) {
    const context = this.context
    if (!context) return
    if (context.state === 'suspended') void context.resume()

    this.stop('reload')
    const speed = Math.max(0.001, Math.abs(animationSpeed))
    const authoredElapsed = elapsedSeconds * speed
    const remainingOffsets = SHOTGUN_AUDIO_CONFIG.reloadOffsetsSeconds
      .filter((offset) => offset > authoredElapsed)
      .map((offset) => offset - authoredElapsed)
    this.schedule('reload', remainingOffsets, speed, context.currentTime)
  }

  stopReload() {
    this.stop('reload')
  }

  stopAll() {
    this.stop('shot')
    this.stop('pump')
    this.stop('reload')
  }
}

canvas.dataset.shotgunAudioReady = 'loading'
canvas.dataset.shotgunAudioTimings = [
  'shot:0.000000',
  `pump:${SHOTGUN_AUDIO_CONFIG.pumpOffsetSeconds.toFixed(6)}`,
  ...SHOTGUN_AUDIO_CONFIG.reloadOffsetsSeconds.map(
    (offset, index) => `reload${index + 1}:${offset.toFixed(6)}`,
  ),
].join(',')
const shotgunAudio = new ShotgunAudioController()
unlockShotgunAudio = () => {
  void shotgunAudio.unlock()
}
void shotgunAudio.preload()

// The four authored clips this phase drives, exactly as exported in the GLB.
const SHOTGUN_ANIMATION_CLIPS = {
  idle: 'Armature|SG_FPS_Idle',
  walk: 'Armature|SG_FPS_Walk',
  shot: 'Armature|SG_FPS_Shot',
  reload: 'Armature|SG_FPS_Reload',
} as const

type ShotgunClipName = keyof typeof SHOTGUN_ANIMATION_CLIPS

// The rifle is the weapon the player starts with. Each weapon owns its own
// ammo, firing, reload, recoil and animation state; selection routes every
// fire/reload request to exactly one of them and never lets the other's
// combat code run.
type WeaponId = 'rifle' | 'shotgun'
const WEAPON_LABELS: Readonly<Record<WeaponId, string>> = {
  rifle: 'AK',
  shotgun: 'SG',
}
let activeWeaponId: WeaponId = 'rifle'
let weaponSwitchCount = 0
canvas.dataset.activeWeapon = activeWeaponId
canvas.dataset.weaponSwitchCount = '0'
canvas.dataset.shotgunReady = 'loading'

// Declared up front so the shared "one visible weapon" invariant can be checked
// from the rifle's own load and fallback paths before the shotgun has landed.
let shotgunRoot: TransformNode | null = null
let shotgunMeshes: AbstractMesh[] = []
let shotgunAnimationGroups: AnimationGroup[] = []
let shotgunRestAnimation: AnimationGroup | null = null
let shotgunReady = false
let weaponSwitchFeedbackTimer: number | undefined

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

function optimizeImportedWeapon(meshes: readonly AbstractMesh[]) {
  const materials = new Set(meshes.map((mesh) => mesh.material).filter((material) => material !== null))
  const anisotropy = isLowEndMobile ? 2 : isMobile ? 4 : 8
  for (const material of materials) {
    if (material instanceof PBRMaterial || material instanceof StandardMaterial) {
      // Sky + sun + the muzzle flash light, so the flash actually lights the gun.
      material.maxSimultaneousLights = 3
    }
    for (const texture of material.getActiveTextures()) {
      texture.anisotropicFilteringLevel = Math.min(
        texture.anisotropicFilteringLevel,
        anisotropy,
      )
    }
  }
}

// Shared by every first-person weapon import. The measured authored bounds are
// the only input used to recentre a GLB, so no transform is ever guessed.
function inspectImportedWeaponBounds(
  weaponName: string,
  logTag: string,
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
    throw new Error(`The ${weaponName} GLB returned invalid authored bounds.`)
  }
  if (size.x <= 0 || size.y <= 0 || size.z <= 0) {
    throw new Error(`The ${weaponName} GLB returned empty authored bounds.`)
  }
  const dominantAxis = size.x >= size.y && size.x >= size.z
    ? '+X'
    : size.y >= size.z ? '+Y' : '+Z'
  if (dominantAxis !== '+Z') {
    throw new Error(
      `The ${weaponName} GLB barrel must resolve to +Z after its authored wrappers; measured dominant axis ${dominantAxis}.`,
    )
  }

  console.info(
    `[Night Breach][${logTag}] Complete authored bounds ${size.x.toFixed(3)} x ${size.y.toFixed(3)} x ${size.z.toFixed(3)} centered at (${center.x.toFixed(3)}, ${center.y.toFixed(3)}, ${center.z.toFixed(3)}); dominant/barrel axis ${dominantAxis}.`,
  )

  return { center, max, min, size }
}

function getUniformWeaponScale(weaponName: string, scaling: Vector3) {
  const { x, y, z } = scaling
  if (Math.abs(x - y) > 0.000001 || Math.abs(x - z) > 0.000001 || x <= 0) {
    throw new Error(`The first-person ${weaponName} must use one positive uniform scale.`)
  }
  return x
}

async function validateImportedWeaponRendering(
  weaponName: string,
  meshes: readonly AbstractMesh[],
) {
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
          reject(new Error(`${weaponName} material validation timed out.`))
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
  // The rifle standby is only ever shown while the rifle is the selected
  // weapon, so a fallback can never put two view models on screen at once.
  if (proceduralRifle && !proceduralRifle.isDisposed()) {
    proceduralRifle.setEnabled(activeWeaponId === 'rifle')
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
  proceduralRifle.setEnabled(activeWeaponId === 'rifle')
  canvas.dataset.weaponSource = 'procedural'
  canvas.dataset.rifleReady = 'procedural'
  canvas.dataset.weaponActiveAnimation = 'procedural'
  canvas.dataset.weaponClipNames = 'none'
  canvas.dataset.weaponSkeletonCount = '0'
  canvas.dataset.weaponBoneCount = '0'
  canvas.dataset.weaponSkinnedMeshCount = '0'
  canvas.dataset.proceduralRifle = 'active'
  canvas.dataset.visibleRifleHierarchies = String(activeWeaponId === 'rifle' ? 1 : 0)
  return proceduralRifle
}

ensureProceduralRifle()
console.info('[Night Breach][Rifle] Local GLB loading started with procedural fallback active.')

// ---------------------------------------------------------------------------
// Weapon fire effects
//
// The previous flash was one flat 11 cm plane toggled on for 45 ms. This
// replaces it with a layered, pooled muzzle effect: a white-hot core, a
// randomly rotated star burst, a forward muzzle jet, barrel smoke, ejected
// brass, a real point light that briefly illuminates the weapon and the world,
// and a short exposure pop. Every mesh, material, and texture is built once at
// startup, so sustained automatic fire only re-poses existing objects and never
// allocates. The point light is created enabled at zero intensity so its shader
// permutation compiles during load instead of hitching on the first shot.
// ---------------------------------------------------------------------------

const MUZZLE_FLASH_DURATION = 0.058
const MUZZLE_SMOKE_LIFETIME = 0.78
const SHELL_CASING_LIFETIME = 1.3

type Canvas2dContext = ReturnType<DynamicTexture['getContext']>

function paintRadialFalloff(
  context: Canvas2dContext,
  centerX: number,
  centerY: number,
  radius: number,
  steps: number,
  colors: readonly string[],
  peakAlpha: number,
) {
  for (let step = steps; step >= 1; step -= 1) {
    const progress = step / steps
    context.globalAlpha = ((1 - progress) ** 1.5) * peakAlpha + 0.02
    context.fillStyle = colors[Math.min(
      colors.length - 1,
      Math.floor(progress * colors.length),
    )]
    context.beginPath()
    context.arc(centerX, centerY, Math.max(0.5, radius * progress), 0, Math.PI * 2)
    context.fill()
  }
  context.globalAlpha = 1
}

function createMuzzleCoreTexture() {
  const texture = new DynamicTexture(
    'muzzleFlashCoreTexture',
    { width: 128, height: 128 },
    scene,
    false,
  )
  const context = texture.getContext()
  context.clearRect(0, 0, 128, 128)
  paintRadialFalloff(context, 64, 64, 62, 30, [
    '#ffffff',
    '#fff8e2',
    '#ffe3a2',
    '#ffb851',
    '#f0791a',
    '#b53c06',
  ], 0.96)
  texture.update(false)
  texture.hasAlpha = true
  return texture
}

function createMuzzleStarTexture() {
  const texture = new DynamicTexture(
    'muzzleFlashStarTexture',
    { width: 128, height: 128 },
    scene,
    false,
  )
  const context = texture.getContext()
  context.clearRect(0, 0, 128, 128)
  const petalCount = 7
  for (let petal = 0; petal < petalCount; petal += 1) {
    const angle = petal / petalCount * Math.PI * 2
    const isMajor = petal % 2 === 0
    const length = isMajor ? 61 : 41
    const spread = isMajor ? 0.17 : 0.1
    context.globalAlpha = isMajor ? 0.88 : 0.58
    context.fillStyle = isMajor ? '#ffd989' : '#ffb347'
    context.beginPath()
    context.moveTo(64 + Math.cos(angle) * length, 64 + Math.sin(angle) * length)
    context.lineTo(64 + Math.cos(angle + spread) * 15, 64 + Math.sin(angle + spread) * 15)
    context.lineTo(64 + Math.cos(angle - spread) * 15, 64 + Math.sin(angle - spread) * 15)
    context.closePath()
    context.fill()
  }
  context.globalAlpha = 1
  paintRadialFalloff(context, 64, 64, 27, 16, [
    '#ffffff',
    '#fff4cd',
    '#ffc768',
    '#f4841f',
  ], 0.94)
  texture.update(false)
  texture.hasAlpha = true
  return texture
}

function createMuzzleSmokeTexture() {
  const texture = new DynamicTexture(
    'muzzleSmokeTexture',
    { width: 64, height: 64 },
    scene,
    false,
  )
  const context = texture.getContext()
  context.clearRect(0, 0, 64, 64)
  paintRadialFalloff(context, 32, 32, 31, 18, [
    '#d8d4cb',
    '#b3afa6',
    '#8b8880',
    '#5f5d57',
  ], 0.52)
  texture.update(false)
  texture.hasAlpha = true
  return texture
}

interface MuzzleSmokePuff {
  active: boolean
  age: number
  lifetime: number
  spin: number
  startSize: number
  endSize: number
  mesh: Mesh
  drift: Vector3
}

interface EjectedShell {
  active: boolean
  age: number
  mesh: Mesh
  velocity: Vector3
  spin: Vector3
}

class WeaponFireEffects {
  private readonly core: Mesh
  private readonly star: Mesh
  private readonly jet: Mesh
  private readonly coreMaterial: StandardMaterial
  private readonly starMaterial: StandardMaterial
  private readonly jetMaterial: StandardMaterial
  private readonly smokeMaterial: StandardMaterial
  private readonly light: PointLight
  private readonly smokePuffs: MuzzleSmokePuff[] = []
  private readonly shells: EjectedShell[] = []
  private readonly baseExposure: number
  // Where the flash anchors on the view-model pivot. Weapon selection retargets
  // it so the burst always sits on the active weapon's real barrel tip.
  private readonly muzzleLocalPosition = WEAPON_VIEW_CONFIG.muzzlePosition.clone()
  private readonly muzzleWorldPosition = Vector3.Zero()
  private readonly ejectForward = Vector3.Zero()
  private readonly ejectRight = Vector3.Zero()
  private readonly ejectUp = Vector3.Zero()
  private readonly smokeCapacity: number
  private readonly shellCapacity: number
  private flashRemaining = 0
  private flashStrength = 1
  private flashSpin = 0
  private exposureBoost = 0
  private nextSmokePuff = 0
  private nextShell = 0

  constructor() {
    this.smokeCapacity = isLowEndMobile ? 4 : isMobile ? 6 : 8
    this.shellCapacity = isLowEndMobile ? 4 : isMobile ? 6 : 10
    this.baseExposure = scene.imageProcessingConfiguration.exposure

    const coreTexture = createMuzzleCoreTexture()
    const starTexture = createMuzzleStarTexture()
    const smokeTexture = createMuzzleSmokeTexture()

    this.coreMaterial = this.createAdditiveMaterial('muzzleFlashCoreMaterial', coreTexture)
    this.starMaterial = this.createAdditiveMaterial('muzzleFlashStarMaterial', starTexture)
    this.jetMaterial = this.createAdditiveMaterial('muzzleFlashJetMaterial', coreTexture)
    this.smokeMaterial = this.createAdditiveMaterial('muzzleSmokeMaterial', smokeTexture)
    this.smokeMaterial.emissiveColor = new Color3(0.3, 0.29, 0.27)

    const muzzle = this.muzzleLocalPosition

    this.star = MeshBuilder.CreatePlane('muzzleFlashStar', { size: 0.34 }, scene)
    this.star.parent = viewModelPivot
    this.star.position.copyFrom(muzzle)
    this.star.material = this.starMaterial
    this.star.isVisible = false
    configureFirstPersonMesh(this.star)

    this.core = MeshBuilder.CreatePlane('muzzleFlashCore', { size: 0.19 }, scene)
    this.core.parent = viewModelPivot
    this.core.position.copyFrom(muzzle)
    this.core.position.z += 0.006
    this.core.material = this.coreMaterial
    this.core.isVisible = false
    configureFirstPersonMesh(this.core)

    // A tapered cone shooting down the barrel line gives the flash real depth
    // instead of reading as a sticker pinned to the screen.
    this.jet = MeshBuilder.CreateCylinder('muzzleFlashJet', {
      height: 0.26,
      diameterBottom: 0.062,
      diameterTop: 0.011,
      tessellation: 10,
    }, scene)
    this.jet.parent = viewModelPivot
    this.jet.rotation.x = Math.PI / 2
    this.jet.position.copyFrom(muzzle)
    this.jet.position.z += 0.13
    this.jet.material = this.jetMaterial
    this.jet.isVisible = false
    configureFirstPersonMesh(this.jet)

    for (let index = 0; index < this.smokeCapacity; index += 1) {
      const mesh = MeshBuilder.CreatePlane(`muzzleSmoke${index}`, { size: 1 }, scene)
      mesh.parent = viewModelPivot
      mesh.material = this.smokeMaterial
      mesh.isVisible = false
      configureFirstPersonMesh(mesh)
      this.smokePuffs.push({
        active: false,
        age: 0,
        lifetime: MUZZLE_SMOKE_LIFETIME,
        spin: 0,
        startSize: 0.05,
        endSize: 0.24,
        mesh,
        drift: Vector3.Zero(),
      })
    }

    const brassMaterial = createMaterial(
      'shellCasingBrass',
      Color3.FromHexString('#c8a231'),
      0.3,
      0.88,
    )
    for (let index = 0; index < this.shellCapacity; index += 1) {
      const mesh = MeshBuilder.CreateBox(`shellCasing${index}`, {
        width: 0.011,
        height: 0.011,
        depth: 0.03,
      }, scene)
      mesh.material = brassMaterial
      mesh.isPickable = false
      mesh.checkCollisions = false
      mesh.receiveShadows = false
      mesh.isVisible = false
      this.shells.push({
        active: false,
        age: 0,
        mesh,
        velocity: Vector3.Zero(),
        spin: Vector3.Zero(),
      })
    }

    this.light = new PointLight('muzzleFlashLight', Vector3.Zero(), scene)
    this.light.parent = viewModelPivot
    this.light.position.copyFrom(muzzle)
    this.light.position.z += 0.2
    this.light.diffuse = new Color3(1, 0.78, 0.42)
    this.light.specular = new Color3(1, 0.86, 0.6)
    this.light.range = 16
    this.light.intensity = 0
    this.light.shadowEnabled = false

    scene.onBeforeRenderObservable.add(() => {
      this.update(Math.min(engine.getDeltaTime() / 1000, 0.05))
    })
  }

  // Re-anchors every flash element on a new barrel tip, keeping the same
  // relative offsets the constructor established. Called on weapon selection.
  setMuzzlePosition(position: Vector3) {
    this.muzzleLocalPosition.copyFrom(position)
    this.star.position.copyFrom(position)
    this.core.position.copyFrom(position)
    this.core.position.z += 0.006
    this.jet.position.copyFrom(position)
    this.jet.position.z += 0.13
    this.light.position.copyFrom(position)
    this.light.position.z += 0.2
  }

  trigger(strength: number, ejectRifleCasing = true) {
    this.flashStrength = clamp(strength, 0.55, 1.25)
    this.flashRemaining = MUZZLE_FLASH_DURATION
    this.flashSpin = Math.random() * Math.PI * 2
    this.exposureBoost = Math.max(this.exposureBoost, 0.2 * this.flashStrength)

    // A short, mostly vertical kick. Deliberately small on the horizontal axis
    // so sustained fire climbs instead of wandering off target.
    camera.cameraRotation.x -= 0.0082 * this.flashStrength
    camera.cameraRotation.y += (Math.random() - 0.5) * 0.0056 * this.flashStrength

    this.spawnSmokePuff()
    if (ejectRifleCasing) this.ejectShell()
  }

  reset() {
    this.flashRemaining = 0
    this.exposureBoost = 0
    this.light.intensity = 0
    this.core.isVisible = false
    this.star.isVisible = false
    this.jet.isVisible = false
    for (let index = 0; index < this.smokePuffs.length; index += 1) {
      const puff = this.smokePuffs[index]
      puff.active = false
      puff.mesh.isVisible = false
    }
    for (let index = 0; index < this.shells.length; index += 1) {
      const shell = this.shells[index]
      shell.active = false
      shell.mesh.isVisible = false
    }
    scene.imageProcessingConfiguration.exposure = this.baseExposure
  }

  private createAdditiveMaterial(name: string, texture: DynamicTexture) {
    const material = new StandardMaterial(name, scene)
    material.diffuseTexture = texture
    material.emissiveColor = new Color3(1, 0.82, 0.5)
    material.diffuseColor = Color3.Black()
    material.specularColor = Color3.Black()
    material.disableLighting = true
    material.useAlphaFromDiffuseTexture = true
    material.transparencyMode = StandardMaterial.MATERIAL_ALPHABLEND
    material.backFaceCulling = false
    material.disableDepthWrite = true
    material.alpha = 1
    return material
  }

  private spawnSmokePuff() {
    const puff = this.smokePuffs[this.nextSmokePuff]
    this.nextSmokePuff = (this.nextSmokePuff + 1) % this.smokeCapacity
    const muzzle = this.muzzleLocalPosition
    puff.active = true
    puff.age = 0
    puff.lifetime = MUZZLE_SMOKE_LIFETIME * (0.78 + Math.random() * 0.42)
    puff.spin = (Math.random() - 0.5) * 2.4
    puff.startSize = 0.045 + Math.random() * 0.02
    puff.endSize = 0.2 + Math.random() * 0.12
    puff.drift.set(
      (Math.random() - 0.5) * 0.07,
      0.11 + Math.random() * 0.07,
      0.2 + Math.random() * 0.1,
    )
    puff.mesh.position.copyFrom(muzzle)
    puff.mesh.position.z += 0.03
    puff.mesh.rotation.z = Math.random() * Math.PI * 2
    puff.mesh.scaling.setAll(puff.startSize)
    puff.mesh.isVisible = true
  }

  private ejectShell() {
    const shell = this.shells[this.nextShell]
    this.nextShell = (this.nextShell + 1) % this.shellCapacity

    // Derive the ejection port from the camera basis rather than the view-model
    // world matrix: the pivot is animated every frame by recoil, sway, and bob,
    // so its matrix can be a frame stale at the moment of the shot.
    camera.getDirectionToRef(Vector3.Forward(), this.ejectForward)
    camera.getDirectionToRef(Vector3.Right(), this.ejectRight)
    camera.getDirectionToRef(Vector3.Up(), this.ejectUp)
    this.muzzleWorldPosition.copyFrom(camera.position)
    this.muzzleWorldPosition.addInPlaceFromFloats(
      this.ejectForward.x * 0.34 + this.ejectRight.x * 0.2 + this.ejectUp.x * -0.12,
      this.ejectForward.y * 0.34 + this.ejectRight.y * 0.2 + this.ejectUp.y * -0.12,
      this.ejectForward.z * 0.34 + this.ejectRight.z * 0.2 + this.ejectUp.z * -0.12,
    )

    const rightPower = 1.9 + Math.random() * 0.8
    const upPower = 1.5 + Math.random() * 0.6
    const forwardPower = 0.25 + Math.random() * 0.3
    shell.active = true
    shell.age = 0
    shell.velocity.set(
      this.ejectRight.x * rightPower + this.ejectUp.x * upPower + this.ejectForward.x * forwardPower,
      this.ejectRight.y * rightPower + this.ejectUp.y * upPower + this.ejectForward.y * forwardPower,
      this.ejectRight.z * rightPower + this.ejectUp.z * upPower + this.ejectForward.z * forwardPower,
    )
    shell.spin.set(
      (Math.random() - 0.5) * 26,
      (Math.random() - 0.5) * 20,
      (Math.random() - 0.5) * 30,
    )
    shell.mesh.position.copyFrom(this.muzzleWorldPosition)
    shell.mesh.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3)
    shell.mesh.visibility = 1
    shell.mesh.isVisible = true
  }

  private update(deltaSeconds: number) {
    this.updateFlash(deltaSeconds)
    this.updateSmoke(deltaSeconds)
    this.updateShells(deltaSeconds)

    if (this.exposureBoost > 0.0008) {
      this.exposureBoost = damp(this.exposureBoost, 0, 17, deltaSeconds)
      scene.imageProcessingConfiguration.exposure = this.baseExposure + this.exposureBoost
    } else if (this.exposureBoost !== 0) {
      this.exposureBoost = 0
      scene.imageProcessingConfiguration.exposure = this.baseExposure
    }
  }

  private updateFlash(deltaSeconds: number) {
    if (this.flashRemaining <= 0) {
      if (this.light.intensity !== 0) {
        this.light.intensity = 0
        this.core.isVisible = false
        this.star.isVisible = false
        this.jet.isVisible = false
      }
      return
    }

    this.flashRemaining = Math.max(0, this.flashRemaining - deltaSeconds)
    const progress = 1 - this.flashRemaining / MUZZLE_FLASH_DURATION
    // Instant attack, sharp decay. A linear fade reads as a soft glow; this
    // curve reads as a detonation.
    const intensity = (1 - progress) ** 1.8
    const visible = this.flashRemaining > 0

    this.core.isVisible = visible
    this.star.isVisible = visible
    this.jet.isVisible = visible
    if (!visible) {
      this.light.intensity = 0
      return
    }

    // The burst expands as it dies, which is what sells the pressure wave.
    const coreScale = this.flashStrength * (0.72 + progress * 0.7)
    const starScale = this.flashStrength * (0.6 + progress * 1.15)
    this.core.scaling.set(coreScale, coreScale, 1)
    this.star.scaling.set(starScale, starScale, 1)
    this.core.rotation.z = this.flashSpin * 1.7
    this.star.rotation.z = this.flashSpin
    this.jet.scaling.set(
      this.flashStrength * (0.85 + progress * 0.3),
      this.flashStrength * (1.05 - progress * 0.45),
      this.flashStrength * (0.85 + progress * 0.3),
    )

    this.coreMaterial.alpha = intensity
    this.starMaterial.alpha = intensity * 0.92
    this.jetMaterial.alpha = intensity * 0.66
    this.light.intensity = 26 * intensity * this.flashStrength
  }

  private updateSmoke(deltaSeconds: number) {
    for (let index = 0; index < this.smokePuffs.length; index += 1) {
      const puff = this.smokePuffs[index]
      if (!puff.active) continue
      puff.age += deltaSeconds
      const progress = puff.age / puff.lifetime
      if (progress >= 1) {
        puff.active = false
        puff.mesh.isVisible = false
        continue
      }
      puff.mesh.position.addInPlaceFromFloats(
        puff.drift.x * deltaSeconds,
        puff.drift.y * deltaSeconds,
        puff.drift.z * deltaSeconds,
      )
      puff.mesh.rotation.z += puff.spin * deltaSeconds
      const size = puff.startSize + (puff.endSize - puff.startSize) * progress
      puff.mesh.scaling.set(size, size, 1)
      puff.mesh.visibility = Math.sin((1 - progress) * Math.PI * 0.5) * 0.34
    }
  }

  private updateShells(deltaSeconds: number) {
    for (let index = 0; index < this.shells.length; index += 1) {
      const shell = this.shells[index]
      if (!shell.active) continue
      shell.age += deltaSeconds
      if (shell.age >= SHELL_CASING_LIFETIME) {
        shell.active = false
        shell.mesh.isVisible = false
        continue
      }
      shell.velocity.y -= 9.4 * deltaSeconds
      shell.velocity.scaleInPlace(Math.max(0, 1 - 0.9 * deltaSeconds))
      shell.mesh.position.addInPlaceFromFloats(
        shell.velocity.x * deltaSeconds,
        shell.velocity.y * deltaSeconds,
        shell.velocity.z * deltaSeconds,
      )
      shell.mesh.rotation.addInPlaceFromFloats(
        shell.spin.x * deltaSeconds,
        shell.spin.y * deltaSeconds,
        shell.spin.z * deltaSeconds,
      )
      const fade = (SHELL_CASING_LIFETIME - shell.age) / 0.4
      shell.mesh.visibility = clamp(fade, 0, 1)
    }
  }
}

const weaponFireEffects = new WeaponFireEffects()

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

function getImportedAnimationDurationSeconds(
  animation: AnimationGroup,
  animationSpeed = RIFLE_ASSET_CONFIG.animationSpeed,
) {
  let durationSeconds = 0
  const speed = Math.max(0.001, Math.abs(animationSpeed))
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

    const authoredBounds = inspectImportedWeaponBounds(
      'rifle',
      'Rifle',
      boundsOffsetRoot,
      modelMeshes,
    )
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
    modelRoot.scaling.setAll(getUniformWeaponScale('rifle', RIFLE_ASSET_CONFIG.scaling))
    modelRoot.parent = parent

    modelMeshes.forEach(configureFirstPersonMesh)
    applyImportedMaterialSettings(modelMeshes, RIFLE_ASSET_CONFIG.material)
    optimizeImportedWeapon(modelMeshes)
    await validateImportedWeaponRendering('Rifle', modelMeshes)

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
    // are never submitted in the same frame. If the shotgun happened to be
    // selected while the rifle was still importing, the rifle stays hidden
    // until it is selected again.
    proceduralRifle?.setEnabled(false)
    activatedRoot.setEnabled(activeWeaponId === 'rifle')
    assertSingleVisibleWeaponHierarchy()

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
  assertSingleVisibleWeaponHierarchy()
  logRuntimeWarning(`[Rifle] ${context}; procedural fallback restored.`, error)
}

// Exactly one first-person hierarchy may ever be enabled, across both weapons
// and the rifle's procedural standby. That is what keeps a weapon switch from
// showing two guns, or two pairs of arms, in the same frame.
function assertSingleVisibleWeaponHierarchy() {
  const visibleRifleRoots: string[] = []
  if (proceduralRifle?.isEnabled() && !proceduralRifle.isDisposed()) {
    visibleRifleRoots.push(proceduralRifle.name)
  }
  if (importedRifleRoot?.isEnabled()) visibleRifleRoots.push(importedRifleRoot.name)
  const visibleRoots = [...visibleRifleRoots]
  if (shotgunRoot?.isEnabled() && !shotgunRoot.isDisposed()) {
    visibleRoots.push(shotgunRoot.name)
  }
  canvas.dataset.visibleRifleHierarchies = String(visibleRifleRoots.length)
  canvas.dataset.visibleWeaponHierarchies = String(visibleRoots.length)
  if (visibleRoots.length !== 1) {
    throw new Error(
      `Expected exactly one visible weapon hierarchy; found ${visibleRoots.length} (${visibleRoots.join(', ') || 'none'}).`,
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
  const visibleRoot = assertSingleVisibleWeaponHierarchy()
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
  // Every rifle action funnels through here, so this single guard keeps the
  // rifle's clips from being driven while a different weapon is selected.
  if (activeWeaponId !== 'rifle') return false
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

// ---------------------------------------------------------------------------
// Shotgun view model and combat state
//
// The shotgun is imported through the same local asset manager, wrapped in the
// same recentre/offset pair, and parented to the same viewModelPivot the rifle
// uses, so hip/ADS blending, sway, bob and recoil apply to it unchanged. Its
// combat behaviour is driven exclusively by the four authored clips resolved in
// shotgunClips; it deliberately shares none of the rifle's animation map, ammo
// or reload state, and the rifle's paths never reach any of this while the
// shotgun is selected.
// ---------------------------------------------------------------------------

let disposeShotgunResources: (() => void) | null = null

const SHOTGUN_SHELL_EJECTION_CONFIG = {
  authoredOffsetSeconds: SHOTGUN_AUDIO_CONFIG.pumpOffsetSeconds,
  capacity: isLowEndMobile ? 3 : isMobile ? 4 : 5,
  lifetimeSeconds: 2.6,
  shellLength: 0.063,
  groundClearance: 0.012,
  gravity: 9.4,
  portOffset: {
    forward: 0.34,
    right: 0.14,
    up: -0.1,
  },
} as const
canvas.dataset.shotgunShellEjectionTiming = (
  SHOTGUN_SHELL_EJECTION_CONFIG.authoredOffsetSeconds
  / Math.max(0.001, Math.abs(SHOTGUN_ASSET_CONFIG.animationSpeed))
).toFixed(6)
canvas.dataset.shotgunShellPoolCapacity = String(SHOTGUN_SHELL_EJECTION_CONFIG.capacity)

interface SpentShotgunShell {
  active: boolean
  age: number
  mesh: Mesh
  velocity: Vector3
  spin: Vector3
}

// The GLB shell is skinned to 12ge_low_062, so a direct clone would keep
// following the reload bone. Bake that small reference once into a centered,
// static prototype instead; pooled clones then share one geometry and the
// authored 12ge material without retaining a skeleton or allocating per shot.
class ShotgunShellEjectionPool {
  private readonly shells: SpentShotgunShell[] = []
  private readonly forward = Vector3.Zero()
  private readonly right = Vector3.Zero()
  private readonly up = Vector3.Zero()
  private readonly spawnPosition = Vector3.Zero()
  private readonly removeUpdateObserver: () => void
  private fallbackMaterial: SurfaceMaterial | null = null
  private nextShell = 0

  constructor(reference: Mesh | null) {
    const prototype = reference
      ? this.createPrototypeFromReference(reference)
      : this.createFallbackPrototype()

    for (let index = 0; index < SHOTGUN_SHELL_EJECTION_CONFIG.capacity; index += 1) {
      const mesh = index === 0
        ? prototype
        : prototype.clone(`spentShotgunShell${index}`, null, true)
      mesh.name = `spentShotgunShell${index}`
      mesh.parent = null
      mesh.skeleton = null
      mesh.isPickable = false
      mesh.checkCollisions = false
      mesh.receiveShadows = false
      mesh.layerMask = WORLD_RENDER_LAYER_MASK
      mesh.renderingGroupId = 0
      mesh.alwaysSelectAsActiveMesh = false
      mesh.isVisible = false
      this.shells.push({
        active: false,
        age: 0,
        mesh,
        velocity: Vector3.Zero(),
        spin: Vector3.Zero(),
      })
    }

    const observer = scene.onBeforeRenderObservable.add(() => {
      this.update(Math.min(engine.getDeltaTime() / 1000, 0.05))
    })
    this.removeUpdateObserver = () => {
      scene.onBeforeRenderObservable.remove(observer)
    }
  }

  private createPrototypeFromReference(reference: Mesh) {
    const sourcePositions = reference.getPositionData(true, true)
    const sourceIndices = reference.getIndices()
    if (!sourcePositions || sourcePositions.length < 9 || !sourceIndices) {
      throw new Error('The authored shotgun shell mesh did not expose usable geometry.')
    }

    const positions = Array.from(sourcePositions)
    let minimumX = Number.POSITIVE_INFINITY
    let minimumY = Number.POSITIVE_INFINITY
    let minimumZ = Number.POSITIVE_INFINITY
    let maximumX = Number.NEGATIVE_INFINITY
    let maximumY = Number.NEGATIVE_INFINITY
    let maximumZ = Number.NEGATIVE_INFINITY
    for (let index = 0; index < positions.length; index += 3) {
      minimumX = Math.min(minimumX, positions[index])
      minimumY = Math.min(minimumY, positions[index + 1])
      minimumZ = Math.min(minimumZ, positions[index + 2])
      maximumX = Math.max(maximumX, positions[index])
      maximumY = Math.max(maximumY, positions[index + 1])
      maximumZ = Math.max(maximumZ, positions[index + 2])
    }

    const centerX = (minimumX + maximumX) * 0.5
    const centerY = (minimumY + maximumY) * 0.5
    const centerZ = (minimumZ + maximumZ) * 0.5
    const longestSide = Math.max(
      maximumX - minimumX,
      maximumY - minimumY,
      maximumZ - minimumZ,
    )
    if (!Number.isFinite(longestSide) || longestSide <= 0) {
      throw new Error('The authored shotgun shell mesh returned invalid bounds.')
    }
    const authoredScale = SHOTGUN_SHELL_EJECTION_CONFIG.shellLength / longestSide
    for (let index = 0; index < positions.length; index += 3) {
      positions[index] = (positions[index] - centerX) * authoredScale
      positions[index + 1] = (positions[index + 1] - centerY) * authoredScale
      positions[index + 2] = (positions[index + 2] - centerZ) * authoredScale
    }

    const vertexData = new VertexData()
    vertexData.positions = positions
    vertexData.indices = Array.from(sourceIndices)
    const sourceNormals = reference.getNormalsData(true, true)
    if (sourceNormals?.length === positions.length) {
      vertexData.normals = Array.from(sourceNormals)
    }
    const sourceUvs = reference.getVerticesData(VertexBuffer.UVKind)
    if (sourceUvs) vertexData.uvs = Array.from(sourceUvs)

    const prototype = new Mesh('spentShotgunShell0', scene)
    vertexData.applyToMesh(prototype, false)
    if (reference.material) {
      prototype.material = reference.material
    } else {
      this.fallbackMaterial = this.createFallbackMaterial()
      prototype.material = this.fallbackMaterial
    }
    canvas.dataset.shotgunShellSource = `${reference.name}:${reference.material?.name ?? 'fallback-material'}`
    return prototype
  }

  private createFallbackMaterial() {
    return createMaterial(
      'spentShotgunShellFallbackMaterial',
      Color3.FromHexString('#8d291f'),
      0.48,
      0.18,
    )
  }

  private createFallbackPrototype() {
    this.fallbackMaterial = this.createFallbackMaterial()
    const prototype = MeshBuilder.CreateCylinder('spentShotgunShell0', {
      height: SHOTGUN_SHELL_EJECTION_CONFIG.shellLength,
      diameter: 0.021,
      tessellation: 8,
    }, scene)
    prototype.material = this.fallbackMaterial
    canvas.dataset.shotgunShellSource = 'procedural-fallback'
    return prototype
  }

  eject() {
    const shell = this.shells[this.nextShell]
    this.nextShell = (this.nextShell + 1) % this.shells.length

    camera.getDirectionToRef(Vector3.Forward(), this.forward)
    camera.getDirectionToRef(Vector3.Right(), this.right)
    camera.getDirectionToRef(Vector3.Up(), this.up)
    const port = SHOTGUN_SHELL_EJECTION_CONFIG.portOffset
    this.spawnPosition.copyFrom(camera.position)
    this.spawnPosition.addInPlaceFromFloats(
      this.forward.x * port.forward + this.right.x * port.right + this.up.x * port.up,
      this.forward.y * port.forward + this.right.y * port.right + this.up.y * port.up,
      this.forward.z * port.forward + this.right.z * port.right + this.up.z * port.up,
    )

    const rightPower = 2.15 + Math.random() * 0.65
    const upPower = 1.65 + Math.random() * 0.55
    const forwardPower = 0.12 + Math.random() * 0.28
    shell.active = true
    shell.age = 0
    shell.velocity.set(
      this.right.x * rightPower + this.up.x * upPower + this.forward.x * forwardPower,
      this.right.y * rightPower + this.up.y * upPower + this.forward.y * forwardPower,
      this.right.z * rightPower + this.up.z * upPower + this.forward.z * forwardPower,
    )
    shell.spin.set(
      (Math.random() - 0.5) * 24,
      (Math.random() - 0.5) * 18,
      (Math.random() - 0.5) * 28,
    )
    shell.mesh.position.copyFrom(this.spawnPosition)
    shell.mesh.rotation.set(
      Math.random() * Math.PI,
      Math.random() * Math.PI,
      Math.random() * Math.PI,
    )
    shell.mesh.visibility = 1
    shell.mesh.isVisible = true
  }

  reset() {
    for (const shell of this.shells) {
      shell.active = false
      shell.mesh.isVisible = false
    }
  }

  dispose() {
    this.removeUpdateObserver()
    for (const shell of this.shells) shell.mesh.dispose(false, false)
    this.shells.length = 0
    this.fallbackMaterial?.dispose()
    this.fallbackMaterial = null
  }

  private update(deltaSeconds: number) {
    const lifetime = SHOTGUN_SHELL_EJECTION_CONFIG.lifetimeSeconds
    const groundY = SHOTGUN_SHELL_EJECTION_CONFIG.groundClearance
    for (const shell of this.shells) {
      if (!shell.active) continue
      shell.age += deltaSeconds
      if (shell.age >= lifetime) {
        shell.active = false
        shell.mesh.isVisible = false
        continue
      }

      shell.velocity.y -= SHOTGUN_SHELL_EJECTION_CONFIG.gravity * deltaSeconds
      shell.velocity.scaleInPlace(Math.max(0, 1 - 0.55 * deltaSeconds))
      shell.mesh.position.addInPlaceFromFloats(
        shell.velocity.x * deltaSeconds,
        shell.velocity.y * deltaSeconds,
        shell.velocity.z * deltaSeconds,
      )
      shell.mesh.rotation.addInPlaceFromFloats(
        shell.spin.x * deltaSeconds,
        shell.spin.y * deltaSeconds,
        shell.spin.z * deltaSeconds,
      )

      if (shell.mesh.position.y <= groundY) {
        shell.mesh.position.y = groundY
        if (shell.velocity.y < -0.25) {
          shell.velocity.y *= -0.28
          shell.velocity.x *= 0.72
          shell.velocity.z *= 0.72
          shell.spin.scaleInPlace(0.7)
        } else {
          shell.velocity.y = 0
          shell.velocity.x *= Math.max(0, 1 - 5 * deltaSeconds)
          shell.velocity.z *= Math.max(0, 1 - 5 * deltaSeconds)
          shell.spin.scaleInPlace(Math.max(0, 1 - 4 * deltaSeconds))
        }
      }

      shell.mesh.visibility = clamp((lifetime - shell.age) / 0.35, 0, 1)
    }
  }
}

let shotgunShellEjectionPool: ShotgunShellEjectionPool | null = null

// The authored clips this phase drives. Resolved once at load; null entries
// mean the GLB changed, in which case the duration fallbacks keep firing and
// reloading functional (without inventing procedural animations).
let shotgunClips: Record<ShotgunClipName, AnimationGroup | null> = {
  idle: null,
  walk: null,
  shot: null,
  reload: null,
}
let activeShotgunAnimation: AnimationGroup | null = null

// Separate shotgun ammunition. Never shared with, or reset by, the rifle's
// magazine/reserve pair.
let shotgunLoadedShells = SHOTGUN_COMBAT_CONFIG.startingLoadedShells
let shotgunReserveShells = SHOTGUN_COMBAT_CONFIG.startingReserveShells

// -1 = inactive. While >= 0 these advance with render time and act as the
// watchdogs that keep the authored end observers honest, exactly like the
// rifle's reload watchdog.
let shotgunShotElapsed = -1
let shotgunReloadElapsed = -1
let shotgunShotDurationSeconds = SHOTGUN_COMBAT_CONFIG.shotCycleFallbackSeconds
let shotgunReloadDurationSeconds = SHOTGUN_COMBAT_CONFIG.reloadFallbackSeconds
let shotgunShellEjectedForCycle = false

// Mirrors the bob "moving" state so the shotgun can hold its authored walk
// loop while the player moves. Written once per frame by the view-model tick.
let playerIsMoving = false

// Diagnostics for the runtime harness: what the most recent blast actually did.
interface ShotgunBlastDiagnostics {
  pelletRaysCast: number
  pelletsIntoZombies: number
  zombiesHit: number
  zombiesDamaged: number
  zombiesKilled: number
  targetPellets: number
  blockedPellets: number
  missedPellets: number
  headshot: boolean
  totalDamage: number
  // Mean distance-falloff multiplier across the pellets that reached zombies:
  // 1 inside full-damage range, approaching the configured minimum at maxRange.
  averageFalloff: number
  maxKnockbackImpulse: number
}
let lastShotgunBlast: ShotgunBlastDiagnostics | null = null

function stopShotgunAnimations() {
  for (const animation of shotgunAnimationGroups) {
    if (animation.isStarted) animation.stop(true)
  }
  activeShotgunAnimation = null
}

// Exact-name resolution first; the normalized fallback only absorbs harmless
// re-exports (case or separator changes), never a different clip.
function resolveShotgunClip(groups: readonly AnimationGroup[], clipName: string) {
  const exact = groups.find((group) => group.name === clipName)
  if (exact) return exact
  const normalize = (value: string) => value.toLowerCase().replace(/[\s_.|-]+/g, '')
  const normalizedTarget = normalize(clipName)
  return groups.find((group) => normalize(group.name).endsWith(normalizedTarget)) ?? null
}

// Every shotgun action funnels through here, mirroring the rifle's single
// entry point: the guard keeps shotgun clips from being driven while another
// weapon is selected, and the stop-first policy means no two shotgun groups
// can ever fight over the rig.
function playShotgunAnimation(name: ShotgunClipName, loop = false) {
  if (activeWeaponId !== 'shotgun') return false
  const animation = shotgunClips[name]
  if (!animation) return false

  stopShotgunAnimations()
  // Rewind authored tracks so repeat shots/reloads always start from frame 0.
  if (!loop) animation.reset()
  animation.start(
    loop,
    SHOTGUN_ASSET_CONFIG.animationSpeed,
    animation.from,
    animation.to,
    false,
  )
  activeShotgunAnimation = animation
  canvas.dataset.shotgunActiveAnimation = animation.name
  return true
}

// The held loop: the authored walk while the player is moving, idle otherwise.
// With no usable clip, every group is stopped and reset so the rig rests in
// its stable authored reference pose instead of a half-played frame.
function playShotgunRestAnimation() {
  stopShotgunAnimations()
  const animation = (playerIsMoving ? shotgunClips.walk : null)
    ?? shotgunClips.idle
    ?? shotgunRestAnimation
  if (!animation) {
    for (const group of shotgunAnimationGroups) group.reset()
    canvas.dataset.shotgunActiveAnimation = 'reference-pose'
    return false
  }
  animation.start(
    true,
    SHOTGUN_ASSET_CONFIG.animationSpeed,
    animation.from,
    animation.to,
    false,
  )
  activeShotgunAnimation = animation
  canvas.dataset.shotgunActiveAnimation = animation.name
  return true
}

// One permanent observer per group, attached exactly once at load, mirroring
// the rifle. Weapon switching never adds or removes observers, so repeated
// switching cannot stack callbacks. Note every deliberate stop in this file
// uses stop(true), which skips this notification; only natural clip completion
// lands here.
function handleShotgunAnimationEnd(animation: AnimationGroup) {
  if (activeShotgunAnimation !== animation) return
  activeShotgunAnimation = null

  if (animation === shotgunClips.reload) {
    completeShotgunReload()
    return
  }
  if (animation === shotgunClips.shot) {
    completeShotgunShotCycle()
  }
}

// The authored shot clip IS the fire-and-pump cycle: only its completion (or
// the duration watchdog, if the clip stalls) re-arms the trigger.
function completeShotgunShotCycle() {
  if (shotgunShotElapsed < 0) return
  shotgunShotElapsed = -1
  shotgunShellEjectedForCycle = false
  const shot = shotgunClips.shot
  if (activeShotgunAnimation === shot) activeShotgunAnimation = null
  if (shot?.isStarted) shot.stop(true)
  if (activeWeaponId === 'shotgun' && shotgunReloadElapsed < 0) {
    playShotgunRestAnimation()
  }
}

// Interruption path (weapon switch, death, restart, disposal): the cycle gate
// is simply cleared; no rest clip is forced because the shotgun is either
// leaving the hands or the whole scene is being reset.
function cancelShotgunShotCycle() {
  if (shotgunShotElapsed < 0) return
  shotgunShotElapsed = -1
  shotgunShellEjectedForCycle = false
  const shot = shotgunClips.shot
  if (activeShotgunAnimation === shot) activeShotgunAnimation = null
  if (shot?.isStarted) shot.stop(true)
}

function beginShotgunReload() {
  if (activeWeaponId !== 'shotgun' || !shotgunReady) return
  if (gameOver || !gameplayInputEnabled()) return
  // The pump cycle finishes before shells go in, and a running reload is
  // never restarted.
  if (shotgunReloadElapsed >= 0 || shotgunShotElapsed >= 0) return
  if (shotgunLoadedShells >= SHOTGUN_COMBAT_CONFIG.magazineCapacity) return
  if (shotgunReserveShells <= 0) return

  shotgunReloadElapsed = 0
  reloadButton.disabled = true
  playShotgunAnimation('reload')
  shotgunAudio.startReload(SHOTGUN_ASSET_CONFIG.animationSpeed)
}

// The single ammo-transfer point. Only completeShotgunReload calls it, and the
// elapsed guard there means it can run at most once per started reload, so an
// interrupted reload never moves a shell and ammo can never be created.
function applyShotgunReloadAmmo() {
  const needed = SHOTGUN_COMBAT_CONFIG.magazineCapacity - shotgunLoadedShells
  const loaded = Math.min(needed, shotgunReserveShells)
  if (loaded <= 0) return
  shotgunLoadedShells += loaded
  shotgunReserveShells -= loaded
  updateAmmoDisplay()
}

function completeShotgunReload() {
  if (shotgunReloadElapsed < 0) return
  shotgunReloadElapsed = -1
  applyShotgunReloadAmmo()
  const reload = shotgunClips.reload
  if (activeShotgunAnimation === reload) activeShotgunAnimation = null
  if (reload?.isStarted) reload.stop(true)
  reloadButton.disabled = false
  if (activeWeaponId === 'shotgun') playShotgunRestAnimation()
}

// Interruption path: the state is cleared BEFORE the clip is stopped so no
// callback ordering can ever reach the ammo transfer above.
function cancelShotgunReload() {
  shotgunAudio.stopReload()
  if (shotgunReloadElapsed < 0) return
  shotgunReloadElapsed = -1
  const reload = shotgunClips.reload
  if (activeShotgunAnimation === reload) activeShotgunAnimation = null
  if (reload?.isStarted) reload.stop(true)
  reloadButton.disabled = false
}

function setShotgunViewModelEnabled(enabled: boolean) {
  if (!shotgunRoot || shotgunRoot.isDisposed()) return
  shotgunRoot.setEnabled(enabled)
  if (enabled) playShotgunRestAnimation()
  else {
    shotgunAudio.stopAll()
    stopShotgunAnimations()
    canvas.dataset.shotgunActiveAnimation = 'stopped'
  }
}

// Retires the shotgun for the rest of the session and, if it was the weapon in
// the player's hands, puts the rifle straight back so no frame is ever rendered
// without a view model.
function discardShotgunViewModel(context: string, error: unknown) {
  const wasSelected = activeWeaponId === 'shotgun'
  // Disposal is an interruption: clear the reload first so its unfinished
  // ammo transfer is dropped, then clear the pump-cycle gate.
  cancelShotgunReload()
  cancelShotgunShotCycle()
  shotgunAudio.stopAll()
  stopShotgunAnimations()
  shotgunRoot?.setEnabled(false)
  try {
    disposeShotgunResources?.()
  } catch (disposeError) {
    logRuntimeWarning('[Shotgun] Partial cleanup was skipped.', disposeError)
  }
  disposeShotgunResources = null
  shotgunRoot = null
  shotgunMeshes = []
  shotgunAnimationGroups = []
  shotgunRestAnimation = null
  shotgunClips = { idle: null, walk: null, shot: null, reload: null }
  activeShotgunAnimation = null
  shotgunReady = false
  canvas.dataset.shotgunReady = 'unavailable'
  canvas.dataset.shotgunActiveAnimation = 'none'

  if (wasSelected) {
    activeWeaponId = 'rifle'
    canvas.dataset.activeWeapon = activeWeaponId
    setRifleViewModelEnabled(true)
    weaponFireEffects.setMuzzlePosition(WEAPON_VIEW_CONFIG.muzzlePosition)
    updateAmmoDisplay()
    equipWeapon()
  }
  updateWeaponSwitchControl()
  logRuntimeWarning(
    `[Shotgun] ${context}; the rifle ${wasSelected ? 'is back in hand' : 'stays selected'}.`,
    error,
  )
}

async function loadLocalShotgunModel(parent: TransformNode) {
  const result = await localAssetManager.load('shotgun')
  if (result.status === 'fallback') {
    canvas.dataset.shotgunReady = 'unavailable'
    console.info('[Night Breach][Shotgun] Local GLB unavailable; the rifle remains the only selectable weapon.')
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

    modelRoot = new TransformNode('localShotgunModelRoot', scene)
    // The shotgun is imported while the rifle is on screen, so it is never
    // enabled until the player actually selects it.
    modelRoot.setEnabled(false)
    const boundsOffsetRoot = new TransformNode('localShotgunBoundsOffset', scene)
    boundsOffsetRoot.parent = modelRoot

    for (const rootNode of entries.rootNodes) rootNode.parent = boundsOffsetRoot
    const modelMeshes = boundsOffsetRoot.getChildMeshes(false)
    if (modelMeshes.length === 0) {
      throw new Error('The shotgun GLB did not instantiate any renderable meshes.')
    }
    const renderableMeshCount = modelMeshes.filter((mesh) => mesh.getTotalVertices() > 0).length
    const skinnedMeshCount = modelMeshes.filter(
      (mesh) => mesh.getTotalVertices() > 0 && mesh.skeleton !== null,
    ).length

    const authoredBounds = inspectImportedWeaponBounds(
      'shotgun',
      'Shotgun',
      boundsOffsetRoot,
      modelMeshes,
    )
    // Recentre only this wrapper, exactly like the rifle. Every loader node,
    // bone, skin and animation target keeps its authored local transform.
    boundsOffsetRoot.position.copyFrom(authoredBounds.center).scaleInPlace(-1)
    modelRoot.position.copyFrom(SHOTGUN_ASSET_CONFIG.position)
    modelRoot.rotationQuaternion = Quaternion.FromEulerAngles(
      SHOTGUN_ASSET_CONFIG.rotation.x,
      SHOTGUN_ASSET_CONFIG.rotation.y,
      SHOTGUN_ASSET_CONFIG.rotation.z,
    )
    modelRoot.scaling.setAll(getUniformWeaponScale('shotgun', SHOTGUN_ASSET_CONFIG.scaling))
    modelRoot.parent = parent

    modelMeshes.forEach(configureFirstPersonMesh)
    applyImportedMaterialSettings(modelMeshes, SHOTGUN_ASSET_CONFIG.material)
    // Presentation only, and only on the arms: the shotgun's authored hands are
    // brought onto the AK's so switching weapons no longer swaps the player's
    // gloves, sleeves and skin. The weapon body and the shells keep the shared
    // 'source' policy applied just above.
    canvas.dataset.shotgunArmsMatched = String(
      matchImportedArmMaterials('Shotgun', modelMeshes, SHOTGUN_ASSET_CONFIG.arms),
    )
    optimizeImportedWeapon(modelMeshes)
    await validateImportedWeaponRendering('Shotgun', modelMeshes)

    const animationGroups = [...entries.animationGroups]
    for (const animation of animationGroups) {
      animation.speedRatio = SHOTGUN_ASSET_CONFIG.animationSpeed
      enableImportedAnimationBlending(animation)
      // The one permanent completion observer per clip. It dispatches into the
      // shotgun's own handlers only, so nothing here can ever reach the
      // rifle's reload or fire completion paths.
      animation.onAnimationGroupEndObservable.add(handleShotgunAnimationEnd)
    }
    const detectedAnimations = detectWeaponAnimations(animationGroups)
    const resolvedClips: Record<ShotgunClipName, AnimationGroup | null> = {
      idle: resolveShotgunClip(animationGroups, SHOTGUN_ANIMATION_CLIPS.idle),
      walk: resolveShotgunClip(animationGroups, SHOTGUN_ANIMATION_CLIPS.walk),
      shot: resolveShotgunClip(animationGroups, SHOTGUN_ANIMATION_CLIPS.shot),
      reload: resolveShotgunClip(animationGroups, SHOTGUN_ANIMATION_CLIPS.reload),
    }
    const restAnimation = resolvedClips.idle
      ?? detectedAnimations.idle
      ?? detectedAnimations.equip
      ?? null
    const clipNames = animationGroups.map((animation) => animation.name)
    const skeletonBoneCount = entries.skeletons.reduce(
      (totalBones, skeleton) => totalBones + skeleton.bones.length,
      0,
    )
    if (entries.skeletons.length > 0 && skinnedMeshCount !== renderableMeshCount) {
      throw new Error(
        `The animated shotgun rig detached from its meshes (${skinnedMeshCount}/${renderableMeshCount} skinned).`,
      )
    }
    const hierarchyNodes = entries.rootNodes.flatMap((rootNode) => [
      rootNode,
      ...rootNode.getDescendants(false),
    ])
    if (entries.rootNodes.some((rootNode) => rootNode.parent !== boundsOffsetRoot)) {
      throw new Error('The imported shotgun hierarchy was not preserved beneath its viewmodel root.')
    }

    const activatedEntries = entries
    const activatedRoot = modelRoot
    shotgunRoot = activatedRoot
    shotgunMeshes = [...modelMeshes]
    shotgunAnimationGroups = animationGroups
    shotgunRestAnimation = restAnimation
    shotgunClips = resolvedClips
    // Cycle durations come straight off the authored clips; the fallbacks only
    // stand in if a clip is missing, keeping the fire/reload gates functional.
    shotgunShotDurationSeconds = resolvedClips.shot
      ? getImportedAnimationDurationSeconds(resolvedClips.shot, SHOTGUN_ASSET_CONFIG.animationSpeed)
      : SHOTGUN_COMBAT_CONFIG.shotCycleFallbackSeconds
    shotgunReloadDurationSeconds = resolvedClips.reload
      ? getImportedAnimationDurationSeconds(resolvedClips.reload, SHOTGUN_ASSET_CONFIG.animationSpeed)
      : SHOTGUN_COMBAT_CONFIG.reloadFallbackSeconds
    await shotgunAudio.preload()
    const shellReference = modelMeshes.find((mesh): mesh is Mesh =>
      mesh instanceof Mesh
      && (mesh.material?.name.toLowerCase() === '12ge'
        || mesh.name.toLowerCase().includes('object_94')),
    ) ?? null
    shotgunShellEjectionPool?.dispose()
    try {
      shotgunShellEjectionPool = new ShotgunShellEjectionPool(shellReference)
    } catch (error) {
      logRuntimeWarning(
        '[Shotgun Shell] Authored shell cloning failed; using the lightweight fallback.',
        error,
      )
      shotgunShellEjectionPool = new ShotgunShellEjectionPool(null)
    }
    const activatedShellPool = shotgunShellEjectionPool
    disposeShotgunResources = () => {
      activatedShellPool.dispose()
      if (shotgunShellEjectionPool === activatedShellPool) {
        shotgunShellEjectionPool = null
      }
      activatedEntries.dispose()
      if (!activatedRoot.isDisposed()) activatedRoot.dispose()
    }
    shotgunReady = true
    stopShotgunAnimations()

    canvas.dataset.shotgunReady = 'glb'
    canvas.dataset.shotgunActiveAnimation = 'stopped'
    canvas.dataset.shotgunRestAnimation = restAnimation?.name ?? 'reference-pose'
    canvas.dataset.shotgunResolvedClips = (Object.keys(resolvedClips) as ShotgunClipName[])
      .filter((name) => resolvedClips[name] !== null)
      .join(',') || 'none'
    canvas.dataset.shotgunShotDuration = shotgunShotDurationSeconds.toFixed(6)
    canvas.dataset.shotgunReloadDuration = shotgunReloadDurationSeconds.toFixed(6)
    canvas.dataset.shotgunClipNames = clipNames.join(',') || 'none'
    canvas.dataset.shotgunAnimations =
      (Object.keys(detectedAnimations) as WeaponAnimationName[]).join(',') || 'none'
    canvas.dataset.shotgunSkeletonCount = String(entries.skeletons.length)
    canvas.dataset.shotgunBoneCount = String(skeletonBoneCount)
    canvas.dataset.shotgunHierarchyNodeCount = String(hierarchyNodes.length)
    canvas.dataset.shotgunMeshCount = String(renderableMeshCount)
    canvas.dataset.shotgunSkinnedMeshCount = String(skinnedMeshCount)
    updateWeaponSwitchControl()

    console.info(
      `[Night Breach][Shotgun] Complete imported hierarchy:\n${hierarchyNodes.map((node) => `  ${node.name} <- ${node.parent?.name ?? '(scene)'}`).join('\n')}`,
    )
    console.info(
      `[Night Breach][Shotgun] GLB validated (${renderableMeshCount} renderable/${skinnedMeshCount} skinned meshes; ${entries.skeletons.length} skeletons/${skeletonBoneCount} bones; clips: ${clipNames.join(', ')}; held pose: ${restAnimation?.name ?? 'authored reference pose'}); root position=${formatTransformVector(activatedRoot.position)} rotation=${formatTransformVector(SHOTGUN_ASSET_CONFIG.rotation)} scale=${formatTransformVector(activatedRoot.scaling)}; controller=${viewModelPivot.name}.`,
    )
    return modelRoot
  } catch (error) {
    try {
      shotgunShellEjectionPool?.dispose()
      shotgunShellEjectionPool = null
      entries?.dispose()
      modelRoot?.dispose()
    } catch (disposeError) {
      logRuntimeWarning('[Shotgun] Partial GLB cleanup was skipped.', disposeError)
    }
    if (shotgunRoot === modelRoot) {
      shotgunRoot = null
      shotgunMeshes = []
      shotgunAnimationGroups = []
      shotgunRestAnimation = null
      shotgunClips = { idle: null, walk: null, shot: null, reload: null }
      activeShotgunAnimation = null
      disposeShotgunResources = null
    }
    shotgunReady = false
    canvas.dataset.shotgunReady = 'unavailable'
    logRuntimeWarning('[Shotgun] GLB setup failed; the rifle stays selected.', error)
    return null
  }
}

// ---------------------------------------------------------------------------
// Weapon selection
// ---------------------------------------------------------------------------

function setRifleViewModelEnabled(enabled: boolean) {
  if (importedRifleRoot && !importedRifleRoot.isDisposed()) {
    importedRifleRoot.setEnabled(enabled)
    proceduralRifle?.setEnabled(false)
  } else if (proceduralRifle && !proceduralRifle.isDisposed()) {
    proceduralRifle.setEnabled(enabled)
  }
  if (enabled) return
  for (const animation of importedAnimationGroups) {
    if (animation.isStarted) animation.stop(true)
  }
  activeImportedWeaponAnimation = null
  canvas.dataset.weaponActiveAnimation = 'stopped'
}

function canSelectWeapon(weaponId: WeaponId) {
  if (gameOver) return false
  if (weaponId === 'shotgun') return shotgunReady && shotgunRoot !== null
  return true
}

function selectWeapon(weaponId: WeaponId) {
  if (!canSelectWeapon(weaponId) || weaponId === activeWeaponId) return false

  const previousWeaponId = activeWeaponId
  activeWeaponId = weaponId

  if (previousWeaponId === 'rifle') {
    // A weapon swap cancels an in-flight rifle reload rather than leaving its
    // timer and animation running behind a hidden weapon.
    cancelRifleReload()
    stopAutomaticFire()
    setRifleViewModelEnabled(false)
  } else {
    // Same policy for the shotgun: an interrupted reload transfers no shells,
    // and an interrupted pump cycle never blocks the next selection.
    cancelShotgunReload()
    cancelShotgunShotCycle()
    stopAutomaticFire()
    setShotgunViewModelEnabled(false)
  }

  if (weaponId === 'rifle') {
    setRifleViewModelEnabled(true)
    equipWeapon()
  } else {
    setShotgunViewModelEnabled(true)
  }

  // The flash follows the active weapon's real barrel tip, and the HUD counter
  // always shows the selected weapon's own ammunition.
  weaponFireEffects.setMuzzlePosition(
    weaponId === 'shotgun'
      ? SHOTGUN_COMBAT_CONFIG.muzzleOffset
      : WEAPON_VIEW_CONFIG.muzzlePosition,
  )
  updateAmmoDisplay()

  canvas.dataset.activeWeapon = weaponId
  weaponSwitchCount += 1
  canvas.dataset.weaponSwitchCount = String(weaponSwitchCount)
  updateWeaponSwitchControl()
  assertSingleVisibleWeaponHierarchy()
  console.info(`[Night Breach][Weapons] Selected ${weaponId} (${WEAPON_LABELS[weaponId]}).`)
  return true
}

function requestWeaponSelection(weaponId: WeaponId) {
  if (!gameplayInputEnabled()) return false
  if (weaponId === 'shotgun' && !shotgunReady) {
    console.info('[Night Breach][Weapons] The shotgun view model is not available; keeping the rifle selected.')
    return false
  }
  return selectWeapon(weaponId)
}

function toggleWeaponSelection() {
  return requestWeaponSelection(activeWeaponId === 'rifle' ? 'shotgun' : 'rifle')
}

function updateWeaponSwitchControl() {
  weaponSwitchButton.textContent = WEAPON_LABELS[activeWeaponId]
  weaponSwitchButton.disabled = !shotgunReady
  weaponSwitchButton.setAttribute(
    'aria-label',
    shotgunReady
      ? `Switch weapon, currently ${activeWeaponId === 'rifle' ? 'AK rifle' : 'shotgun'}`
      : 'Switch weapon, unavailable',
  )
}

updateWeaponSwitchControl()
// The rifle stays the deployed weapon while this resolves, and it stays the
// deployed weapon permanently if the import fails.
void loadLocalShotgunModel(viewModelPivot).catch((error) => {
  discardShotgunViewModel('Unexpected load failure', error)
})

switchWeaponSlot = requestWeaponSelection

weaponSwitchButton.addEventListener('pointerdown', (event) => {
  if (!isTouchDevice || !gameplayInputEnabled() || weaponSwitchButton.disabled) return
  event.preventDefault()
  event.stopPropagation()
  weaponSwitchButton.classList.add('active')
  toggleWeaponSelection()
  // One reused handle, so repeated taps can never stack press-feedback timers.
  if (weaponSwitchFeedbackTimer !== undefined) {
    window.clearTimeout(weaponSwitchFeedbackTimer)
  }
  weaponSwitchFeedbackTimer = window.setTimeout(deactivateWeaponSwitchButton, 90)
}, { passive: false })

function deactivateWeaponSwitchButton() {
  weaponSwitchFeedbackTimer = undefined
  weaponSwitchButton.classList.remove('active')
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

// The one ammo readout shows whichever weapon is in the player's hands, in the
// HUD's existing loaded/reserve format.
function updateAmmoDisplay() {
  ammoDisplay.textContent = activeWeaponId === 'shotgun'
    ? `${shotgunLoadedShells}/${shotgunReserveShells}`
    : `${magazineAmmo}/${reserveAmmo}`
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

// The rifle's reload. The shotgun runs its own beginShotgunReload, so this
// path must never run while the shotgun is selected.
function beginReload() {
  if (activeWeaponId !== 'rifle') return
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

// Swapping away from the rifle abandons its reload instead of letting the timer
// and the authored clip keep running against a hidden view model. Any rounds the
// reload already committed stay in the magazine.
function cancelRifleReload() {
  if (reloadElapsed < 0) return
  const reloadAnimation = importedWeaponAnimations.reload
  if (reloadAnimation?.isStarted) reloadAnimation.stop(true)
  reloadElapsed = -1
  reloadApplied = false
  reloadButton.disabled = false
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
  // The rifle's shot. Pressing fire with the shotgun selected routes to
  // fireShotgun instead and must never fall through to here.
  if (activeWeaponId !== 'rifle') return
  if (gameOver || magazineAmmo <= 0 || reloadElapsed >= 0) return

  magazineAmmo -= 1
  const recoilScale = 1 - adsBlend * 0.32
  if (!playImportedWeaponAnimation('fire')) {
    recoilAmount = Math.min(0.064, recoilAmount + 0.047 * recoilScale)
  } else {
    // The authored fire clip already moves the rifle, so layer on only the
    // small extra shove that gives the shot weight without fighting it.
    recoilAmount = Math.min(0.028, recoilAmount + 0.017 * recoilScale)
  }
  muzzleFlashRemaining = MUZZLE_FLASH_DURATION
  weaponFireEffects.trigger(recoilScale)
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

// ---------------------------------------------------------------------------
// Shotgun firing
// ---------------------------------------------------------------------------

const shotgunPelletRay = new Ray(Vector3.Zero(), Vector3.Forward(), SHOTGUN_COMBAT_CONFIG.maxRange)
const shotgunAimForward = Vector3.Forward()
const shotgunAimRight = Vector3.Right()
const shotgunAimUp = Vector3.Up()

// Full damage inside fullDamageRange, then a straight line down to the minimum
// multiplier at maxRange. Applied independently to every pellet.
function shotgunDamageFalloff(distance: number) {
  const { fullDamageRange, maxRange, minDamageMultiplierAtMaxRange } = SHOTGUN_COMBAT_CONFIG
  if (distance <= fullDamageRange) return 1
  const progress = clamp(
    (distance - fullDamageRange) / (maxRange - fullDamageRange),
    0,
    1,
  )
  return 1 + (minDamageMultiplierAtMaxRange - 1) * progress
}

// Knockback has a deliberately sharper curve than damage: maximum force is
// retained through five units, is already much weaker at eight, and approaches
// zero at the pellet ray's maximum range.
function shotgunKnockbackFalloff(distance: number) {
  const {
    fullForceRange,
    weakForceRange,
    weakForceMultiplier,
    longRangeForceMultiplier,
  } = SHOTGUN_COMBAT_CONFIG.knockback
  if (distance <= fullForceRange) return 1
  if (distance <= weakForceRange) {
    const progress = (distance - fullForceRange) / (weakForceRange - fullForceRange)
    return 1 + (weakForceMultiplier - 1) * progress
  }
  const progress = clamp(
    (distance - weakForceRange) / (SHOTGUN_COMBAT_CONFIG.maxRange - weakForceRange),
    0,
    1,
  )
  return weakForceMultiplier
    + (longRangeForceMultiplier - weakForceMultiplier) * progress
}

interface ShotgunPelletBurst {
  point: Vector3
  direction: Vector3
  headshot: boolean
}

interface ShotgunBlastImpact {
  pelletCount: number
  closePelletCount: number
  totalDamage: number
  headshot: boolean
  knockbackImpulse: number
  bloodBursts: ShotgunPelletBurst[]
  flinchDirection: Vector3
}

function fireShotgun() {
  // Hard gates, in the order the design doc lists them: shotgun in hand, the
  // player alive with gameplay input live, a shell chambered, no reload in
  // flight, and the previous fire-and-pump cycle fully completed.
  if (activeWeaponId !== 'shotgun' || !shotgunReady) return
  if (gameOver || !gameplayInputEnabled()) return
  if (shotgunLoadedShells <= 0) return
  if (shotgunReloadElapsed >= 0) return
  if (shotgunShotElapsed >= 0) return

  // Exactly one shell per trigger pull, and the authored SG_FPS_Shot clip IS
  // the fire-and-pump cycle: its completion (watched below and by the clip's
  // end observer) is what re-arms the trigger.
  shotgunLoadedShells -= 1
  updateAmmoDisplay()
  shotgunShotElapsed = 0
  shotgunShellEjectedForCycle = false
  playShotgunAnimation('shot')

  // Muzzle flash and recoil belong to the trigger pull, not the pump. The
  // burst is bigger than the rifle's and the camera kick is far heavier, with
  // a small random horizontal component; the view-model shove rides the same
  // recoilAmount channel the rifle uses and recovers through the same damping,
  // so the barrel settles back exactly onto the crosshair.
  const recoilScale = 1 - adsBlend * SHOTGUN_COMBAT_CONFIG.recoil.adsRecoilReduction
  recoilAmount = Math.min(
    SHOTGUN_COMBAT_CONFIG.recoil.viewModelKickCap,
    recoilAmount + SHOTGUN_COMBAT_CONFIG.recoil.viewModelKick * recoilScale,
  )
  muzzleFlashRemaining = MUZZLE_FLASH_DURATION
  // The generic fire effect owns AK brass. The shotgun's larger spent shell
  // stays chambered until the authored pump frame below, so suppress the
  // immediate rifle casing here.
  weaponFireEffects.trigger(SHOTGUN_COMBAT_CONFIG.recoil.muzzleFlashStrength, false)
  // This call shares the exact trigger point with the visible muzzle flash and
  // the pellet raycasts immediately below. It also schedules the later pump
  // cue from the same audio clock as the shot, avoiding timer/frame drift.
  shotgunAudio.startShotCycle(SHOTGUN_ASSET_CONFIG.animationSpeed)
  camera.cameraRotation.x -= SHOTGUN_COMBAT_CONFIG.recoil.cameraKickPitch * recoilScale
  camera.cameraRotation.y += (Math.random() * 2 - 1)
    * SHOTGUN_COMBAT_CONFIG.recoil.cameraKickYaw * recoilScale
  pulseCrosshair()

  // All pellets leave from the camera/crosshair line with individual random
  // spread inside the hip/ADS cone.
  camera.getDirectionToRef(Vector3.Forward(), shotgunAimForward)
  camera.getDirectionToRef(Vector3.Right(), shotgunAimRight)
  camera.getDirectionToRef(Vector3.Up(), shotgunAimUp)
  const spreadDegrees = SHOTGUN_COMBAT_CONFIG.hipSpreadDegrees
    + (SHOTGUN_COMBAT_CONFIG.adsSpreadDegrees - SHOTGUN_COMBAT_CONFIG.hipSpreadDegrees)
    * adsBlend
  const spreadRadians = spreadDegrees * Math.PI / 180

  const impacts = new Map<Zombie, ShotgunBlastImpact>()
  const diagnostics: ShotgunBlastDiagnostics = {
    pelletRaysCast: 0,
    pelletsIntoZombies: 0,
    zombiesHit: 0,
    zombiesDamaged: 0,
    zombiesKilled: 0,
    targetPellets: 0,
    blockedPellets: 0,
    missedPellets: 0,
    headshot: false,
    totalDamage: 0,
    averageFalloff: 0,
    maxKnockbackImpulse: 0,
  }
  let falloffSum = 0

  for (let pellet = 0; pellet < SHOTGUN_COMBAT_CONFIG.pelletsPerShot; pellet += 1) {
    // Uniform sampling over the cone's disc, so the pattern clusters near the
    // aim point without collapsing onto it.
    const coneAngle = spreadRadians * Math.sqrt(Math.random())
    const azimuth = Math.random() * Math.PI * 2
    const radial = Math.tan(coneAngle)
    const offsetRight = Math.cos(azimuth) * radial
    const offsetUp = Math.sin(azimuth) * radial
    shotgunPelletRay.origin.copyFrom(camera.globalPosition)
    shotgunPelletRay.direction.set(
      shotgunAimForward.x + shotgunAimRight.x * offsetRight + shotgunAimUp.x * offsetUp,
      shotgunAimForward.y + shotgunAimRight.y * offsetRight + shotgunAimUp.y * offsetUp,
      shotgunAimForward.z + shotgunAimRight.z * offsetRight + shotgunAimUp.z * offsetUp,
    )
    shotgunPelletRay.direction.normalize()
    shotgunPelletRay.length = SHOTGUN_COMBAT_CONFIG.maxRange

    // One independent closest-hit raycast per pellet. Because a ray resolves
    // to a single nearest pickable mesh, one pellet can only ever touch one
    // hit zone of one zombie, so overlapping head/torso/limb volumes can
    // never double-count it -- while separate pellets remain free to land on
    // the same zombie. View-model weapon and arm meshes are not pickable, and
    // the first blocking wall or prop simply wins the pick.
    diagnostics.pelletRaysCast += 1
    const result = scene.pickWithRay(shotgunPelletRay)
    if (!result?.hit || !result.pickedMesh) {
      diagnostics.missedPellets += 1
      continue
    }

    const zombieHit = zombieHitZones.get(result.pickedMesh as Mesh)
    if (!zombieHit) {
      const target = targets.get(result.pickedMesh as Mesh)
      if (target) {
        hitTarget(target)
        diagnostics.targetPellets += 1
      } else {
        diagnostics.blockedPellets += 1
      }
      continue
    }

    const falloff = shotgunDamageFalloff(result.distance)
    const headshot = zombieHit.zone === 'head'
    const pelletDamage = SHOTGUN_COMBAT_CONFIG.damagePerPellet
      * SHOTGUN_COMBAT_CONFIG.zoneDamageMultipliers[zombieHit.zone]
      * falloff
    let impact = impacts.get(zombieHit.zombie)
    if (!impact) {
      impact = {
        pelletCount: 0,
        closePelletCount: 0,
        totalDamage: 0,
        headshot: false,
        knockbackImpulse: 0,
        bloodBursts: [],
        flinchDirection: Vector3.Zero(),
      }
      impacts.set(zombieHit.zombie, impact)
    }
    impact.pelletCount += 1
    if (result.distance <= SHOTGUN_COMBAT_CONFIG.knockback.deathLaunchRange) {
      impact.closePelletCount += 1
    }
    impact.totalDamage += pelletDamage
    impact.headshot ||= headshot
    impact.knockbackImpulse += SHOTGUN_COMBAT_CONFIG.knockback.forcePerPellet
      * shotgunKnockbackFalloff(result.distance)
    impact.flinchDirection.addInPlace(shotgunPelletRay.direction)
    diagnostics.pelletsIntoZombies += 1
    falloffSum += falloff

    // Per-pellet blood at each real impact point, capped per zombie so one
    // blast cannot flush the shared particle pool. Head pellets take priority
    // inside the cap so a headshot blast always bleeds like one.
    const burst: ShotgunPelletBurst = {
      point: result.pickedPoint?.clone() ?? result.pickedMesh.getAbsolutePosition().clone(),
      direction: shotgunPelletRay.direction.clone(),
      headshot,
    }
    if (impact.bloodBursts.length < SHOTGUN_COMBAT_CONFIG.maxBloodBurstsPerZombie) {
      impact.bloodBursts.push(burst)
    } else if (headshot) {
      const replaceIndex = impact.bloodBursts.findIndex((existing) => !existing.headshot)
      if (replaceIndex >= 0) impact.bloodBursts[replaceIndex] = burst
    }
  }

  // Damage and knockback are settled once per zombie, after every pellet has
  // been cast, so each zombie takes a single aggregated hit reaction and a
  // single capped impulse instead of up to eight conflicting ones.
  diagnostics.zombiesHit = impacts.size
  let anyDamage = diagnostics.targetPellets > 0
  let anyHeadshot = false
  for (const [zombie, impact] of impacts) {
    if (impact.flinchDirection.lengthSquared() < 0.000001) {
      impact.flinchDirection.copyFrom(shotgunAimForward)
    }
    impact.flinchDirection.normalize()
    const impulse = Math.min(
      SHOTGUN_COMBAT_CONFIG.knockback.maxSpeed,
      impact.knockbackImpulse,
    )
    if (impulse >= SHOTGUN_COMBAT_CONFIG.knockback.minimumForce) {
      // Set horizontal momentum before damage can transition the zombie to
      // dead. A qualifying lethal close blast will transfer this exact
      // direction into the separate corpse impulse inside die().
      zombie.applyKnockback(
        zombie.root.position.x - camera.globalPosition.x,
        zombie.root.position.z - camera.globalPosition.z,
        impulse,
        impact.closePelletCount
          >= SHOTGUN_COMBAT_CONFIG.knockback.deathLaunchMinimumPellets
          ? SHOTGUN_COMBAT_CONFIG.knockback.deathMinimumSpeed
          : 0,
      )
      diagnostics.maxKnockbackImpulse = Math.max(
        diagnostics.maxKnockbackImpulse,
        impulse,
      )
    }
    const damaged = zombie.applyShotgunBlast(
      impact.totalDamage,
      impact.headshot,
      impact.flinchDirection,
      SHOTGUN_COMBAT_CONFIG.knockback.durationSeconds,
    )
    if (!damaged) continue
    diagnostics.zombiesDamaged += 1
    diagnostics.totalDamage += impact.totalDamage
    anyDamage = true
    if (impact.headshot) anyHeadshot = true

    // Head bursts spawn last so the strongest burst is the one that reads as
    // the defining hit of the blast.
    impact.bloodBursts.sort((a, b) => Number(a.headshot) - Number(b.headshot))
    for (const burst of impact.bloodBursts) {
      bloodEffectPool.spawn(burst.point, burst.direction, burst.headshot)
    }

    if (zombie.eliminated) {
      // Death counting and animation remain in the existing death path. The
      // pre-applied blast now moves only the collision-aware corpse root.
      diagnostics.zombiesKilled += 1
      continue
    }
  }

  // Shared feedback fires once per blast, not once per pellet.
  if (anyDamage) showHitMarker()
  if (anyHeadshot) {
    showHeadshotIndicator()
    camera.cameraRotation.x -= 0.0035
    camera.cameraRotation.y += (Math.random() - 0.5) * 0.004
  }
  diagnostics.headshot = anyHeadshot
  diagnostics.averageFalloff = diagnostics.pelletsIntoZombies > 0
    ? falloffSum / diagnostics.pelletsIntoZombies
    : 0
  lastShotgunBlast = diagnostics
}

// Fire and reload requests route to the selected weapon only, so no AK ammo,
// animation, recoil or callback can ever run while the shotgun is in hand,
// and vice versa. Both the desktop bindings and the mobile buttons call these.
fireWeapon = () => {
  if (activeWeaponId === 'shotgun') fireShotgun()
  else fire()
}
reloadWeapon = () => {
  if (activeWeaponId === 'shotgun') beginShotgunReload()
  else beginReload()
}

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

  shotgunAudio.stopAll()
  resetZombieWave()
  bloodEffectPool.reset()
  playerHealth = PLAYER_MAX_HEALTH
  updateHealthDisplay()
  magazineAmmo = 30
  reserveAmmo = 120
  reloadElapsed = -1
  reloadApplied = false
  // The shotgun restarts on its configured loadout with no reload or pump
  // cycle in flight; an interrupted reload transfers nothing.
  cancelShotgunReload()
  cancelShotgunShotCycle()
  shotgunLoadedShells = SHOTGUN_COMBAT_CONFIG.startingLoadedShells
  shotgunReserveShells = SHOTGUN_COMBAT_CONFIG.startingReserveShells
  lastShotgunBlast = null
  recoilAmount = 0
  muzzleFlashRemaining = 0
  weaponFireEffects.reset()
  shotgunShellEjectionPool?.reset()
  reloadButton.disabled = false
  updateAmmoDisplay()
  // Cleared here rather than further down so the retry can put the default
  // loadout back in the player's hands before the equip clip is started.
  gameOver = false
  selectWeapon('rifle')
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
  playerIsMoving = moving
  bobBlend = damp(bobBlend, moving ? 1 : 0, 8, deltaSeconds)
  if (moving) bobTime += deltaSeconds * 8.2

  const bobX = Math.sin(bobTime) * 0.006 * bobBlend
  const bobY = -Math.abs(Math.cos(bobTime)) * 0.005 * bobBlend

  recoilAmount = damp(recoilAmount, 0, 19, deltaSeconds)
  muzzleFlashRemaining = Math.max(0, muzzleFlashRemaining - deltaSeconds)

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

  // Shotgun cycle clocks. The authored end observers are authoritative here
  // too; these watchdogs only stop a stalled clip from wedging the trigger or
  // the reload, mirroring the rifle's pattern above.
  if (shotgunShotElapsed >= 0) {
    shotgunShotElapsed += deltaSeconds
    const ejectionTime = SHOTGUN_SHELL_EJECTION_CONFIG.authoredOffsetSeconds
      / Math.max(0.001, Math.abs(SHOTGUN_ASSET_CONFIG.animationSpeed))
    if (!shotgunShellEjectedForCycle
      && shotgunShotElapsed >= ejectionTime
      && activeWeaponId === 'shotgun'
      && !gameOver) {
      shotgunShellEjectedForCycle = true
      shotgunShellEjectionPool?.eject()
    }
    if (shotgunShotElapsed
      >= shotgunShotDurationSeconds + RELOAD_COMPLETION_GRACE_SECONDS) {
      completeShotgunShotCycle()
    }
  }
  if (shotgunReloadElapsed >= 0) {
    shotgunReloadElapsed += deltaSeconds
    if (shotgunReloadElapsed
      >= shotgunReloadDurationSeconds + RELOAD_COMPLETION_GRACE_SECONDS) {
      completeShotgunReload()
    }
  }

  // Locomotion loop for the shotgun's rest state: the authored walk while the
  // player moves, idle when standing. Never while a shot or reload is playing,
  // so those clips can never be overridden by the loop.
  if (activeWeaponId === 'shotgun'
    && shotgunReady
    && shotgunShotElapsed < 0
    && shotgunReloadElapsed < 0) {
    const desiredRest = (playerIsMoving ? shotgunClips.walk : null)
      ?? shotgunClips.idle
      ?? shotgunRestAnimation
    if (desiredRest && activeShotgunAnimation !== desiredRest) {
      playShotgunRestAnimation()
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
    // Only a frame that actually submitted the imported rifle proves it renders,
    // so a shotgun-selected frame leaves the validation pending.
    if (pendingImportedRifleFirstFrame && importedRifleRoot?.isEnabled()) {
      pendingImportedRifleFirstFrame = false
      canvas.dataset.weaponSource = 'glb'
      canvas.dataset.rifleReady = 'glb'
      proceduralRifle?.dispose()
      proceduralRifle = null
      canvas.dataset.proceduralRifle = 'disposed'
      assertSingleVisibleWeaponHierarchy()
      logFinalImportedRiflePresentation()
      console.info('[Night Breach][Rifle] First GLB frame succeeded; procedural rifle removed from the scene.')
    }
  } catch (error) {
    renderFailureCount += 1
    // Retire whichever weapon was actually on screen for the failed frame.
    if (activeWeaponId === 'shotgun' && shotgunRoot) {
      discardShotgunViewModel('The imported GLB caused a render failure', error)
      return
    }
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
    shotgunAudio.stopAll()
    cancelMobileInput()
    if (isDesktop && deployed && !gameOver) stopCameraControls()
    for (let index = 0; index < zombies.length; index += 1) {
      zombies[index].setPaused(true)
    }
    pausedWeaponAnimations.length = 0
    // Both weapons' clips are covered; only the selected one is ever playing.
    const lifecycleAnimations = [...importedAnimationGroups, ...shotgunAnimationGroups]
    for (let index = 0; index < lifecycleAnimations.length; index += 1) {
      const animation = lifecycleAnimations[index]
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
    // Scheduled Web Audio sources cannot be paused. Backgrounding stops them
    // above; on return, rebuild only cues that have not yet occurred so the
    // resumed authored clip stays synchronized without replaying old sounds.
    if (activeWeaponId === 'shotgun') {
      if (shotgunShotElapsed >= 0) {
        shotgunAudio.resumeShotCycle(
          shotgunShotElapsed,
          SHOTGUN_ASSET_CONFIG.animationSpeed,
        )
      } else if (shotgunReloadElapsed >= 0) {
        shotgunAudio.resumeReload(
          shotgunReloadElapsed,
          SHOTGUN_ASSET_CONFIG.animationSpeed,
        )
      }
    }
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
          activeWeapon: activeWeaponId,
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
          // Scene-wide totals, so repeated weapon switching can be proven not to
          // leak meshes, transform nodes, skeletons or animation groups.
          sceneAnimationGroupCount: scene.animationGroups.length,
          sceneMeshCount: scene.meshes.length,
          sceneSkeletonCount: scene.skeletons.length,
          sceneTransformNodeCount: scene.transformNodes.length,
          hudAmmoText: ammoDisplay.textContent,
          lastShotgunBlast: lastShotgunBlast ? { ...lastShotgunBlast } : null,
          shotgunActiveAnimation: canvas.dataset.shotgunActiveAnimation ?? 'none',
          shotgunAmmo: `${shotgunLoadedShells}/${shotgunReserveShells}`,
          shotgunAnimationGroupCount: shotgunAnimationGroups.length,
          shotgunBoneCount: Number(canvas.dataset.shotgunBoneCount ?? 0),
          shotgunClipNames: canvas.dataset.shotgunClipNames ?? 'none',
          shotgunEnabled: Boolean(shotgunRoot?.isEnabled()),
          shotgunEndObserverCounts: {
            idle: shotgunClips.idle?.onAnimationGroupEndObservable.observers.length ?? 0,
            walk: shotgunClips.walk?.onAnimationGroupEndObservable.observers.length ?? 0,
            shot: shotgunClips.shot?.onAnimationGroupEndObservable.observers.length ?? 0,
            reload: shotgunClips.reload?.onAnimationGroupEndObservable.observers.length ?? 0,
          },
          shotgunHierarchyNodeCount: Number(canvas.dataset.shotgunHierarchyNodeCount ?? 0),
          shotgunMeshCount: Number(canvas.dataset.shotgunMeshCount ?? 0),
          shotgunReady: canvas.dataset.shotgunReady,
          shotgunReloadDuration: shotgunReloadDurationSeconds,
          shotgunReloadElapsed,
          shotgunResolvedClips: canvas.dataset.shotgunResolvedClips ?? 'none',
          shotgunRestAnimation: canvas.dataset.shotgunRestAnimation ?? 'none',
          shotgunSceneMeshCount: shotgunMeshes.length,
          shotgunShotDuration: shotgunShotDurationSeconds,
          shotgunShotElapsed,
          shotgunSkeletonCount: Number(canvas.dataset.shotgunSkeletonCount ?? 0),
          weaponSwitchCount,
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
          visibleWeaponHierarchies: Number(canvas.dataset.visibleWeaponHierarchies ?? 0),
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
            knockback: zombie.knockbackAmount,
            deathKnockback: zombie.deathImpulseAmount,
            deathBackFallAngle: zombie.deathBackFallAngle,
            chestUp: zombie.chestUpAmount,
          })),
        }
      },
      fire() {
        fireWeapon()
      },
      reload() {
        reloadWeapon()
      },
      inputGates() {
        return {
          isDesktop,
          isTouchDevice,
          gameReady,
          deployed,
          webViewActive,
          portraitInputPaused,
          gameOver,
          gameplayInputEnabled: gameplayInputEnabled(),
        }
      },
      // Reports the shotgun barrel tip in viewModelPivot space so the harness
      // can verify the configured muzzle flash anchor against the real posed
      // geometry. Skinned positions are read through getPositionData, which
      // applies the current bone pose without mutating any vertex buffer; the
      // farthest +Z slice across every shotgun mesh is the muzzle ring.
      measureShotgunMuzzle() {
        if (shotgunMeshes.length === 0) return { error: 'no-mesh', meshNames: [] }
        viewModelPivot.computeWorldMatrix(true)
        const pivotInverse = viewModelPivot.getWorldMatrix().clone().invert()
        const vertex = Vector3.Zero()
        const transformed = Vector3.Zero()
        const meshData: { positions: Float32Array | number[]; toPivot: Matrix }[] = []
        for (const mesh of shotgunMeshes) {
          if (!(mesh instanceof Mesh) || mesh.getTotalVertices() === 0) continue
          const positions = mesh.getPositionData(true, false)
          if (!positions) continue
          mesh.computeWorldMatrix(true)
          meshData.push({
            positions,
            toPivot: mesh.getWorldMatrix().multiply(pivotInverse),
          })
        }
        if (meshData.length === 0) {
          return { error: 'no-positions', meshNames: shotgunMeshes.map((mesh) => mesh.name) }
        }
        let maxZ = Number.NEGATIVE_INFINITY
        for (const { positions, toPivot } of meshData) {
          for (let index = 0; index < positions.length; index += 3) {
            vertex.copyFromFloats(positions[index], positions[index + 1], positions[index + 2])
            Vector3.TransformCoordinatesToRef(vertex, toPivot, transformed)
            if (transformed.z > maxZ) maxZ = transformed.z
          }
        }
        let frontCount = 0
        let sumX = 0
        let sumY = 0
        let sumZ = 0
        for (const { positions, toPivot } of meshData) {
          for (let index = 0; index < positions.length; index += 3) {
            vertex.copyFromFloats(positions[index], positions[index + 1], positions[index + 2])
            Vector3.TransformCoordinatesToRef(vertex, toPivot, transformed)
            if (transformed.z <= maxZ - 0.03) continue
            frontCount += 1
            sumX += transformed.x
            sumY += transformed.y
            sumZ += transformed.z
          }
        }
        if (frontCount === 0) return { error: 'no-front-vertices', meshNames: [], maxZ }
        const configured = SHOTGUN_COMBAT_CONFIG.muzzleOffset
        return {
          measured: { x: sumX / frontCount, y: sumY / frontCount, z: sumZ / frontCount },
          configured: { x: configured.x, y: configured.y, z: configured.z },
          frontVertexCount: frontCount,
          maxZ,
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
      selectWeapon(weaponId: WeaponId) {
        return requestWeaponSelection(weaponId)
      },
      toggleWeapon() {
        return toggleWeaponSelection()
      },
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
