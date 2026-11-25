/**
 * UIManager — Realms of Etheryn
 * Manages all DOM-based HUD elements: bars, panels, chat, modals, toasts.
 * All dynamic text is set with textContent (never innerHTML) to stay XSS-safe.
 */
/** Emoji icon per skill name (skill bar + character selection). */
const SKILL_ICONS = {
    'Shield Bash': '💥', 'Cleave': '🪓', 'War Cry': '📣', 'Berserk': '😡',
    'Fireball': '🔥', 'Chain Lightning': '⚡', 'Arcane Surge': '✨', 'Meteor Strike': '☄️',
    'Holy Strike': '✝️', 'Consecrate': '🔆', 'Divine Heal': '💚', 'Divine Immunity': '🛡️',
    'Mend': '🩹', 'Sanctuary': '⛲', 'Blessing': '🙏', 'Revive': '🕊️',
};

class UIManager {
    constructor() {
        this._currentTab   = null;
        this._minimapCtx   = null;
        this._stateGetter  = () => null;
        this._actions      = {};
        this._shopContext  = null;
    }

    /**
     * Cache element references and wire static buttons.
     * @param {Function} stateGetter  () => game.state
     * @param {object}   actions      { useItem(id), equipItem(id) }
     */
    init(stateGetter, actions) {
        this._stateGetter = stateGetter;
        this._actions     = actions;

        // HUD
        this.elPlayerName = document.getElementById('player-name-display');
        this.elClassLevel = document.getElementById('player-class-level');
        this.elAvatar     = document.getElementById('player-avatar');
        this.elHpFill     = document.getElementById('hp-bar');
        this.elHpText     = document.getElementById('hp-val');
        this.elMpFill     = document.getElementById('mp-bar');
        this.elMpText     = document.getElementById('mp-val');
        this.elXpFill     = document.getElementById('xp-bar-fill');
        this.elXpText     = document.getElementById('xp-text');
        this.elGold       = document.getElementById('gold-text');
        this.elZone       = document.getElementById('zone-name');
        this.elConn       = document.getElementById('conn-status');

        // Chat
        this.elChat = document.getElementById('chat-messages');

        // Skill slots (Q W E R) and potion slots (F G)
        this.skillSlots = ['q', 'w', 'e', 'r'].map(k => ({
            slot: document.getElementById(`slot-${k}`),
            name: document.getElementById(`name-${k}`),
            cd:   document.getElementById(`cd-${k}`),
        }));
        this.elPotionHp = document.getElementById('count-f');
        this.elPotionMp = document.getElementById('count-g');
        this.elTargetMenu = document.getElementById('target-menu');

        // Minimap
        const mm = document.getElementById('minimap');
        if (mm) this._minimapCtx = mm.getContext('2d');

        // Side panel tabs (floating over the canvas)
        this.elCanvasWrap = document.getElementById('canvas-wrap');
        this.elSidePanel  = document.getElementById('side-panel');
        this.elSideBody  = document.getElementById('side-panel-content');
        document.querySelectorAll('.side-tab').forEach(tab => {
            tab.addEventListener('click', () => this.openPanel(tab.dataset.tab));
        });

        // Overlays
        this.elModal      = document.getElementById('modal');
        this.elModalBox   = document.getElementById('modal-box');
        this.elPlayerMenu = document.getElementById('player-menu');
        this.elDeath      = document.getElementById('death-overlay');
        this.elLevelUp    = document.getElementById('level-announce');
        this.elToasts     = document.getElementById('toast-container');
        this.elAnnounce   = document.getElementById('map-announce');

        // Click on the dim backdrop closes the modal
        this.elModal.addEventListener('click', e => { if (e.target === this.elModal) this.closeModal(); });
        this.elDeathCount = document.getElementById('death-countdown');
        document.getElementById('respawn-btn').addEventListener('click', () => {
            if (this._onRespawn) this._onRespawn();
            else this.hideDeath();
        });
    }

    // ─────────────────────────────────────────────
    //  SMALL DOM HELPERS
    // ─────────────────────────────────────────────
    /** Create an element with optional class and text. */
    _el(tag, className, text) {
        const el = document.createElement(tag);
        if (className) el.className = className;
        if (text !== undefined) el.textContent = text;
        return el;
    }

    /** Create a styled button. */
    _btn(label, onClick, variant = '') {
        const b = this._el('button', `btn-fantasy ${variant}`.trim(), label);
        b.addEventListener('click', onClick);
        return b;
    }

    /** Icon for a skill name. */
    skillIcon(name) {
        return SKILL_ICONS[name] || '✦';
    }

