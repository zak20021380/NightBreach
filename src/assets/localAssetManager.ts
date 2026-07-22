import { type AssetContainer } from '@babylonjs/core/assetContainer'
import {
  type ISceneLoaderProgressEvent,
  SceneLoader,
} from '@babylonjs/core/Loading/sceneLoader'
import { type Scene } from '@babylonjs/core/scene'
import {
  type LocalAssetDefinitions,
  type LocalAssetKey,
} from './assetConfig'

export interface AssetProgressSnapshot {
  readonly activeKey: LocalAssetKey | null
  readonly completed: number
  readonly total: number
  readonly ratio: number
}

export type AssetLoadResult<TKey extends LocalAssetKey> =
  | {
      readonly status: 'loaded'
      readonly config: LocalAssetDefinitions[TKey]
      readonly container: AssetContainer
    }
  | {
      readonly status: 'fallback'
      readonly config: LocalAssetDefinitions[TKey]
      readonly reason: string
    }

type AssetProgressListener = (snapshot: AssetProgressSnapshot) => void
type AnyAssetResult = AssetLoadResult<LocalAssetKey>

let gltfLoaderPromise: Promise<unknown> | null = null
let localResourceGuardInstalled = false

function registerGltfLoaderOnce() {
  gltfLoaderPromise ??= import('@babylonjs/loaders/glTF')
  return gltfLoaderPromise
}

function isSafeLocalGlbPath(path: string) {
  return path.startsWith('/assets/')
    && path.endsWith('.glb')
    && !path.includes('://')
    && !path.includes('..')
    && !path.includes('\\')
}

function isSafeLocalAssetResource(url: string) {
  if (url.startsWith('data:') || url.startsWith('blob:')) return true
  try {
    const resolved = new URL(url, window.location.href)
    return resolved.origin === window.location.origin
      && resolved.pathname.startsWith('/assets/')
      && !resolved.pathname.includes('..')
  } catch (error) {
    console.warn(
      `[Night Breach][Assets] Could not validate asset URL.\n${describeError(error)}`,
      error,
    )
    return false
  }
}

function installLocalResourceGuard() {
  if (localResourceGuardInstalled) return
  localResourceGuardInstalled = true
  SceneLoader.OnPluginActivatedObservable.add((plugin) => {
    if (!('preprocessUrlAsync' in plugin)) return
    const guardedPlugin = plugin as typeof plugin & {
      preprocessUrlAsync: (url: string) => Promise<string>
    }
    const preprocessUrlAsync = guardedPlugin.preprocessUrlAsync.bind(plugin)
    guardedPlugin.preprocessUrlAsync = async (url: string) => {
      const processedUrl = await preprocessUrlAsync(url)
      if (!isSafeLocalAssetResource(processedUrl)) {
        throw new Error(`Rejected remote or out-of-scope GLB resource: ${processedUrl}`)
      }
      return processedUrl
    }
  })
}

function describeError(error: unknown) {
  if (error instanceof Error) return error.stack ?? `${error.name}: ${error.message}`
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

export class LocalAssetManager {
  private readonly cache = new Map<LocalAssetKey, Promise<AnyAssetResult>>()
  private readonly progress = new Map<LocalAssetKey, number>()
  private readonly settled = new Set<LocalAssetKey>()
  private readonly scene: Scene
  private readonly definitions: LocalAssetDefinitions
  private readonly onProgress: AssetProgressListener

  constructor(
    scene: Scene,
    definitions: LocalAssetDefinitions,
    onProgress: AssetProgressListener,
  ) {
    this.scene = scene
    this.definitions = definitions
    this.onProgress = onProgress
    installLocalResourceGuard()
    for (const key of Object.keys(definitions) as LocalAssetKey[]) {
      this.progress.set(key, 0)
    }
    this.emitProgress(null)
  }

  load<TKey extends LocalAssetKey>(key: TKey): Promise<AssetLoadResult<TKey>> {
    const cached = this.cache.get(key)
    if (cached) return cached as Promise<AssetLoadResult<TKey>>

    const promise = this.loadOnce(key) as Promise<AnyAssetResult>
    this.cache.set(key, promise)
    return promise as Promise<AssetLoadResult<TKey>>
  }

  private async loadOnce<TKey extends LocalAssetKey>(key: TKey): Promise<AssetLoadResult<TKey>> {
    const config = this.definitions[key]
    this.progress.set(key, 0.04)
    this.emitProgress(key)

    try {
      if (!isSafeLocalGlbPath(config.path)) {
        throw new Error(`Rejected non-local asset path: ${config.path}`)
      }

      if (!await this.mayExist(config.path)) {
        throw new Error(`No local file was found at ${config.path}`)
      }

      await registerGltfLoaderOnce()
      const container = await SceneLoader.LoadAssetContainerAsync(
        '',
        config.path,
        this.scene,
        (event) => this.handleFileProgress(key, event),
        '.glb',
        config.label,
      )

      if (container.meshes.length === 0) {
        container.dispose()
        throw new Error(`The GLB at ${config.path} contains no meshes`)
      }

      console.info(
        `[Night Breach][Assets] ${config.label}: local GLB loaded once and cached (${config.path}; ${container.meshes.length} meshes).`,
      )
      return { status: 'loaded', config, container }
    } catch (error) {
      const reason = describeError(error)
      console.warn(
        `[Night Breach][Assets] ${config.label}: procedural fallback active; local GLB unavailable (${config.path}). ${reason}`,
      )
      return { status: 'fallback', config, reason }
    } finally {
      this.progress.set(key, 1)
      this.settled.add(key)
      this.emitProgress(key)
    }
  }

  private async mayExist(path: string) {
    try {
      const response = await fetch(path, {
        method: 'HEAD',
        cache: 'no-store',
        credentials: 'same-origin',
      })
      if (response.status === 405 || response.status === 501) return true
      if (!response.ok) return false
      const contentType = response.headers.get('content-type') ?? ''
      return !contentType.toLowerCase().includes('text/html')
    } catch (error) {
      // A few embedded/static servers do not implement HEAD correctly. Let the
      // Babylon loader make the definitive same-origin request in that case.
      console.info(
        `[Night Breach][Assets] HEAD preflight was unavailable for ${path}; attempting the local GLB directly.\n${describeError(error)}`,
        error,
      )
      return true
    }
  }

  private handleFileProgress(key: LocalAssetKey, event: ISceneLoaderProgressEvent) {
    const previous = this.progress.get(key) ?? 0
    const ratio = event.lengthComputable && event.total > 0
      ? event.loaded / event.total
      : Math.max(previous, 0.12)
    this.progress.set(key, Math.min(0.98, Math.max(previous, ratio)))
    this.emitProgress(key)
  }

  private emitProgress(activeKey: LocalAssetKey | null) {
    let totalProgress = 0
    for (const value of this.progress.values()) totalProgress += value
    const total = this.progress.size
    try {
      this.onProgress({
        activeKey,
        completed: this.settled.size,
        total,
        ratio: total === 0 ? 1 : totalProgress / total,
      })
    } catch (error) {
      // Progress UI is optional; it must never make asset fallback or startup fail.
      console.warn(
        `[Night Breach][Assets] Loading indicator update was skipped.\n${describeError(error)}`,
        error,
      )
    }
  }
}
