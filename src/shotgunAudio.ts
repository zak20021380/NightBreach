import {
  SHOTGUN_AUDIO_CONFIG,
  type ShotgunSoundName,
} from './gameConfig'

interface ShotgunAudioDependencies {
  canvas: HTMLCanvasElement
  logRuntimeWarning: (context: string, error: unknown) => void
}

// One AudioContext, three decoded buffers and three persistent gain nodes keep
// playback cheap on mobile. AudioBufferSourceNodes are intentionally one-shot,
// but every live/scheduled source is tracked so an action can never duplicate
// itself and weapon switches, death, restart or page suspension can stop it.
export class ShotgunAudioController {
  private readonly dependencies: ShotgunAudioDependencies
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

  constructor(dependencies: ShotgunAudioDependencies) {
    this.dependencies = dependencies
  }

  private ensureContext() {
    if (this.context) return this.context
    if (typeof AudioContext === 'undefined') {
      if (!this.audioUnavailableLogged) {
        this.audioUnavailableLogged = true
        console.warn('[Night Breach][Shotgun Audio] Web Audio is unavailable in this browser.')
      }
      this.dependencies.canvas.dataset.shotgunAudioReady = 'unavailable'
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

    this.dependencies.canvas.dataset.shotgunAudioReady = 'loading'
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
            this.dependencies.logRuntimeWarning(
              `[Shotgun Audio] Could not preload ${path}.`,
              error,
            )
          }
        }),
    ).then(() => {
      this.dependencies.canvas.dataset.shotgunAudioReady =
        this.buffers.size === 3 ? 'ready' : 'partial'
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
        this.dependencies.logRuntimeWarning(
          '[Shotgun Audio] AudioContext resume was unavailable.',
          error,
        )
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
