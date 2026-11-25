/**
 * gameData.js — Static game data for Realms of Etheryn
 * Exports: ITEMS, MAX_LEVEL, CLASSES, SKILLS, QUESTS, QUEST_CHAIN, ROOMS,
 *          MONSTER_TEMPLATES, MONSTER_SPAWNS
 *
 * Damage model: every hit is either 'physical' or 'magic'.
 *   physical → scales with ATK, reduced by the target's DEF
 *   magic    → scales with MAG, reduced by the target's RES
 */

'use strict';

// ─── Items ─────────────────────────────────────────────────────────────────────
// type      : 'weapon' | 'armor' | 'head' (equipment slots) or 'consumable'
// `shop: false` items are never sold (starter gear, quest rewards).
const ITEMS = {
    // Starter gear (equipped on every new character, see CLASSES.starterGear)
    rusty_sword: {
        id: 'rusty_sword',
        name: 'Rusty Sword',
        type: 'weapon',
        atkBonus: 2,
        price: 0,
        shop: false,
        description: 'Better than bare fists. +2 ATK',
    },
    training_mace: {
        id: 'training_mace',
        name: 'Training Mace',
        type: 'weapon',
        atkBonus: 2,
        price: 0,
        shop: false,
        description: 'Standard issue of the Order. +2 ATK',
    },
    apprentice_wand: {
        id: 'apprentice_wand',
        name: 'Apprentice Wand',
        type: 'weapon',
        magBonus: 2,
        price: 0,
        shop: false,
        description: 'A student\'s first focus. +2 MAG',
    },
    willow_staff: {
        id: 'willow_staff',
        name: 'Willow Staff',
        type: 'weapon',
        magBonus: 2,
        price: 0,
        shop: false,
        description: 'Cut from a temple willow. +2 MAG',
    },
    padded_tunic: {
        id: 'padded_tunic',
        name: 'Padded Tunic',
        type: 'armor',
        defBonus: 1,
        price: 0,
        shop: false,
        description: 'Quilted cloth. +1 DEF',
    },
    cloth_robe: {
        id: 'cloth_robe',
        name: 'Cloth Robe',
        type: 'armor',
        resBonus: 1,
        price: 0,
        shop: false,
        description: 'Simple acolyte robes. +1 RES',
    },

    iron_sword: {
        id: 'iron_sword',
        name: 'Iron Sword',
        type: 'weapon',
        atkBonus: 5,
        price: 30,
        description: 'A sturdy iron sword. +5 ATK',
    },
    steel_sword: {
        id: 'steel_sword',
        name: 'Steel Sword',
        type: 'weapon',
        atkBonus: 10,
        price: 80,
        description: 'Forged from Etheryn steel. +10 ATK',
    },
    oak_staff: {
        id: 'oak_staff',
        name: 'Oak Staff',
        type: 'weapon',
        magBonus: 5,
        price: 30,
        description: 'A staff carved from old oak. +5 MAG',
    },
    arcane_staff: {
        id: 'arcane_staff',
        name: 'Arcane Staff',
        type: 'weapon',
        magBonus: 10,
        price: 80,
        description: 'Humming with stored mana. +10 MAG',
    },
    leather_armor: {
        id: 'leather_armor',
        name: 'Leather Armor',
        type: 'armor',
        defBonus: 5,
        price: 25,
        description: 'Light but protective. +5 DEF',
    },
    chain_mail: {
        id: 'chain_mail',
        name: 'Chain Mail',
        type: 'armor',
        defBonus: 12,
        price: 75,
        description: 'Heavy linked armor. +12 DEF',
    },
    mage_robe: {
        id: 'mage_robe',
        name: 'Mage Robe',
        type: 'armor',
        defBonus: 2,
        resBonus: 8,
        price: 40,
        description: 'Warded cloth that turns spells. +2 DEF, +8 RES',
    },
    health_potion: {
        id: 'health_potion',
        name: 'Health Potion',
        type: 'consumable',
        healAmount: 50,
        price: 15,
        description: 'Restores 50 HP.',
    },
    mana_potion: {
        id: 'mana_potion',
        name: 'Mana Potion',
        type: 'consumable',
        manaAmount: 40,
        price: 12,
        description: 'Restores 40 MP.',
    },
    goblin_crown: {
        id: 'goblin_crown',
        name: "Goblin King's Crown",
        type: 'head',
        defBonus: 8,
        resBonus: 8,
        price: 0,
        shop: false,
        description: 'Taken from the Goblin King himself. +8 DEF, +8 RES',
    },
};

