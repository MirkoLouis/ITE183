/**
 * server/index.js — Realms of Etheryn — Main Game Server
 *
 * Stack : Node.js + Express + Socket.IO
 * Serves: /public as static files
 * Handles all real-time multiplayer game logic via Socket.IO events.
 *
 * The server is authoritative for combat, rewards, quests, shops and room
 * transitions. Clients only report their own x position / facing.
 */

'use strict';

const path       = require('path');
const http       = require('http');
const express    = require('express');
const { Server } = require('socket.io');

const {
    ITEMS, MAX_LEVEL, CLASSES, SKILLS, QUESTS, QUEST_CHAIN, ROOMS,
    MONSTER_TEMPLATES, MONSTER_SPAWNS, SUMMON_POINTS,
} = require('./gameData');

const {
    clamp, xDistance, randInt,
    getPlayerStats, calcDamage, calcBasicAttack, calcSkillDamage, calcMonsterDamage,
    xpToNextLevel,
    sanitise, publicPlayer,
} = require('./utils');

// ─── App & HTTP Server ─────────────────────────────────────────────────────────

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
});

/**
 * Unique id for this server run. Clients compare it on (re)connect and
 * reload themselves when it changes, so open tabs never run stale code.
 */
const BUILD_ID = Date.now().toString(36);

// Never let browsers cache the client: every load gets the current files
app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
});

// Serve the client from /public
app.use(express.static(path.join(__dirname, '..', 'public'), { etag: false, lastModified: false }));

// Class + skill data for the character-selection screen
app.get('/api/classes', (req, res) => {
    res.json(Object.fromEntries(Object.entries(CLASSES).map(([id, cls]) => [
        id, { ...cls, skills: SKILLS[id] ?? [] },
    ])));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`[Realms of Etheryn] Server running on http://localhost:${PORT}`);
});

// ─── Tuning Constants ──────────────────────────────────────────────────────────

/** Extra px allowed on range checks to absorb network latency. */
const RANGE_SLACK = 40;

/** How close (px) a player must be to an NPC to trade / take quests. */
const NPC_RANGE = 200;

/** How close (px) a player must be to a portal to use it. */
const PORTAL_RANGE = 120;

/** How close (px) to a map edge a player must be to take a path exit. */
const EXIT_RANGE = 80;

/** Minimum ms between basic attacks. */
const ATTACK_COOLDOWN = 500;

/** How long a downed player waits for a Revive before returning to town. */
const DOWNED_MS = 20000;

/** Outgoing damage multiplier while Berserk. */
const BERSERK_MULT = 1.6;

/** Damage multiplier for each Chain Lightning jump. */
const CHAIN_MULT = 0.7;

/** A chasing monster gives up if its target hasn't hit it for this long. */
const AGGRO_TIMEOUT = 5000;

/** After giving up, the monster ignores that player's proximity for this long. */
const AGGRO_IGNORE_MS = 5000;

/** Duelists are placed this far apart before the countdown. */
const DUEL_GAP = 300;

/** Duel countdown length (ms); no moving or attacking until it ends. */
const DUEL_COUNTDOWN = 3000;

/** Monsters won't move closer than this to each other. */
const MONSTER_SPACING = 28;

/** Monster movement tick and position broadcast intervals (ms). */
const MONSTER_MOVE_TICK = 50;
const MONSTER_SYNC_TICK = 100;

// ─── Game State ────────────────────────────────────────────────────────────────

/**
 * players — Map<socketId, PlayerObject>
 * PlayerObject shape:
 * { id, name, x, y, room, hp, maxHp, mp, maxMp, level, xp, xpToLevel, gold,
 *   class, color, inventory[], equipment:{weapon,armor,head},
 *   buffAtk, buffAtkExpiry, berserkUntil, immuneUntil, blessAmount, blessUntil,
 *   downed, downedUntil, downedTimer,
 *   attackCooldown, facing,
 *   skillCooldowns: { skillId: timestamp },
 *   quest: { id, progress } | null, completedQuests: string[],
 *   duelTarget: socketId | null, duelAccepted: bool }
 */
const players = new Map();

/**
 * monsters — Map<roomId, Map<monsterId, MonsterObject>>
 */
const monsters = new Map();

// Initialise monster maps for each room
for (const roomId of Object.keys(ROOMS)) {
    monsters.set(roomId, new Map());
}

// ─── Monster Initialisation ────────────────────────────────────────────────────

/** Build a live monster object from a template. */
function createMonster(tmpl, roomId, id, x, extra = {}) {
    return {
        ...tmpl,
        id,
        damage:         { ...tmpl.damage },
        hp:             tmpl.maxHp,
        x,
        y:              ROOMS[roomId].groundY,
        room:           roomId,
        spawnX:         x,
        lastAttackTime: 0,
        isDead:         false,
        facing:         'left',
        aggroTarget:    null,     // player id being chased
        lastThreatAt:   0,        // last time the target hit (or aggroed) it
        returning:      false,    // walking back to spawn after giving up
        ignoreUntil:    {},       // playerId → ts: no proximity aggro until then
        dirty:          false,    // position/facing changed since last sync
        skillReadyAt:   {},       // boss skill → ts when usable again
        windup:         null,     // pending Crushing Blow { until, targetId }
        damagers:       new Set(),// names of players who hit a boss this life
        summoned:       false,    // true for Call the Horde adds (never respawn)
        ...extra,
    };
}

/**
 * Spawn all monsters defined in MONSTER_SPAWNS into the server state.
 */
function initMonsters() {
    for (const [roomId, spawns] of Object.entries(MONSTER_SPAWNS)) {
        const roomMonsters = monsters.get(roomId);

        // Build one monster object per spawn entry
        spawns.forEach((spawn, i) => {
            const tmpl = MONSTER_TEMPLATES[spawn.template];
            if (!tmpl) return;
            const monsterId = `${roomId}_${tmpl.sprite}_${i}`;
            roomMonsters.set(monsterId, createMonster(tmpl, roomId, monsterId, spawn.x));
        });
    }
}
initMonsters();

/** Counter for unique summon ids. */
let summonSeq = 0;

// ─── Helpers ───────────────────────────────────────────────────────────────────

/** Strip server-only fields from a monster before sending it. */
function publicMonster(m) {
    return {
        id: m.id, name: m.name, sprite: m.sprite,
        hp: m.hp, maxHp: m.maxHp, x: m.x, y: m.y, room: m.room,
        width: m.width, height: m.height,
        def: m.def, res: m.res, isDead: m.isDead,
        facing: m.facing, aggro: Boolean(m.aggroTarget),
    };
}

/** Full data for the owning client (adds quest progress). */
function selfPlayer(player) {
    return {
        ...publicPlayer(player),
        quest:           player.quest,
        completedQuests: player.completedQuests,
    };
}

/** Look up a live socket by id. */
function socketOf(sid) {
    return io.sockets.sockets.get(sid);
}

/** Equipment slots, in display order. */
const EQUIP_SLOTS = ['head', 'weapon', 'armor'];

/** Send a player's current inventory / equipment / stats to them. */
function emitInventory(socket, player) {
    socket.emit('inventory:updated', {
        inventory: player.inventory,
        equipment: player.equipment,
        stats:     getPlayerStats(player),
    });
}