    _capFirst(str) {
        return str ? str.charAt(0).toUpperCase() + str.slice(1) : '';
    }

    // ─────────────────────────────────────────────
    //  HUD
    // ─────────────────────────────────────────────
    setConnection(connected) {
        if (!this.elConn) return;
        this.elConn.textContent = connected ? '● Connected' : '● Disconnected';
        this.elConn.className   = connected ? 'connected' : 'disconnected';
    }

    updateHud(player, roomName, maxLevel, inventory) {
        if (!player) return;

        // Identity + zone
        const avatars = { warrior: '🛡️', mage: '🔮', paladin: '✝️', healer: '⚕️' };
        this.elPlayerName.textContent = player.name;
        this.elClassLevel.textContent = `${this._capFirst(player.class)} · Lv ${player.level}`;
        this.elAvatar.textContent     = avatars[player.class] || '🧙';
        this.elZone.textContent       = roomName || '';

        // Bars
        const pct = (a, b) => `${Math.max(0, Math.min(100, (a / (b || 1)) * 100))}%`;
        this.elHpFill.style.width = pct(player.hp, player.maxHp);
        this.elHpText.textContent = `${player.hp}/${player.maxHp}`;
        this.elMpFill.style.width = pct(player.mp, player.maxMp);
        this.elMpText.textContent = `${player.mp}/${player.maxMp}`;
        const isMax = player.level >= maxLevel;
        this.elXpFill.style.width = isMax ? '100%' : pct(player.xp, player.xpToLevel);
        this.elXpText.textContent = isMax ? 'MAX LEVEL' : `${player.xp} / ${player.xpToLevel} XP`;
        this.elGold.textContent   = `🪙 ${player.gold} Gold`;

        // Potion counts on the F / G slots
        const count = id => (inventory || []).filter(i => i.id === id).length;
        this.elPotionHp.textContent = `×${count('health_potion')}`;
        this.elPotionMp.textContent = `×${count('mana_potion')}`;
    }

    // ─────────────────────────────────────────────
    //  MINIMAP
    // ─────────────────────────────────────────────
    updateMinimap(state) {
        const ctx = this._minimapCtx;
        if (!ctx || !state.room) return;
        const W = ctx.canvas.width, H = ctx.canvas.height;
        const scaleX = W / state.room.width;
        const groundY = H - 10;

        // Background + ground line
        ctx.fillStyle = '#0a0812';
        ctx.fillRect(0, 0, W, H);
        ctx.fillStyle = '#3a2a40';
        ctx.fillRect(0, groundY, W, 2);

        // Portals (purple) and NPCs (yellow)
        ctx.fillStyle = '#b070ff';
        (state.room.portals || []).forEach(p => ctx.fillRect(p.x * scaleX - 2, groundY - 10, 4, 10));
        ctx.fillStyle = '#ffd060';
        (state.room.npcs || []).forEach(n => ctx.fillRect(n.x * scaleX - 1.5, groundY - 7, 3, 7));

        // Monsters (red), players (white), self (gold)
        ctx.fillStyle = '#ff3030';
        Object.values(state.monsters).forEach(m => {
            if (!m.isDead && m.hp > 0) ctx.fillRect(m.x * scaleX - 2, groundY - 6, 4, 4);
        });
        Object.values(state.players).forEach(p => {
            const self = p.id === state.selfId;
            ctx.fillStyle = self ? '#ffe060' : '#ffffff';
            ctx.beginPath(); ctx.arc(p.x * scaleX, groundY - 4, self ? 3 : 2, 0, Math.PI * 2); ctx.fill();
        });
    }

    // ─────────────────────────────────────────────
    //  SKILL BAR
    // ─────────────────────────────────────────────
    /** Label the Q / E slots with this class's skills. */
    setSkills(skills) {
        // Fill every slot
        this.skillSlots.forEach((s, i) => {
            const skill = skills[i];
            if (!skill || !s.slot) return;
            s.name.textContent = skill.name;
            s.slot.querySelector('.skill-icon').textContent = this.skillIcon(skill.name);
            const type = skill.damageType ? ` · ${skill.damageType}` : '';
            const ult  = skill.ultimate ? ' · ULTIMATE' : '';
            s.slot.title = `${skill.name} — ${skill.mpCost} MP · ${skill.cooldown / 1000}s${type}${ult}\n${skill.description || ''}`;
            s.slot.classList.toggle('ultimate', Boolean(skill.ultimate));
        });
    }

