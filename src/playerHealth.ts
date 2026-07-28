import { type UniversalCamera } from '@babylonjs/core/Cameras/universalCamera'
import { type Vector3 } from '@babylonjs/core/Maths/math.vector'
import { PLAYER_MAX_HEALTH } from './gameConfig'
import { clamp } from './runtimeUtils'

interface PlayerHealthElements {
  damageIndicator: HTMLDivElement
  healthFill: HTMLDivElement
  healthHud: HTMLDivElement
  healthValue: HTMLSpanElement
}

interface PlayerHealthDependencies {
  camera: UniversalCamera
  elements: PlayerHealthElements
  isGameOver: () => boolean
  onPlayerKilled: () => void
}

export function createPlayerHealthController({
  camera,
  elements,
  isGameOver,
  onPlayerKilled,
}: PlayerHealthDependencies) {
  let playerHealth = PLAYER_MAX_HEALTH
  let damageIndicatorTimer: number | undefined

  function updateHealthDisplay() {
    const healthPercent = playerHealth / PLAYER_MAX_HEALTH * 100
    elements.healthValue.textContent = String(playerHealth)
    elements.healthFill.style.width = `${healthPercent}%`
    elements.healthHud.setAttribute('aria-valuenow', String(playerHealth))
    elements.healthHud.classList.toggle('critical', playerHealth <= 30)
  }

  function damagePlayer(amount: number, attackerPosition: Vector3) {
    if (isGameOver() || playerHealth <= 0) return

    const attackerYaw = Math.atan2(
      attackerPosition.x - camera.position.x,
      attackerPosition.z - camera.position.z,
    )
    const relativeYaw = Math.atan2(
      Math.sin(attackerYaw - camera.rotation.y),
      Math.cos(attackerYaw - camera.rotation.y),
    )

    playerHealth = Math.max(0, playerHealth - amount)
    updateHealthDisplay()

    elements.damageIndicator.style.setProperty('--damage-angle', `${relativeYaw}rad`)
    elements.damageIndicator.classList.remove('visible')
    void elements.damageIndicator.offsetWidth
    elements.damageIndicator.classList.add('visible')
    if (damageIndicatorTimer !== undefined) window.clearTimeout(damageIndicatorTimer)
    damageIndicatorTimer = window.setTimeout(hideDamageIndicator, 360)

    // A restrained impulse gives the hit weight without disorienting aim.
    camera.cameraRotation.x -= 0.006
    camera.cameraRotation.y += clamp(Math.sin(relativeYaw) * 0.006, -0.006, 0.006)

    if (playerHealth > 0) return
    onPlayerKilled()
  }

  function hideDamageIndicator() {
    elements.damageIndicator.classList.remove('visible')
  }

  function resetHealth() {
    playerHealth = PLAYER_MAX_HEALTH
    updateHealthDisplay()
  }

  function clearDamageIndicator() {
    if (damageIndicatorTimer !== undefined) window.clearTimeout(damageIndicatorTimer)
    elements.damageIndicator.classList.remove('visible')
  }

  return {
    clearDamageIndicator,
    damagePlayer,
    get health() {
      return playerHealth
    },
    resetHealth,
    updateHealthDisplay,
  }
}