/** Tell the room a player's gear changed (crown shows on their sprite). */
function broadcastEquipment(player) {
    io.to(player.room).emit('player:equipment', { playerId: player.id, equipment: player.equipment });
}

/** A new character's starter gear for their class. */
function starterEquipment(cls) {
    const gear = CLASSES[cls].starterGear ?? {};
    return Object.fromEntries(EQUIP_SLOTS.map(slot => [slot, gear[slot] ? { ...ITEMS[gear[slot]] } : null]));
}

/** Tell everyone in the room about a player's HP. */
function broadcastHp(player) {
    io.to(player.room).emit('player:hp', {
        playerId: player.id, hp: player.hp, maxHp: player.maxHp,
    });
}

/** Heal a player and broadcast it (green number for everyone). */
function healPlayer(target, amount, sourceId) {
    const healed = Math.min(amount, target.maxHp - target.hp);
    target.hp   += healed;
    io.to(target.room).emit('player:healed', {
        playerId: target.id, hp: target.hp, maxHp: target.maxHp, amount: healed, sourceId,
    });
    return healed;
}

/** Players currently able to act. */
function isActive(player) {
    return Boolean(player) && !player.downed && player.hp > 0;
}

/** True while a stun is running. */
function isStunned(player) {
    return Date.now() < (player.stunnedUntil ?? 0);
}

/** Stun a player (Divine Immunity blocks it) and tell the room. */
function stunPlayer(player, ms) {
    if (isImmune(player) || !isActive(player)) return;
    player.stunnedUntil = Date.now() + ms;
    io.to(player.room).emit('player:stunned', { playerId: player.id, until: player.stunnedUntil });
}

/** Server-wide system line in everyone's chat. */
function systemChat(message) {
    io.emit('chat:system', { message });
}

/** True while Divine Immunity is up. */
function isImmune(player) {
    return Date.now() < (player.immuneUntil ?? 0);
}

/** Apply Berserk (or any future outgoing modifier) to a damage roll. */
function applyOutgoingMods(attacker, result) {
    if (Date.now() < (attacker.berserkUntil ?? 0)) {
        return { ...result, damage: Math.round(result.damage * BERSERK_MULT) };
    }
    return result;
}

/** Build a complete game-state snapshot for one player. */
function buildGameState(socketId) {
    const player = players.get(socketId);
    if (!player) return {};

    const roomId = player.room;

    // Everyone else in the same room
    const roomPlayers = [...players.values()]
        .filter(p => p.room === roomId && p.id !== socketId)
        .map(publicPlayer);

    // Living monsters in the room
    const roomMonsterList = [...(monsters.get(roomId)?.values() ?? [])]
        .filter(m => !m.isDead)
        .map(publicMonster);

    return {
        self:       selfPlayer(player),
        players:    roomPlayers,
        monsters:   roomMonsterList,
        room:       ROOMS[roomId],
        roomNames:  Object.fromEntries(Object.values(ROOMS).map(r => [r.id, r.name])),
        items:      ITEMS,
        quests:     QUESTS,
        questChain: QUEST_CHAIN,
        skills:     SKILLS[player.class] ?? [],
        maxLevel:   MAX_LEVEL,
    };
}

/**
 * Move a player into another room at a given x and send them the new state.
 */
function movePlayerToRoom(socket, player, roomId, x, facing) {
    const prevRoom = player.room;

    // Leaving the room forfeits any duel
    if (isInDuel(player)) {
        const opponent = players.get(player.duelTarget);
        if (opponent) endDuel(opponent, player, 'forfeit');
    }
    clearPendingDuel(player);

    // Update position and socket.io room membership
    player.room   = roomId;
    player.x      = x;
    player.y      = ROOMS[roomId].groundY;
    player.facing = facing ?? player.facing;
    socket.leave(prevRoom);
    socket.join(roomId);

    // Notify old room, new player, new room
    io.to(prevRoom).emit('player:left', { playerId: socket.id });
    socket.emit('game:state', buildGameState(socket.id));
    socket.to(roomId).emit('player:joined', publicPlayer(player));
}

/**
 * Give XP + gold to one player, handling multi-level-ups up to MAX_LEVEL.
 */
function awardPlayer(player, xpAmount, goldAmount) {
    const socket = socketOf(player.id);

    // No more XP once capped
    const atCap  = player.level >= MAX_LEVEL;
    const xpGain = atCap ? 0 : xpAmount;
    player.xp   += xpGain;
    player.gold += goldAmount;

    // Level-up cascade with role-based gains
    while (player.level < MAX_LEVEL && player.xp >= player.xpToLevel) {
        const gains       = CLASSES[player.class].levelGains;
        player.xp        -= player.xpToLevel;
        player.level     += 1;
        player.xpToLevel  = xpToNextLevel(player.level);
        player.maxHp     += gains.hp;
        player.maxMp     += gains.mp;
        player.hp         = player.maxHp;   // full heal on level up
        player.mp         = player.maxMp;

        // Reaching the cap clears leftover XP
        if (player.level >= MAX_LEVEL) player.xp = 0;

        // Everyone in the room sees the level-up
        io.to(player.room).emit('player:levelup', {
            playerId:  player.id,
            name:      player.name,
            level:     player.level,
            hp:        player.hp,
            maxHp:     player.maxHp,
            mp:        player.mp,
            maxMp:     player.maxMp,
            xpToLevel: player.xpToLevel,
            stats:     getPlayerStats(player),
            gains,
            isMax:     player.level >= MAX_LEVEL,
        });
        console.log(`[LEVEL UP] ${player.name} reached level ${player.level}`);
    }

    // Private XP / gold update
    if (socket) {
        socket.emit('player:xpGold', {
            xp: player.xp, xpToLevel: player.xpToLevel, gold: player.gold,
            level: player.level, xpGained: xpGain, goldGained: goldAmount,
        });
    }
}

// ─── Downed / Revive / Respawn ─────────────────────────────────────────────────

/**
 * A monster dropped the player to 0 HP: collapse in place and wait
 * DOWNED_MS for a Revive before returning to town.
 */
function downPlayer(player) {
    if (player.downed) return;

    // A monster kill during a duel forfeits it
    if (isInDuel(player)) {
        const opponent = players.get(player.duelTarget);
        if (opponent) endDuel(opponent, player, 'forfeit');
    }

    player.downed      = true;
    player.hp          = 0;
    player.downedUntil = Date.now() + DOWNED_MS;
    clearTimeout(player.downedTimer);
    player.downedTimer = setTimeout(() => respawnInTown(player), DOWNED_MS);

    io.to(player.room).emit('player:downed', {
        playerId: player.id, name: player.name, until: player.downedUntil,
    });
    console.log(`[DOWNED] ${player.name} in ${player.room}`);
}

/** Bring a downed player back where they lie. */
function revivePlayer(player, byPlayer) {
    clearTimeout(player.downedTimer);
    player.downed      = false;
    player.downedUntil = 0;
    player.hp          = Math.floor(player.maxHp * 0.5);

    io.to(player.room).emit('player:revived', {
        playerId: player.id, name: player.name, hp: player.hp, maxHp: player.maxHp,
        byId: byPlayer?.id ?? null, byName: byPlayer?.name ?? null,
    });
    console.log(`[REVIVE] ${byPlayer?.name} revived ${player.name}`);
}