    /** Show cooldown overlays (call every frame). cooldowns: skillId → expiry ts */
    tickSkillCooldowns(skills, cooldowns) {
        const now = Date.now();
        this.skillSlots.forEach((s, i) => {
            const skill = skills[i];
            if (!skill || !s.slot) return;
            const expiry = cooldowns[skill.id] || 0;
            const onCd   = now < expiry;
            s.slot.classList.toggle('on-cooldown', onCd);
            if (onCd) s.cd.textContent = `${Math.ceil((expiry - now) / 1000)}s`;
        });
    }

    // ─────────────────────────────────────────────
    //  CHAT
    // ─────────────────────────────────────────────
    addChatMessage(senderId, senderName, message, isSystem = false) {
        if (!this.elChat) return;
        const line = this._el('div', 'chat-line');

        // System line or "Name: message"
        if (isSystem) {
            line.appendChild(this._el('span', 'chat-sys', message));
        } else {
            const colors = ['#ff8080', '#80c0ff', '#80ff80', '#ffcc60', '#c080ff', '#ff80cc', '#80ffff', '#ffd080'];
            const who = this._el('span', 'chat-who', `${senderName}: `);
            who.style.color = colors[(senderId || ' ').charCodeAt(0) % colors.length];
            line.appendChild(who);
            line.appendChild(document.createTextNode(message));
            if (window.Audio) window.Audio.playChat();
        }

        // Keep the log at most 100 lines
        this.elChat.appendChild(line);
        while (this.elChat.children.length > 100) this.elChat.removeChild(this.elChat.firstChild);
        this.elChat.scrollTop = this.elChat.scrollHeight;
    }

    // ─────────────────────────────────────────────
    //  SIDE PANEL (Inventory / Quests / Stats)
    // ─────────────────────────────────────────────
    /** Toggle a tab: same tab closes the panel, other tab switches. */
    togglePanel(tab) {
        if (this.elSidePanel.classList.contains('open') && this._currentTab === tab) {
            this.closePanel();
        } else {
            this.openPanel(tab);
        }
    }

