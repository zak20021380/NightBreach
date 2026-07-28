import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture'
import { type Scene } from '@babylonjs/core/scene'

type Canvas2dContext = ReturnType<DynamicTexture['getContext']>

function paintRadialFalloff(
  context: Canvas2dContext,
  centerX: number,
  centerY: number,
  radius: number,
  steps: number,
  colors: readonly string[],
  peakAlpha: number,
) {
  for (let step = steps; step >= 1; step -= 1) {
    const progress = step / steps
    context.globalAlpha = ((1 - progress) ** 1.5) * peakAlpha + 0.02
    context.fillStyle = colors[Math.min(
      colors.length - 1,
      Math.floor(progress * colors.length),
    )]
    context.beginPath()
    context.arc(centerX, centerY, Math.max(0.5, radius * progress), 0, Math.PI * 2)
    context.fill()
  }
  context.globalAlpha = 1
}

export function createMuzzleCoreTexture(scene: Scene) {
  const texture = new DynamicTexture(
    'muzzleFlashCoreTexture',
    { width: 128, height: 128 },
    scene,
    false,
  )
  const context = texture.getContext()
  context.clearRect(0, 0, 128, 128)
  paintRadialFalloff(context, 64, 64, 62, 30, [
    '#ffffff',
    '#fff8e2',
    '#ffe3a2',
    '#ffb851',
    '#f0791a',
    '#b53c06',
  ], 0.96)
  texture.update(false)
  texture.hasAlpha = true
  return texture
}

export function createMuzzleStarTexture(scene: Scene) {
  const texture = new DynamicTexture(
    'muzzleFlashStarTexture',
    { width: 128, height: 128 },
    scene,
    false,
  )
  const context = texture.getContext()
  context.clearRect(0, 0, 128, 128)
  const petalCount = 7
  for (let petal = 0; petal < petalCount; petal += 1) {
    const angle = petal / petalCount * Math.PI * 2
    const isMajor = petal % 2 === 0
    const length = isMajor ? 61 : 41
    const spread = isMajor ? 0.17 : 0.1
    context.globalAlpha = isMajor ? 0.88 : 0.58
    context.fillStyle = isMajor ? '#ffd989' : '#ffb347'
    context.beginPath()
    context.moveTo(64 + Math.cos(angle) * length, 64 + Math.sin(angle) * length)
    context.lineTo(64 + Math.cos(angle + spread) * 15, 64 + Math.sin(angle + spread) * 15)
    context.lineTo(64 + Math.cos(angle - spread) * 15, 64 + Math.sin(angle - spread) * 15)
    context.closePath()
    context.fill()
  }
  context.globalAlpha = 1
  paintRadialFalloff(context, 64, 64, 27, 16, [
    '#ffffff',
    '#fff4cd',
    '#ffc768',
    '#f4841f',
  ], 0.94)
  texture.update(false)
  texture.hasAlpha = true
  return texture
}

export function createMuzzleSmokeTexture(scene: Scene) {
  const texture = new DynamicTexture(
    'muzzleSmokeTexture',
    { width: 64, height: 64 },
    scene,
    false,
  )
  const context = texture.getContext()
  context.clearRect(0, 0, 64, 64)
  paintRadialFalloff(context, 32, 32, 31, 18, [
    '#d8d4cb',
    '#b3afa6',
    '#8b8880',
    '#5f5d57',
  ], 0.52)
  texture.update(false)
  texture.hasAlpha = true
  return texture
}