// ─── Levelling ─────────────────────────────────────────────────────────────────
const MAX_LEVEL = 5;

// ─── Character Classes ─────────────────────────────────────────────────────────
// damageType  : type of the class's basic attack
// attackRange : basic attack reach in px
// levelGains  : added on every level-up (HP/MP to the max pools, stats permanently)
// starterGear : item ids equipped on a new character
const CLASSES = {
    warrior: {
        name: 'Warrior',
        maxHp: 120,
        maxMp: 60,
        atk: 8,
        mag: 1,
        def: 5,
        res: 2,
        damageType: 'physical',
        attackRange: 90,
        levelGains: { hp: 12, mp: 4, atk: 2, mag: 0, def: 2, res: 0 },
        starterGear: { weapon: 'rusty_sword', armor: 'padded_tunic' },
        description: 'A stalwart fighter with high HP and defence.',
    },
    mage: {
        name: 'Mage',
        maxHp: 80,
        maxMp: 120,
        atk: 2,
        mag: 15,
        def: 2,
        res: 6,
        damageType: 'magic',
        attackRange: 260,
        levelGains: { hp: 6, mp: 12, atk: 0, mag: 3, def: 0, res: 1 },
        starterGear: { weapon: 'apprentice_wand', armor: 'cloth_robe' },
        description: 'A ranged spellcaster with devastating magic.',
    },
    paladin: {
        name: 'Paladin',
        maxHp: 110,
        maxMp: 100,
        atk: 9,
        mag: 7,
        def: 7,
        res: 5,
        damageType: 'physical',
        attackRange: 90,
        levelGains: { hp: 10, mp: 8, atk: 1, mag: 1, def: 1, res: 1 },
        starterGear: { weapon: 'training_mace', armor: 'padded_tunic' },
        description: 'A holy warrior who can both fight and heal.',
    },
    healer: {
        name: 'Healer',
        maxHp: 85,
        maxMp: 120,
        atk: 2,
        mag: 10,
        def: 3,
        res: 6,
        damageType: 'magic',
        attackRange: 220,
        levelGains: { hp: 7, mp: 12, atk: 0, mag: 2, def: 0, res: 2 },
        starterGear: { weapon: 'willow_staff', armor: 'cloth_robe' },
        description: 'A devoted cleric who keeps the party alive.',
    },
};