/** Downed timer ran out (or the player gave up): respawn in town at 50%. */
function respawnInTown(player) {
    if (!players.has(player.id) || !player.downed) return;
    clearTimeout(player.downedTimer);
    player.downed      = false;
    player.downedUntil = 0;
    player.hp          = Math.floor(player.maxHp * 0.5);
    player.mp          = Math.floor(player.maxMp * 0.5);

    const socket = socketOf(player.id);
    if (!socket) return;
    socket.emit('player:died', { message: 'No one came to your aid. You wake in Etheryn Town.' });
    const town = ROOMS['etheryn-town'];
    movePlayerToRoom(socket, player, town.id, town.spawnPoint.x, 'right');
}

// ─── Duels ─────────────────────────────────────────────────────────────────────

/** True if the player is in an accepted duel. */
function isInDuel(player) {
    return Boolean(player.duelTarget && player.duelAccepted);
}

/** True if a and b are dueling each other. */
function areDueling(a, b) {
    return isInDuel(a) && isInDuel(b) && a.duelTarget === b.id && b.duelTarget === a.id;
}

/** Drop an unanswered outgoing duel request. */
function clearPendingDuel(player) {
    if (player.duelTarget && !player.duelAccepted) {
        player.duelTarget = null;
    }
}

/**
 * Finish a duel. The loser is revived in place at 50% HP.
 * @param {object} winner
 * @param {object} loser
 * @param {'defeat'|'forfeit'} reason
 */
function endDuel(winner, loser, reason) {
    // Reset duel state on both players
    winner.duelTarget = null; winner.duelAccepted = false;
    loser.duelTarget  = null; loser.duelAccepted  = false;

    // Revive the loser in place after a defeat
    if (reason === 'defeat') {
        loser.hp = Math.max(1, Math.floor(loser.maxHp * 0.5));
        broadcastHp(loser);
    }

    // Both rooms hear about it (they differ on a forfeit by room change)
    const payload = {
        winnerId: winner.id, winnerName: winner.name,
        loserId:  loser.id,  loserName:  loser.name,
        reason,
    };
    io.to(winner.room).emit('duel:ended', payload);
    if (loser.room !== winner.room) io.to(loser.room).emit('duel:ended', payload);

    console.log(`[DUEL] ${winner.name} beat ${loser.name} (${reason})`);
}

// ─── Combat Resolution ─────────────────────────────────────────────────────────

/**
 * Apply a hit to a monster and handle its death, rewards and respawn.
 */
function hitMonster(attacker, monster, result) {
    if (monster.isDead) return;
    monster.hp = Math.max(0, monster.hp - result.damage);

    // Being hit aggroes the monster onto the attacker (latest attacker wins)
    setAggro(monster, attacker);
    if (monster.boss) monster.damagers.add(attacker.name);

    // Everyone in the room sees the hit
    io.to(monster.room).emit('combat:damage', {
        attackerId:  attacker.id,
        targetId:    monster.id,
        targetType:  'monster',
        damage:      result.damage,
        isCrit:      result.isCrit,
        damageType:  result.damageType,
        targetHp:    monster.hp,
        targetMaxHp: monster.maxHp,
    });

    if (monster.hp > 0) return;

    // ── Monster died ──
    monster.isDead = true;
    clearAggro(monster);
    monster.returning = false;
    io.to(monster.room).emit('monster:died', { monsterId: monster.id, killerId: attacker.id });

    // Boss kill: server-wide announcement, and its summons vanish
    if (monster.boss) bossDefeated(monster);

    // Shared credit: every player in the room gets XP, gold and quest progress
    for (const p of players.values()) {
        if (p.room !== monster.room) continue;
        awardPlayer(p, monster.xp, monster.gold);

        // Quest progress for matching kill objectives
        const questDef = p.quest && QUESTS[p.quest.id];
        if (!questDef || questDef.objective.target !== monster.name) continue;
        if (p.quest.progress >= questDef.objective.count) continue;
        p.quest.progress += 1;
        socketOf(p.id)?.emit('quest:progress', {
            questId: p.quest.id, progress: p.quest.progress, count: questDef.objective.count,
        });
    }

    // Summoned adds never come back
    if (monster.summoned) {
        monsters.get(monster.room).delete(monster.id);
        return;
    }

    // Respawn after the template's delay
    setTimeout(() => {
        monster.hp           = monster.maxHp;
        monster.isDead       = false;
        monster.x            = monster.spawnX;
        monster.returning    = false;
        monster.ignoreUntil  = {};
        monster.skillReadyAt = {};
        monster.windup       = null;
        monster.damagers     = new Set();
        clearAggro(monster);
        io.to(monster.room).emit('monster:respawned', publicMonster(monster));
        if (monster.boss) systemChat(`⚠ The ${monster.name} has returned to his throne!`);
        console.log(`[RESPAWN] ${monster.name} (${monster.id})`);
    }, monster.respawnTime);
}

/** Announce a boss kill to every player and clear its summons. */
function bossDefeated(boss) {
    const killers = [...boss.damagers];
    io.emit('boss:defeated', { name: boss.name, killers });
    systemChat(`☠ The ${boss.name} has fallen! Slain by ${killers.join(', ') || 'unknown heroes'}.`);

    // Remove any Call the Horde goblins still alive
    const roomMonsters = monsters.get(boss.room);
    for (const m of [...roomMonsters.values()]) {
        if (!m.summoned || m.isDead) continue;
        m.isDead = true;
        roomMonsters.delete(m.id);
        io.to(boss.room).emit('monster:died', { monsterId: m.id, killerId: null, despawn: true });
    }
    console.log(`[BOSS] ${boss.name} slain by ${killers.join(', ')}`);
}

/**
 * Apply a hit to a player (duel opponent or monster victim).
 * Divine Immunity blocks everything.
 * @returns {number} damage actually dealt
 */
function hitPlayer(attacker, target, result, attackerType = 'player') {
    const immune = isImmune(target);
    const damage = immune ? 0 : result.damage;
    target.hp    = Math.max(0, target.hp - damage);

    // Everyone in the room sees the hit
    io.to(target.room).emit('combat:damage', {
        attackerId:   attacker.id,
        attackerType,
        targetId:     target.id,
        targetType:   'player',
        damage,
        immune,
        isCrit:       result.isCrit,
        damageType:   result.damageType,
        targetHp:     target.hp,
        targetMaxHp:  target.maxHp,
    });

    // 0 HP: duels end in a defeat, monsters down the player
    if (target.hp <= 0) {
        if (attackerType === 'player') endDuel(attacker, target, 'defeat');
        else                           downPlayer(target);
    }
    return damage;
}

/**
 * Resolve a target id into a monster or a duel opponent, with a range check.
 * @returns {{ kind:'monster'|'player', entity:object } | { error:string }}
 */
function resolveEnemy(attacker, targetId, targetType, range) {
    // Monster target
    if (targetType === 'monster' || (!targetType && monsters.get(attacker.room)?.has(targetId))) {
        const monster = monsters.get(attacker.room)?.get(targetId);
        if (!monster || monster.isDead) return { error: 'Invalid target.' };
        if (xDistance(attacker, monster) > range + RANGE_SLACK + monster.width / 2) {
            return { error: 'Target is out of range.' };
        }
        return { kind: 'monster', entity: monster };
    }

    // Player target (duel only)
    const target = players.get(targetId);
    if (!isActive(target) || target.room !== attacker.room) {
        return { error: 'Invalid target.' };
    }
    if (!areDueling(attacker, target)) {
        return { error: 'You must be in a duel to attack players.' };
    }
    if (Date.now() < (attacker.duelStartsAt ?? 0)) {
        return { error: 'Wait for the duel countdown!' };
    }
    if (xDistance(attacker, target) > range + RANGE_SLACK) {
        return { error: 'Target is out of range.' };
    }
    return { kind: 'player', entity: target };
}

