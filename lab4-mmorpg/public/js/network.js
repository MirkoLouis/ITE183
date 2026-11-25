/**
 * @fileoverview network.js - Socket.IO Client Wrapper for Realms of Etheryn
 * @description Manages all real-time communication between the browser client
 *              and the Node.js/Socket.IO game server.  Exposes a clean API so
 *              game.js never has to touch the raw socket directly.
 *              Event names and payloads mirror server/index.js exactly.
 * @module NetworkManager
 */

'use strict';

/**
 * Every server → client event. Each one is forwarded to handlers
 * registered with `Network.on(name, cb)`.
 *
 * Payload summary (see server/index.js for the source of truth):
 *   game:state        { self, players[], monsters[], room, roomNames, items, quests, questChain, skills, maxLevel }
 *   player:joined     publicPlayer
 *   player:left       { playerId }
 *   player:moved      { id, x, y, facing }
 *   player:emoted     { playerId, emote }
 *   player:levelup    { playerId, name, level, hp, maxHp, mp, maxMp, xpToLevel, stats, gains, isMax }
 *   player:xpGold     { xp, xpToLevel, gold, level, xpGained, goldGained }
 *   player:mpRegen    { mp, maxMp }
 *   player:hp         { playerId, hp, maxHp }
 *   player:healed     { playerId, hp, maxHp, amount, sourceId }   (room broadcast)
 *   player:buffed     { playerId, buff: 'atk'|'berserk'|'immune'|'bless', duration, stats? }
 *   player:skillUsed  { playerId, skillId, skillName, kind, damageType, targetId, targetX,
 *                       chainIds[], radius, delay, duration, cooldown }
 *   player:downed     { playerId, name, until }
 *   player:revived    { playerId, name, hp, maxHp, byId, byName }
 *   player:died       { message }   (downed timer ran out → back in town)
 *   player:inspected  publicPlayer (no inventory / gold)
 *   combat:damage     { attackerId, attackerType?, targetId, targetType, damage, immune?,
 *                       isCrit, damageType, targetHp, targetMaxHp }
 *   monster:died      { monsterId, killerId }
 *   monster:respawned publicMonster
 *   monsters:moved    [{ id, x, facing, aggro }]   (~10 Hz, only changed monsters)
 *   monster:skill     { monsterId, skill: 'horde'|'slam'|'crush_windup'|'crush'|'crush_miss'|'spear', ... }
 *   player:stunned    { playerId, until }
 *   boss:defeated     { name, killers[] }            (server-wide)
 *   chat:system       { message }                    (server-wide system line)
 *   player:equipment  { playerId, equipment }        (gear changed; crown is drawn)
 *   chat:message      { senderId, senderName, message, timestamp }
 *   quest:accepted    { quest, progress }
 *   quest:progress    { questId, progress, count }
 *   quest:completed   { questId, reward, item, completedQuests }
 *   shop:bought       { item, gold, inventory, equipment, stats }
 *   inventory:updated { inventory, equipment, stats }
 *   duel:request      { challengerId, challengerName }
 *   duel:sent         { targetName }
 *   duel:declined     { byName }
 *   duel:started      { player1Id, player1Name, player2Id, player2Name }
 *   duel:ended        { winnerId, winnerName, loserId, loserName, reason }
 *   error:*           { message }
 */
const SERVER_EVENTS = [
    'game:state',
    'player:joined', 'player:left', 'player:moved', 'player:emoted',
    'player:levelup', 'player:xpGold', 'player:mpRegen', 'player:hp',
    'player:healed', 'player:buffed', 'player:skillUsed', 'player:died',
    'player:downed', 'player:revived',
    'player:inspected',
    'combat:damage', 'monster:died', 'monster:respawned', 'monsters:moved',
    'monster:skill', 'player:stunned', 'boss:defeated', 'chat:system', 'player:equipment',
    'chat:message',
    'quest:accepted', 'quest:progress', 'quest:completed',
    'shop:bought', 'inventory:updated',
    'duel:request', 'duel:sent', 'duel:declined', 'duel:started', 'duel:ended',
    'error:room', 'error:combat', 'error:skill', 'error:quest', 'error:shop',
    'error:inventory', 'error:duel', 'error:inspect',
];

/**
 * @class NetworkManager
 * @description Wraps a Socket.IO socket, forwards every server→client event,
 *              and exposes typed helper methods for every client→server action.
 */