// ─── Skills (indexed by class, bound to Q / W / E / R) ─────────────────────────
// targeting : 'enemy' | 'ally' → client opens the target picker
//             'none'           → casts immediately (self / area)
// kind      : how the server resolves the skill
//   damage     single enemy                 (power + ATK/MAG)
//   chain      target + `jumps` enemies within `jumpRadius` of it (70% each)
//   aoe_self   every enemy within `radius` of the caster
//   meteor     after `delay` ms, every enemy within `radius` of the target
//   buff_atk   +amount ATK and MAG to self + allies within `radius` for `duration`
//   berserk    +60% damage and faster attacks for `duration`
//   immunity   immune to all damage for `duration`
//   heal_self  heal self for power + MAG
//   heal_ally  heal one ally for power + MAG
//   heal_area  heal allies within `radius` for power + MAG/2
//   bless_area +amount DEF and RES to allies within `radius` for `duration`
//   revive     raise a downed ally at 50% HP
const SKILLS = {
    warrior: [
        { id: 1, key: 'Q', name: 'Shield Bash', kind: 'damage',   targeting: 'enemy', mpCost: 15, cooldown: 8000 ,  power: 25, damageType: 'physical', range: 100,
          description: 'Bash one enemy for 25 physical damage.' },
        { id: 2, key: 'W', name: 'Cleave',      kind: 'aoe_self', targeting: 'none',  mpCost: 20, cooldown: 10000,  power: 20, damageType: 'physical', radius: 120,
          description: 'Hit every enemy within 120px for 20 physical damage.' },
        { id: 3, key: 'E', name: 'War Cry',     kind: 'buff_atk', targeting: 'none',  mpCost: 20, cooldown: 20000, amount: 5, duration: 10000, radius: 250,
          description: '+5 ATK and MAG to you and allies within 250px for 10s.' },
        { id: 4, key: 'R', name: 'Berserk',     kind: 'berserk',  targeting: 'none',  mpCost: 30, cooldown: 75000, duration: 10000, ultimate: true,
          description: '+60% damage and faster attacks for 10s.' },
    ],
    mage: [
        { id: 1, key: 'Q', name: 'Fireball',        kind: 'damage',   targeting: 'enemy', mpCost: 30, cooldown: 7000 ,  power: 40, damageType: 'magic', range: 320,
          description: '40 magic damage to one enemy.' },
        { id: 2, key: 'W', name: 'Chain Lightning', kind: 'chain',    targeting: 'enemy', mpCost: 30, cooldown: 10000,  power: 30, damageType: 'magic', range: 300, jumps: 2, jumpRadius: 250,
          description: '30 magic damage that jumps to 2 nearby enemies.' },
        { id: 3, key: 'E', name: 'Arcane Surge',    kind: 'buff_atk', targeting: 'none',  mpCost: 30, cooldown: 20000, amount: 5, duration: 10000, radius: 250,
          description: '+5 ATK and MAG to you and allies within 250px for 10s.' },
        { id: 4, key: 'R', name: 'Meteor Strike',   kind: 'meteor',   targeting: 'enemy', mpCost: 50, cooldown: 75000, power: 90, damageType: 'magic', range: 400, radius: 200, delay: 1500, ultimate: true,
          description: '90 magic damage to everything near the target after 1.5s.' },
    ],
    paladin: [
        { id: 1, key: 'Q', name: 'Holy Strike',     kind: 'damage',    targeting: 'enemy', mpCost: 15, cooldown: 7000 ,  power: 22, damageType: 'magic', range: 120,
          description: '22 magic damage to one enemy.' },
        { id: 2, key: 'W', name: 'Consecrate',      kind: 'aoe_self',  targeting: 'none',  mpCost: 25, cooldown: 10000,  power: 18, damageType: 'magic', radius: 150,
          description: '18 magic damage to every enemy within 150px.' },
        { id: 3, key: 'E', name: 'Divine Heal',     kind: 'heal_self', targeting: 'none',  mpCost: 35, cooldown: 15000, power: 60,
          description: 'Heal yourself for 60 + MAG.' },
        { id: 4, key: 'R', name: 'Divine Immunity', kind: 'immunity',  targeting: 'none',  mpCost: 40, cooldown: 75000, duration: 6000, ultimate: true,
          description: 'Immune to all damage and stuns for 6s.' },
    ],
    healer: [
        { id: 1, key: 'Q', name: 'Mend',      kind: 'heal_ally',  targeting: 'ally', mpCost: 25, cooldown: 5000 ,  power: 45, range: 300,
          description: 'Heal one ally for 45 + MAG.' },
        { id: 2, key: 'W', name: 'Sanctuary', kind: 'heal_area',  targeting: 'none', mpCost: 40, cooldown: 14000, power: 25, radius: 250,
          description: 'Heal every ally within 250px.' },
        { id: 3, key: 'E', name: 'Blessing',  kind: 'bless_area', targeting: 'none', mpCost: 35, cooldown: 20000, amount: 4, duration: 12000, radius: 250,
          description: '+4 DEF and RES to nearby allies for 12s.' },
        { id: 4, key: 'R', name: 'Revive',    kind: 'revive',     targeting: 'ally', mpCost: 50, cooldown: 45000, range: 300, ultimate: true,
          description: 'Raise a downed ally at 50% HP.' },
    ],
};