/**
 * Resolve an ally target for healing / revive.
 * @param {boolean} wantDowned  true for Revive, false for heals
 */
function resolveAlly(caster, targetId, range, wantDowned) {
    const target = players.get(targetId);
    if (!target || target.room !== caster.room) return { error: 'That ally is not here.' };
    if (wantDowned && !target.downed)           return { error: `${target.name} is not downed.` };
    if (!wantDowned && target.downed)           return { error: `${target.name} needs a Revive, not a heal.` };
    if (target.id !== caster.id && isInDuel(target) && target.duelTarget !== caster.id) {
        return { error: `${target.name} is in a duel.` };
    }
    if (xDistance(caster, target) > range + RANGE_SLACK) return { error: 'Ally is out of range.' };
    return { entity: target };
}

/** Every enemy (living monsters + duel opponent) within `radius` of x. */
function enemiesAround(caster, x, radius) {
    const list = [];
    for (const m of monsters.get(caster.room)?.values() ?? []) {
        if (!m.isDead && Math.abs(m.x - x) <= radius + m.width / 2) list.push({ kind: 'monster', entity: m });
    }
    const opp = isInDuel(caster) ? players.get(caster.duelTarget) : null;
    if (isActive(opp) && areDueling(caster, opp) && Math.abs(opp.x - x) <= radius) {
        list.push({ kind: 'player', entity: opp });
    }
    return list;
}

/** Allies (active players not dueling someone else) within `radius` of the caster. */
function alliesAround(caster, radius) {
    return [...players.values()].filter(p =>
        p.room === caster.room && isActive(p) && xDistance(caster, p) <= radius &&
        (p.id === caster.id || !isInDuel(p) || p.duelTarget === caster.id));
}

/** Roll and apply skill damage to one resolved enemy. */
function skillHit(caster, skill, enemy, mult = 1) {
    const targetStats = enemy.kind === 'monster' ? enemy.entity : getPlayerStats(enemy.entity);
    let result = applyOutgoingMods(caster, calcSkillDamage(caster, skill, targetStats));
    if (mult !== 1) result = { ...result, damage: Math.max(1, Math.round(result.damage * mult)) };
    if (enemy.kind === 'monster') hitMonster(caster, enemy.entity, result);
    else                          hitPlayer(caster, enemy.entity, result);
}

// ─── Monster Aggro & Movement ──────────────────────────────────────────────────

/** Start (or refresh) chasing a player. */
function setAggro(monster, player) {
    if (monster.aggroTarget !== player.id) monster.dirty = true;
    monster.aggroTarget  = player.id;
    monster.lastThreatAt = Date.now();
    monster.returning    = false;
}

/** Forget the current target (no return trip). */
function clearAggro(monster) {
    if (monster.aggroTarget) monster.dirty = true;
    monster.aggroTarget = null;
}

/** Stop chasing, walk home, and ignore that player's proximity for a while. */
function giveUp(monster) {
    if (monster.aggroTarget) monster.ignoreUntil[monster.aggroTarget] = Date.now() + AGGRO_IGNORE_MS;
    clearAggro(monster);
    monster.returning = true;
}

/**
 * Step a monster toward goalX at its speed without crowding closer than
 * MONSTER_SPACING to a monster in its path. Returns true if it moved.
 */
function stepMonster(monster, goalX, stopDist, dt, roomMonsters) {
    const diff = goalX - monster.x;
    if (Math.abs(diff) <= stopDist) return false;
    const dir  = Math.sign(diff);
    let   newX = monster.x + dir * Math.min(monster.speed * dt, Math.abs(diff) - stopDist);

    // Don't walk into another monster ahead of us
    for (const o of roomMonsters.values()) {
        if (o === monster || o.isDead) continue;
        const ahead = Math.sign(o.x - monster.x) === dir;
        if (ahead && Math.abs(newX - o.x) < MONSTER_SPACING) {
            newX = o.x - dir * MONSTER_SPACING;
        }
    }

    // Never get pushed backwards by the spacing rule
    if (Math.sign(newX - monster.x) !== dir || Math.abs(newX - monster.x) < 0.5) return false;
    monster.x      = newX;
    monster.facing = dir < 0 ? 'left' : 'right';
    monster.dirty  = true;
    return true;
}

/**
 * Monster movement (20 Hz):
 *   idle      → aggro onto the nearest player inside aggroRadius (unless ignored)
 *   aggroed   → chase the target into attack range; give up after AGGRO_TIMEOUT
 *               without being hit, when leashed, or when the target is gone/downed
 *   returning → walk back to spawn
 */
setInterval(() => {
    const now = Date.now();
    const dt  = MONSTER_MOVE_TICK / 1000;

    for (const [roomId, room] of Object.entries(ROOMS)) {
        if (room.isSafe) continue;
        const roomMonsters = monsters.get(roomId);
        if (!roomMonsters || roomMonsters.size === 0) continue;
        const roomPlayers = [...players.values()].filter(p => p.room === roomId && isActive(p));

        for (const m of roomMonsters.values()) {
            if (m.isDead) continue;

            // ── Validate an existing chase ──
            if (m.aggroTarget) {
                const t = players.get(m.aggroTarget);
                if (!t || t.room !== roomId || !isActive(t))     giveUp(m);
                else if (now - m.lastThreatAt > AGGRO_TIMEOUT)    giveUp(m);
                else if (Math.abs(m.x - m.spawnX) > m.leash)      giveUp(m);
            }

            // ── Proximity aggro while idle ──
            if (!m.aggroTarget && !m.returning) {
                let best = null, bestD = Infinity;
                for (const p of roomPlayers) {
                    const d = xDistance(m, p);
                    if (d <= m.aggroRadius && d < bestD && now >= (m.ignoreUntil[p.id] ?? 0)) { best = p; bestD = d; }
                }
                if (best) setAggro(m, best);
            }

            // ── Move (a boss winding up a Crushing Blow stands still) ──
            if (m.windup) continue;
            if (m.aggroTarget) {
                const t = players.get(m.aggroTarget);
                stepMonster(m, t.x, m.attackRange * 0.8, dt, roomMonsters);
                const face = t.x < m.x ? 'left' : 'right';
                if (face !== m.facing) { m.facing = face; m.dirty = true; }
            } else if (m.returning) {
                if (!stepMonster(m, m.spawnX, 2, dt, roomMonsters) && Math.abs(m.x - m.spawnX) <= 30) {
                    m.returning = false;
                }
            }
        }
    }
}, MONSTER_MOVE_TICK);

/** Broadcast moved / re-faced / aggro-changed monsters per room (10 Hz). */
setInterval(() => {
    for (const [roomId, roomMonsters] of monsters) {
        const changed = [];
        for (const m of roomMonsters.values()) {
            if (!m.dirty || m.isDead) continue;
            m.dirty = false;
            changed.push({ id: m.id, x: Math.round(m.x), facing: m.facing, aggro: Boolean(m.aggroTarget) });
        }
        if (changed.length) io.to(roomId).emit('monsters:moved', changed);
    }
}, MONSTER_SYNC_TICK);

