import { type AssetContainer } from '@babylonjs/core/assetContainer'
import { Vector3 } from '@babylonjs/core/Maths/math.vector'
import { type AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh'
import { Mesh } from '@babylonjs/core/Meshes/mesh'
import { TransformNode } from '@babylonjs/core/Meshes/transformNode'
import { type Scene } from '@babylonjs/core/scene'

export const WOODEN_SHED_SOURCE_PATH =
  '/assets/environment/old-wooden-shed/old_wooden_shed.glb'

const DOOR_NODE_SOURCE_NAME = 'Door'
const EXPECTED_MESH_SOURCE_NAMES = [
  'Door_Tex2_0',
  'DoorHingeP2_Tex2_0',
  'DoorBolt_Tex2_0',
  'DoorHingeP1_Tex2_0',
  'DoorBoltP2_Tex2_0',
  'DoorBoltP1_Tex2_0',
  'Base_Tex2_0',
  'Base_Tex1_0',
  'DoorHingeP3_Tex2_0',
  'DoorHingeP4_Tex2_0',
  'DoorBoltP3_Tex2_0',
  'Roof_Tex2_0',
] as const

const EXPECTED_HIERARCHY_SOURCE_NAMES = [
  'Sketchfab_model',
  'shed.fbx',
  'RootNode',
  'Door',
  'Door_Tex2_0',
  'DoorHingeP2',
  'DoorHingeP2_Tex2_0',
  'DoorBolt',
  'DoorBolt_Tex2_0',
  'DoorHingeP1',
  'DoorHingeP1_Tex2_0',
  'DoorBoltP2',
  'DoorBoltP2_Tex2_0',
  'DoorBoltP1',
  'DoorBoltP1_Tex2_0',
  'Base',
  'Base_Tex2_0',
  'Base_Tex1_0',
  'DoorHingeP3',
  'DoorHingeP3_Tex2_0',
  'DoorHingeP4',
  'DoorHingeP4_Tex2_0',
  'DoorBoltP3',
  'DoorBoltP3_Tex2_0',
  'Roof',
  'Roof_Tex2_0',
] as const

export interface ModelBounds {
  readonly minimum: Vector3
  readonly maximum: Vector3
  readonly center: Vector3
  readonly size: Vector3
}

export interface WoodenShedAssetSummary {
  readonly bounds: {
    readonly maximum: readonly [x: number, y: number, z: number]
    readonly minimum: readonly [x: number, y: number, z: number]
    readonly size: readonly [x: number, y: number, z: number]
  }
  readonly doorMeshNames: readonly string[]
  readonly hierarchyNodeNames: readonly string[]
  readonly meshNames: readonly string[]
  readonly rootTransform: {
    readonly position: readonly [x: number, y: number, z: number]
    readonly rotation: readonly [x: number, y: number, z: number]
    readonly scale: readonly [x: number, y: number, z: number]
  }
  readonly sourcePath: string
  readonly uniformScale: number
}

interface WoodenShedInstanceOptions {
  readonly instanceName: string
  readonly rotationY: number
  readonly scene: Scene
  readonly shedContainer: AssetContainer
  readonly targetX: number
  readonly targetZ: number
  readonly uniformScale: number
  readonly worldLayerMask: number
}

export interface WoodenShedInstance {
  readonly asset: WoodenShedAssetSummary
  readonly doorBounds: ModelBounds
  readonly importedMeshes: readonly AbstractMesh[]
  readonly movingDoorMeshes: readonly Mesh[]
  readonly movingDoorNode: TransformNode
  readonly placementRoot: TransformNode
}

export function getWoodenShedBounds(
  meshes: readonly AbstractMesh[],
): ModelBounds {
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

  for (const mesh of meshes) {
    mesh.computeWorldMatrix(true)
    const boundingBox = mesh.getBoundingInfo().boundingBox
    minimum.minimizeInPlace(boundingBox.minimumWorld)
    maximum.maximizeInPlace(boundingBox.maximumWorld)
  }

  if (!Number.isFinite(minimum.x) || !Number.isFinite(maximum.x)) {
    throw new Error('The old wooden shed has no finite render bounds.')
  }

  return {
    minimum,
    maximum,
    center: minimum.add(maximum).scale(0.5),
    size: maximum.subtract(minimum),
  }
}

function vectorTuple(vector: Vector3): readonly [number, number, number] {
  return [vector.x, vector.y, vector.z]
}

/**
 * Instantiates one complete, authored shed hierarchy. Placement, orientation,
 * grounding, and uniform scale are applied only to this parent root; no child
 * mesh, material, UV, roof, base, door, or hardware transform is reshaped.
 */
export function instantiateAuditedWoodenShed(
  options: WoodenShedInstanceOptions,
): WoodenShedInstance {
  const {
    instanceName,
    rotationY,
    scene,
    shedContainer,
    targetX,
    targetZ,
    uniformScale,
    worldLayerMask,
  } = options
  const importPrefix = `${instanceName}_`
  const sourceName = (importedName: string) =>
    importedName.startsWith(importPrefix)
      ? importedName.slice(importPrefix.length)
      : importedName
  const entries = shedContainer.instantiateModelsToScene(
    (name) => `${importPrefix}${name}`,
    false,
    { doNotInstantiate: true },
  )

  const placementRoot = new TransformNode(`${instanceName}Placement`, scene)
  for (const rootNode of entries.rootNodes) rootNode.parent = placementRoot

  const allDescendants = entries.rootNodes.flatMap((rootNode) => [
    rootNode,
    ...rootNode.getDescendants(false),
  ])
  const importedMeshes = allDescendants.filter(
    (node): node is AbstractMesh =>
      node instanceof Mesh && node.getTotalVertices() > 0,
  )
  if (importedMeshes.length !== EXPECTED_MESH_SOURCE_NAMES.length) {
    entries.dispose()
    placementRoot.dispose()
    throw new Error(
      `Old Wooden Shed hierarchy changed: expected ${EXPECTED_MESH_SOURCE_NAMES.length} `
      + `render meshes, received ${importedMeshes.length}.`,
    )
  }

  const importedMeshNames = importedMeshes.map((mesh) => sourceName(mesh.name))
  const missingMeshNames = EXPECTED_MESH_SOURCE_NAMES.filter(
    (name) => !importedMeshNames.includes(name),
  )
  if (missingMeshNames.length > 0) {
    entries.dispose()
    placementRoot.dispose()
    throw new Error(
      `Old Wooden Shed is missing audited meshes: ${missingMeshNames.join(', ')}.`,
    )
  }

  const movingDoorNode = allDescendants.find(
    (node): node is TransformNode =>
      node instanceof TransformNode
      && sourceName(node.name) === DOOR_NODE_SOURCE_NAME,
  )
  if (!movingDoorNode) {
    entries.dispose()
    placementRoot.dispose()
    throw new Error('Old Wooden Shed door transform was not found.')
  }

  const movingDoorMeshes = movingDoorNode.getChildMeshes(false)
    .filter(
      (mesh): mesh is Mesh =>
        mesh instanceof Mesh && mesh.getTotalVertices() > 0,
    )
  const movingDoorHierarchy = [
    movingDoorNode,
    ...movingDoorNode.getChildTransformNodes(false),
  ]
  const importedNodeSet = new Set(allDescendants)
  if (movingDoorHierarchy.some((node) => !importedNodeSet.has(node))) {
    entries.dispose()
    placementRoot.dispose()
    throw new Error(
      `Old Wooden Shed door hierarchy escaped its ${instanceName} instance.`,
    )
  }
  // A second clone can retain a cached world matrix independently of the first
  // clone. Explicitly thaw its complete authored Door subtree before it is
  // reparented to the cabin's live hinge; the static freeze pass below still
  // freezes every mesh outside this exact instance-owned hierarchy.
  for (const node of movingDoorHierarchy) node.unfreezeWorldMatrix()
  const movingDoorMeshNames = movingDoorMeshes.map(
    (mesh) => sourceName(mesh.name),
  )
  if (!movingDoorMeshNames.includes('Door_Tex2_0')) {
    entries.dispose()
    placementRoot.dispose()
    throw new Error('Old Wooden Shed door panel mesh was not found under Door.')
  }

  const originalBounds = getWoodenShedBounds(importedMeshes)
  const originalDoorBounds = getWoodenShedBounds(movingDoorMeshes)
  const doorFacesPositiveZ =
    Math.abs(originalDoorBounds.center.z - originalBounds.maximum.z)
      < Math.abs(originalDoorBounds.center.z - originalBounds.minimum.z)
  if (!doorFacesPositiveZ) {
    entries.dispose()
    placementRoot.dispose()
    throw new Error(
      'Old Wooden Shed entrance orientation no longer matches its audited hierarchy.',
    )
  }

  placementRoot.position.set(targetX, 0, targetZ)
  placementRoot.rotation.y = rotationY
  placementRoot.scaling.setAll(uniformScale)
  placementRoot.computeWorldMatrix(true)
  for (const rootNode of entries.rootNodes) rootNode.computeWorldMatrix(true)
  for (const mesh of importedMeshes) mesh.computeWorldMatrix(true)

  // Centre the authored bounds on the previous house location and put the
  // lowest authored support post exactly on the snow. This correction remains
  // on the one placement root rather than introducing a child offset node.
  const initialPlacedBounds = getWoodenShedBounds(importedMeshes)
  placementRoot.position.addInPlace(new Vector3(
    targetX - initialPlacedBounds.center.x,
    -initialPlacedBounds.minimum.y,
    targetZ - initialPlacedBounds.center.z,
  ))

  for (const mesh of importedMeshes) {
    mesh.isPickable = false
    mesh.checkCollisions = false
    mesh.receiveShadows = true
    mesh.layerMask = worldLayerMask
    mesh.metadata = {
      ...mesh.metadata,
      importedOldWoodenShed: true,
      preserveWithImportedEnvironment: true,
      shedInstance: instanceName,
      sourceMeshName: sourceName(mesh.name),
    }
  }

  placementRoot.computeWorldMatrix(true)
  for (const rootNode of entries.rootNodes) rootNode.computeWorldMatrix(true)
  for (const mesh of importedMeshes) mesh.computeWorldMatrix(true)
  const placedBounds = getWoodenShedBounds(importedMeshes)
  const doorBounds = getWoodenShedBounds(movingDoorMeshes)

  const hierarchyNodeNames = allDescendants.map(
    (node) => sourceName(node.name),
  )
  const missingHierarchy = EXPECTED_HIERARCHY_SOURCE_NAMES.filter(
    (name) => !hierarchyNodeNames.includes(name),
  )
  if (missingHierarchy.length > 0) {
    throw new Error(
      `Old Wooden Shed hierarchy audit failed after placement: `
      + `${missingHierarchy.join(', ')}.`,
    )
  }

  const rootPosition = vectorTuple(placementRoot.position)
  console.info(
    `[Night Breach][Shed] Imported ${WOODEN_SHED_SOURCE_PATH} as ${instanceName}: `
    + `${importedMeshes.length} meshes, door=${movingDoorMeshNames.join('|')}, `
    + `rootPosition=(${rootPosition.join(',')}), `
    + `rotationY=${rotationY}, uniformScale=${uniformScale}.`,
  )

  return {
    asset: {
      bounds: {
        maximum: vectorTuple(placedBounds.maximum),
        minimum: vectorTuple(placedBounds.minimum),
        size: vectorTuple(placedBounds.size),
      },
      doorMeshNames: movingDoorMeshNames,
      hierarchyNodeNames,
      meshNames: importedMeshNames,
      rootTransform: {
        position: rootPosition,
        rotation: [0, rotationY, 0],
        scale: [uniformScale, uniformScale, uniformScale],
      },
      sourcePath: WOODEN_SHED_SOURCE_PATH,
      uniformScale,
    },
    doorBounds,
    importedMeshes,
    movingDoorMeshes,
    movingDoorNode,
    placementRoot,
  }
}
