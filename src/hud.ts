interface HudElements {
  ammoDisplay: HTMLDivElement
  crosshair: HTMLDivElement
  headshotIndicator: HTMLDivElement
  hitMarker: HTMLDivElement
}

interface HudAmmoState {
  activeWeaponId: 'rifle' | 'shotgun'
  magazineAmmo: number
  reserveAmmo: number
  shotgunLoadedShells: number
  shotgunReserveShells: number
}

interface HudDependencies {
  ammoState: HudAmmoState
  elements: HudElements
}

export function createHudController({
  ammoState,
  elements,
}: HudDependencies) {
  let crosshairTimer: number | undefined
  let hitMarkerTimer: number | undefined
  let headshotTimer: number | undefined

  // The one ammo readout shows whichever weapon is in the player's hands, in the
  // HUD's existing loaded/reserve format.
  function updateAmmoDisplay() {
    elements.ammoDisplay.textContent = ammoState.activeWeaponId === 'shotgun'
      ? `${ammoState.shotgunLoadedShells}/${ammoState.shotgunReserveShells}`
      : `${ammoState.magazineAmmo}/${ammoState.reserveAmmo}`
  }

  function pulseCrosshair() {
    elements.crosshair.classList.remove('firing')
    void elements.crosshair.offsetWidth
    elements.crosshair.classList.add('firing')
    if (crosshairTimer !== undefined) window.clearTimeout(crosshairTimer)
    crosshairTimer = window.setTimeout(hideCrosshairPulse, 75)
  }

  function hideCrosshairPulse() {
    elements.crosshair.classList.remove('firing')
  }

  function showHitMarker() {
    elements.hitMarker.classList.remove('visible')
    void elements.hitMarker.offsetWidth
    elements.hitMarker.classList.add('visible')
    if (hitMarkerTimer !== undefined) window.clearTimeout(hitMarkerTimer)
    hitMarkerTimer = window.setTimeout(hideHitMarker, 95)
  }

  function hideHitMarker() {
    elements.hitMarker.classList.remove('visible')
  }

  function showHeadshotIndicator() {
    elements.headshotIndicator.classList.remove('visible')
    void elements.headshotIndicator.offsetWidth
    elements.headshotIndicator.classList.add('visible')
    if (headshotTimer !== undefined) window.clearTimeout(headshotTimer)
    headshotTimer = window.setTimeout(hideHeadshotIndicator, 260)
  }

  function hideHeadshotIndicator() {
    elements.headshotIndicator.classList.remove('visible')
  }

  return {
    pulseCrosshair,
    showHeadshotIndicator,
    showHitMarker,
    updateAmmoDisplay,
  }
}