// ─── Quests ────────────────────────────────────────────────────────────────────
// Quests are given in QUEST_CHAIN order; `requires` must be completed first.
const QUESTS = {
    goblin_menace: {
        id: 'goblin_menace',
        name: 'Goblin Trouble',
        description: 'Slay 3 Goblins in Doomwood Forest.',
        giver: 'seraphel',
        requires: null,
        objective: { type: 'kill', target: 'Goblin', count: 3 },
        reward: { xp: 100, gold: 50, item: null },
        dialogue: {
            offer: [
                'Hero! You have arrived just in time.',
                'The Voidstone beneath Doomwood has twisted the goblin tribes. They raid our roads every night.',
                'Pass through the portal east of town and thin their numbers. Slay three Goblins.',
            ],
            progress: ['The goblins still prowl the Doomwood. Return when three have fallen.'],
            complete: ['Well fought! The roads are quieter already. Take this for your trouble.'],
        },
    },
    goblin_king: {
        id: 'goblin_king',
        name: 'Crown of Rot',
        description: 'Defeat the Goblin King in the Deeper Forest.',
        giver: 'seraphel',
        requires: 'goblin_menace',
        objective: { type: 'kill', target: 'Goblin King', count: 1 },
        reward: { xp: 250, gold: 120, item: 'goblin_crown' },
        dialogue: {
            offer: [
                'The goblins answer to a king, bloated on Voidstone power, deep within the forest.',
                'His hide turns steel. Bring a spellcaster if you can, and bring friends.',
                'Follow the path east through Doomwood into the Deeper Forest and end him.',
            ],
            progress: ['The Goblin King still lives. Steel struggles against him; magic bites deeper.'],
            complete: [
                'You did it! Without their king, the tribes will scatter.',
                'Wear his crown with pride, champion of Etheryn. Sephiron will hear of this.',
            ],
        },
    },
};

const QUEST_CHAIN = ['goblin_menace', 'goblin_king'];

// ─── Rooms ─────────────────────────────────────────────────────────────────────
// tagline : subtitle on the map announcement title
// exits   : walking off the left/right edge leads to that room (a path).
// portals : clicking one teleports to `to`.
// npcs    : `shop` = item type sold, `quest` = gives quests.
const ROOMS = {
    'market': {
        id: 'market',
        name: 'Etheryn Market',
        tagline: 'Where coin buys courage',
        theme: 'market',
        width: 1600,
        groundY: 500,
        spawnPoint: { x: 1450 },
        isSafe: true,
        exits: { left: null, right: 'etheryn-town' },
        portals: [],
        npcs: [
            {
                id: 'brom', name: 'Brom', title: 'Weaponsmith', x: 350, shop: 'weapon',
                dialogue: ['Swords for the strong, staves for the clever. What will it be?'],
            },
            {
                id: 'hilda', name: 'Hilda', title: 'Armorer', x: 800, shop: 'armor',
                dialogue: ['Good armor is the difference between a hero and a corpse.'],
            },
            {
                id: 'pip', name: 'Pip', title: 'Alchemist', x: 1200, shop: 'consumable',
                dialogue: ['Fresh potions! Only slightly explosive!'],
            },
        ],
    },
    'etheryn-town': {
        id: 'etheryn-town',
        name: 'Etheryn Town',
        tagline: 'The last free town of the realm',
        theme: 'town',
        width: 1600,
        groundY: 500,
        spawnPoint: { x: 700 },
        isSafe: true,
        exits: { left: 'market', right: null },
        portals: [
            { id: 'portal-doomwood', x: 1480, to: 'doomwood-forest', label: 'Doomwood' },
        ],
        npcs: [
            {
                id: 'seraphel', name: 'Seraphel', title: 'Captain of the Watch', x: 520, quest: true,
                dialogue: ['Etheryn still stands, thanks to heroes like you.'],
            },
        ],
    },
    'doomwood-forest': {
        id: 'doomwood-forest',
        name: 'Doomwood Forest',
        tagline: 'Goblin territory',
        theme: 'forest',
        width: 1600,
        groundY: 500,
        spawnPoint: { x: 200 },
        isSafe: false,
        exits: { left: null, right: 'deeper-forest' },
        portals: [
            { id: 'portal-town', x: 110, to: 'etheryn-town', label: 'Etheryn' },
        ],
        npcs: [],
    },
    'deeper-forest': {
        id: 'deeper-forest',
        name: 'Deeper Forest',
        tagline: 'Lair of the Goblin King',
        theme: 'deep',
        width: 1600,
        groundY: 500,
        spawnPoint: { x: 120 },
        isSafe: false,
        exits: { left: 'doomwood-forest', right: null },
        portals: [],
        npcs: [],
    },
};

