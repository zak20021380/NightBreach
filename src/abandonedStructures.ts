import { type AssetContainer } from '@babylonjs/core/assetContainer'
import { type ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator'
import { type AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh'
import { type Scene } from '@babylonjs/core/scene'
import {
  createEnterableWoodenShed,
  type EnterableHouseResult,
} from './enterableHouse'
import { createGuardShack, type GuardShackResult } from './guardShack'
import {
  type WeatherShelter,
  type WinterSurface,
} from './winterEnvironment'

interface AbandonedStructureOptions {
  scene: Scene
  shedContainer: AssetContainer
  shadowGenerator: ShadowGenerator | null
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
  secondaryHouse: GuardShackResult
  visibleMeshCount: number
  structures: readonly AbandonedStructureSummary[]
  weatherShelters: readonly WeatherShelter[]
  winterSurfaces: readonly WinterSurface[]
}

/**
 * Creates the two established arena structures without moving either location.
 * Both visible house hierarchies come from the exact imported wooden-shed GLB.
 * The enterable instance owns room-aware collision and interaction, while the
 * second instance retains its original single convex collider.
 */
export function createAbandonedStructures(
  options: AbandonedStructureOptions,
): AbandonedStructureResult {
  const enterableHouse = createEnterableWoodenShed(options)
  const guardShack = createGuardShack(options)

  return {
    collisionMeshCount:
      enterableHouse.collisionMeshCount + guardShack.collisionMeshCount,
    enterableHouse,
    secondaryHouse: guardShack,
    visibleMeshCount:
      enterableHouse.visibleMeshCount + guardShack.visibleMeshCount,
    structures: [
      {
        name: 'enterableOldWoodenShed',
        label: 'Enterable old wooden shed',
        position: enterableHouse.position,
        footprint: enterableHouse.footprint,
      },
      {
        name: 'secondaryOldWoodenShed',
        label: 'Secondary old wooden shed',
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
