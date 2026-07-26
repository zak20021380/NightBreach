// Device capability detection and touch tuning. Evaluated once at module load
// from navigator/window; these flags gate mobile controls, render scaling,
// shadow quality, effect pool sizes, and AI think intervals throughout the game.

export const isTouchDevice = navigator.maxTouchPoints > 0
  || window.matchMedia('(pointer: coarse)').matches
export const isMobile = isTouchDevice || window.innerWidth < 768
export const isDesktop = !isTouchDevice
  && window.matchMedia('(hover: hover) and (pointer: fine)').matches
export const hardwareThreadCount = navigator.hardwareConcurrency || 4
export const deviceMemoryGb = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 4
export const isLowEndMobile = isMobile && (hardwareThreadCount <= 4 || deviceMemoryGb <= 4)

export const TOUCH_CONFIG = {
  lookSensitivity: 0.00215,
  adsLookSensitivityMultiplier: 0.72,
  joystickDeadZone: 0.08,
  automaticFireInterval: 0.1,
  hipFov: 72 * Math.PI / 180,
  adsFov: 56 * Math.PI / 180,
  hipSpread: 0.0035,
  adsSpread: 0.00075,
}