// ─── Monster Templates ─────────────────────────────────────────────────────────
// width/height are the clickable sprite box in px (feet at x, y).
// aggroRadius : players closer than this get chased
// speed       : chase / return speed in px/s
// leash       : max distance from spawn before giving up the chase
const MONSTER_TEMPLATES = {
    Goblin: {
        name: 'Goblin',
        sprite: 'goblin',
        maxHp: 70,
        xp: 20,
        gold: 8,
        damage: { min: 4, max: 8 },
        damageType: 'physical',
        def: 2,
        res: 2,
        attackRange: 110,
        attackCooldown: 2000,
        respawnTime: 8000,
        aggroRadius: 180,
        speed: 110,
        leash: 600,
        width: 44,
        height: 62,
    },
    'Goblin King': {
        name: 'Goblin King',
        sprite: 'goblin_king',
        boss: true,
        maxHp: 1400,
        xp: 150,
        gold: 80,
        damage: { min: 18, max: 28 },
        damageType: 'physical',
        def: 14,
        res: 3,
        attackRange: 170,
        attackCooldown: 2500,
        respawnTime: 60000,
        aggroRadius: 250,
        speed: 70,
        leash: 600,
        width: 90,
        height: 130,
        // Boss skills (used only while aggroed; one per AI tick, in this priority)
        skills: {
            horde: { name: 'Call the Horde', cooldown: 45000, hpThreshold: 0.6, count: 5, summon: 'Goblin' },
            slam:  { name: 'Ground Slam',    cooldown: 15000, radius: 180, damage: { min: 10, max: 16 }, stun: 2000 },
            crush: { name: 'Crushing Blow',  cooldown: 12000, windup: 800, mult: 2.5 },
            spear: { name: 'Spear Toss',     cooldown: 7000,  range: 600, damage: { min: 14, max: 22 } },
        },
    },
};

// Where Call the Horde drops its goblins, per room
const SUMMON_POINTS = {
    'deeper-forest': [200, 450, 700, 1350, 1520],
};

// Spawn positions per room (y is always the room's groundY)
const MONSTER_SPAWNS = {
    'doomwood-forest': [
        { template: 'Goblin', x: 480 },
        { template: 'Goblin', x: 700 },
        { template: 'Goblin', x: 920 },
        { template: 'Goblin', x: 1140 },
        { template: 'Goblin', x: 1360 },
    ],
    'deeper-forest': [
        { template: 'Goblin King', x: 1100 },
    ],
};

module.exports = {
    ITEMS,
    MAX_LEVEL,
    CLASSES,
    SKILLS,
    QUESTS,
    QUEST_CHAIN,
    ROOMS,
    MONSTER_TEMPLATES,
    MONSTER_SPAWNS,
    SUMMON_POINTS,
};
