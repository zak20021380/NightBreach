import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial'
import { Color3 } from '@babylonjs/core/Maths/math.color'
import { Mesh } from '@babylonjs/core/Meshes/mesh'
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder'
import { type Scene } from '@babylonjs/core/scene'

interface NaturalBoundaryOptions {
  readonly scene: Scene
  readonly worldLayerMask: number
}

export interface NaturalBoundaryResult {
  readonly fallenLogCount: number
  readonly fencePieceCount: number
  readonly meshCount: number
  readonly propCount: number
  readonly rockCount: number
  readonly snowbankCount: number
}

function createBoundaryMaterial(
  name: string,
  color: Color3,
  roughness: number,
  scene: Scene,
) {
  const material = new PBRMaterial(name, scene)
  material.albedoColor = color
  material.metallic = 0
  material.roughness = roughness
  material.environmentIntensity = 0.48
  return material
}

function mergeBoundaryPieces(
  name: string,
  pieces: Mesh[],
  material: PBRMaterial,
  worldLayerMask: number,
) {
  const merged = Mesh.MergeMeshes(
    pieces,
    true,
    true,
    undefined,
    false,
    true,
  )
  if (!merged) throw new Error(`Could not merge natural boundary "${name}".`)
  merged.name = name
  merged.material = material
  merged.isPickable = false
  merged.checkCollisions = false
  merged.receiveShadows = false
  merged.layerMask = worldLayerMask
  merged.metadata = {
    naturalBoundaryDecoration: true,
    preserveWithImportedEnvironment: true,
  }
  merged.computeWorldMatrix(true)
  merged.freezeWorldMatrix()
  return merged
}

/**
 * Builds a few low-poly silhouettes beyond the invisible ±26 m collision
 * limit. Every category is merged into one static draw mesh; none participates
 * in picking, collision, physics, shadows, or per-frame work.
 */
export function createNaturalBoundary(
  options: NaturalBoundaryOptions,
): NaturalBoundaryResult {
  const snowMaterial = createBoundaryMaterial(
    'naturalBoundarySnowMaterial',
    Color3.FromHexString('#dbe5ea'),
    0.98,
    options.scene,
  )
  const rockMaterial = createBoundaryMaterial(
    'naturalBoundaryRockMaterial',
    Color3.FromHexString('#454d50'),
    0.96,
    options.scene,
  )
  const woodMaterial = createBoundaryMaterial(
    'naturalBoundaryWoodMaterial',
    Color3.FromHexString('#4a382b'),
    0.94,
    options.scene,
  )

  const snowbankDefinitions = [
    [-18.5, 27.2, 2.5, 0.48, 1.05, 0.08],
    [-5.5, 27.35, 2.1, 0.42, 1.25, -0.15],
    [25, 27.1, 2.7, 0.52, 1.05, 0.18],
    [-23, -27.25, 2.4, 0.45, 1.2, -0.12],
    [3.5, -27.3, 2.8, 0.5, 1.05, 0.1],
    [22, -27.15, 2.25, 0.42, 1.3, -0.2],
    [-27.25, -11.5, 1.2, 0.46, 2.6, 0.12],
    [-27.15, 14, 1.05, 0.4, 2.3, -0.1],
    [27.2, -17, 1.15, 0.45, 2.7, 0.14],
    [27.3, 16.5, 1.25, 0.48, 2.45, -0.16],
  ] as const
  const snowbanks = snowbankDefinitions.map(
    ([x, z, scaleX, scaleY, scaleZ, rotationY], index) => {
      const bank = MeshBuilder.CreateSphere(
        `naturalBoundarySnowbank${index + 1}`,
        { diameter: 2, segments: 6 },
        options.scene,
      )
      bank.position.set(x, -0.24, z)
      bank.scaling.set(scaleX, scaleY, scaleZ)
      bank.rotation.y = rotationY
      return bank
    },
  )
  mergeBoundaryPieces(
    'naturalBoundarySnowbanks',
    snowbanks,
    snowMaterial,
    options.worldLayerMask,
  )

  const rockDefinitions = [
    [-24.5, -27.05, 1.25, 0.72, 0.9, 0.3],
    [25.2, -26.95, 0.9, 0.58, 1.15, -0.45],
    [-27.1, -2, 1.05, 0.65, 0.82, 0.2],
    [27.05, 7.5, 1.2, 0.76, 0.9, -0.18],
    [-8.5, 27.05, 0.82, 0.55, 1.05, 0.5],
    [27.15, 23.5, 0.92, 0.62, 1.2, -0.38],
  ] as const
  const rocks = rockDefinitions.map(
    ([x, z, scaleX, scaleY, scaleZ, rotationY], index) => {
      const rock = MeshBuilder.CreateSphere(
        `naturalBoundaryRock${index + 1}`,
        { diameter: 1.4, segments: 5 },
        options.scene,
      )
      rock.position.set(x, 0.28, z)
      rock.scaling.set(scaleX, scaleY, scaleZ)
      rock.rotation.y = rotationY
      return rock
    },
  )
  mergeBoundaryPieces(
    'naturalBoundaryRocks',
    rocks,
    rockMaterial,
    options.worldLayerMask,
  )

  const logDefinitions = [
    [-20, 0.28, 27.15, 3.8, 0.46, 0.32],
    [18.5, 0.25, -27.1, 3.3, 0.42, -0.28],
    [-27.05, 0.3, 9, 3.6, 0.48, 1.42],
  ] as const
  const woodPieces = logDefinitions.map(
    ([x, y, z, length, diameter, rotationY], index) => {
      const log = MeshBuilder.CreateCylinder(
        `naturalBoundaryFallenLog${index + 1}`,
        { height: length, diameter, tessellation: 6 },
        options.scene,
      )
      log.position.set(x, y, z)
      log.rotation.set(0, rotationY, Math.PI * 0.5)
      return log
    },
  )
  const fenceDefinitions = [
    [27.05, 0.58, -12, 0.18, 1.16, 0.18, 0],
    [27.05, 0.48, -9.8, 0.18, 0.96, 0.18, 0.08],
    [27.02, 0.65, -10.9, 0.15, 0.16, 2.25, 0.06],
    [-2.3, 0.62, 27.05, 0.18, 1.24, 0.18, -0.04],
    [0.2, 0.5, 27.05, 0.18, 1, 0.18, 0.08],
    [-1, 0.68, 27.02, 2.55, 0.15, 0.16, -0.09],
  ] as const
  for (
    let index = 0;
    index < fenceDefinitions.length;
    index += 1
  ) {
    const [x, y, z, width, height, depth, rotationY] =
      fenceDefinitions[index]
    const piece = MeshBuilder.CreateBox(
      `naturalBoundaryFencePiece${index + 1}`,
      { width, height, depth },
      options.scene,
    )
    piece.position.set(x, y, z)
    piece.rotation.y = rotationY
    woodPieces.push(piece)
  }
  mergeBoundaryPieces(
    'naturalBoundaryWoodDebris',
    woodPieces,
    woodMaterial,
    options.worldLayerMask,
  )

  const propCount =
    snowbankDefinitions.length
    + rockDefinitions.length
    + logDefinitions.length
    + fenceDefinitions.length
  console.info(
    `[Night Breach][Natural Boundary] ${propCount} lightweight props merged `
    + `into 3 non-colliding, shadow-free meshes outside the playable limit.`,
  )
  return {
    fallenLogCount: logDefinitions.length,
    fencePieceCount: fenceDefinitions.length,
    meshCount: 3,
    propCount,
    rockCount: rockDefinitions.length,
    snowbankCount: snowbankDefinitions.length,
  }
}
