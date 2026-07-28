import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera'
import { Engine } from '@babylonjs/core/Engines/engine'
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight'
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight'
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color'
import { Vector3 } from '@babylonjs/core/Maths/math.vector'
import { type AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh'
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder'
import { TransformNode } from '@babylonjs/core/Meshes/transformNode'
import { Scene } from '@babylonjs/core/scene'
import { SceneLoader } from '@babylonjs/core/Loading/sceneLoader'
import '@babylonjs/loaders/glTF'

const SOURCE_PATH =
  '/assets/environment/old-wooden-shed/old_wooden_shed.glb'
const UNIFORM_SCALE = 0.0132

const canvas = document.querySelector<HTMLCanvasElement>('#previewCanvas')
if (!canvas) throw new Error('The isolated shed preview canvas is missing.')

const engine = new Engine(canvas, true, {
  adaptToDeviceRatio: true,
  preserveDrawingBuffer: true,
  stencil: true,
})
const scene = new Scene(engine)
scene.clearColor = Color4.FromHexString('#bbc6cbff')

const camera = new ArcRotateCamera(
  'isolatedShedCamera',
  Math.PI * 0.5,
  Math.PI * 0.42,
  8.5,
  new Vector3(0, 1.75, 0),
  scene,
)
camera.fov = 0.72

const skyLight = new HemisphericLight(
  'isolatedShedSkyLight',
  new Vector3(0.25, 1, 0.2),
  scene,
)
skyLight.intensity = 1.25
skyLight.diffuse = Color3.FromHexString('#f4f7f7')
skyLight.groundColor = Color3.FromHexString('#677277')

const sun = new DirectionalLight(
  'isolatedShedSun',
  new Vector3(-0.5, -1, 0.7),
  scene,
)
sun.position.set(5, 8, -5)
sun.intensity = 1.5

const imported = await SceneLoader.ImportMeshAsync('', '', SOURCE_PATH, scene)
const renderMeshes = imported.meshes.filter(
  (mesh): mesh is AbstractMesh => mesh.getTotalVertices() > 0,
)
if (renderMeshes.length === 0) {
  throw new Error(`No render meshes were loaded from ${SOURCE_PATH}.`)
}

const minimum = new Vector3(
  Number.POSITIVE_INFINITY,
  Number.POSITIVE_INFINITY,
  Number.POSITIVE_INFINITY,
)
const maximum = new Vector3(
  Number.NEGATIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
)
for (const mesh of renderMeshes) {
  mesh.computeWorldMatrix(true)
  const bounds = mesh.getBoundingInfo().boundingBox
  minimum.minimizeInPlace(bounds.minimumWorld)
  maximum.maximizeInPlace(bounds.maximumWorld)
}
const center = minimum.add(maximum).scale(0.5)

const placementRoot = new TransformNode('isolatedShedPlacement', scene)
placementRoot.scaling.setAll(UNIFORM_SCALE)
const importedNodes = [...imported.meshes, ...imported.transformNodes]
for (const rootNode of importedNodes.filter((node) => !node.parent)) {
  rootNode.parent = placementRoot
}
placementRoot.position.set(
  -center.x * UNIFORM_SCALE,
  -minimum.y * UNIFORM_SCALE,
  -center.z * UNIFORM_SCALE,
)

const ground = MeshBuilder.CreateGround(
  'isolatedPreviewGround',
  { width: 14, height: 14 },
  scene,
)
const groundMaterial = new (await import(
  '@babylonjs/core/Materials/standardMaterial'
)).StandardMaterial('isolatedPreviewGroundMaterial', scene)
groundMaterial.diffuseColor = Color3.FromHexString('#e8eeef')
groundMaterial.specularColor = Color3.Black()
ground.material = groundMaterial

engine.runRenderLoop(() => scene.render())
window.addEventListener('resize', () => engine.resize())

await scene.whenReadyAsync()
for (let frame = 0; frame < 8; frame += 1) {
  scene.render()
  await new Promise<void>((resolveFrame) =>
    window.requestAnimationFrame(() => resolveFrame())
  )
}
canvas.dataset.previewReady = 'true'
canvas.dataset.sourcePath = SOURCE_PATH
canvas.dataset.meshCount = String(renderMeshes.length)
canvas.dataset.bounds = [
  maximum.x - minimum.x,
  maximum.y - minimum.y,
  maximum.z - minimum.z,
].map((value) => value.toFixed(3)).join(',')
canvas.dataset.minimum = [minimum.x, minimum.y, minimum.z]
  .map((value) => value.toFixed(3))
  .join(',')
canvas.dataset.maximum = [maximum.x, maximum.y, maximum.z]
  .map((value) => value.toFixed(3))
  .join(',')
document.title = 'READY: Old Wooden Shed isolated preview'
