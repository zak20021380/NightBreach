import { type ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator'
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial'
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial'
import { type AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh'
import { type Scene } from '@babylonjs/core/scene'
import {
  createEnterableOperationsHouse,
  type EnterableHouseResult,
} from './enterableHouse'
import { createGuardShack } from './guardShack'
import {
  type WeatherShelter,
  type WinterSurface,
} from './winterEnvironment'

type StructureMaterial = PBRMaterial | StandardMaterial

interface AbandonedStructureOptions {
  scene: Scene
  shadowGenerator: ShadowGenerator | null
  materials: {
    concrete: StructureMaterial
    hazard: StructureMaterial
    metal: StructureMaterial
    wall: StructureMaterial
    wood: StructureMaterial
  }
  worldLayerMask: number
  registerEnvironmentMesh: (mesh: AbstractMesh) => void
}

export interface AbandonedStructureSummary {
  name: string
  label: string
  position: readonly [x: number, z: number]
  footprint: readonly [width: number, depth: number]
}

export interface AbandonedStructureResult {
  collisionMeshCount: number
  enterableHouse: EnterableHouseResult
  visibleMeshCount: number
  structures: readonly AbandonedStructureSummary[]
  weatherShelters: readonly WeatherShelter[]
  winterSurfaces: readonly WinterSurface[]
}

/**
 * Creates the two established arena structures without moving either footprint.
 * The larger operations house owns room-aware collision and interaction, while
 * the non-enterable guard shack retains its original single convex collider.
 */
export function createAbandonedStructures(
  options: AbandonedStructureOptions,
): AbandonedStructureResult {
  const enterableHouse = createEnterableOperationsHouse(options)
  const guardShack = createGuardShack(options)

  return {
    collisionMeshCount:
      enterableHouse.collisionMeshCount + guardShack.collisionMeshCount,
    enterableHouse,
    visibleMeshCount:
      enterableHouse.visibleMeshCount + guardShack.visibleMeshCount,
    structures: [
      {
        name: 'damagedOperationsBuilding',
        label: 'Damaged operations building',
        position: enterableHouse.position,
        footprint: enterableHouse.footprint,
      },
      {
        name: 'guardShack',
        label: 'Guard shack',
        position: guardShack.position,
        footprint: guardShack.footprint,
      },
    ],
    weatherShelters: enterableHouse.weatherShelters,
    winterSurfaces: [
      ...enterableHouse.winterSurfaces,
      ...guardShack.winterSurfaces,
    ],
  }
}
