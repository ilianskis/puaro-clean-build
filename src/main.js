import { GameController } from './game/GameController.js'

document.addEventListener('DOMContentLoaded', () => {
  const game = new GameController()
  game.init()
})
