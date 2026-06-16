'use strict';

/* ── Module-path fix ────────────────────────────────────────────────────────
   Bot.js lives at the repo root but was written expecting to be placed at
   server/Bot.js, so its require('../public/js/gameData') resolves one level
   above the app directory at runtime.  We intercept that resolution here and
   redirect it to the correct in-app path before any game modules are loaded.
   ─────────────────────────────────────────────────────────────────────────── */
const Module = require('module');
const path   = require('path');

const _origResolve = Module._resolveFilename.bind(Module);
Module._resolveFilename = function (request, parent, isMain, options) {
  if (request === '../public/js/gameData') {
    return _origResolve(path.join(__dirname, 'public/js/gameData'), parent, isMain, options);
  }
  return _origResolve(request, parent, isMain, options);
};

/* ── Core dependencies ──────────────────────────────────────────────────── */
const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const fs         = require('fs');

/* ── Game modules ───────────────────────────────────────────────────────── */
const Bot                                    = require('./Bot');
const { CLASSES, ABILITIES, SHOP_ITEMS, TALENT_TREES } = require('./gameData');

/* ── Express / HTTP / Socket.io setup ───────────────────────────────────── */
const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

const PORT = process.env.PORT || 3000;

/* Serve static files from /public if the directory exists */
const publicDir = path.join(__dirname, 'public');
if (fs.existsSync(publicDir)) {
  app.use(express.static(publicDir));
}

app.use(express.json());