// ─── Boss Skills ───────────────────────────────────────────────────────────────

/** Broadcast a boss skill so clients can draw it. */
function emitMonsterSkill(monster, skill, extra = {}) {
    io.to(monster.room).emit('monster:skill', { monsterId: monster.id, skill, ...extra });
}

/** Flat-range physical hit from a boss skill against one player. */
function bossHit(monster, player, range, mult = 1) {
    const r = calcDamage(randInt(range.min, range.max), 'physical', { atk: 0, mag: 0 }, getPlayerStats(player));
    hitPlayer(monster, player, { ...r, damage: Math.max(1, Math.round(r.damage * mult)) }, 'monster');
}

/**
 * Try one boss skill this tick (priority: Call the Horde → Ground Slam →
 * Crushing Blow → Spear Toss). Returns true if the boss is busy (cast or
 * winding up), so the basic attack is skipped.
 */
function bossAct(monster, roomPlayers, now) {
    const sk     = monster.skills;
    const ready  = k => now >= (monster.skillReadyAt[k] ?? 0);
    const use    = k => { monster.skillReadyAt[k] = now + sk[k].cooldown; };
    const target = players.get(monster.aggroTarget);

    // ── Finish a Crushing Blow wind-up ──
    if (monster.windup) {
        if (now < monster.windup.until) return true;
        const t = players.get(monster.windup.targetId);
        monster.windup = null;
        monster.lastAttackTime = now;
        if (t && isActive(t) && t.room === monster.room && xDistance(monster, t) <= monster.attackRange + RANGE_SLACK) {
            emitMonsterSkill(monster, 'crush', { targetId: t.id });
            bossHit(monster, t, monster.damage, sk.crush.mult);
        } else {
            emitMonsterSkill(monster, 'crush_miss', {});
        }
        return true;
    }
    if (!target || !isActive(target) || target.room !== monster.room) return false;

    // ── Call the Horde: below the HP threshold, whenever ready ──
    if (ready('horde') && monster.hp <= monster.maxHp * sk.horde.hpThreshold) {
        use('horde');
        const tmpl   = MONSTER_TEMPLATES[sk.horde.summon];
        const points = (SUMMON_POINTS[monster.room] ?? []).slice(0, sk.horde.count);
        emitMonsterSkill(monster, 'horde', { positions: points });
        points.forEach(x => {
            const add = createMonster(tmpl, monster.room, `${monster.room}_summon_${++summonSeq}`, x, { summoned: true });
            monsters.get(monster.room).set(add.id, add);
            io.to(monster.room).emit('monster:respawned', publicMonster(add));

            // Each add charges the nearest player
            let best = null, bestD = Infinity;
            roomPlayers.forEach(p => { const d = xDistance(add, p); if (isActive(p) && d < bestD) { best = p; bestD = d; } });
            if (best) setAggro(add, best);
        });
        return true;
    }

    // ── Ground Slam: damage + stun everyone close ──
    const close = roomPlayers.filter(p => isActive(p) && xDistance(monster, p) <= sk.slam.radius);
    if (ready('slam') && close.length) {
        use('slam');
        emitMonsterSkill(monster, 'slam', { radius: sk.slam.radius, stun: sk.slam.stun });
        close.forEach(p => {
            bossHit(monster, p, sk.slam.damage);
            stunPlayer(p, sk.slam.stun);
        });
        monster.lastAttackTime = now;
        return true;
    }

    // ── Crushing Blow: telegraphed heavy hit on the target ──
    if (ready('crush') && xDistance(monster, target) <= monster.attackRange) {
        use('crush');
        monster.windup = { until: now + sk.crush.windup, targetId: target.id };
        emitMonsterSkill(monster, 'crush_windup', { targetId: target.id, delay: sk.crush.windup });
        return true;
    }

    // ── Spear Toss: farthest player out of melee reach ──
    if (ready('spear')) {
        let far = null, farD = monster.attackRange;
        roomPlayers.forEach(p => {
            const d = xDistance(monster, p);
            if (isActive(p) && d > farD && d <= sk.spear.range) { far = p; farD = d; }
        });
        if (far) {
            use('spear');
            emitMonsterSkill(monster, 'spear', { targetId: far.id });
            bossHit(monster, far, sk.spear.damage);
            return true;
        }
    }
    return false;
}

// ─── Monster AI Loop ───────────────────────────────────────────────────────────

/**
 * Every 250 ms, each monster whose cooldown is ready hits the nearest
 * active player within its attack range.
 */
setInterval(() => {
    const now = Date.now();

    for (const [roomId, room] of Object.entries(ROOMS)) {
        if (room.isSafe) continue;             // no monsters attack in safe rooms
        const roomMonsters = monsters.get(roomId);
        if (!roomMonsters || roomMonsters.size === 0) continue;

        // Collect active players in this room
        const roomPlayers = [...players.values()].filter(p => p.room === roomId && isActive(p));
        if (roomPlayers.length === 0) continue;

        for (const monster of [...roomMonsters.values()]) {
            if (monster.isDead) continue;

            // Bosses try a skill first (and stay busy while winding up)
            if (monster.skills && (monster.aggroTarget || monster.windup) && bossAct(monster, roomPlayers, now)) continue;
            if (now - monster.lastAttackTime < monster.attackCooldown) continue;

            // Prefer the chased player; otherwise the nearest one
            let nearest = null;
            let nearestDist = Infinity;
            const chased = players.get(monster.aggroTarget);
            if (chased && chased.room === roomId && isActive(chased) && xDistance(monster, chased) <= monster.attackRange) {
                nearest = chased; nearestDist = xDistance(monster, chased);
            }
            for (const p of nearest ? [] : roomPlayers) {
                const d = xDistance(monster, p);
                if (isActive(p) && d < nearestDist) { nearestDist = d; nearest = p; }
            }
            if (!nearest || nearestDist > monster.attackRange) continue;

            // Attack
            monster.lastAttackTime = now;
            hitPlayer(monster, nearest, calcMonsterDamage(monster, nearest), 'monster');
        }
    }
}, 250);

// ─── Regeneration ──────────────────────────────────────────────────────────────

/**
 * Every 3 seconds: everyone (not downed) regens 5 MP; players in safe rooms
 * also regen 5% of their max HP.
 */
setInterval(() => {
    for (const [sid, player] of players) {
        if (player.downed) continue;
        const socket = socketOf(sid);

        // MP regen (private)
        if (player.mp < player.maxMp) {
            player.mp = Math.min(player.maxMp, player.mp + 5);
            if (socket) socket.emit('player:mpRegen', { mp: player.mp, maxMp: player.maxMp });
        }

        // HP regen in town / market only (public, shows on HP bars)
        if (ROOMS[player.room]?.isSafe && player.hp < player.maxHp && !isInDuel(player)) {
            player.hp = Math.min(player.maxHp, player.hp + Math.ceil(player.maxHp * 0.05));
            broadcastHp(player);
        }
    }
}, 3000);

// ─── Socket.IO Connection ──────────────────────────────────────────────────────

