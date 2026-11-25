/**
 * Game — Realms of Etheryn
 * Main game orchestrator. Glues Network, Renderer, UI and Audio together.
 * Owns the game loop, click-to-move / auto-attack, interaction handling,
 * and every server event handler.
 *
 * Movement is horizontal only. The local player is moved client-side and its
 * x position is reported to the server ~20×/s; everything else (combat,
 * rewards, quests, shops, room changes) is decided by the server.
 */
class GameController {
    constructor() {
        this.state = {
            selfId:          null,
            room:            null,      // room definition from the server
            roomNames:       {},        // roomId → display name
            players:         {},        // id → player (includes self)
            monsters:        {},        // id → monster
            items:           {},
            quests:          {},
            questChain:      [],
            skills:          [],
            skillCooldowns:  {},        // skillId → expiry timestamp
            maxLevel:        5,
            autoBattle:      true,      // fight back + auto skill rotation
            quest:           null,      // { id, progress }
            completedQuests: [],
            inventory:       [],
            equipment:       { weapon: null, armor: null },
            action:          null,      // current click intent (see _updateAction)
            duelOpponentId:  null,
            duelIds:         [],        // both duelists' ids, for the ⚔ marker
            hoverId:         null,
        };

        // Movement / interaction tuning (px, ms)
        this.WALK_SPEED     = 240;
        this.NPC_REACH      = 60;
        this.PORTAL_REACH   = 30;
        this.PLAYER_REACH   = 70;
        this.AUTO_ATTACK_MS = 1000;
        this.BERSERK_ATTACK_MS = 600;
        this.SEND_INTERVAL  = 50;
        this.EXIT_MARGIN    = 5;
        this.AUTO_CAST_GAP  = 700;      // ms between auto-battle skill casts
        this.AUTO_HEAL_PCT  = 0.7;      // heals only fire below this HP fraction

        // Auto-battle runtime
        this._autoNextCast = 0;

        // Input
        this._keys = new Set();

        // Networking throttle
        this._lastSendTime = 0;
        this._lastSent     = { x: null, facing: null };

        // Misc runtime
        this._lastAttack        = 0;
        this._roomChangePending = false;
        this._snapCamera        = true;
        this._lastTime          = null;
        this._lastError         = { text: '', at: 0 };
        this._started           = false;
    }

    // ─────────────────────────────────────────────
    //  INIT — called after character creation submit
    // ─────────────────────────────────────────────
    init() {
        if (this._started) return;
        this._started = true;

        // UI gets read access to state plus inventory actions
        UI.init(() => this.state, {
            useItem:   id => Network.useItem(id),
            equipItem: id => Network.equipItem(id),
        });

        // Input + layout
        this._bindKeyboard();
        this._bindMouse();
        this._bindHud();
        window.addEventListener('resize', () => this._layoutCanvas());
        this._layoutCanvas();

        // Server events
        this._registerNetworkHandlers();
        UI.setConnection(Network.connected);

        // Join with the character from the creation screen
        const cfg = window.playerConfig;
        if (!cfg) { console.error('No playerConfig found!'); return; }
        Audio.init();
        Network.joinGame(cfg.name, cfg.characterClass, cfg.color);

        // Start the loop
        this._lastTime = performance.now();
        requestAnimationFrame(ts => this._loop(ts));
    }

    /** Size the canvas to its wrapper (everything below the top bar, left of the side panel). */
    _layoutCanvas() {
        const wrap   = document.getElementById('canvas-wrap');
        const canvas = document.getElementById('game-canvas');
        const w = wrap.clientWidth;
        const h = wrap.clientHeight;

        // Match CSS size to pixel size so clicks map 1:1
        canvas.style.width  = `${w}px`;
        canvas.style.height = `${h}px`;
        Renderer.resize(w, h);
        this._snapCamera = true;
    }

    // ─────────────────────────────────────────────
    //  INPUT BINDING
    // ─────────────────────────────────────────────
    _isTyping() {
        const el = document.activeElement;
        return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA');
    }