/* ── Health check ───────────────────────────────────────────────────────── */
app.get('/health', (_req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

/* ── Game-data endpoint (lets clients bootstrap without a bundle step) ─── */
app.get('/api/game-data', (_req, res) => {
  res.json({ CLASSES, ABILITIES, SHOP_ITEMS, TALENT_TREES });
});

/* ══════════════════════════════════════════════════════════════════════════
   ARENA GAME ENGINE
   ══════════════════════════════════════════════════════════════════════════ */

const TICK_RATE      = 100;   // ms between server ticks
const MAX_PLAYERS    = 3;
const ARENA_W        = 800;
const ARENA_H        = 600;
const AUTO_ATTACK_RANGE = 80;

/* Active rooms: roomId → RoomState */
const rooms = new Map();

/* Socket → roomId mapping for fast cleanup */
const socketRoom = new Map();

/* ── Helpers ────────────────────────────────────────────────────────────── */
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function pickTargets(bots, selfId) {
  return bots.filter(b => b.id !== selfId && b.alive);
}

function nearestAlive(bots, self) {
  const others = pickTargets(bots, self.id);
  if (!others.length) return null;
  return others.reduce((best, b) =>
    distance(self, b) < distance(self, best) ? b : best
  );
}

/* ── Combat resolution ──────────────────────────────────────────────────── */

/**
 * Apply a single damage event to a target bot.
 * Returns an array of log entries to broadcast.
 */
function applyDamage(target, amount, damageType, sourceId, abilityId, isCrit, room) {
  if (!target.alive) return [];
  if (target.isImmune()) return [{ type: 'immune', targetId: target.id, sourceId, abilityId }];

  /* Dodge check (physical only) */
  if (damageType === 'physical' && Math.random() < target.dodgeChance) {
    return [{ type: 'dodge', targetId: target.id, sourceId, abilityId }];
  }

  /* Armor mitigation for physical damage */
  let finalDmg = amount;
  if (damageType === 'physical') {
    const mitigation = target.armor / (target.armor + 400);
    finalDmg = Math.max(1, Math.floor(amount * (1 - mitigation)));
  }

  target.hp = Math.max(0, target.hp - finalDmg);

  const events = [{ type: 'damage', targetId: target.id, sourceId, abilityId, amount: finalDmg, isCrit }];

  if (target.hp <= 0) {
    target.alive = false;
    target.state = 'dead';
    events.push({ type: 'death', targetId: target.id, sourceId });

    /* Award XP to the killer */
    const killer = room.bots.find(b => b.id === sourceId);
    if (killer && killer.alive) {
      const xpGain = 100 + target.level * 20;
      killer.addXP(xpGain);
      events.push({ type: 'xp', targetId: killer.id, amount: xpGain });
    }
  }

  return events;
}

/**
 * Apply a heal to a bot.
 */
function applyHeal(target, amount, sourceId, abilityId) {
  if (!target.alive) return [];
  const actual = Math.min(amount, target.maxHp - target.hp);
  target.hp += actual;
  return [{ type: 'heal', targetId: target.id, sourceId, abilityId, amount: actual }];
}

/**
 * Resolve a single ability use by `caster` against `target` (may be null for
 * self-targeted / AoE abilities).  Returns an array of combat events.
 */
function resolveAbility(caster, target, abilityId, room) {
  const ability = ABILITIES[abilityId];
  if (!ability) return [];
  if (!caster.alive) return [];

  const cd = caster.abilityCooldowns[abilityId] || 0;
  if (cd > 0) return [{ type: 'error', targetId: caster.id, msg: `${abilityId} on cooldown` }];
  if (caster.mana < (ability.manaCost || 0)) return [{ type: 'error', targetId: caster.id, msg: 'oom' }];
  if (caster.isStunned()) return [{ type: 'error', targetId: caster.id, msg: 'stunned' }];

  /* Deduct mana and set cooldown */
  caster.mana = Math.max(0, caster.mana - (ability.manaCost || 0));
  caster.abilityCooldowns[abilityId] = ability.cooldown;

  const events = [];

  switch (ability.type) {
    /* ── Direct melee / projectile / holy damage ── */
    case 'melee':
    case 'projectile':
    case 'gap_closer': {
      if (!target || !target.alive) break;
      const power = ability.damageType === 'physical' ? caster.attackPower : caster.spellPower;
      const isCrit = Math.random() < caster.critChance;
      const raw    = Math.floor(power * ability.damage * (isCrit ? 2 : 1));
      events.push(...applyDamage(target, raw, ability.damageType, caster.id, abilityId, isCrit, room));

      /* Gap closer: teleport caster next to target */
      if (ability.type === 'gap_closer' && target.alive) {
        caster.x = clamp(target.x + 60, 0, ARENA_W);
        caster.y = target.y;
      }

      /* Self-heal component (e.g. holyStrike) */
      if (ability.healSelf) {
        const healAmt = Math.floor(caster.spellPower * ability.healSelf);
        events.push(...applyHeal(caster, healAmt, caster.id, abilityId));
      }

      /* Stun */
      if (ability.stun && target.alive) {
        target.state      = 'stunned';
        target.stateTimer = ability.stun;
        events.push({ type: 'stun', targetId: target.id, sourceId: caster.id, duration: ability.stun });
      }
      break;
    }

    /* ── AoE (melee range) ── */
    case 'aoe': {
      const enemies = pickTargets(room.bots, caster.id);
      for (const enemy of enemies) {
        if (!enemy.alive) continue;
        const dist = distance(caster, enemy);
        if (dist > ability.range) continue;
        const power  = ability.damageType === 'physical' ? caster.attackPower : caster.spellPower;
        const isCrit = Math.random() < caster.critChance;
        const raw    = Math.floor(power * ability.damage * (isCrit ? 2 : 1));
        events.push(...applyDamage(enemy, raw, ability.damageType, caster.id, abilityId, isCrit, room));

        /* Freeze (frostNova) */
        if (ability.freeze && enemy.alive) {
          enemy.state      = 'stunned';
          enemy.stateTimer = ability.freeze;
          events.push({ type: 'freeze', targetId: enemy.id, sourceId: caster.id, duration: ability.freeze });
        }
      }
      break;
    }

    /* ── AoE ranged (multiShot) ── */
    case 'aoe_ranged': {
      const enemies = pickTargets(room.bots, caster.id);
      for (const enemy of enemies) {
        if (!enemy.alive) continue;
        const isCrit = Math.random() < caster.critChance;
        const raw    = Math.floor(caster.attackPower * ability.damage * (isCrit ? 2 : 1));
        events.push(...applyDamage(enemy, raw, ability.damageType, caster.id, abilityId, isCrit, room));
      }
      break;
    }

    /* ── DoT application ── */
    case 'dot': {
      if (!target || !target.alive) break;
      target.dots.push({
        sourceId:    caster.id,
        abilityId,
        damage:      ability.damage,
        damageType:  ability.damageType,
        tickRate:    ability.tickRate,
        remaining:   ability.tickRate * ability.ticks,
        tickTimer:   ability.tickRate,
        healSourceId: ability.healSelf ? caster.id : null
      });
      events.push({ type: 'dot_applied', targetId: target.id, sourceId: caster.id, abilityId });
      break;
    }

    /* ── Channel (drainLife) ── */
    case 'channel': {
      if (!target || !target.alive) break;
      target.dots.push({
        sourceId:    caster.id,
        abilityId,
        damage:      ability.damage,
        damageType:  ability.damageType,
        tickRate:    ability.tickRate,
        remaining:   ability.tickRate * ability.ticks,
        tickTimer:   ability.tickRate,
        healSourceId: ability.healSelf ? caster.id : null
      });
      events.push({ type: 'channel_start', targetId: target.id, sourceId: caster.id, abilityId });
      break;
    }

    /* ── Defensive / buff ── */
    case 'defensive': {
      if (ability.immune) {
        caster.buffs.push({ type: 'immune', amount: 1, duration: ability.immune, remaining: ability.immune });
        events.push({ type: 'buff', targetId: caster.id, buffType: 'immune', duration: ability.immune });
      }
      if (ability.dodgeBonus) {
        caster.buffs.push({ type: 'dodgeBonus', amount: ability.dodgeBonus, duration: ability.duration, remaining: ability.duration });
        events.push({ type: 'buff', targetId: caster.id, buffType: 'dodgeBonus', amount: ability.dodgeBonus, duration: ability.duration });
      }
      break;
    }

    /* ── Self buff (battleCry) ── */
    case 'buff': {
      caster.buffs.push({
        type:      ability.buffType,
        amount:    ability.buffAmount,
        duration:  ability.buffDuration,
        remaining: ability.buffDuration
      });
      events.push({ type: 'buff', targetId: caster.id, buffType: ability.buffType, amount: ability.buffAmount, duration: ability.buffDuration });
      break;
    }

    /* ── Pure heal (layOnHands) ── */
    case 'heal': {
      const healAmt = Math.floor(caster.maxHp * (ability.healSelf || 1.0));
      events.push(...applyHeal(caster, healAmt, caster.id, abilityId));
      break;
    }

    /* ── CC (fear) ── */
    case 'cc': {
      if (!target || !target.alive) break;
      if (!target.isImmune()) {
        target.state      = 'feared';
        target.stateTimer = ability.fear;
        events.push({ type: 'fear', targetId: target.id, sourceId: caster.id, duration: ability.fear });
      }
      break;
    }
  }

  return events;
}

/* ── AI: pick an ability for a bot to use this tick ── */
function pickAIAbility(bot, bots) {
  const target = nearestAlive(bots, bot);
  if (!target) return null;

  for (const abilityId of bot.abilities) {
    const ability = ABILITIES[abilityId];
    if (!ability) continue;
    const cd = bot.abilityCooldowns[abilityId] || 0;
    if (cd > 0) continue;
    if (bot.mana < (ability.manaCost || 0)) continue;

    /* Range check for targeted abilities */
    if (ability.range && ability.type !== 'aoe' && ability.type !== 'aoe_ranged' &&
        ability.type !== 'buff' && ability.type !== 'defensive' && ability.type !== 'heal') {
      if (distance(bot, target) > ability.range) continue;
    }

    /* Prefer self-heal when low HP */
    if ((ability.type === 'heal' || ability.type === 'defensive') && bot.hp > bot.maxHp * 0.5) continue;

    return { abilityId, target: ability.type === 'buff' || ability.type === 'defensive' || ability.type === 'heal' ? null : target };
  }
  return null;
}

/* ── Auto-attack ── */
function processAutoAttack(bot, bots, dt, room) {
  const target = nearestAlive(bots, bot);
  if (!target) return [];
  if (distance(bot, target) > AUTO_ATTACK_RANGE) return [];

  bot.autoAttackTimer -= dt;
  if (bot.autoAttackTimer > 0) return [];

  bot.autoAttackTimer = bot.autoAttackInterval;
  const isCrit = Math.random() < bot.critChance;
  const raw    = Math.floor(bot.attackPower * (isCrit ? 2 : 1));
  return applyDamage(target, raw, 'physical', bot.id, 'autoAttack', isCrit, room);
}

/* ── Movement AI ── */
function moveBot(bot, bots, dt) {
  if (!bot.alive || bot.isStunned()) return;
  const target = nearestAlive(bots, bot);
  if (!target) return;

  const dist = distance(bot, target);
  const desiredRange = 60;

  if (dist > desiredRange) {
    const speed = bot.speed * 60 * (dt / 1000); // pixels per tick
    const dx = target.x - bot.x;
    const dy = target.y - bot.y;
    const len = Math.hypot(dx, dy) || 1;
    bot.x = clamp(bot.x + (dx / len) * speed, 0, ARENA_W);
    bot.y = clamp(bot.y + (dy / len) * speed, 0, ARENA_H);
    bot.facing = dx >= 0 ? 1 : -1;
  }
}

/* ── Room state factory ── */
function createRoom(roomId) {
  return {
    id:        roomId,
    phase:     'lobby',   // lobby | battle | ended
    bots:      [],
    players:   new Map(), // socketId → { botId, name, className }
    tickTimer: null,
    gold:      {},        // botId → gold amount
    round:     1
  };
}

/* ── Spawn bots for a room ── */
function spawnBots(room) {
  const classNames = Object.keys(CLASSES);
  const positions  = [
    { x: 150, y: 300 },
    { x: 400, y: 150 },
    { x: 650, y: 300 }
  ];

  room.bots = [];
  let idx = 0;

  for (const [socketId, info] of room.players) {
    const cls = info.className || classNames[idx % classNames.length];
    const bot = new Bot(info.botId, info.name, cls);
    bot.x = positions[idx].x;
    bot.y = positions[idx].y;
    bot.prepareForBattle();
    room.bots.push(bot);
    room.gold[info.botId] = 0;
    idx++;
  }
}

/* ── Check win condition ── */
function checkWinner(room) {
  const alive = room.bots.filter(b => b.alive);
  if (alive.length <= 1) {
    return alive[0] || null;
  }
  return undefined; // battle still ongoing
}

/* ── Broadcast full state snapshot ── */
function broadcastState(room) {
  io.to(room.id).emit('state', {
    phase:  room.phase,
    round:  room.round,
    bots:   room.bots.map(b => b.serialize()),
    gold:   { ...room.gold }
  });
}

/* ── Main game tick ── */
function gameTick(room) {
  if (room.phase !== 'battle') return;

  const dt     = TICK_RATE;
  const events = [];

  for (const bot of room.bots) {
    if (!bot.alive) continue;

    /* Tick DoTs, buffs, cooldowns, mana regen */
    const tickEvents = bot.tickEffects(dt);
    events.push(...tickEvents);

    /* Apply DoT damage events */
    for (const ev of tickEvents) {
      if (ev.type === 'damage') {
        const target = room.bots.find(b => b.id === ev.targetId);
        if (target) {
          target.hp = Math.max(0, target.hp - ev.amount);
          if (target.hp <= 0 && target.alive) {
            target.alive = false;
            target.state = 'dead';
            events.push({ type: 'death', targetId: target.id, sourceId: ev.sourceId });
          }
        }
      }
      if (ev.type === 'heal') {
        const target = room.bots.find(b => b.id === ev.targetId);
        if (target && target.alive) {
          target.hp = Math.min(target.maxHp, target.hp + ev.amount);
        }
      }
    }

    /* Movement */
    moveBot(bot, room.bots, dt);

    /* Auto-attack */
    events.push(...processAutoAttack(bot, room.bots, dt, room));

    /* AI ability usage */
    const aiAction = pickAIAbility(bot, room.bots);
    if (aiAction) {
      events.push(...resolveAbility(bot, aiAction.target, aiAction.abilityId, room));
    }
  }

  /* Broadcast events */
  if (events.length) {
    io.to(room.id).emit('events', events);
  }

  /* Broadcast state every tick */
  broadcastState(room);

  /* Check win condition */
  const winner = checkWinner(room);
  if (winner !== undefined) {
    endBattle(room, winner);
  }
}

/* ── End battle ── */
function endBattle(room, winner) {
  room.phase = 'ended';
  clearInterval(room.tickTimer);
  room.tickTimer = null;

  /* Award gold to survivors */
  for (const bot of room.bots) {
    if (bot.alive) {
      room.gold[bot.id] = (room.gold[bot.id] || 0) + 200;
    }
  }

  io.to(room.id).emit('battle_end', {
    winner:   winner ? winner.serialize() : null,
    bots:     room.bots.map(b => b.serialize()),
    gold:     { ...room.gold }
  });
}

/* ── Start battle ── */
function startBattle(room) {
  room.phase = 'battle';
  spawnBots(room);
  broadcastState(room);
  io.to(room.id).emit('battle_start', { bots: room.bots.map(b => b.serialize()) });
  room.tickTimer = setInterval(() => gameTick(room), TICK_RATE);
}

/* ══════════════════════════════════════════════════════════════════════════
   SOCKET.IO EVENT HANDLERS
   ══════════════════════════════════════════════════════════════════════════ */

io.on('connection', (socket) => {
  console.log(`[connect] ${socket.id}`);

  /* ── join_room ──────────────────────────────────────────────────────────
     Payload: { roomId?, name, className }
     Creates or joins a room.  Assigns a bot slot to the player.
  ── */
  socket.on('join_room', ({ roomId, name, className } = {}) => {
    roomId = roomId || uuidv4();

    if (!rooms.has(roomId)) {
      rooms.set(roomId, createRoom(roomId));
    }

    const room = rooms.get(roomId);

    if (room.phase !== 'lobby') {
      socket.emit('error', { msg: 'Room already in progress' });
      return;
    }

    if (room.players.size >= MAX_PLAYERS) {
      socket.emit('error', { msg: 'Room is full' });
      return;
    }

    if (!CLASSES[className]) {
      socket.emit('error', { msg: `Unknown class: ${className}` });
      return;
    }

    const botId = uuidv4();
    room.players.set(socket.id, { botId, name: name || `Player${room.players.size + 1}`, className });
    socketRoom.set(socket.id, roomId);
    socket.join(roomId);

    socket.emit('joined', { roomId, botId, playerCount: room.players.size });
    io.to(roomId).emit('lobby_update', {
      roomId,
      players: [...room.players.values()].map(p => ({ name: p.name, className: p.className })),
      maxPlayers: MAX_PLAYERS
    });

    console.log(`[join] ${name} (${className}) → room ${roomId} [${room.players.size}/${MAX_PLAYERS}]`);
  });

  /* ── start_battle ───────────────────────────────────────────────────────
     Any player in the room can trigger the start (requires ≥ 2 players).
  ── */
  socket.on('start_battle', () => {
    const roomId = socketRoom.get(socket.id);
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room || room.phase !== 'lobby') return;
    if (room.players.size < 2) {
      socket.emit('error', { msg: 'Need at least 2 players to start' });
      return;
    }
    startBattle(room);
  });

  /* ── use_ability ────────────────────────────────────────────────────────
     Payload: { abilityId, targetId? }
     Player manually triggers an ability for their bot.
  ── */
  socket.on('use_ability', ({ abilityId, targetId } = {}) => {
    const roomId = socketRoom.get(socket.id);
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room || room.phase !== 'battle') return;

    const playerInfo = room.players.get(socket.id);
    if (!playerInfo) return;

    const caster = room.bots.find(b => b.id === playerInfo.botId);
    if (!caster || !caster.alive) return;

    const target = targetId ? room.bots.find(b => b.id === targetId) : nearestAlive(room.bots, caster);
    const events = resolveAbility(caster, target, abilityId, room);

    if (events.length) {
      io.to(roomId).emit('events', events);
      broadcastState(room);
    }
  });

  /* ── buy_item ───────────────────────────────────────────────────────────
     Payload: { itemId }
     Purchase a shop item between rounds (phase === 'ended').
  ── */
  socket.on('buy_item', ({ itemId } = {}) => {
    const roomId = socketRoom.get(socket.id);
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;

    const playerInfo = room.players.get(socket.id);
    if (!playerInfo) return;

    const bot  = room.bots.find(b => b.id === playerInfo.botId);
    const item = SHOP_ITEMS.find(i => i.id === itemId);

    if (!bot || !item) { socket.emit('error', { msg: 'Invalid item or bot' }); return; }

    const gold = room.gold[bot.id] || 0;
    if (gold < item.cost) { socket.emit('error', { msg: 'Not enough gold' }); return; }

    const eligible = item.classes.includes('all') || item.classes.includes(bot.className);
    if (!eligible) { socket.emit('error', { msg: 'Class cannot equip this item' }); return; }

    room.gold[bot.id] -= item.cost;
    bot.applyItem(item);

    socket.emit('item_purchased', { itemId, gold: room.gold[bot.id], stats: bot.serialize() });
    io.to(roomId).emit('shop_update', { botId: bot.id, gold: room.gold[bot.id] });
  });

  /* ── allocate_talent ────────────────────────────────────────────────────
     Payload: { talentId }
  ── */
  socket.on('allocate_talent', ({ talentId } = {}) => {
    const roomId = socketRoom.get(socket.id);
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;

    const playerInfo = room.players.get(socket.id);
    if (!playerInfo) return;

    const bot = room.bots.find(b => b.id === playerInfo.botId);
    if (!bot) return;

    const success = bot.allocateTalent(talentId);
    if (success) {
      socket.emit('talent_allocated', { talentId, talents: bot.talents, talentPoints: bot.talentPoints, stats: bot.serialize() });
    } else {
      socket.emit('error', { msg: 'Cannot allocate talent' });
    }
  });

  /* ── next_round ─────────────────────────────────────────────────────────
     Reset bots and start a new round in the same room.
  ── */
  socket.on('next_round', () => {
    const roomId = socketRoom.get(socket.id);
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room || room.phase !== 'ended') return;

    room.round++;
    room.phase = 'lobby';
    startBattle(room);
  });

  /* ── get_state ──────────────────────────────────────────────────────────
     Request a full state snapshot (useful on reconnect).
  ── */
  socket.on('get_state', () => {
    const roomId = socketRoom.get(socket.id);
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (room) broadcastState(room);
  });

  /* ── disconnect ─────────────────────────────────────────────────────────
     Clean up player from room.  If room is empty, destroy it.
  ── */
  socket.on('disconnect', () => {
    console.log(`[disconnect] ${socket.id}`);
    const roomId = socketRoom.get(socket.id);
    if (!roomId) return;

    socketRoom.delete(socket.id);
    const room = rooms.get(roomId);
    if (!room) return;

    room.players.delete(socket.id);

    if (room.players.size === 0) {
      if (room.tickTimer) clearInterval(room.tickTimer);
      rooms.delete(roomId);
      console.log(`[room] ${roomId} destroyed (empty)`);
    } else {
      io.to(roomId).emit('player_left', { playerCount: room.players.size });
    }
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   START SERVER
   ══════════════════════════════════════════════════════════════════════════ */

server.listen(PORT, () => {
  console.log(`ArenaBattle server running on port ${PORT}`);
  console.log(`Classes available: ${Object.keys(CLASSES).join(', ')}`);
});

/* ── Graceful shutdown ──────────────────────────────────────────────────── */
function shutdown(signal) {
  console.log(`\n[${signal}] Shutting down gracefully…`);

  /* Stop all active game loops */
  for (const room of rooms.values()) {
    if (room.tickTimer) clearInterval(room.tickTimer);
  }

  server.close(() => {
    console.log('HTTP server closed.');
    process.exit(0);
  });

  /* Force-exit after 10 s if connections linger */
  setTimeout(() => {
    console.error('Forced exit after timeout.');
    process.exit(1);
  }, 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});