class NetworkManager {
    constructor() {
        /** @type {Socket|null} The underlying Socket.IO socket instance */
        this.socket = null;

        /**
         * @type {Map<string, Function[]>}
         * Internal callback registry – game.js registers handlers here via `on()`.
         */
        this._handlers = new Map();

        /** @type {boolean} Whether the socket is currently connected */
        this.connected = false;

        /** @type {string|null} Server build id seen on the first connect */
        this.buildId = null;

        /** @type {number} serverClock − localClock (ms), so timers work across laptops */
        this.clockOffset = 0;

        // Automatically connect as soon as the instance is created.
        this._connect();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // INTERNAL HELPERS
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Establishes the Socket.IO connection and wires up all server→client events.
     * @private
     */
    _connect() {
        // Connect to whatever origin served this page (works in dev AND production).
        this.socket = io(window.location.origin, {
            transports: ['websocket', 'polling'],
            reconnectionAttempts: 10,
            reconnectionDelay: 1500,
        });

        // ── Connection lifecycle ──
        this.socket.on('connect', () => {
            this.connected = true;
            console.log('[Network] Connected – socket id:', this.socket.id);
            this._dispatch('connect', {});
        });

        this.socket.on('disconnect', (reason) => {
            this.connected = false;
            console.warn('[Network] Disconnected:', reason);
            this._dispatch('disconnect', { reason });
        });

        this.socket.on('connect_error', (err) => {
            console.error('[Network] Connection error:', err.message);
            this._dispatch('connect_error', { message: err.message });
        });

        // ── Server build check: reload if the server restarted with new code ──
        this.socket.on('server:hello', ({ buildId, time }) => {
            if (typeof time === 'number') this.clockOffset = time - Date.now();
            if (this.buildId === null) {
                this.buildId = buildId;
            } else if (buildId !== this.buildId) {
                console.warn('[Network] Server was updated – reloading the page.');
                window.location.reload();
            }
        });

        // ── Forward every game event ──
        for (const event of SERVER_EVENTS) {
            this.socket.on(event, (data) => this._dispatch(event, data));
        }
    }

    /**
     * Dispatches an event to all registered local handlers.
     * @private
     * @param {string} event - Event name.
     * @param {*}      data  - Payload forwarded to every handler.
     */
    _dispatch(event, data) {
        const callbacks = this._handlers.get(event);
        if (!callbacks) return;

        // Isolate handler errors so one bad handler can't break the rest
        for (const cb of callbacks) {
            try {
                cb(data);
            } catch (err) {
                console.error(`[Network] Error in handler for "${event}":`, err);
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PUBLIC API – RECEIVING EVENTS
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Register a handler for any server event (or lifecycle event like 'connect').
     * @param {string}   event    - Event name (e.g. 'game:state').
     * @param {Function} callback - Called with the event payload.
     * @returns {NetworkManager} `this` for chaining.
     */
    on(event, callback) {
        if (typeof callback !== 'function') {
            throw new TypeError(`[Network] Handler for "${event}" must be a function.`);
        }
        if (!this._handlers.has(event)) {
            this._handlers.set(event, []);
        }
        this._handlers.get(event).push(callback);
        return this;
    }

    /**
     * Low-level emit wrapper – prefer the typed methods below.
     * Socket.IO buffers emits made before the connection opens.
     * @param {string} event - Socket.IO event name.
     * @param {*}      data  - Payload.
     */
    emit(event, data) {
        if (!this.socket) return;
        this.socket.emit(event, data);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PUBLIC API – SENDING EVENTS (Client → Server)
    // ─────────────────────────────────────────────────────────────────────────

    /** Convert a server timestamp to this machine's clock (0 stays 0). */
    toLocal(serverTs) {
        return serverTs ? serverTs - this.clockOffset : 0;
    }

    /** Join the game with a chosen name, class, and colour. */
    joinGame(name, characterClass, color) {
        this.emit('player:join', { name, characterClass, color });
    }

    /** Report the local player's x position and facing ('left' | 'right'). */
    movePlayer(x, facing) {
        this.emit('player:move', { x, facing });
    }

    /** Send a chat message to the current room. */
    sendChat(message) {
        this.emit('chat:send', { message });
    }

    /** Broadcast an emote ('wave', 'bow', 'dance', 'laugh', 'cry', 'cheer'). */
    sendEmote(emote) {
        this.emit('player:emote', { emote });
    }

    /** Request a room transition (path exit or portal). */
    changeRoom(room) {
        this.emit('room:change', { room });
    }

    /** Basic attack on a monster or duel opponent. */
    attackTarget(targetId, targetType) {
        this.emit('combat:attack', { targetId, targetType });
    }

    /** Activate a skill (targetId may be null for self skills). */
    useSkill(skillId, targetId, targetType) {
        this.emit('player:skill', { skillId, targetId, targetType });
    }

    /** Accept a quest from Seraphel. */
    acceptQuest(questId) {
        this.emit('quest:accept', { questId });
    }

    /** Turn in a completed quest. */
    completeQuest(questId) {
        this.emit('quest:complete', { questId });
    }

    /** Buy an item from a specific shopkeeper NPC. */
    buyItem(itemId, npcId) {
        this.emit('shop:buy', { itemId, npcId });
    }

    /** Use a consumable from the inventory. */
    useItem(itemId) {
        this.emit('inventory:use', { itemId });
    }

    /** Equip a weapon / armor from the inventory. */
    equipItem(itemId) {
        this.emit('inventory:equip', { itemId });
    }

    /** Give up while downed and respawn in town. */
    respawn() {
        this.emit('player:respawn', {});
    }

    /** Fetch another player's profile. */
    inspectPlayer(targetId) {
        this.emit('player:inspect', { targetId });
    }

    /** Challenge another player to a duel. */
    requestDuel(targetId) {
        this.emit('duel:request', { targetId });
    }

    /** Accept an incoming duel challenge. */
    acceptDuel(challengerId) {
        this.emit('duel:accept', { challengerId });
    }

    /** Decline an incoming duel challenge. */
    declineDuel(challengerId) {
        this.emit('duel:decline', { challengerId });
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// SINGLETON EXPORT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Global singleton – import via `window.Network` anywhere in the client.
 * @type {NetworkManager}
 */
window.Network = new NetworkManager();
