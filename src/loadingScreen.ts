/**
 * Isolated controller for the boot loading screen declared inline in index.html.
 *
 * The markup and its styles live in index.html so the poster and progress UI
 * paint before this module (or any other game code) finishes downloading. This
 * controller only mutates that existing DOM; it never creates or imports game
 * state, and it stays silent when the overlay is already gone.
 */

export const LOADING_STAGES = {
  initializing: 'INITIALIZING',
  environment: 'LOADING ENVIRONMENT',
  weapon: 'PREPARING WEAPON',
  enemies: 'PREPARING ENEMIES',
  finalizing: 'FINALIZING',
} as const

export type LoadingStageLabel = (typeof LOADING_STAGES)[keyof typeof LOADING_STAGES]

const FADE_OUT_DURATION = 260

interface LoadingScreenElements {
  fill: HTMLElement | null
  percent: HTMLElement | null
  root: HTMLElement | null
  stage: HTMLElement | null
  track: HTMLElement | null
}

export interface LoadingScreenController {
  /** True until complete() has torn the overlay down. */
  readonly isActive: boolean
  complete: () => void
  setProgress: (completed: number, total: number) => void
  setStage: (label: string) => void
  showError: (message: string) => void
}

function ratioToPercent(completed: number, total: number) {
  if (!Number.isFinite(completed) || !Number.isFinite(total) || total <= 0) return 0
  const ratio = Math.min(1, Math.max(0, completed / total))
  return Math.round(ratio * 100)
}

export function createLoadingScreenController(): LoadingScreenController {
  const elements: LoadingScreenElements = {
    fill: document.querySelector<HTMLElement>('#nbLoadingFill'),
    percent: document.querySelector<HTMLElement>('#nbLoadingPercent'),
    root: document.querySelector<HTMLElement>('#nbLoading'),
    stage: document.querySelector<HTMLElement>('#nbLoadingStage'),
    track: document.querySelector<HTMLElement>('#nbLoadingTrack'),
  }

  let active = elements.root !== null

  function setStage(label: string) {
    if (!active || !elements.stage) return
    elements.stage.textContent = label
  }

  function setProgress(completed: number, total: number) {
    if (!active) return
    const percent = ratioToPercent(completed, total)
    if (elements.fill) elements.fill.style.width = `${percent}%`
    if (elements.percent) elements.percent.textContent = `${percent}%`
    elements.track?.setAttribute('aria-valuenow', String(percent))
  }

  function showError(message: string) {
    if (!active || !elements.root) return
    elements.root.classList.add('is-error')
    if (elements.stage) elements.stage.textContent = message
    // The overlay deliberately stays up on error: the message is the only thing
    // the player can act on. No fade-out is scheduled here.
  }

  function complete() {
    if (!active || !elements.root) return
    const root = elements.root
    // Fill to 100% before deactivating: setProgress() is guarded on `active`.
    setProgress(1, 1)
    active = false
    root.classList.add('is-complete')
    root.setAttribute('aria-hidden', 'true')
    // Drop the poster with the overlay so the decoded full-screen bitmap is not
    // retained behind the live scene.
    removalTimer = window.setTimeout(() => {
      removalTimer = undefined
      root.remove()
    }, FADE_OUT_DURATION)
  }

  return {
    get isActive() {
      return active
    },
    complete,
    setProgress,
    setStage,
    showError,
  }
}
