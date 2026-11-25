/**
 * utils.js — Helper functions for Realms of Etheryn server
 */

'use strict';

const { CLASSES } = require('./gameData');

// ─── Geometry ──────────────────────────────────────────────────────────────────

/**
 * Clamp a value between min and max (inclusive). Non-numbers become min.
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function clamp(value, min, max) {
    // Reject NaN / non-numeric input from clients
    if (typeof value !== 'number' || Number.isNaN(value)) return min;
    return Math.max(min, Math.min(max, value));
}

/**
 * Horizontal distance between two entities (the world is a single ground line).
 * @param {{x:number}} a
 * @param {{x:number}} b
 * @returns {number}
 */
function xDistance(a, b) {
    return Math.abs(a.x - b.x);
}

/**
 * Random integer in [min, max].
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function randInt(min, max) {
    return min + Math.floor(Math.random() * (max - min + 1));
}

// ─── Stats ─────────────────────────────────────────────────────────────────────

/**
 * Compute a player's effective ATK / MAG / DEF / RES from class, role-based
 * level growth, equipment, and active buffs (War Cry / Arcane Surge, Blessing).
 * @param {object} player
 * @returns {{ atk:number, mag:number, def:number, res:number }}
 */
function getPlayerStats(player) {
    const cls    = CLASSES[player.class] ?? CLASSES.warrior;
    const gains  = cls.levelGains;
    const gear   = Object.values(player.equipment ?? {}).filter(Boolean);   // weapon, armor, head
    const bonus  = key => gear.reduce((sum, item) => sum + (item[key] ?? 0), 0);
    const lvl    = player.level - 1;
    const now    = Date.now();
    const buff   = now < (player.buffAtkExpiry ?? 0) ? player.buffAtk : 0;
    const bless  = now < (player.blessUntil ?? 0) ? player.blessAmount : 0;

    // Sum every stat source
    return {
        atk: cls.atk + lvl * gains.atk + bonus('atkBonus') + buff,
        mag: cls.mag + lvl * gains.mag + bonus('magBonus') + buff,
        def: cls.def + lvl * gains.def + bonus('defBonus') + bless,
        res: cls.res + lvl * gains.res + bonus('resBonus') + bless,
    };
}

// ─── Combat ────────────────────────────────────────────────────────────────────

/** Critical hit chance (20%). */
const CRIT_CHANCE = 0.2;

/** Critical hit damage multiplier. */
const CRIT_MULTIPLIER = 1.75;

/**
 * Core damage formula shared by every attack.
 *   physical: base + ATK − targetDEF/2
 *   magic   : base + MAG − targetRES/2
 * @param {number} base           — Raw damage before stats
 * @param {string} damageType     — 'physical' | 'magic'
 * @param {object} attackerStats  — { atk, mag }
 * @param {object} targetStats    — { def, res }
 * @returns {{ damage:number, isCrit:boolean, damageType:string }}
 */
function calcDamage(base, damageType, attackerStats, targetStats) {
    // Pick the offensive and defensive stat for this damage type
    const isMagic    = damageType === 'magic';
    const power      = isMagic ? attackerStats.mag : attackerStats.atk;
    const mitigation = isMagic ? (targetStats.res ?? 0) : (targetStats.def ?? 0);

    // Roll crit and apply mitigation
    const isCrit = Math.random() < CRIT_CHANCE;
    const raw    = (base + power) * (isCrit ? CRIT_MULTIPLIER : 1);
    const damage = Math.max(1, Math.round(raw - mitigation / 2));

    return { damage, isCrit, damageType: isMagic ? 'magic' : 'physical' };
}

/**
 * Basic attack: base 5–15, type comes from the attacker's class.
 * @param {object} attacker    — Player object
 * @param {object} targetStats — { def, res }
 */
function calcBasicAttack(attacker, targetStats) {
    const cls = CLASSES[attacker.class] ?? CLASSES.warrior;
    return calcDamage(randInt(5, 15), cls.damageType, getPlayerStats(attacker), targetStats);
}

/**
 * Damage skill: base is the skill's power value.
 * @param {object} attacker    — Player object
 * @param {object} skill       — Skill definition
 * @param {object} targetStats — { def, res }
 */
function calcSkillDamage(attacker, skill, targetStats) {
    return calcDamage(skill.power, skill.damageType, getPlayerStats(attacker), targetStats);
}

/**
 * Monster attack against a player. Monsters have no ATK/MAG stat;
 * their damage range is the base.
 * @param {object} monster
 * @param {object} player
 */
function calcMonsterDamage(monster, player) {
    return calcDamage(
        randInt(monster.damage.min, monster.damage.max),
        monster.damageType,
        { atk: 0, mag: 0 },
        getPlayerStats(player),
    );
}

// ─── XP / Levelling ────────────────────────────────────────────────────────────

/**
 * XP required to reach the next level from the current one.
 * Uses a gentle exponential curve: base 100 × 1.4^(level-1).
 * @param {number} level  — Current level
 * @returns {number}
 */
function xpToNextLevel(level) {
    return Math.floor(100 * Math.pow(1.4, level - 1));
}

// ─── Sanitisation ──────────────────────────────────────────────────────────────

/**
 * Strip dangerous characters from a player-supplied string.
 * @param {string} str
 * @param {number} [maxLen=32]
 * @returns {string}
 */
function sanitise(str, maxLen = 32) {
    if (typeof str !== 'string') return '';
    return str.replace(/[<>&"'`]/g, '').trim().slice(0, maxLen);
}

/**
 * Returns a safe subset of player data to broadcast to other clients.
 * Omits internal server fields (cooldown timers etc.).
 * @param {object} player
 * @returns {object}
 */
function publicPlayer(player) {
    const {
        id, name, x, y, room, hp, maxHp, mp, maxMp,
        level, xp, xpToLevel, gold, class: cls, color,
        inventory, equipment, facing,
    } = player;
    const now = Date.now();

    return {
        id, name, x, y, room, hp, maxHp, mp, maxMp,
        level, xp, xpToLevel, gold, class: cls, color,
        inventory, equipment, facing,
        stats:       getPlayerStats(player),
        attackRange: (CLASSES[cls] ?? CLASSES.warrior).attackRange,
        damageType:  (CLASSES[cls] ?? CLASSES.warrior).damageType,
        downed:      Boolean(player.downed),
        downedUntil: player.downedUntil ?? 0,
        stunnedUntil: player.stunnedUntil ?? 0,
        buffs: {
            atk:     now < (player.buffAtkExpiry ?? 0),
            berserk: now < (player.berserkUntil ?? 0),
            immune:  now < (player.immuneUntil ?? 0),
            bless:   now < (player.blessUntil ?? 0),
        },
    };
}

module.exports = {
    clamp,
    xDistance,
    randInt,
    getPlayerStats,
    calcDamage,
    calcBasicAttack,
    calcSkillDamage,
    calcMonsterDamage,
    xpToNextLevel,
    sanitise,
    publicPlayer,
};