    openPanel(tab) {
        this._currentTab = tab;
        this.elSidePanel.classList.add('open');
        this.elCanvasWrap.classList.add('panel-open');     // chat slides left of the panel
        document.querySelectorAll('.side-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
        this.refreshPanel();
    }

    closePanel() {
        this._currentTab = null;
        this.elSidePanel.classList.remove('open');
        this.elCanvasWrap.classList.remove('panel-open');
    }

    /** Re-render the visible tab from current game state. */
    refreshPanel() {
        const state = this._stateGetter();
        if (!state || !this._currentTab || !this.elSidePanel.classList.contains('open')) return;
        const self = state.players[state.selfId];
        const body = this.elSideBody;
        body.replaceChildren();
        if (!self) return;

        if (this._currentTab === 'inventory') this._renderInventory(body, self, state);
        if (this._currentTab === 'quests')    this._renderQuests(body, state);
        if (this._currentTab === 'stats')     this._renderStats(body, self);
    }

    /** One-line stat summary for an item, e.g. "+5 ATK +2 DEF". */
    itemStatText(item) {
        if (!item) return '';
        const parts = [];
        if (item.atkBonus)   parts.push(`+${item.atkBonus} ATK`);
        if (item.magBonus)   parts.push(`+${item.magBonus} MAG`);
        if (item.defBonus)   parts.push(`+${item.defBonus} DEF`);
        if (item.resBonus)   parts.push(`+${item.resBonus} RES`);
        if (item.healAmount) parts.push(`+${item.healAmount} HP`);
        if (item.manaAmount) parts.push(`+${item.manaAmount} MP`);
        return parts.join('  ');
    }

    _itemIcon(item) {
        if (item.type === 'head')   return '👑';
        if (item.type === 'weapon') return item.magBonus ? '🪄' : '⚔️';
        if (item.type === 'armor')  return item.resBonus && !item.defBonus ? '🥻' : '🛡️';
        return item.manaAmount ? '🔵' : '🧪';
    }

    _renderInventory(body, self, state) {
        // ── Paper doll: character in the middle, a slot box per body part ──
        body.appendChild(this._el('div', 'panel-section-title', 'Equipped'));
        const doll = this._el('div', 'paper-doll');

        // Character portrait
        const portrait = document.createElement('canvas');
        portrait.className = 'pd-portrait';
        portrait.width  = 120;
        portrait.height = 170;
        doll.appendChild(portrait);
        if (window.Renderer) Renderer.drawPortrait(portrait, { ...self, equipment: state.equipment });

        // Arrows from each slot to its body part (doll coordinates, 290×236)
        const svgNS = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(svgNS, 'svg');
        svg.setAttribute('class', 'pd-arrows');
        svg.setAttribute('viewBox', '0 0 290 236');
        svg.innerHTML = `
            <defs><marker id="pd-head" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0,0 L10,5 L0,10 z" fill="#c9a84c"/></marker></defs>`;
        const arrows = {
            head:   'M196,52 C186,70 172,72 156,84',     // head slot (top right) → head
            weapon: 'M98,118 C108,118 112,116 122,112',  // weapon slot (left) → weapon hand
            armor:  'M196,176 C182,168 172,160 158,146', // armor slot (bottom right) → chest
        };
        Object.entries(arrows).forEach(([slot, d]) => {
            const path = document.createElementNS(svgNS, 'path');
            path.setAttribute('d', d);
            path.setAttribute('class', state.equipment[slot] ? 'pd-arrow on' : 'pd-arrow');
            path.setAttribute('marker-end', 'url(#pd-head)');
            svg.appendChild(path);
        });
        doll.appendChild(svg);

        // Slot boxes
        const labels = { head: 'Head', weapon: 'Weapon', armor: 'Armor' };
        ['head', 'weapon', 'armor'].forEach(slot => {
            const item = state.equipment[slot];
            const box  = this._el('div', `pd-slot pd-${slot}${item ? ' filled' : ''}`);
            box.appendChild(this._el('div', 'pd-label', labels[slot]));
            const line = this._el('div', 'pd-item');
            line.appendChild(this._el('span', 'pd-icon', item ? this._itemIcon(item) : '·'));
            line.appendChild(this._el('span', 'pd-name', item ? item.name : 'Empty'));
            box.appendChild(line);
            box.appendChild(this._el('div', 'pd-stats', item ? this.itemStatText(item) : ''));
            if (item) box.title = item.description || item.name;
            doll.appendChild(box);
        });
        body.appendChild(doll);

        // Bag contents
        body.appendChild(this._el('div', 'panel-section-title', `Bag (${state.inventory.length})`));
        if (state.inventory.length === 0) {
            body.appendChild(this._el('div', 'panel-empty', 'Empty. Visit the Market west of town!'));
            return;
        }
        state.inventory.forEach(item => {
            const row = this._el('div', 'inv-row');
            row.appendChild(this._el('span', 'inv-icon', this._itemIcon(item)));
            const info = this._el('div', 'inv-info');
            info.appendChild(this._el('div', 'inv-name', item.name));
            info.appendChild(this._el('div', 'inv-desc', this.itemStatText(item)));
            row.appendChild(info);

            // Use or Equip
            if (item.type === 'consumable') {
                row.appendChild(this._btn('Use', () => this._actions.useItem(item.id), 'btn-small'));
            } else {
                row.appendChild(this._btn('Equip', () => this._actions.equipItem(item.id), 'btn-small btn-gold'));
            }
            body.appendChild(row);
        });
    }

    _renderQuests(body, state) {
        body.appendChild(this._el('div', 'panel-section-title', 'Active Quest'));

        // Active quest with progress bar
        const active = state.quest && state.quests[state.quest.id];
        if (!active) {
            body.appendChild(this._el('div', 'panel-empty', 'No active quest. Talk to Seraphel in Etheryn Town.'));
        } else {
            const box = this._el('div', 'quest-item');
            const count = active.objective.count;
            box.appendChild(this._el('div', 'q-name', active.name));
            box.appendChild(this._el('div', 'q-desc', active.description));
            box.appendChild(this._el('div', 'q-progress', `Progress: ${state.quest.progress} / ${count}`));
            const bar  = this._el('div', 'q-bar');
            const fill = this._el('div', 'q-bar-fill');
            fill.style.width = `${Math.min(100, (state.quest.progress / count) * 100)}%`;
            bar.appendChild(fill);
            box.appendChild(bar);
            const r = active.reward;
            const itemName = r.item && state.items[r.item] ? ` · ${state.items[r.item].name}` : '';
            box.appendChild(this._el('div', 'q-reward', `Reward: ${r.xp} XP · ${r.gold} G${itemName}`));
            body.appendChild(box);
        }

        // Completed quests
        if (state.completedQuests.length) {
            body.appendChild(this._el('div', 'panel-section-title', 'Completed'));
            state.completedQuests.forEach(id => {
                body.appendChild(this._el('div', 'panel-empty', `✔ ${state.quests[id]?.name || id}`));
            });
        }
    }

    _renderStats(body, self) {
        const s = self.stats || {};
        const rows = [
            ['Class',       this._capFirst(self.class)],
            ['Level',       self.level],
            ['HP',          `${self.hp}/${self.maxHp}`],
            ['MP',          `${self.mp}/${self.maxMp}`],
            ['ATK',         s.atk],
            ['MAG',         s.mag],
            ['DEF',         s.def],
            ['RES',         s.res],
            ['Attack Type', this._capFirst(self.damageType)],
            ['XP',          `${self.xp}/${self.xpToLevel}`],
            ['Gold',        `${self.gold} G`],
        ];

        // Two-column table
        body.appendChild(this._el('div', 'panel-section-title', 'Character'));
        const table = this._el('table', 'stat-table');
        rows.forEach(([k, v]) => {
            const tr = this._el('tr');
            tr.appendChild(this._el('td', '', k));
            tr.appendChild(this._el('td', '', String(v ?? '-')));
            table.appendChild(tr);
        });
        body.appendChild(table);
        body.appendChild(this._el('div', 'panel-empty',
            'Physical damage uses ATK vs DEF. Magic damage uses MAG vs RES.'));
    }

    // ─────────────────────────────────────────────
    //  MODAL (NPC dialogue, shop, inspect)
    // ─────────────────────────────────────────────
    isModalOpen() {
        return this.elModal.classList.contains('open');
    }

    _openModal(builder) {
        this.hidePlayerMenu();
        this.elModalBox.replaceChildren();
        builder(this.elModalBox);
        this.elModal.classList.add('open');
    }

    closeModal() {
        this.elModal.classList.remove('open');
        this._shopContext = null;
    }

    /**
     * NPC dialogue: every line in one panel, optional detail boxes, action buttons.
     * @param {object} opts { name, title, lines[], details:[[label, value]], buttons:[{label, onClick, variant}] }
     */
    showNPCDialog({ name, title, lines, details = [], buttons = [] }) {
        this._openModal(box => {
            box.appendChild(this._el('div', 'modal-title', name));
            if (title) box.appendChild(this._el('div', 'modal-subtitle', title));

            // All dialogue at once, one paragraph per line
            const text = this._el('div', 'dialog-text');
            lines.forEach(line => text.appendChild(this._el('p', '', line)));
            box.appendChild(text);

            // Objective / Reward / Progress boxes
            if (details.length) {
                const grid = this._el('div', 'dialog-details');
                details.forEach(([label, value]) => {
                    const cell = this._el('div', 'dialog-detail');
                    cell.appendChild(this._el('div', 'dd-label', label));
                    cell.appendChild(this._el('div', 'dd-value', value));
                    grid.appendChild(cell);
                });
                box.appendChild(grid);
            }

            // Actions (e.g. Accept Quest / Turn In) + Close
            const row = this._el('div', 'modal-buttons');
            buttons.forEach(btn => row.appendChild(this._btn(btn.label, () => {
                this.closeModal();
                btn.onClick();
            }, btn.variant || 'btn-gold')));
            row.appendChild(this._btn('Close', () => this.closeModal()));
            box.appendChild(row);
        });
    }

    /**
     * Shop for one shopkeeper. Stays open after buying.
     * @param {object} opts { npc, items[], gold, onBuy(itemId) }
     */
    showShop({ npc, items, gold, onBuy }) {
        this._shopContext = { npc, items, onBuy };
        this._openModal(box => {
            box.appendChild(this._el('div', 'modal-title', `${npc.name}'s Wares`));
            box.appendChild(this._el('div', 'modal-subtitle', npc.dialogue?.[0] || npc.title));
            const goldEl = this._el('div', 'shop-gold', `Your Gold: ${gold} G`);
            box.appendChild(goldEl);
            const grid = this._el('div', 'shop-grid');
            box.appendChild(grid);

            // One card per item
            const cards = items.map(item => {
                const card = this._el('div', 'shop-card');
                card.appendChild(this._el('div', 'shop-item-icon', this._itemIcon(item)));
                card.appendChild(this._el('div', 'shop-item-name', item.name));
                card.appendChild(this._el('div', 'shop-item-desc', this.itemStatText(item)));
                card.appendChild(this._el('div', 'shop-item-price', `${item.price} G`));
                const btn = this._btn('Buy', () => onBuy(item.id), 'btn-gold btn-small');
                card.appendChild(btn);
                grid.appendChild(card);
                return { item, btn };
            });

            // Expose a refresher so purchases update the gold / buttons
            this._shopContext.refresh = (newGold) => {
                goldEl.textContent = `Your Gold: ${newGold} G`;
                cards.forEach(({ item, btn }) => { btn.disabled = newGold < item.price; });
            };
            this._shopContext.refresh(gold);

            const row = this._el('div', 'modal-buttons');
            row.appendChild(this._btn('Close', () => this.closeModal()));
            box.appendChild(row);
        });
    }

    /** Update an open shop after a purchase. */
    refreshShop(gold) {
        if (this.isModalOpen() && this._shopContext?.refresh) this._shopContext.refresh(gold);
    }

    /** Inspect card for another player. */
    showInspect(profile, items) {
        const s = profile.stats || {};
        this._openModal(box => {
            box.appendChild(this._el('div', 'modal-title', profile.name));
            box.appendChild(this._el('div', 'modal-subtitle',
                `Level ${profile.level} ${this._capFirst(profile.class)} · ${this._capFirst(profile.damageType)} attacker`));

            // Vital stats
            const table = this._el('table', 'stat-table');
            [
                ['HP', `${profile.hp}/${profile.maxHp}`],
                ['ATK / MAG', `${s.atk} / ${s.mag}`],
                ['DEF / RES', `${s.def} / ${s.res}`],
            ].forEach(([k, v]) => {
                const tr = this._el('tr');
                tr.appendChild(this._el('td', '', k));
                tr.appendChild(this._el('td', '', v));
                table.appendChild(tr);
            });
            box.appendChild(table);

            // Equipped gear
            box.appendChild(this._el('div', 'panel-section-title', 'Equipment'));
            ['head', 'weapon', 'armor'].forEach(slot => {
                const item = profile.equipment?.[slot];
                const row  = this._el('div', 'inv-row');
                row.appendChild(this._el('span', 'inv-icon', item ? this._itemIcon(item) : '—'));
                const info = this._el('div', 'inv-info');
                info.appendChild(this._el('div', 'inv-name', item ? item.name : `No ${slot}`));
                info.appendChild(this._el('div', 'inv-desc', item ? this.itemStatText(item) : ''));
                row.appendChild(info);
                box.appendChild(row);
            });

            const row = this._el('div', 'modal-buttons');
            row.appendChild(this._btn('Close', () => this.closeModal()));
            box.appendChild(row);
        });
    }

    // ─────────────────────────────────────────────
    //  PLAYER ACTION MENU
    // ─────────────────────────────────────────────
    /**
     * Small popup at a screen position over the canvas.
     * @param {number} x  Page x
     * @param {number} y  Page y
     * @param {object} player
     * @param {object} actions { onDuel, onInspect }
     */
    showPlayerMenu(x, y, player, actions) {
        const menu = this.elPlayerMenu;
        menu.replaceChildren();

        // Header + buttons
        menu.appendChild(this._el('div', 'pm-title', player.name));
        menu.appendChild(this._el('div', 'pm-sub', `Lv ${player.level} ${this._capFirst(player.class)}`));
        menu.appendChild(this._btn('⚔ Duel', () => { this.hidePlayerMenu(); actions.onDuel(); }, 'btn-small btn-gold'));
        menu.appendChild(this._btn('🔍 Inspect', () => { this.hidePlayerMenu(); actions.onInspect(); }, 'btn-small'));
        menu.appendChild(this._btn('Cancel', () => this.hidePlayerMenu(), 'btn-small'));

        // Keep on screen
        menu.classList.add('open');
        const w = menu.offsetWidth, h = menu.offsetHeight;
        menu.style.left = `${Math.min(window.innerWidth - w - 8, Math.max(8, x - w / 2))}px`;
        menu.style.top  = `${Math.min(window.innerHeight - h - 8, Math.max(8, y - h - 20))}px`;
    }

    hidePlayerMenu() {
        this.elPlayerMenu.classList.remove('open');
    }

    // ─────────────────────────────────────────────
    //  DUEL
    // ─────────────────────────────────────────────
    /** Incoming challenge with Accept / Decline; auto-declines after 15 s. */
    showDuelRequest(challengerName, onAccept, onDecline) {
        const toast = this._el('div', 'toast duel-toast');
        toast.appendChild(this._el('div', '', `⚔ ${challengerName} challenges you to a duel!`));
        const row = this._el('div', 'modal-buttons');
        let done = false;
        const finish = (fn) => { if (done) return; done = true; toast.remove(); fn(); };
        row.appendChild(this._btn('Accept', () => finish(onAccept), 'btn-small btn-gold'));
        row.appendChild(this._btn('Decline', () => finish(onDecline), 'btn-small'));
        toast.appendChild(row);
        this.elToasts.appendChild(toast);
        setTimeout(() => finish(onDecline), 15000);
    }

    // ─────────────────────────────────────────────
    //  TOASTS
    // ─────────────────────────────────────────────
    /** @param {''|'quest'|'level'|'combat'|'error'|'success'} type */
    showToast(message, type = '', duration = 3000) {
        if (!this.elToasts) return;
        const toast = this._el('div', `toast ${type}`.trim(), message);
        toast.style.animationDuration = `${duration}ms`;
        this.elToasts.appendChild(toast);
        setTimeout(() => toast.remove(), duration + 100);
    }

    // ─────────────────────────────────────────────
    //  MAP ANNOUNCEMENT TITLE
    // ─────────────────────────────────────────────
    /**
     * Big styled title in the sky when entering a map.
     * @param {object} room  Room definition (name, tagline, theme, isSafe)
     */
    announceMap(room) {
        const el = this.elAnnounce;
        const ornaments = { market: '❖', town: '⚜', forest: '☠', deep: '♛' };
        const orn = ornaments[room.theme] || '✦';

        // Fill text for this map
        el.querySelector('.ma-orn-left').textContent  = orn;
        el.querySelector('.ma-orn-right').textContent = orn;
        el.querySelector('.ma-title').textContent     = room.name;
        el.querySelector('.ma-tagline').textContent   = room.tagline || '';
        el.querySelector('.ma-danger').textContent    = room.isSafe ? '' : '⚠ Hostile Zone';

        // Swap the theme class and restart the animation
        this._mapAnnounceUntil = Date.now() + 3600;
        el.className = '';
        void el.offsetWidth;
        el.classList.add(`announce-${room.theme}`, 'show');
    }

    /**
     * Server-wide boss kill title (reuses the map announcement element).
     * @param {string}   name     Boss name
     * @param {string[]} killers  Players who damaged it
     */
    announceBoss(name, killers) {
        const el = this.elAnnounce;
        el.querySelector('.ma-orn-left').textContent  = '☠';
        el.querySelector('.ma-orn-right').textContent = '☠';
        el.querySelector('.ma-title').textContent     = `The ${name} Has Fallen`;
        el.querySelector('.ma-tagline').textContent   = killers.length ? `Slain by ${killers.join(', ')}` : '';
        el.querySelector('.ma-danger').textContent    = '';

        // Same timing slot as a map title, so a level-up waits for it
        this._mapAnnounceUntil = Date.now() + 3600;
        el.className = '';
        void el.offsetWidth;
        el.classList.add('announce-boss', 'show');
    }

    // ─────────────────────────────────────────────
    //  AUTO-BATTLE SLOT / DUEL COUNTDOWN
    // ─────────────────────────────────────────────
    /** Show the auto-battle state on the ⚔ slot. */
    setAutoBattle(on) {
        document.getElementById('slot-attack').classList.toggle('auto-on', on);
        const label = document.getElementById('auto-label');
        label.textContent = on ? 'Auto: ON' : 'Auto: OFF';
        label.className   = `skill-label ${on ? 'on' : 'off'}`;
    }

    /**
     * 3 · 2 · 1 · FIGHT! in the sky until `startsAt`.
     * @param {string} opponentName
     * @param {number} startsAt  Server timestamp when attacks unlock
     */
    duelCountdown(opponentName, startsAt) {
        const el  = document.getElementById('duel-countdown');
        const num = el.querySelector('.dc-num');
        el.querySelector('.dc-name').textContent = opponentName;
        el.classList.add('open');

        // Re-trigger the pop animation for each number
        const show = (text, cls) => {
            num.textContent = text;
            num.className = 'dc-num';
            void num.offsetWidth;
            num.classList.add(cls);
        };
        clearInterval(this._duelTicker);
        let last = null;
        const tick = () => {
            const left = Math.ceil((startsAt - Date.now()) / 1000);
            if (left > 0) {
                if (left !== last) { show(String(left), 'tick'); last = left; }
                return;
            }
            clearInterval(this._duelTicker);
            show('FIGHT!', 'fight');
            setTimeout(() => el.classList.remove('open'), 1200);
        };
        tick();
        this._duelTicker = setInterval(tick, 100);
    }

    // ─────────────────────────────────────────────
    //  TARGET PICKER (targeted skills)
    // ─────────────────────────────────────────────
    /**
     * List of targets for a skill; number keys 1–9 pick too.
     * @param {string} title
     * @param {Array<{id,label,sub,hpPct,targetType}>} entries
     * @param {Function} onPick (entry) => void
     */
    showTargetPicker(title, entries, onPick) {
        const menu = this.elTargetMenu;
        menu.replaceChildren();
        menu.appendChild(this._el('div', 'tm-title', title));

        // One row per target
        this._pickerEntries = entries;
        this._pickerOnPick  = onPick;
        entries.slice(0, 9).forEach((e, i) => {
            const row = this._el('button', 'tm-row');
            row.appendChild(this._el('span', 'tm-key', String(i + 1)));
            const info = this._el('span', 'tm-info');
            info.appendChild(this._el('span', 'tm-name', e.label));
            const bar  = this._el('span', 'tm-bar');
            const fill = this._el('span', 'tm-bar-fill');
            fill.style.width = `${Math.max(0, Math.min(100, e.hpPct * 100))}%`;
            bar.appendChild(fill);
            info.appendChild(bar);
            row.appendChild(info);
            row.appendChild(this._el('span', 'tm-sub', e.sub));
            row.addEventListener('click', () => this.pickTarget(i));
            menu.appendChild(row);
        });
        menu.appendChild(this._el('div', 'tm-hint', 'Press 1–9 or click · Esc to cancel'));
        menu.classList.add('open');
    }

    isPickerOpen() {
        return this.elTargetMenu.classList.contains('open');
    }

    /** Pick entry i (0-based); ignores out-of-range indices. */
    pickTarget(i) {
        const entry = this._pickerEntries?.[i];
        if (!entry || !this.isPickerOpen()) return;
        this.hideTargetPicker();
        this._pickerOnPick(entry);
    }

    hideTargetPicker() {
        this.elTargetMenu.classList.remove('open');
    }

    // ─────────────────────────────────────────────
    //  DOWNED / DEATH / LEVEL UP
    // ─────────────────────────────────────────────
    /** Downed overlay with a countdown and a "Return to town" button. */
    showDowned(until, onRespawn) {
        this._onRespawn = onRespawn;
        this.elDeath.querySelector('h2').textContent = '☠ You Have Fallen';
        this.elDeath.querySelector('p').textContent  = 'A Healer can Revive you. Otherwise you return to town in';
        this.elDeath.querySelector('#respawn-btn').textContent = 'Return to Town';
        this.elDeath.classList.add('visible', 'downed');

        // Live countdown
        clearInterval(this._deathTicker);
        clearTimeout(this._deathTimer);
        const tick = () => {
            this.elDeathCount.textContent = `${Math.max(0, Math.ceil((until - Date.now()) / 1000))}s`;
        };
        tick();
        this._deathTicker = setInterval(tick, 250);
    }

    /** Brief notice after the downed timer ran out (auto-hides). */
    showDeath(message) {
        this._onRespawn = null;
        clearInterval(this._deathTicker);
        this.elDeath.classList.remove('downed');
        this.elDeath.querySelector('h2').textContent = '☠ You Have Fallen';
        this.elDeath.querySelector('p').textContent  = message;
        this.elDeathCount.textContent = '';
        this.elDeath.querySelector('#respawn-btn').textContent = 'Continue';
        this.elDeath.classList.add('visible');
        clearTimeout(this._deathTimer);
        this._deathTimer = setTimeout(() => this.hideDeath(), 4000);
    }

    hideDeath() {
        clearInterval(this._deathTicker);
        this._onRespawn = null;
        this.elDeath.classList.remove('visible', 'downed');
    }

    /**
     * Level-up title in the sky (same style family as the map announcement).
     * Waits for a map title that is still showing so they never overlap.
     */
    announceLevel(level, gains, isMax) {
        const el    = this.elLevelUp;
        const delay = Math.max(0, (this._mapAnnounceUntil || 0) - Date.now());

        // e.g. "+12 HP  +4 MP  +2 ATK  +2 DEF"
        const parts = [];
        if (gains) {
            [['hp', 'HP'], ['mp', 'MP'], ['atk', 'ATK'], ['mag', 'MAG'], ['def', 'DEF'], ['res', 'RES']]
                .forEach(([k, label]) => { if (gains[k]) parts.push(`+${gains[k]} ${label}`); });
        }

        clearTimeout(this._levelTimer);
        this._levelTimer = setTimeout(() => {
            el.querySelector('.ma-title').textContent   = isMax ? `LEVEL ${level} · MAX` : `LEVEL ${level}`;
            el.querySelector('.ma-tagline').textContent = 'Level Up!';
            el.querySelector('.ma-gains').textContent   = parts.join('   ');
            el.classList.remove('show');
            void el.offsetWidth;            // restart the CSS animation
            el.classList.add('show');
        }, delay);
    }

    /** Escape key: close whatever is open. */
    closeAll() {
        this.hidePlayerMenu();
        this.hideTargetPicker();
        this.closeModal();
    }
}

window.UI = new UIManager();