io.on('connection', (socket) => {
    console.log(`[CONNECT] ${socket.id}`);

    // Tell the client which server build it is talking to
    socket.emit('server:hello', { buildId: BUILD_ID, time: Date.now() });

    // ── player:join ─────────────────────────────────────────────────────────────
    socket.on('player:join', ({ name, characterClass, color } = {}) => {
        if (players.has(socket.id)) return;   // ignore duplicate joins

        const safeName  = sanitise(name, 20) || 'Adventurer';
        const cls       = CLASSES[characterClass] ? characterClass : 'warrior';
        const safeColor = /^#[0-9A-Fa-f]{3,6}$/.test(color) ? color : '#4fc3f7';
        const classData = CLASSES[cls];
        const spawnRoom = ROOMS['etheryn-town'];

        // Fresh level-1 character
        const player = {
            id:              socket.id,
            name:            safeName,
            x:               spawnRoom.spawnPoint.x + randInt(-60, 60),
            y:               spawnRoom.groundY,
            room:            spawnRoom.id,
            hp:              classData.maxHp,
            maxHp:           classData.maxHp,
            mp:              classData.maxMp,
            maxMp:           classData.maxMp,
            level:           1,
            xp:              0,
            xpToLevel:       xpToNextLevel(1),
            gold:            40,
            class:           cls,
            color:           safeColor,
            buffAtk:         0,
            buffAtkExpiry:   0,
            berserkUntil:    0,
            immuneUntil:     0,
            stunnedUntil:    0,
            blessAmount:     0,
            blessUntil:      0,
            downed:          false,
            downedUntil:     0,
            downedTimer:     null,
            inventory:       [],
            equipment:       starterEquipment(cls),
            attackCooldown:  0,
            facing:          'right',
            skillCooldowns:  {},
            quest:           null,
            completedQuests: [],
            duelTarget:      null,
            duelAccepted:    false,
        };

        players.set(socket.id, player);
        socket.join(spawnRoom.id);

        // Send full state to the joining player, announce to the room
        socket.emit('game:state', buildGameState(socket.id));
        socket.to(spawnRoom.id).emit('player:joined', publicPlayer(player));

        console.log(`[JOIN] ${safeName} (${cls}) joined ${spawnRoom.id}`);
    });

    // ── player:move ─────────────────────────────────────────────────────────────
    socket.on('player:move', ({ x, facing } = {}) => {
        const player = players.get(socket.id);
        if (!isActive(player) || isStunned(player)) return;   // downed / stunned can't move
        if (Date.now() < (player.duelStartsAt ?? 0)) return;   // frozen during the duel countdown
        const roomDef = ROOMS[player.room];

        // Clamp to the room; y is always the ground line
        player.x      = clamp(x, 0, roomDef.width);
        player.y      = roomDef.groundY;
        player.facing = ['left', 'right'].includes(facing) ? facing : player.facing;

        socket.to(player.room).emit('player:moved', {
            id:     socket.id,
            x:      player.x,
            y:      player.y,
            facing: player.facing,
        });
    });

    // ── chat:send ────────────────────────────────────────────────────────────────
    socket.on('chat:send', ({ message } = {}) => {
        const player = players.get(socket.id);
        if (!player) return;

        const safeMsg = sanitise(message, 200);
        if (!safeMsg) return;

        io.to(player.room).emit('chat:message', {
            senderId:   socket.id,
            senderName: player.name,
            message:    safeMsg,
            timestamp:  Date.now(),
        });
    });

    // ── player:emote ─────────────────────────────────────────────────────────────
    socket.on('player:emote', ({ emote } = {}) => {
        const player = players.get(socket.id);
        if (!player) return;

        const allowedEmotes = ['wave', 'bow', 'dance', 'laugh', 'cry', 'cheer'];
        const safeEmote = allowedEmotes.includes(emote) ? emote : 'wave';

        io.to(player.room).emit('player:emoted', {
            playerId: socket.id,
            emote:    safeEmote,
        });
    });

    // ── player:respawn (give up while downed) ────────────────────────────────────
    socket.on('player:respawn', () => {
        const player = players.get(socket.id);
        if (player?.downed) respawnInTown(player);
    });

    // ── room:change (path exit or portal) ─────────────────────────────────────────
    socket.on('room:change', ({ room } = {}) => {
        const player = players.get(socket.id);
        if (!player) return;
        if (!isActive(player)) { socket.emit('error:room', { message: 'You are downed.' }); return; }
        if (isStunned(player)) { socket.emit('error:room', { message: 'You are stunned!' }); return; }
        const current = ROOMS[player.room];
        const target  = ROOMS[room];
        if (!target || room === player.room) {
            socket.emit('error:room', { message: 'Unknown room.' });
            return;
        }

        // Path exits: must be standing at the matching edge
        if (current.exits.left === room && player.x <= EXIT_RANGE) {
            movePlayerToRoom(socket, player, room, target.width - 40, 'left');
            console.log(`[ROOM] ${player.name} walked ${current.id} → ${room}`);
            return;
        }
        if (current.exits.right === room && player.x >= current.width - EXIT_RANGE) {
            movePlayerToRoom(socket, player, room, 40, 'right');
            console.log(`[ROOM] ${player.name} walked ${current.id} → ${room}`);
            return;
        }

        // Portals: must be standing next to one that leads there
        const portal = current.portals.find(p => p.to === room);
        if (portal && xDistance(player, portal) <= PORTAL_RANGE) {
            // Arrive beside the return portal if the target room has one
            const back    = target.portals.find(p => p.to === current.id);
            const arriveX = back
                ? back.x + (back.x < target.width / 2 ? 80 : -80)
                : target.spawnPoint.x;
            movePlayerToRoom(socket, player, room, arriveX, back && back.x > target.width / 2 ? 'left' : 'right');
            console.log(`[ROOM] ${player.name} teleported ${current.id} → ${room}`);
            return;
        }

        socket.emit('error:room', { message: 'You cannot reach that area from here.' });
    });

    // ── combat:attack (basic attack) ──────────────────────────────────────────────
    socket.on('combat:attack', ({ targetId, targetType } = {}) => {
        const attacker = players.get(socket.id);
        if (!isActive(attacker) || isStunned(attacker)) return;

        // Global attack cooldown (prevents spam)
        const now = Date.now();
        if (now - attacker.attackCooldown < ATTACK_COOLDOWN) return;

        // Validate target + range
        const range  = CLASSES[attacker.class].attackRange;
        const target = resolveEnemy(attacker, targetId, targetType, range);
        if (target.error) { socket.emit('error:combat', { message: target.error }); return; }
        attacker.attackCooldown = now;

        // Roll and apply damage
        const targetStats = target.kind === 'monster' ? target.entity : getPlayerStats(target.entity);
        const result      = applyOutgoingMods(attacker, calcBasicAttack(attacker, targetStats));
        if (target.kind === 'monster') hitMonster(attacker, target.entity, result);
        else                           hitPlayer(attacker, target.entity, result);
    });

    // ── player:skill ─────────────────────────────────────────────────────────────
    socket.on('player:skill', ({ skillId, targetId, targetType } = {}) => {
        const player = players.get(socket.id);
        if (!isActive(player)) return;
        if (isStunned(player)) { socket.emit('error:skill', { message: 'You are stunned!' }); return; }

        // Look up the skill for this class
        const skill = (SKILLS[player.class] ?? []).find(s => s.id === skillId);
        if (!skill) { socket.emit('error:skill', { message: 'Unknown skill.' }); return; }

        // Cooldown + MP checks
        const now      = Date.now();
        const lastUsed = player.skillCooldowns[skillId] ?? 0;
        if (now - lastUsed < skill.cooldown) {
            const remaining = Math.ceil((skill.cooldown - (now - lastUsed)) / 1000);
            socket.emit('error:skill', { message: `${skill.name} is on cooldown (${remaining}s).` });
            return;
        }
        if (player.mp < skill.mpCost) {
            socket.emit('error:skill', { message: 'Not enough MP.' });
            return;
        }

        // Targeted skills must have a valid target before anything is spent
        let target = null;
        if (skill.targeting === 'enemy') {
            target = resolveEnemy(player, targetId, targetType, skill.range);
        } else if (skill.targeting === 'ally') {
            target = resolveAlly(player, targetId, skill.range, skill.kind === 'revive');
        }
        if (target?.error) { socket.emit('error:skill', { message: target.error }); return; }

        // Chain Lightning picks its extra jump targets now
        let chainTargets = [];
        if (skill.kind === 'chain') {
            chainTargets = enemiesAround(player, target.entity.x, skill.jumpRadius)
                .filter(e => e.entity.id !== target.entity.id)
                .sort((a, b) => Math.abs(a.entity.x - target.entity.x) - Math.abs(b.entity.x - target.entity.x))
                .slice(0, skill.jumps);
        }

        // Spend MP and start cooldown
        player.mp -= skill.mpCost;
        player.skillCooldowns[skillId] = now;
        socket.emit('player:mpRegen', { mp: player.mp, maxMp: player.maxMp });

        // Everyone sees the cast (with whatever the client needs to draw it)
        io.to(player.room).emit('player:skillUsed', {
            playerId:   socket.id,
            skillId,
            skillName:  skill.name,
            kind:       skill.kind,
            damageType: skill.damageType ?? null,
            targetId:   target?.entity?.id ?? null,
            targetX:    target?.entity?.x ?? null,
            chainIds:   chainTargets.map(e => e.entity.id),
            radius:     skill.radius ?? null,
            delay:      skill.delay ?? null,
            duration:   skill.duration ?? null,
            cooldown:   skill.cooldown,
        });

        // ── Resolve the effect ──
        switch (skill.kind) {
            case 'damage':
                skillHit(player, skill, target);
                break;

            case 'chain':
                skillHit(player, skill, target);
                chainTargets.forEach(e => skillHit(player, skill, e, CHAIN_MULT));
                break;

            case 'aoe_self':
                enemiesAround(player, player.x, skill.radius).forEach(e => skillHit(player, skill, e));
                break;

            case 'meteor': {
                // Impact point is fixed at cast time; damage lands after the delay
                const impactX = target.entity.x;
                setTimeout(() => {
                    const caster = players.get(socket.id);
                    if (!caster || caster.room !== player.room) return;
                    enemiesAround(caster, impactX, skill.radius).forEach(e => skillHit(caster, skill, e));
                }, skill.delay);
                break;
            }

            case 'buff_atk':
                // Party buff: caster + allies within radius
                alliesAround(player, skill.radius ?? 0).forEach(p => {
                    p.buffAtk       = skill.amount;
                    p.buffAtkExpiry = now + skill.duration;
                    io.to(player.room).emit('player:buffed', {
                        playerId: p.id, buff: 'atk', duration: skill.duration, stats: getPlayerStats(p),
                    });
                });
                break;

            case 'berserk':
                player.berserkUntil = now + skill.duration;
                io.to(player.room).emit('player:buffed', { playerId: socket.id, buff: 'berserk', duration: skill.duration });
                break;

            case 'immunity':
                player.immuneUntil = now + skill.duration;
                io.to(player.room).emit('player:buffed', { playerId: socket.id, buff: 'immune', duration: skill.duration });
                break;

            case 'heal_self':
                healPlayer(player, skill.power + getPlayerStats(player).mag, socket.id);
                break;

            case 'heal_ally':
                healPlayer(target.entity, skill.power + getPlayerStats(player).mag, socket.id);
                break;

            case 'heal_area': {
                const amount = skill.power + Math.floor(getPlayerStats(player).mag / 2);
                alliesAround(player, skill.radius).forEach(p => healPlayer(p, amount, socket.id));
                break;
            }

            case 'bless_area':
                alliesAround(player, skill.radius).forEach(p => {
                    p.blessAmount = skill.amount;
                    p.blessUntil  = now + skill.duration;
                    io.to(player.room).emit('player:buffed', {
                        playerId: p.id, buff: 'bless', duration: skill.duration, stats: getPlayerStats(p),
                    });
                });
                break;

            case 'revive':
                revivePlayer(target.entity, player);
                break;
        }
    });

    // ── player:inspect ───────────────────────────────────────────────────────────
    socket.on('player:inspect', ({ targetId } = {}) => {
        const player = players.get(socket.id);
        const target = players.get(targetId);
        if (!player || !target || target.room !== player.room) {
            socket.emit('error:inspect', { message: 'That player is not here.' });
            return;
        }

        // Public profile without inventory or gold
        const { inventory, gold, ...profile } = publicPlayer(target);
        socket.emit('player:inspected', profile);
    });

    // ── duel:request ─────────────────────────────────────────────────────────────
    socket.on('duel:request', ({ targetId } = {}) => {
        const challenger = players.get(socket.id);
        const target     = players.get(targetId);
        if (!challenger || !target || targetId === socket.id) return;

        // Same room, both able to fight, neither already dueling
        if (challenger.room !== target.room) {
            socket.emit('error:duel', { message: 'Target is not in your area.' }); return;
        }
        if (!isActive(challenger) || !isActive(target)) {
            socket.emit('error:duel', { message: 'Downed players cannot duel.' }); return;
        }
        if (isInDuel(challenger) || isInDuel(target)) {
            socket.emit('error:duel', { message: 'One of you is already in a duel.' }); return;
        }

        challenger.duelTarget   = targetId;
        challenger.duelAccepted = false;

        socketOf(targetId)?.emit('duel:request', {
            challengerId: socket.id, challengerName: challenger.name,
        });
        socket.emit('duel:sent', { targetName: target.name });
    });

    // ── duel:accept ──────────────────────────────────────────────────────────────
    socket.on('duel:accept', ({ challengerId } = {}) => {
        const accepter   = players.get(socket.id);
        const challenger = players.get(challengerId);
        if (!accepter || !challenger) return;

        // Must be a pending request aimed at us, still in the same room
        if (challenger.duelTarget !== socket.id || challenger.duelAccepted) {
            socket.emit('error:duel', { message: 'That duel request has expired.' }); return;
        }
        if (challenger.room !== accepter.room || isInDuel(accepter) || !isActive(accepter) || !isActive(challenger)) {
            socket.emit('error:duel', { message: 'The duel can no longer start.' }); return;
        }

        accepter.duelTarget     = challengerId;
        accepter.duelAccepted   = true;
        challenger.duelAccepted = true;

        // Place both DUEL_GAP apart around their midpoint, facing each other
        const room  = ROOMS[accepter.room];
        const half  = DUEL_GAP / 2;
        const mid   = clamp((challenger.x + accepter.x) / 2, half + 20, room.width - half - 20);
        const [left, right] = challenger.x <= accepter.x ? [challenger, accepter] : [accepter, challenger];
        left.x  = mid - half; left.facing  = 'right';
        right.x = mid + half; right.facing = 'left';

        // Countdown lock on both
        const startsAt = Date.now() + DUEL_COUNTDOWN;
        challenger.duelStartsAt = startsAt;
        accepter.duelStartsAt   = startsAt;

        io.to(accepter.room).emit('duel:started', {
            player1Id: challengerId, player1Name: challenger.name, player1X: challenger.x, player1Facing: challenger.facing,
            player2Id: socket.id,    player2Name: accepter.name,   player2X: accepter.x,   player2Facing: accepter.facing,
            startsAt, countdown: DUEL_COUNTDOWN,
        });
        console.log(`[DUEL] ${challenger.name} vs ${accepter.name}`);
    });

    // ── duel:decline ─────────────────────────────────────────────────────────────
    socket.on('duel:decline', ({ challengerId } = {}) => {
        const decliner   = players.get(socket.id);
        const challenger = players.get(challengerId);
        if (!decliner || !challenger || challenger.duelTarget !== socket.id) return;

        clearPendingDuel(challenger);
        socketOf(challengerId)?.emit('duel:declined', { byName: decliner.name });
    });

    // ── quest:accept ─────────────────────────────────────────────────────────────
    socket.on('quest:accept', ({ questId } = {}) => {
        const player = players.get(socket.id);
        if (!player) return;
        const quest = QUESTS[questId];

        // Validate quest availability
        if (!quest)                                   { socket.emit('error:quest', { message: 'Unknown quest.' }); return; }
        if (player.quest)                             { socket.emit('error:quest', { message: 'You already have an active quest.' }); return; }
        if (player.completedQuests.includes(questId)) { socket.emit('error:quest', { message: 'Quest already completed.' }); return; }
        if (quest.requires && !player.completedQuests.includes(quest.requires)) {
            socket.emit('error:quest', { message: 'You are not ready for this quest yet.' }); return;
        }

        player.quest = { id: questId, progress: 0 };
        socket.emit('quest:accepted', { quest, progress: 0 });
        console.log(`[QUEST] ${player.name} accepted "${quest.name}"`);
    });

    // ── quest:complete ────────────────────────────────────────────────────────────
    socket.on('quest:complete', ({ questId } = {}) => {
        const player = players.get(socket.id);
        if (!player) return;
        if (!player.quest || player.quest.id !== questId) {
            socket.emit('error:quest', { message: 'No matching active quest.' }); return;
        }

        // Objective must be met
        const questDef = QUESTS[questId];
        const required = questDef.objective.count;
        if (player.quest.progress < required) {
            socket.emit('error:quest', {
                message: `Quest incomplete. (${player.quest.progress}/${required})`,
            }); return;
        }

        // Close the quest and hand out the item reward
        player.quest = null;
        player.completedQuests.push(questId);
        const item = questDef.reward.item ? ITEMS[questDef.reward.item] : null;
        if (item) player.inventory.push({ ...item });

        socket.emit('quest:completed', {
            questId,
            reward:          questDef.reward,
            item,
            completedQuests: player.completedQuests,
        });
        if (item) emitInventory(socket, player);

        // XP / gold (may level up)
        awardPlayer(player, questDef.reward.xp, questDef.reward.gold);

        console.log(`[QUEST DONE] ${player.name} completed "${questDef.name}"`);
    });

    // ── shop:buy ──────────────────────────────────────────────────────────────────
    socket.on('shop:buy', ({ itemId, npcId } = {}) => {
        const player = players.get(socket.id);
        if (!player) return;

        // Must be next to a shopkeeper who sells this item type
        const item = ITEMS[itemId];
        const npc  = ROOMS[player.room].npcs.find(n => n.id === npcId);
        if (!item || item.shop === false) { socket.emit('error:shop', { message: 'Item not found.' }); return; }
        if (!npc || npc.shop !== item.type) { socket.emit('error:shop', { message: 'This merchant does not sell that.' }); return; }
        if (xDistance(player, npc) > NPC_RANGE) { socket.emit('error:shop', { message: 'Walk closer to the merchant.' }); return; }
        if (player.gold < item.price) { socket.emit('error:shop', { message: 'Not enough gold.' }); return; }

        player.gold -= item.price;

        // Gear goes straight into an empty slot, otherwise into the bag
        const slot = EQUIP_SLOTS.includes(item.type) ? item.type : null;
        if (slot && !player.equipment[slot]) {
            player.equipment[slot] = { ...item };
            broadcastEquipment(player);
        } else {
            player.inventory.push({ ...item });
        }

        socket.emit('shop:bought', {
            item,
            gold:      player.gold,
            inventory: player.inventory,
            equipment: player.equipment,
            stats:     getPlayerStats(player),
        });
        console.log(`[SHOP] ${player.name} bought ${item.name} for ${item.price}g`);
    });

    // ── inventory:use (Health / Mana Potion) ──────────────────────────────────────
    socket.on('inventory:use', ({ itemId } = {}) => {
        const player = players.get(socket.id);
        if (!isActive(player)) return;
        if (isStunned(player)) { socket.emit('error:inventory', { message: 'You are stunned!' }); return; }
        const idx = player.inventory.findIndex(i => i.id === itemId);
        if (idx === -1) { socket.emit('error:inventory', { message: 'Item not in inventory.' }); return; }
        const item = player.inventory[idx];
        if (item.type !== 'consumable') return;

        // Health potion (visible heal)
        if (item.healAmount) healPlayer(player, item.healAmount, socket.id);

        // Mana potion (private)
        if (item.manaAmount) {
            player.mp = Math.min(player.maxMp, player.mp + item.manaAmount);
            socket.emit('player:mpRegen', { mp: player.mp, maxMp: player.maxMp });
        }

        player.inventory.splice(idx, 1);
        emitInventory(socket, player);
    });

    // ── inventory:equip ───────────────────────────────────────────────────────────
    socket.on('inventory:equip', ({ itemId } = {}) => {
        const player = players.get(socket.id);
        if (!player) return;
        const idx  = player.inventory.findIndex(i => i.id === itemId);
        const item = player.inventory[idx];
        if (!item || !EQUIP_SLOTS.includes(item.type)) {
            socket.emit('error:inventory', { message: 'You cannot equip that.' }); return;
        }

        // Swap with whatever is in that slot
        const slot     = item.type;
        const previous = player.equipment[slot];
        player.equipment[slot] = item;
        player.inventory.splice(idx, 1);
        if (previous) player.inventory.push(previous);

        emitInventory(socket, player);
        broadcastEquipment(player);
    });

    // ── disconnect ────────────────────────────────────────────────────────────────
    socket.on('disconnect', () => {
        const player = players.get(socket.id);
        if (!player) return;

        // Disconnecting forfeits an active duel and cancels a downed timer
        if (isInDuel(player)) {
            const opponent = players.get(player.duelTarget);
            if (opponent) endDuel(opponent, player, 'forfeit');
        }
        clearTimeout(player.downedTimer);

        io.to(player.room).emit('player:left', { playerId: socket.id });
        console.log(`[DISCONNECT] ${player.name} left ${player.room}`);
        players.delete(socket.id);
    });
});
