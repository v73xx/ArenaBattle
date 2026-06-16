/* Re-export root gameData so Bot.js (at repo root) can resolve
   require('../public/js/gameData') correctly when the module
   resolution is patched by server.js. */
module.exports = require('../../gameData');