    _bindKeyboard() {
        const chatInput = document.getElementById('chat-input');

        window.addEventListener('keydown', e => {
            // Enter focuses chat (sending is handled on the input itself)
            if (e.key === 'Enter' && !this._isTyping()) {
                e.preventDefault();
                chatInput.focus();
                return;
            }

            // Escape: leave chat, or close menus and cancel the current action
            if (e.key === 'Escape') {
                if (this._isTyping()) { document.activeElement.blur(); return; }
                UI.closeAll();
                this.state.action = null;
                return;
            }

            if (this._isTyping() || e.ctrlKey || e.metaKey) return;

            // Movement keys are tracked as held
            const key = e.key.toLowerCase();
            if (['arrowleft', 'arrowright', 'a', 'd'].includes(key)) {
                this._keys.add(key);
                e.preventDefault();
                return;
            }
            if (e.repeat) return;

            // Number keys pick from an open target picker
            if (/^[1-9]$/.test(key) && UI.isPickerOpen()) {
                UI.pickTarget(Number(key) - 1);
                return;
            }

            // One-shot hotkeys: Q W E R skills, F / G potions, J K L panels
            switch (key) {
                case 'q': this.useSkill(0); break;
                case 'w': this.useSkill(1); break;
                case 'e': this.useSkill(2); break;
                case 'r': this.useSkill(3); break;
                case 'f': this.usePotion('health_potion'); break;
                case 'g': this.usePotion('mana_potion');   break;
                case 'j': UI.togglePanel('inventory'); break;
                case 'k': UI.togglePanel('quests');    break;
                case 'l': UI.togglePanel('stats');     break;
                case 't': this.toggleAutoBattle();     break;
            }
        });

        window.addEventListener('keyup', e => this._keys.delete(e.key.toLowerCase()));
        window.addEventListener('blur', () => this._keys.clear());   // avoid stuck keys

        // Chat log only takes the mouse while chat is focused
        const chatBox = document.getElementById('chat-box');
        chatInput.addEventListener('focus', () => chatBox.classList.add('active'));
        chatInput.addEventListener('blur',  () => chatBox.classList.remove('active'));

        // Chat input: Enter sends
        chatInput.addEventListener('keydown', e => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            e.stopPropagation();
            this._sendChatMessage(chatInput);
        });
    }

    _bindMouse() {
        const canvas = document.getElementById('game-canvas');

        // Left click: interact / move
        canvas.addEventListener('click', e => {
            UI.hidePlayerMenu();
            const world = this._eventToWorld(e, canvas);
            this._handleWorldClick(world, e);
        });

        // Hover highlight + pointer cursor
        canvas.addEventListener('mousemove', e => {
            const hit = this._hitTest(this._eventToWorld(e, canvas));
            this.state.hoverId  = hit ? hit.id : null;
            canvas.style.cursor = hit ? 'pointer' : 'crosshair';
        });
        canvas.addEventListener('mouseleave', () => { this.state.hoverId = null; });
        canvas.addEventListener('contextmenu', e => e.preventDefault());
    }

    _bindHud() {
        // Skill bar slots are clickable too
        document.getElementById('slot-attack').addEventListener('click', () => this.toggleAutoBattle());
        UI.setAutoBattle(this.state.autoBattle);
        ['q', 'w', 'e', 'r'].forEach((k, i) =>
            document.getElementById(`slot-${k}`).addEventListener('click', () => this.useSkill(i)));
        document.getElementById('slot-f').addEventListener('click', () => this.usePotion('health_potion'));
        document.getElementById('slot-g').addEventListener('click', () => this.usePotion('mana_potion'));
        document.getElementById('chat-send').addEventListener('click', () =>
            this._sendChatMessage(document.getElementById('chat-input')));
    }

    _eventToWorld(e, canvas) {
        const rect = canvas.getBoundingClientRect();
        return Renderer.screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
    }

    // ─────────────────────────────────────────────
    //  CLICK HANDLING
    // ─────────────────────────────────────────────
    /**
     * Find the clickable entity under a world point. When several overlap,
     * the one whose centre is closest horizontally wins.
     * @returns {{kind:'monster'|'player'|'npc'|'portal', id:string, entity:object}|null}
     */
    _hitTest({ x, y }) {
        const { room, players, monsters, selfId } = this.state;
        if (!room) return null;
        const g = room.groundY;
        const hits = [];
        const inBox = (cx, halfW, top) => Math.abs(x - cx) <= halfW && y >= g - top && y <= g + 8;

        // Collect every candidate
        Object.values(monsters).forEach(m => {
            if (!m.isDead && m.hp > 0 && inBox(m.x, m.width / 2 + 6, m.height + 25)) hits.push({ kind: 'monster', id: m.id, entity: m });
        });
        Object.values(players).forEach(p => {
            if (p.id !== selfId && inBox(p.x, 22, 115)) hits.push({ kind: 'player', id: p.id, entity: p });
        });
        (room.npcs || []).forEach(n => {
            if (inBox(n.x, 28, 115)) hits.push({ kind: 'npc', id: n.id, entity: n });
        });
        (room.portals || []).forEach(p => {
            if (inBox(p.x, 40, 125)) hits.push({ kind: 'portal', id: p.id, entity: p });
        });

        hits.sort((a, b) => Math.abs(a.entity.x - x) - Math.abs(b.entity.x - x));
        return hits[0] || null;
    }

    _handleWorldClick(world, e) {
        if (!this.state.room || this._roomChangePending || this._self()?.downed) return;
        UI.hideTargetPicker();
        const hit = this._hitTest(world);

        // Empty ground: walk there (clamped so walls without a path are reachable)
        if (!hit) {
            const room = this.state.room;
            const minX = room.exits?.left  ? 0 : 20;
            const maxX = room.exits?.right ? room.width : room.width - 20;
            this.state.action = { type: 'move', x: Math.max(minX, Math.min(maxX, world.x)) };
            return;
        }

        switch (hit.kind) {
            case 'monster':
                this.state.action = { type: 'attack', id: hit.id, targetType: 'monster' };
                break;
            case 'npc':
                this.state.action = { type: 'npc', id: hit.id };
                break;
            case 'portal':
                this.state.action = { type: 'portal', id: hit.id };
                break;
            case 'player':
                // Clicking your duel opponent attacks them; anyone else opens the menu
                if (hit.id === this.state.duelOpponentId) {
                    this.state.action = { type: 'attack', id: hit.id, targetType: 'player' };
                } else {
                    UI.showPlayerMenu(e.clientX, e.clientY, hit.entity, {
                        onDuel:    () => { this.state.action = { type: 'player', id: hit.id }; },
                        onInspect: () => Network.inspectPlayer(hit.id),
                    });
                }
                break;
        }
    }

    // ─────────────────────────────────────────────
    //  GAME LOOP
    // ─────────────────────────────────────────────
    _loop(timestamp) {
        const dt = Math.min((timestamp - this._lastTime) / 1000, 0.05); // cap at 50ms
        this._lastTime = timestamp;

        this._update(dt);

        // Camera + HUD
        const self = this.state.players[this.state.selfId];
        if (self && this.state.room) {
            Renderer.updateCamera(self.x, this.state.room, this._snapCamera);
            this._snapCamera = false;
            UI.updateHud(self, this.state.room.name, this.state.maxLevel, this.state.inventory);
            UI.tickSkillCooldowns(this.state.skills, this.state.skillCooldowns);
            UI.updateMinimap(this.state);
        }

        // Draw
        Renderer.render({
            selfId:     this.state.selfId,
            room:       this.state.room,
            roomNames:  this.state.roomNames,
            players:    this.state.players,
            monsters:   this.state.monsters,
            targetId:   this.state.action?.type === 'attack' ? this.state.action.id : null,
            hoverId:    this.state.hoverId,
            npcMarkers: this._npcMarkers(),
            duelIds:    this.state.duelIds,
        });

        requestAnimationFrame(ts => this._loop(ts));
    }

    _update(dt) {
        const self = this.state.players[this.state.selfId];
        const room = this.state.room;

        // Smooth interpolation for other players and chasing monsters
        // (runs even while we wait on a room change)
        const lerp = Math.min(1, dt * 12);
        Object.values(this.state.players).forEach(p => {
            if (p.id === this.state.selfId || p._tx === undefined) return;
            p.x += (p._tx - p.x) * lerp;
        });
        Object.values(this.state.monsters).forEach(m => {
            if (m._tx !== undefined) m.x += (m._tx - m.x) * lerp;
        });

        if (!self || !room || this._roomChangePending) return;

        // Downed players can't move or act
        if (self.downed) { this.state.action = null; return; }

        // Stunned players and duelists in the countdown freeze in place
        if (this._isStunned(self) || this._inDuelCountdown(self)) return;

        // ── Keyboard movement overrides any click action ──
        let dx = 0;
        if (this._keys.has('arrowleft')  || this._keys.has('a')) dx -= 1;
        if (this._keys.has('arrowright') || this._keys.has('d')) dx += 1;
        if (dx !== 0) {
            this.state.action = null;
            self.facing = dx < 0 ? 'left' : 'right';
            self.x += dx * this.WALK_SPEED * dt;
        } else if (this.state.action) {
            this._updateAction(self, dt);
        }

        // ── Auto-battle skill rotation while fighting ──
        if (this.state.autoBattle && this.state.action?.type === 'attack') this._autoCast(self);

        // ── Clamp to the room (edges with a path stay open) ──
        const minX = room.exits?.left  ? 0 : 20;
        const maxX = room.exits?.right ? room.width : room.width - 20;
        self.x = Math.max(minX, Math.min(maxX, self.x));

        // ── Path exits (5px margin so float rounding can't strand you at the edge) ──
        if (self.x <= this.EXIT_MARGIN && room.exits?.left) {
            this._changeRoom(room.exits.left);
            return;
        }
        if (self.x >= room.width - this.EXIT_MARGIN && room.exits?.right) {
            this._changeRoom(room.exits.right);
            return;
        }

        // ── Report position (throttled, only when changed) ──
        const now = Date.now();
        if (now - this._lastSendTime >= this.SEND_INTERVAL) {
            this._sendPosition(self);
            this._lastSendTime = now;
        }
    }

    _sendPosition(self) {
        const x = Math.round(self.x);
        if (x === this._lastSent.x && self.facing === this._lastSent.facing) return;
        Network.movePlayer(x, self.facing);
        this._lastSent = { x, facing: self.facing };
    }

    /**
     * Walk `self` toward goalX until within `reach`. Returns true on arrival.
     */
    _walkToward(self, goalX, reach, dt) {
        const diff = goalX - self.x;
        if (Math.abs(diff) <= reach) return true;
        const step = Math.min(this.WALK_SPEED * dt, Math.abs(diff) - reach);
        self.x     += Math.sign(diff) * step;
        self.facing = diff < 0 ? 'left' : 'right';
        return Math.abs(goalX - self.x) <= reach + 0.5;
    }

    /**
     * Progress the current click action:
     *   move   → walk to x
     *   npc    → walk to NPC, then talk / shop
     *   portal → walk to portal, then teleport
     *   player → walk to player, then send a duel request
     *   attack → walk into range, then auto-attack every AUTO_ATTACK_MS
     */
    _updateAction(self, dt) {
        const a = this.state.action;
        const room = this.state.room;

        switch (a.type) {
            case 'move': {
                if (this._walkToward(self, a.x, 2, dt)) this.state.action = null;
                break;
            }
            case 'npc': {
                const npc = room.npcs.find(n => n.id === a.id);
                if (!npc) { this.state.action = null; break; }
                if (this._walkToward(self, npc.x, this.NPC_REACH, dt)) {
                    this.state.action = null;
                    this._interactNPC(npc);
                }
                break;
            }
            case 'portal': {
                const portal = room.portals.find(p => p.id === a.id);
                if (!portal) { this.state.action = null; break; }
                if (this._walkToward(self, portal.x, this.PORTAL_REACH, dt)) {
                    this.state.action = null;
                    Audio.playPortal();
                    this._changeRoom(portal.to);
                }
                break;
            }
            case 'player': {
                const target = this.state.players[a.id];
                if (!target) { this.state.action = null; break; }
                if (this._walkToward(self, target.x, this.PLAYER_REACH, dt)) {
                    this.state.action = null;
                    Network.requestDuel(a.id);
                }
                break;
            }
            case 'attack': {
                const target = a.targetType === 'monster' ? this.state.monsters[a.id] : this.state.players[a.id];
                const alive  = target && !target.isDead && target.hp > 0;
                const valid  = a.targetType === 'monster' || a.id === this.state.duelOpponentId;
                if (!alive || !valid) { this.state.action = null; break; }

                // Close in, then swing on a timer
                const reach = (self.attackRange || 90) - 15 + (a.targetType === 'monster' ? target.width / 2 : 0);
                if (this._walkToward(self, target.x, reach, dt)) {
                    self.facing = target.x < self.x ? 'left' : 'right';
                    const now = Date.now();
                    const interval = self.buffs?.berserk ? this.BERSERK_ATTACK_MS : this.AUTO_ATTACK_MS;
                    if (now - this._lastAttack >= interval) {
                        this._lastAttack = now;
                        this._sendPosition(self);       // make sure the server has our latest x
                        Network.attackTarget(a.id, a.targetType);
                    }
                }
                break;
            }
            case 'cast': {
                // Walk into skill range, then cast; damage casts resume auto-attack
                const target = a.targetType === 'monster' ? this.state.monsters[a.id] : this.state.players[a.id];
                if (!target || target.isDead) { this.state.action = null; break; }
                const reach = Math.max(10, a.skill.range - 20) + (a.targetType === 'monster' ? target.width / 2 : 0);
                if (this._walkToward(self, target.x, reach, dt)) {
                    this._sendPosition(self);
                    Network.useSkill(a.skill.id, a.id, a.targetType);
                    this.state.action = a.skill.targeting === 'enemy'
                        ? { type: 'attack', id: a.id, targetType: a.targetType }
                        : null;
                }
                break;
            }
            default:
                this.state.action = null;
        }
    }

    _changeRoom(roomId) {
        const self = this.state.players[this.state.selfId];
        if (!self || this._roomChangePending) return;
        this._roomChangePending = true;

        // Flush our position first so the server's edge / portal check passes
        Network.movePlayer(Math.round(self.x), self.facing);
        Network.changeRoom(roomId);

        // Unfreeze if the server refuses (error:room)
        clearTimeout(this._roomChangeTimer);
        this._roomChangeTimer = setTimeout(() => { this._roomChangePending = false; }, 2000);
    }

    // ─────────────────────────────────────────────
    //  NPC INTERACTION
    // ─────────────────────────────────────────────
    /** Next quest Seraphel can offer, or null. */
    _nextQuestId() {
        const { questChain, quests, completedQuests } = this.state;
        return questChain.find(id =>
            !completedQuests.includes(id) &&
            (!quests[id].requires || completedQuests.includes(quests[id].requires))) || null;
    }

    /** '!' = quest available, '?' = ready to turn in. */
    _npcMarkers() {
        const markers = {};
        const room = this.state.room;
        if (!room) return markers;

        (room.npcs || []).forEach(n => {
            if (!n.quest) return;
            const q = this.state.quest;
            if (q) {
                const def = this.state.quests[q.id];
                if (def && q.progress >= def.objective.count) markers[n.id] = '?';
            } else if (this._nextQuestId()) {
                markers[n.id] = '!';
            }
        });
        return markers;
    }

    _interactNPC(npc) {
        const self = this.state.players[this.state.selfId];

        // Shopkeepers open their filtered shop
        if (npc.shop) {
            const items = Object.values(this.state.items).filter(i => i.type === npc.shop && i.shop !== false);
            UI.showShop({ npc, items, gold: self.gold, onBuy: id => Network.buyItem(id, npc.id) });
            return;
        }

        // Quest giver
        if (npc.quest) {
            this._openQuestDialog(npc);
            return;
        }

        // Anyone else just talks
        UI.showNPCDialog({ name: npc.name, title: npc.title, lines: npc.dialogue || ['...'] });
    }

    /** "100 XP · 50 Gold · Goblin King's Crown" */
    _rewardText(def) {
        const r = def.reward;
        const item = r.item && this.state.items[r.item] ? ` · ${this.state.items[r.item].name}` : '';
        return `${r.xp} XP · ${r.gold} Gold${item}`;
    }

    _openQuestDialog(npc) {
        const active = this.state.quest;

        // Active quest: progress or turn-in
        if (active) {
            const def  = this.state.quests[active.id];
            const done = active.progress >= def.objective.count;
            UI.showNPCDialog({
                name: npc.name, title: def.name,
                lines: done ? def.dialogue.complete : def.dialogue.progress,
                details: [
                    ['Progress', `${active.progress} / ${def.objective.count} ${def.objective.target} slain`],
                    ['Reward', this._rewardText(def)],
                ],
                buttons: done ? [{ label: '🏆 Turn In', onClick: () => Network.completeQuest(active.id) }] : [],
            });
            return;
        }

        // Offer the next quest in the chain
        const nextId = this._nextQuestId();
        if (nextId) {
            const def = this.state.quests[nextId];
            UI.showNPCDialog({
                name: npc.name, title: def.name,
                lines: def.dialogue.offer,
                details: [
                    ['Objective', def.description],
                    ['Reward', this._rewardText(def)],
                ],
                buttons: [{ label: '📜 Accept Quest', onClick: () => Network.acceptQuest(nextId) }],
            });
            return;
        }

        // Chain finished
        UI.showNPCDialog({
            name: npc.name, title: npc.title,
            lines: [
                'You have done all Etheryn could ask of you, champion.',
                "Sephiron's shadow still lingers over the realm... but that is a tale for another day.",
            ],
        });
    }

    // ─────────────────────────────────────────────
    //  COMBAT
    // ─────────────────────────────────────────────
    /** Living monster nearest to self within `range` (+ its half width). */
    _nearestMonster(range = Infinity) {
        const self = this.state.players[this.state.selfId];
        if (!self) return null;
        let best = null, bestD = Infinity;
        Object.values(this.state.monsters).forEach(m => {
            if (m.isDead || m.hp <= 0) return;
            const d = Math.abs(m.x - self.x) - m.width / 2;
            if (d < bestD && d <= range) { bestD = d; best = m; }
        });
        return best;
    }

    // ─────────────────────────────────────────────
    //  AUTO-BATTLE
    // ─────────────────────────────────────────────
    /** Attack slot / T: flip auto-battle on or off. */
    toggleAutoBattle() {
        this.state.autoBattle = !this.state.autoBattle;
        UI.setAutoBattle(this.state.autoBattle);
        UI.showToast(`Auto-battle ${this.state.autoBattle ? 'ON' : 'OFF'}`, this.state.autoBattle ? 'success' : '', 1200);
    }

    /** True during the 3-2-1 before a duel. */
    _inDuelCountdown(p) {
        return Date.now() < (p?.duelStartsAt || 0);
    }

    /**
     * Something hit us: if auto-battle is on and we're idle, fight back.
     * Only monsters and our duel opponent can hit us.
     */
    _retaliate(attackerId) {
        const S = this.state;
        const self = this._self();
        if (!S.autoBattle || S.action || !self || self.downed) return;
        if (S.monsters[attackerId] && !S.monsters[attackerId].isDead) {
            S.action = { type: 'attack', id: attackerId, targetType: 'monster' };
        } else if (attackerId === S.duelOpponentId && S.players[attackerId]) {
            S.action = { type: 'attack', id: attackerId, targetType: 'player' };
        }
    }

    /** Allies auto-heals may target: active players not dueling someone else. */
    _healableAllies(self, range) {
        const S = this.state;
        return Object.values(S.players).filter(p =>
            !p.downed && Math.abs(p.x - self.x) <= range &&
            (p.id === S.selfId || !S.duelIds.includes(p.id) || p.id === S.duelOpponentId));
    }

    /**
     * Pick and cast one skill for the current fight, in priority order:
     *   1. buffs (War Cry, Arcane Surge, Blessing) not already active
     *   2. the ultimate (Revive only when an ally is downed)
     *   3. everything else (damage / AoE on the target, heals below 70% HP)
     * Basic attacks keep going between casts.
     */
    _autoCast(self) {
        const S   = this.state;
        const now = Date.now();
        if (now < this._autoNextCast || this._isStunned(self) || this._inDuelCountdown(self)) return;

        const a      = S.action;
        const target = a.targetType === 'monster' ? S.monsters[a.id] : S.players[a.id];
        if (!target || target.isDead || target.hp <= 0) return;
        const dist   = Math.abs(target.x - self.x) - (a.targetType === 'monster' ? target.width / 2 : 0);
        const buffs  = self.buffs || {};

        // Priority buckets
        const isBuff = k => k.kind === 'buff_atk' || k.kind === 'bless_area';
        const order  = [
            ...S.skills.filter(isBuff),
            ...S.skills.filter(k => k.ultimate && !isBuff(k)),
            ...S.skills.filter(k => !k.ultimate && !isBuff(k)),
        ];

        for (const skill of order) {
            if (now < (S.skillCooldowns[skill.id] || 0) || self.mp < skill.mpCost) continue;

            // Is this skill useful right now, and on whom?
            let targetId = null, targetType = null, useful = false;
            switch (skill.kind) {
                case 'buff_atk':   useful = !buffs.atk;     break;
                case 'bless_area': useful = !buffs.bless;   break;
                case 'berserk':    useful = !buffs.berserk; break;
                case 'immunity':   useful = !buffs.immune;  break;
                case 'damage':
                case 'chain':
                case 'meteor':
                    useful = dist <= skill.range;
                    targetId = a.id; targetType = a.targetType;
                    break;
                case 'aoe_self':
                    useful = dist <= skill.radius;
                    break;
                case 'heal_self':
                    useful = self.hp < self.maxHp * this.AUTO_HEAL_PCT;
                    break;
                case 'heal_area':
                    useful = this._healableAllies(self, skill.radius).some(p => p.hp < p.maxHp * this.AUTO_HEAL_PCT);
                    break;
                case 'heal_ally': {
                    const hurt = this._healableAllies(self, skill.range)
                        .filter(p => p.hp < p.maxHp * this.AUTO_HEAL_PCT)
                        .sort((x, y) => x.hp / x.maxHp - y.hp / y.maxHp)[0];
                    if (hurt) { useful = true; targetId = hurt.id; targetType = 'player'; }
                    break;
                }
                case 'revive': {
                    const fallen = Object.values(S.players).find(p => p.downed && Math.abs(p.x - self.x) <= skill.range);
                    if (fallen) { useful = true; targetId = fallen.id; targetType = 'player'; }
                    break;
                }
            }
            if (!useful) continue;

            // Cast it (server re-validates range, MP and cooldown)
            this._sendPosition(self);
            Network.useSkill(skill.id, targetId, targetType);
            this._autoNextCast = now + this.AUTO_CAST_GAP;
            return;
        }
    }

    /** True while the Goblin King's Ground Slam stun is running. */
    _isStunned(p) {
        return Date.now() < (p?.stunnedUntil || 0);
    }

    useSkill(index) {
        const skill = this.state.skills[index];
        const self  = this._self();
        if (!skill || !self || self.downed) return;
        if (this._isStunned(self)) { UI.showToast('You are stunned!', 'error', 1000); return; }
        if (this._inDuelCountdown(self)) { UI.showToast('Wait for the countdown!', 'error', 1000); return; }

        // Local cooldown / MP pre-checks (server re-validates)
        if (Date.now() < (this.state.skillCooldowns[skill.id] || 0)) {
            UI.showToast(`${skill.name} is on cooldown.`, 'error', 1200);
            return;
        }
        if (self.mp < skill.mpCost) {
            UI.showToast('Not enough MP.', 'error', 1200);
            return;
        }

        // Self / area skills cast immediately
        if (skill.targeting === 'none') {
            Network.useSkill(skill.id, null, null);
            return;
        }

        // Targeted skills open the picker
        this._openTargetPicker(skill);
    }

    /** Build the ally / enemy list for a targeted skill and show the picker. */
    _openTargetPicker(skill) {
        const S    = this.state;
        const self = this._self();
        const dist = e => `${Math.round(Math.abs(e.x - self.x))}px`;
        let entries = [];

        if (skill.targeting === 'enemy') {
            // Living monsters, current target first, then nearest
            const current = S.action?.type === 'attack' ? S.action.id : null;
            entries = Object.values(S.monsters)
                .filter(m => !m.isDead && m.hp > 0)
                .sort((a, b) => (b.id === current) - (a.id === current) || Math.abs(a.x - self.x) - Math.abs(b.x - self.x))
                .map(m => ({ id: m.id, targetType: 'monster', label: m.name, sub: dist(m), hpPct: m.hp / m.maxHp }));

            // Duel opponent
            const opp = S.players[S.duelOpponentId];
            if (opp && !opp.downed) {
                entries.unshift({ id: opp.id, targetType: 'player', label: `⚔ ${opp.name}`, sub: dist(opp), hpPct: opp.hp / opp.maxHp });
            }
        } else {
            // Allies: Revive lists only the downed, heals list everyone else (self first)
            const wantDowned = skill.kind === 'revive';
            entries = Object.values(S.players)
                .filter(p => Boolean(p.downed) === wantDowned)
                .filter(p => p.id === S.selfId || !S.duelIds.includes(p.id) || p.id === S.duelOpponentId)
                .sort((a, b) => (b.id === S.selfId) - (a.id === S.selfId) || Math.abs(a.x - self.x) - Math.abs(b.x - self.x))
                .map(p => ({
                    id: p.id, targetType: 'player',
                    label: p.id === S.selfId ? `${p.name} (you)` : p.name,
                    sub: p.downed ? `downed · ${dist(p)}` : `${p.hp}/${p.maxHp} · ${dist(p)}`,
                    hpPct: p.hp / p.maxHp,
                }));
        }

        // Nothing to pick
        if (entries.length === 0) {
            const msg = skill.targeting === 'enemy' ? 'No enemies here.'
                : skill.kind === 'revive' ? 'No fallen allies to revive.' : 'No allies here.';
            UI.showToast(msg, 'error', 1500);
            return;
        }

        // Walk into range (if needed), then cast
        UI.showTargetPicker(`${skill.key} · ${skill.name} — choose ${skill.targeting === 'enemy' ? 'an enemy' : 'an ally'}`,
            entries, entry => {
                this.state.action = { type: 'cast', skill, id: entry.id, targetType: entry.targetType };
            });
    }

    /** F = Health Potion, G = Mana Potion. */
    usePotion(itemId) {
        const self = this._self();
        if (!self || self.downed) return;
        if (this._isStunned(self)) { UI.showToast('You are stunned!', 'error', 1000); return; }
        if (this._inDuelCountdown(self)) { UI.showToast('Wait for the countdown!', 'error', 1000); return; }
        const name = itemId === 'mana_potion' ? 'Mana Potions' : 'Health Potions';
        if (!this.state.inventory.some(i => i.id === itemId)) {
            UI.showToast(`No ${name}! Pip sells them in the Market.`, 'error', 2000);
            return;
        }
        Network.useItem(itemId);
    }

    // ─────────────────────────────────────────────
    //  CHAT
    // ─────────────────────────────────────────────
    _sendChatMessage(inputEl) {
        const msg = inputEl.value.trim();
        inputEl.value = '';
        inputEl.blur();
        if (!msg) return;

        // Emote commands
        const emotes = ['wave', 'dance', 'bow', 'cheer', 'laugh', 'cry'];
        const m = msg.match(/^\/(\w+)$/);
        if (m && emotes.includes(m[1].toLowerCase())) {
            Network.sendEmote(m[1].toLowerCase());
            return;
        }
        if (m) {
            UI.addChatMessage(null, '', `Emotes: ${emotes.map(e => '/' + e).join(' ')}`, true);
            return;
        }

        Network.sendChat(msg);
    }

    // ─────────────────────────────────────────────
    //  NETWORK EVENT HANDLERS
    // ─────────────────────────────────────────────
    /** Shorthand for the local player object. */
    _self() {
        return this.state.players[this.state.selfId];
    }

    /** Find a player or monster by id. */
    _entity(id) {
        return this.state.players[id] || this.state.monsters[id] || null;
    }

    _registerNetworkHandlers() {
        const S = this.state;

        // ── Connection ──
        Network.on('connect',    () => UI.setConnection(true));
        Network.on('disconnect', () => {
            UI.setConnection(false);
            UI.showToast('Disconnected from server. Refresh to rejoin.', 'error', 6000);
        });

        // ── Full snapshot (join, room change, death) ──
        Network.on('game:state', data => {
            const firstJoin = !S.selfId;
            S.selfId          = data.self.id;
            S.room            = data.room;
            S.roomNames       = data.roomNames || {};
            S.items           = data.items  || {};
            S.quests          = data.quests || {};
            S.questChain      = data.questChain || [];
            S.skills          = data.skills || [];
            S.maxLevel        = data.maxLevel || 5;
            S.quest           = data.self.quest;
            S.completedQuests = data.self.completedQuests || [];
            S.inventory       = data.self.inventory || [];
            S.equipment       = data.self.equipment || { weapon: null, armor: null };

            // Rebuild entity maps keyed by id (self included)
            S.players = {};
            (data.players || []).forEach(p => { S.players[p.id] = p; });
            S.players[data.self.id] = data.self;
            Object.values(S.players).forEach(p => {
                p.downedUntil  = Network.toLocal(p.downedUntil);
                p.stunnedUntil = Network.toLocal(p.stunnedUntil);
            });
            S.monsters = {};
            (data.monsters || []).forEach(m => { S.monsters[m.id] = m; });

            // Reset transient state
            S.action = null;
            S.hoverId = null;
            this._roomChangePending = false;
            clearTimeout(this._roomChangeTimer);
            this._lastSent   = { x: null, facing: null };
            this._snapCamera = true;
            S.duelIds = S.duelIds.filter(id => S.players[id]);
            if (S.duelOpponentId && !S.players[S.duelOpponentId]) S.duelOpponentId = null;

            UI.setSkills(S.skills);
            UI.closeModal();
            UI.hideTargetPicker();
            if (data.self.downed) UI.showDowned(data.self.downedUntil, () => Network.respawn());   // already local (converted above)
            UI.refreshPanel();

            if (firstJoin) {
                UI.addChatMessage(null, '', '⚔ Welcome to Realms of Etheryn! Click to move, click things to interact.', true);
                UI.addChatMessage(null, '', 'Talk to Seraphel (!) for a quest. The Market is to the west.', true);
            }
            UI.announceMap(S.room);
        });

        // ── Players coming and going ──
        Network.on('player:joined', p => {
            p.downedUntil  = Network.toLocal(p.downedUntil);
            p.stunnedUntil = Network.toLocal(p.stunnedUntil);
            S.players[p.id] = p;
            UI.addChatMessage(null, '', `✨ ${p.name} arrived.`, true);
        });

        Network.on('player:left', ({ playerId }) => {
            const name = S.players[playerId]?.name || 'Someone';
            delete S.players[playerId];
            if (S.action?.id === playerId) S.action = null;
            UI.addChatMessage(null, '', `👋 ${name} left the area.`, true);
        });

        Network.on('player:moved', ({ id, x, facing }) => {
            const p = S.players[id];
            if (!p || id === S.selfId) return;
            p._tx    = x;
            p.facing = facing;
        });

        Network.on('player:emoted', ({ playerId, emote }) => Renderer.addEmote(playerId, emote));

        // ── Progression ──
        Network.on('player:levelup', d => {
            const p = S.players[d.playerId];
            if (p) Object.assign(p, {
                level: d.level, hp: d.hp, maxHp: d.maxHp, mp: d.mp, maxMp: d.maxMp,
                xpToLevel: d.xpToLevel, stats: d.stats,
            });
            if (p) Renderer.addLevelBurst(p.id);   // golden burst everyone sees

            // Self gets the sky announcement; others a chat line
            if (d.playerId === S.selfId) {
                UI.announceLevel(d.level, d.gains, d.isMax);
                Audio.playLevelUp();
                UI.addChatMessage(null, '', `🌟 You reached Level ${d.level}!`, true);
            } else {
                UI.addChatMessage(null, '', `🌟 ${d.name} reached Level ${d.level}!`, true);
            }
            UI.refreshPanel();
        });

        Network.on('player:xpGold', d => {
            const self = this._self();
            if (!self) return;
            self.xp = d.xp; self.xpToLevel = d.xpToLevel; self.gold = d.gold; self.level = d.level;
            if (d.xpGained)   Renderer.addDamageNumber(self.x, self.y - 125, `+${d.xpGained} XP`, 'xp');
            if (d.goldGained) Renderer.addDamageNumber(self.x, self.y - 145, `+${d.goldGained} G`, 'gold');
            if (d.goldGained) Audio.playCoinPickup();
            UI.refreshPanel();
        });

        // ── HP / MP ──
        Network.on('player:mpRegen', ({ mp, maxMp }) => {
            const self = this._self();
            if (self) { self.mp = mp; self.maxMp = maxMp; }
        });

        Network.on('player:hp', ({ playerId, hp, maxHp }) => {
            const p = S.players[playerId];
            if (p) { p.hp = hp; p.maxHp = maxHp; }
        });

        // Heals are broadcast so everyone sees the green number
        Network.on('player:healed', ({ playerId, hp, maxHp, amount }) => {
            const p = S.players[playerId];
            if (!p) return;
            p.hp = hp; p.maxHp = maxHp;
            if (amount > 0) Renderer.addDamageNumber(p.x, p.y - 168, `+${amount}`, 'heal');
        });

        // ── Downed / revived ──
        Network.on('player:downed', ({ playerId, name, until: serverUntil }) => {
            const until = Network.toLocal(serverUntil);
            const p = S.players[playerId];
            if (p) { p.downed = true; p.downedUntil = until; p.hp = 0; }
            if (S.action?.id === playerId) S.action = null;
            if (playerId === S.selfId) {
                S.action = null;
                UI.closeAll();
                Audio.playDeath();
                UI.showDowned(until, () => Network.respawn());
            } else {
                UI.addChatMessage(null, '', `💀 ${name} has fallen! A Healer can Revive them.`, true);
            }
        });

        Network.on('player:revived', ({ playerId, name, hp, maxHp, byName }) => {
            const p = S.players[playerId];
            if (p) {
                Object.assign(p, { downed: false, downedUntil: 0, hp, maxHp });
                Renderer.showCast(p, '#fff6a0');
                Renderer.addDamageNumber(p.x, p.y - 178, 'REVIVED', 'heal', true);
            }
            if (playerId === S.selfId) {
                UI.hideDeath();
                UI.showToast(`🕊 ${byName} revived you!`, 'success', 3000);
            }
            UI.addChatMessage(null, '', `🕊 ${byName} revived ${name}.`, true);
        });

        // ── Skills / buffs (visible to everyone) ──
        Network.on('player:buffed', ({ playerId, buff, duration, stats }) => {
            const p = S.players[playerId];
            if (!p) return;
            p.buffs = { ...(p.buffs || {}), [buff]: true };
            if (playerId === S.selfId) {
                const names = { atk: 'Attack up', berserk: 'BERSERK', immune: 'IMMUNE', bless: 'Blessed: +DEF/RES' };
                UI.showToast(`${names[buff] || buff} (${Math.round(duration / 1000)}s)`, 'success', 1800);
            }
            if (stats) p.stats = stats;
            clearTimeout(p[`_${buff}Timer`]);
            p[`_${buff}Timer`] = setTimeout(() => { p.buffs[buff] = false; }, duration);
        });

        Network.on('player:skillUsed', d => {
            const p = S.players[d.playerId];
            if (p) {
                Renderer.addDamageNumber(p.x, p.y - 188, d.skillName, 'info');

                // Kind-specific visuals everyone sees
                const ringColors = {
                    heal_self: '#40ff80', heal_ally: '#40ff80', buff_atk: '#ff9a3c',
                    berserk: '#ff3030', immunity: '#ffe060', revive: '#fff6a0',
                };
                if (ringColors[d.kind]) Renderer.showCast(p, ringColors[d.kind]);
                if (d.kind === 'aoe_self')   Renderer.showAoe(p.x, d.radius, d.damageType === 'magic' ? '#ffe080' : '#ff9a3c');
                if (d.kind === 'heal_area')  Renderer.showAoe(p.x, d.radius, '#40ff80');
                if (d.kind === 'bless_area') Renderer.showAoe(p.x, d.radius, '#80b0ff');
                if (d.kind === 'chain') {
                    const chain = [d.targetId, ...(d.chainIds || [])].map(id => this._entity(id)).filter(Boolean);
                    Renderer.addLightning([p, ...chain]);
                }
                if (d.kind === 'meteor') Renderer.addMeteor(d.targetX, d.delay, d.radius);
            }
            if (d.playerId === S.selfId) {
                S.skillCooldowns[d.skillId] = Date.now() + d.cooldown;
                Audio.playSkill();
            }
        });

        // ── Combat ──
        Network.on('combat:damage', d => {
            const target   = this._entity(d.targetId);
            const attacker = this._entity(d.attackerId);
            if (target) {
                target.hp    = d.targetHp;
                target.maxHp = d.targetMaxHp;
            }

            // Visuals everyone sees: swing / bolt, flash, number
            Renderer.showAttack(attacker, target, d.damageType);
            if (!target) return;
            // Players: float above the two-line name tag; monsters: just above the body
            const numY = d.targetType === 'player' ? target.y - 168 : target.y - 95;
            if (d.immune) {
                Renderer.addDamageNumber(target.x, numY, 'IMMUNE', 'gold');
            } else {
                Renderer.flash(target.id);
                Renderer.addDamageNumber(target.x, numY, d.isCrit ? `${d.damage}!` : d.damage, d.damageType, d.isCrit);
            }

            // Auto-battle: fight back when idle
            if (d.targetId === S.selfId) this._retaliate(d.attackerId);

            // Sounds only for hits involving us
            if (d.targetId === S.selfId && !d.immune) Audio.playHurt();
            if (d.attackerId === S.selfId)           Audio.playAttack();
        });

        Network.on('monster:died', ({ monsterId, despawn }) => {
            const m = S.monsters[monsterId];
            if (!m) return;
            m.isDead = true;
            m.hp     = 0;
            Renderer.addPuff(m, despawn ? 'rgba(80,200,80,' : undefined);
            if (S.action?.id === monsterId) S.action = null;
            if (monsterId.includes('_summon_')) delete S.monsters[monsterId];   // summons never return
        });

        // ── Goblin King skills (visible to everyone in the map) ──
        Network.on('monster:skill', d => {
            const boss = S.monsters[d.monsterId];
            if (!boss) return;
            const target = S.players[d.targetId];
            switch (d.skill) {
                case 'horde':
                    Renderer.addDamageNumber(boss.x, boss.y - 175, 'CALL THE HORDE!', 'physical', true);
                    (d.positions || []).forEach(x => Renderer.addPuff({ x, y: boss.y, height: 60 }, 'rgba(80,200,80,'));
                    UI.addChatMessage(null, '', '📯 The Goblin King calls the horde!', true);
                    break;
                case 'slam':
                    Renderer.addShockwave(boss.x, d.radius);
                    Renderer.addDamageNumber(boss.x, boss.y - 175, 'GROUND SLAM!', 'physical', true);
                    break;
                case 'crush_windup':
                    Renderer.addWindup(boss.id, d.delay);
                    break;
                case 'crush':
                    Renderer.showAttack(boss, target, 'physical');
                    Renderer.addShockwave(target ? target.x : boss.x, 60);
                    break;
                case 'crush_miss':
                    Renderer.addDamageNumber(boss.x, boss.y - 175, 'MISSED', 'info');
                    break;
                case 'spear':
                    Renderer.addSpear(boss, target);
                    break;
            }
        });

        Network.on('player:stunned', ({ playerId, until }) => {
            const p = S.players[playerId];
            if (p) p.stunnedUntil = Network.toLocal(until);
            if (playerId === S.selfId) UI.showToast('💫 Stunned!', 'error', 1500);
        });

        // ── Server-wide announcements ──
        Network.on('boss:defeated', ({ name, killers }) => {
            UI.announceBoss(name, killers);
            Audio.playLevelUp();
        });
        Network.on('chat:system', ({ message }) => UI.addChatMessage(null, '', message, true));

        // Chasing / returning monsters
        Network.on('monsters:moved', list => {
            list.forEach(({ id, x, facing, aggro }) => {
                const m = S.monsters[id];
                if (!m) return;
                m._tx = x; m.facing = facing; m.aggro = aggro;
            });
        });

        Network.on('monster:respawned', m => {
            if (m.room === S.room?.id) S.monsters[m.id] = m;
        });

        // Downed timer ran out (game:state for town follows)
        Network.on('player:died', ({ message }) => UI.showDeath(message));

        // ── Chat ──
        Network.on('chat:message', d => UI.addChatMessage(d.senderId, d.senderName, d.message));

        // ── Quests ──
        Network.on('quest:accepted', ({ quest, progress }) => {
            S.quest = { id: quest.id, progress };
            UI.showToast(`📜 Quest accepted: ${quest.name}`, 'quest');
            UI.addChatMessage(null, '', `📜 ${quest.name}: ${quest.description}`, true);
            UI.refreshPanel();
        });

        Network.on('quest:progress', ({ questId, progress, count }) => {
            if (!S.quest || S.quest.id !== questId) return;
            S.quest.progress = progress;
            const def = S.quests[questId];
            UI.showToast(`${def.objective.target} slain (${progress}/${count})`, 'quest', 1800);
            if (progress >= count) UI.showToast('✅ Objective complete! Return to Seraphel.', 'quest', 4000);
            UI.refreshPanel();
        });

        Network.on('quest:completed', ({ questId, reward, item, completedQuests }) => {
            S.quest = null;
            S.completedQuests = completedQuests;
            const extra = item ? ` + ${item.name}` : '';
            UI.showToast(`🏆 ${S.quests[questId]?.name} complete! +${reward.xp} XP, +${reward.gold} G${extra}`, 'level', 5000);
            Audio.playLevelUp();
            UI.refreshPanel();
        });

        // ── Shop / inventory ──
        const applyInventory = ({ inventory, equipment, stats }) => {
            const self = this._self();
            S.inventory = inventory;
            S.equipment = equipment;
            if (self) { self.inventory = inventory; self.equipment = equipment; if (stats) self.stats = stats; }
            UI.refreshPanel();
        };

        Network.on('shop:bought', d => {
            const self = this._self();
            if (self) self.gold = d.gold;
            applyInventory(d);
            const equipped = Object.values(d.equipment).some(e => e && e.id === d.item.id) &&
                             !d.inventory.some(i => i.id === d.item.id);
            UI.showToast(`Bought ${d.item.name}${equipped ? ' (equipped)' : ' (in bag, press J)'}`, 'success', 2000);
            UI.refreshShop(d.gold);
            Audio.playCoinPickup();
        });

        Network.on('inventory:updated', applyInventory);

        // Someone's gear changed (the crown shows on their sprite)
        Network.on('player:equipment', ({ playerId, equipment }) => {
            const p = S.players[playerId];
            if (p) p.equipment = equipment;
            if (playerId === S.selfId) { S.equipment = equipment; UI.refreshPanel(); }
        });

        // ── Player ↔ player ──
        Network.on('player:inspected', profile => UI.showInspect(profile));

        Network.on('duel:request', ({ challengerId, challengerName }) => {
            UI.showDuelRequest(challengerName,
                () => Network.acceptDuel(challengerId),
                () => Network.declineDuel(challengerId));
        });

        Network.on('duel:sent',     ({ targetName }) => UI.showToast(`Duel request sent to ${targetName}.`, '', 2000));
        Network.on('duel:declined', ({ byName })     => UI.showToast(`${byName} declined your duel.`, 'error', 2500));

        Network.on('duel:started', d => {
            S.duelIds = [d.player1Id, d.player2Id];
            const startsAt = Date.now() + d.countdown;   // local clock, immune to laptop clock skew

            // Both duelists are placed apart (self included) and frozen until startsAt
            [[d.player1Id, d.player1X, d.player1Facing], [d.player2Id, d.player2X, d.player2Facing]].forEach(([id, x, facing]) => {
                const p = S.players[id];
                if (!p) return;
                p.x = x; p._tx = id === S.selfId ? undefined : x; p.facing = facing;
                p.duelStartsAt = startsAt;
            });

            if (d.player1Id === S.selfId || d.player2Id === S.selfId) {
                S.duelOpponentId = d.player1Id === S.selfId ? d.player2Id : d.player1Id;
                const opp = S.players[S.duelOpponentId];
                S.action = null;
                this._lastSent = { x: null, facing: null };

                // Countdown, then auto-battle (if on) starts the fight
                UI.duelCountdown(opp?.name || 'Opponent', startsAt);
                setTimeout(() => {
                    if (S.duelOpponentId === opp?.id && S.autoBattle && !S.action) {
                        S.action = { type: 'attack', id: opp.id, targetType: 'player' };
                    }
                }, Math.max(0, startsAt - Date.now()));
            }
            UI.addChatMessage(null, '', `⚔ Duel: ${d.player1Name} vs ${d.player2Name}!`, true);
        });

        Network.on('duel:ended', d => {
            S.duelIds = [];
            if (d.winnerId === S.selfId || d.loserId === S.selfId) {
                if (S.action?.id === S.duelOpponentId) S.action = null;
                S.duelOpponentId = null;
                const won = d.winnerId === S.selfId;
                UI.showToast(won ? '🏆 You won the duel!' : '💀 You lost the duel...', won ? 'level' : 'combat', 3500);
            }
            const how = d.reason === 'forfeit' ? ' (forfeit)' : '';
            UI.addChatMessage(null, '', `⚔ ${d.winnerName} defeated ${d.loserName} in a duel${how}.`, true);
        });

        // ── Errors from the server ──
        ['room', 'combat', 'skill', 'quest', 'shop', 'inventory', 'duel', 'inspect'].forEach(kind => {
            Network.on(`error:${kind}`, ({ message }) => {
                if (kind === 'room') this._roomChangePending = false;

                // Drop duplicates fired in quick succession
                const now = Date.now();
                if (message === this._lastError.text && now - this._lastError.at < 1500) return;
                this._lastError = { text: message, at: now };
                UI.showToast(message, 'error', 2000);
            });
        });
    }
}

// Instantiate globally
window.Game = new GameController();
