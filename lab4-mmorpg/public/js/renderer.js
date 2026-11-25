/**
 * Renderer — Realms of Etheryn
 * Handles all HTML5 Canvas drawing: world, NPCs, portals, players, monsters, effects.
 *
 * Every room is a single horizontal ground line (room.groundY) that is
 * room.width px wide. The camera follows the local player horizontally and
 * keeps the ground a fixed distance above the bottom of the canvas.
 *
 * The class is named CanvasRenderer (not Renderer) so that the bare
 * identifier `Renderer` resolves to the window singleton below, not the class.
 */
class CanvasRenderer {
    constructor(canvas) {
        this.canvas = canvas;
        this.ctx    = canvas.getContext('2d');
        this.camera = { x: 0, y: 0 };

        /** Distance in px from the ground line to the bottom of the canvas (room for the skill bar). */
        this.GROUND_MARGIN = 130;

        /** @type {Array<{wx,wy,value,color,big,born}>} */
        this.damageNumbers = [];
        /** @type {Array<{entityId,emote,born}>} */
        this.emotes = [];
        /** @type {Map<string,number>} entityId → hit-flash timestamp */
        this.hitFlash = new Map();
        /** @type {Map<string,{born,dir,color}>} entityId → melee slash */
        this.slashEffects = new Map();
        /** @type {Array<{fx,fy,tx,ty,color,born}>} magic bolts in flight */
        this.projectiles = [];
        /** @type {Array<{wx,wy,born,color}>} death puffs */
        this.puffs = [];
        /** @type {Array<{x,radius,color,born}>} area-of-effect rings */
        this.aoes = [];
        /** @type {Array<{points,born}>} chain lightning bolts */
        this.lightning = [];
        /** @type {Array<{x,radius,born,delay}>} falling meteors */
        this.meteors = [];
        /** @type {Array<{entityId,born}>} level-up bursts (follow the player) */
        this.levelBursts = [];
        /** @type {Array<{x,radius,born}>} boss ground-slam shockwaves */
        this.shockwaves = [];
        /** @type {Map<string,{born,delay}>} boss Crushing Blow wind-ups */
        this.windups = new Map();
    }

    /** Set the canvas pixel size (called by the layout code). */
    resize(width, height) {
        this.canvas.width  = Math.max(1, Math.floor(width));
        this.canvas.height = Math.max(1, Math.floor(height));
    }

    /** Smooth camera tracking — lerp toward player, clamped to the room. */
    updateCamera(px, room, snap = false) {
        const W = this.canvas.width, H = this.canvas.height;

        // Centre the room if it is narrower than the screen
        let targetX = px - W / 2;
        if (room.width <= W) targetX = (room.width - W) / 2;
        else targetX = Math.max(0, Math.min(room.width - W, targetX));

        this.camera.x  = snap ? targetX : this.camera.x + (targetX - this.camera.x) * 0.12;
        this.camera.y  = room.groundY + this.GROUND_MARGIN - H;
    }

    /** Convert screen coords → world coords */
    screenToWorld(sx, sy) {
        return { x: sx + this.camera.x, y: sy + this.camera.y };
    }

    /** Convert world coords → screen coords */
    worldToScreen(wx, wy) {
        return { x: wx - this.camera.x, y: wy - this.camera.y };
    }

    // ─────────────────────────────────────────────
    //  MAIN RENDER
    // ─────────────────────────────────────────────
    /**
     * @param {object} s
     * @param {string} s.selfId
     * @param {object} s.room        Room definition from the server
     * @param {object} s.roomNames   roomId → display name
     * @param {object} s.players     id → player
     * @param {object} s.monsters    id → monster
     * @param {string|null} s.targetId   Currently targeted entity
     * @param {string|null} s.hoverId    Entity under the mouse
     * @param {object} s.npcMarkers  npcId → '!' | '?'
     * @param {string[]} s.duelIds   Both duelists' ids (or empty)
     */
    render(s) {
        const { ctx } = this;
        if (!s.room) return;
        ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

        // World layers, back to front
        this.drawBackground(s.room.theme);
        this.drawGround(s.room);
        this.drawProps(s.room);
        this.drawExitSigns(s.room, s.roomNames || {});
        (s.room.portals || []).forEach(p => this.drawPortal(s.room, p, s.roomNames || {}, s.hoverId === p.id));
        (s.room.npcs || []).forEach(n => this.drawNPC(s.room, n, s.npcMarkers?.[n.id], s.hoverId === n.id));
        this.drawMonsters(s);
        this.drawPlayers(s);

        // Effects on top
        this.drawLevelBursts(s);
        this.drawShockwaves();
        this.drawAoes();
        this.drawMeteors();
        this.drawLightning();
        this.drawProjectiles();
        this.drawPuffs();
        this.drawDamageNumbers();
        this.drawEmotes(s);
    }

    // ─────────────────────────────────────────────
    //  BACKGROUND
    // ─────────────────────────────────────────────
    drawBackground(theme) {
        const { ctx, canvas } = this;
        const W = canvas.width, H = canvas.height;
        const horizon = this._groundY();

        // Sky colours per theme
        const skies = {
            market: ['#2a1030', '#6a2a40', '#c0603a'],
            town:   ['#0d0520', '#1a0a3a', '#4a2060'],
            forest: ['#030308', '#0a0a1a', '#1a0a2e'],
            deep:   ['#020102', '#100308', '#2a0810'],
        };
        const [c0, c1, c2] = skies[theme] || skies.town;
        const sky = ctx.createLinearGradient(0, 0, 0, horizon);
        sky.addColorStop(0, c0);
        sky.addColorStop(0.6, c1);
        sky.addColorStop(1, c2);
        ctx.fillStyle = sky;
        ctx.fillRect(0, 0, W, H);

        // Stars (not in the dense deep forest)
        if (theme !== 'deep') {
            for (let i = 0; i < 70; i++) {
                const sx    = ((i * 523 + 91) % 1900) - this.camera.x * 0.1;
                const sy    = (i * 197) % Math.max(60, horizon - 200);
                const alpha = (theme === 'market' ? 0.25 : 0.4) + 0.5 * Math.abs(Math.sin(Date.now() / 1800 + i));
                ctx.fillStyle = `rgba(255,255,220,${alpha})`;
                ctx.fillRect(((sx % W) + W) % W, sy, 1.5, 1.5);
            }
        }

        // Theme-specific far layer
        if (theme === 'town' || theme === 'market') {
            this._drawMountains(horizon, theme === 'market' ? '#3a1830' : '#2a1040');
        } else {
            this._drawMoon(theme);
            this._drawFarTrees(horizon, theme === 'deep' ? '#0a0204' : '#07070f');
        }
    }

    /** Parallax mountain silhouettes */
    _drawMountains(horizon, color) {
        const { ctx, canvas } = this;
        const W = canvas.width;
        const peaks = [0, 0.55, 0.35, 0.75, 0.45, 0.65, 0.3, 0.7, 0.4];
        const offset = -(this.camera.x * 0.25) % 900;

        // Repeat a 900px mountain strip across the screen
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.moveTo(0, horizon);
        for (let o = offset - 900; o < W + 900; o += 900) {
            peaks.forEach((h, i) => ctx.lineTo(o + i * 112, horizon - h * 260));
        }
        ctx.lineTo(W, horizon);
        ctx.closePath();
        ctx.fill();
    }

    /** Moon for forest themes (green in Doomwood, red in the Deeper Forest) */
    _drawMoon(theme) {
        const { ctx } = this;
        const mx = this.canvas.width * 0.7 - this.camera.x * 0.05;
        const glow = theme === 'deep' ? '255,40,40' : '50,200,80';

        // Soft halo then the disc
        const g = ctx.createRadialGradient(mx, 70, 0, mx, 70, 180);
        g.addColorStop(0, `rgba(${glow},0.15)`);
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        ctx.fillRect(mx - 180, 0, 360, 260);
        ctx.save();
        ctx.fillStyle   = theme === 'deep' ? '#e0a090' : '#c8e8a0';
        ctx.shadowColor = theme === 'deep' ? '#ff3030' : '#40ff60';
        ctx.shadowBlur  = 20;
        ctx.beginPath(); ctx.arc(mx, 70, 22, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
    }

    /** Distant tree line silhouette */
    _drawFarTrees(horizon, color) {
        const { ctx, canvas } = this;
        const offset = -(this.camera.x * 0.3) % 60;

        // Row of triangular pines
        ctx.fillStyle = color;
        for (let x = offset - 60; x < canvas.width + 60; x += 60) {
            const h = 120 + ((Math.abs(Math.floor((x - offset) / 60)) * 37) % 70);
            ctx.beginPath();
            ctx.moveTo(x, horizon);
            ctx.lineTo(x + 30, horizon - h);
            ctx.lineTo(x + 60, horizon);
            ctx.fill();
        }
    }

    // ─────────────────────────────────────────────
    //  GROUND
    // ─────────────────────────────────────────────
    drawGround(room) {
        const { ctx, canvas } = this;
        const W = canvas.width;
        const gy = this._groundY();
        const theme = room.theme;

        // Fill
        const fills = { market: '#4a3420', town: '#3a2510', forest: '#111108', deep: '#0c0606' };
        ctx.fillStyle = fills[theme] || fills.town;
        ctx.fillRect(0, gy, W, canvas.height - gy);

        // Paved themes get brick lines
        if (theme === 'town' || theme === 'market') {
            ctx.strokeStyle = theme === 'market' ? '#3a2614' : '#2a1808';
            ctx.lineWidth = 1;
            for (let y = gy; y < canvas.height; y += 20) {
                const row = Math.floor((y - gy) / 20);
                ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
                for (let x = -(this.camera.x % 40) - 40 + (row % 2) * 20; x < W + 40; x += 40) {
                    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y + 20); ctx.stroke();
                }
            }
        } else {
            // Forest roots
            ctx.strokeStyle = theme === 'deep' ? '#200808' : '#1a1204';
            ctx.lineWidth = 2;
            for (let wx = 100; wx < room.width; wx += 260) {
                const sx = wx - this.camera.x;
                ctx.beginPath();
                ctx.moveTo(sx, gy);
                ctx.bezierCurveTo(sx - 30, gy + 15, sx + 20, gy + 25, sx + 40, gy + 40);
                ctx.stroke();
            }
        }

        // Top edge highlight
        const edges = { market: '#7a5430', town: '#5a3820', forest: '#1e1e08', deep: '#2a0c0c' };
        ctx.fillStyle = edges[theme] || edges.town;
        ctx.fillRect(0, gy, W, 4);

        // Darken everything outside the room's bounds
        ctx.fillStyle = 'rgba(0,0,0,0.6)';
        const left  = -this.camera.x;
        const right = room.width - this.camera.x;
        if (left > 0)  ctx.fillRect(0, 0, left, canvas.height);
        if (right < W) ctx.fillRect(right, 0, W - right, canvas.height);
    }

    /** Screen y of the ground line */
    _groundY() {
        return this.canvas.height - this.GROUND_MARGIN;
    }

    // ─────────────────────────────────────────────
    //  PROPS (per-theme scenery)
    // ─────────────────────────────────────────────
    drawProps(room) {
        switch (room.theme) {
            case 'market':
                this._drawLanternString(room);
                (room.npcs || []).forEach(n => this._drawStall(n));
                break;
            case 'town':
                this._drawTownHall();
                this._drawTorches([200, 900, 1300]);
                this._drawFountain(1000);
                break;
            case 'forest':
                this._drawDeadTrees([260, 560, 820, 1060, 1290, 1520], '#2a1808');
                this._drawFog('rgba(10,60,30,0.35)');
                this._drawSkulls([380, 760, 1250]);
                break;
            case 'deep':
                this._drawDeadTrees([200, 380, 560, 720, 1350, 1500], '#1a0606');
                this._drawGlowingEyes();
                this._drawFog('rgba(70,10,10,0.4)');
                this._drawSkulls([300, 650, 900, 1300, 1420]);
                this._drawThrone(1100);
                break;
        }
    }

    _drawTownHall() {
        const { ctx } = this;
        const sx = 60 - this.camera.x;
        const sy = this._groundY() - 180;

        // Body, roof, door, windows
        ctx.fillStyle = '#3a2c1c';
        ctx.fillRect(sx, sy, 220, 180);
        ctx.fillStyle = '#5a2010';
        ctx.beginPath();
        ctx.moveTo(sx - 10, sy); ctx.lineTo(sx + 110, sy - 60); ctx.lineTo(sx + 230, sy);
        ctx.closePath(); ctx.fill();
        ctx.fillStyle = '#1a0c04';
        ctx.fillRect(sx + 85, sy + 110, 50, 70);
        ctx.fillStyle = '#ffd060';
        ctx.globalAlpha = 0.7 + 0.15 * Math.sin(Date.now() / 900);
        ctx.fillRect(sx + 20, sy + 30, 40, 35);
        ctx.fillRect(sx + 160, sy + 30, 40, 35);
        ctx.globalAlpha = 1;

        // Sign
        ctx.fillStyle = '#c89040';
        ctx.font = 'bold 11px serif';
        ctx.textAlign = 'center';
        ctx.fillText('ETHERYN TOWN HALL', sx + 110, sy - 10);
    }

    _drawTorches(xs) {
        const { ctx } = this;
        const t = Date.now() / 1000;
        const gy = this._groundY();

        xs.forEach(wx => {
            const sx = wx - this.camera.x;
            const sy = gy - 60;

            // Glow, pole, flame
            const pulse = 0.18 + 0.07 * Math.sin(t * 2.5 + wx);
            const grd = ctx.createRadialGradient(sx, sy, 0, sx, sy, 120);
            grd.addColorStop(0, `rgba(255,160,40,${pulse})`);
            grd.addColorStop(1, 'rgba(255,80,0,0)');
            ctx.fillStyle = grd;
            ctx.fillRect(sx - 120, sy - 120, 240, 240);
            ctx.strokeStyle = '#5a3010';
            ctx.lineWidth = 4;
            ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(sx, gy); ctx.stroke();
            const fl = 8 + 3 * Math.sin(t * 8 + wx);
            ctx.fillStyle = '#ff8000';
            ctx.beginPath(); ctx.ellipse(sx, sy - fl / 2, 5, fl, 0, 0, Math.PI * 2); ctx.fill();
            ctx.fillStyle = '#ffff60';
            ctx.beginPath(); ctx.arc(sx, sy - 3, 3, 0, Math.PI * 2); ctx.fill();
        });
    }

    _drawFountain(wx) {
        const { ctx } = this;
        const sx = wx - this.camera.x;
        const gy = this._groundY();
        const t  = Date.now() / 300;

        // Basin, pillar, water arcs
        ctx.fillStyle = '#5a5060';
        ctx.fillRect(sx - 60, gy - 30, 120, 30);
        ctx.fillRect(sx - 8, gy - 75, 16, 45);
        ctx.strokeStyle = 'rgba(120,180,255,0.7)';
        ctx.lineWidth = 2;
        for (let i = -1; i <= 1; i += 2) {
            ctx.beginPath();
            ctx.moveTo(sx, gy - 75);
            ctx.quadraticCurveTo(sx + i * 30, gy - 100 + Math.sin(t) * 3, sx + i * 48, gy - 30);
            ctx.stroke();
        }
    }

    _drawLanternString(room) {
        const { ctx } = this;
        const gy = this._groundY();
        const t  = Date.now() / 1000;

        // Rope sagging between poles every 300px, with lanterns
        ctx.strokeStyle = '#2a1a10';
        ctx.lineWidth = 2;
        for (let wx = 0; wx < room.width; wx += 300) {
            const a = wx - this.camera.x, b = a + 300;
            ctx.beginPath();
            ctx.moveTo(a, gy - 230);
            ctx.quadraticCurveTo(a + 150, gy - 190, b, gy - 230);
            ctx.stroke();
            for (let k = 1; k <= 3; k++) {
                const lx = a + k * 75;
                const ly = gy - 230 + 40 * (1 - Math.pow((k * 75 - 150) / 150, 2)) * 0.5 + 10;
                ctx.fillStyle = `rgba(255,${150 + k * 20},60,${0.75 + 0.2 * Math.sin(t * 3 + k + wx)})`;
                ctx.beginPath(); ctx.arc(lx, ly, 6, 0, Math.PI * 2); ctx.fill();
            }
        }
    }

    /** Market stall behind a shopkeeper NPC, colour-coded by shop type */
    _drawStall(npc) {
        const { ctx } = this;
        const sx = npc.x - this.camera.x;
        const gy = this._groundY();
        const colors = { weapon: '#a03020', armor: '#3050a0', consumable: '#308040' };
        const labels = { weapon: '⚔ WEAPONS', armor: '🛡 ARMOR', consumable: '🧪 POTIONS' };
        const awning = colors[npc.shop] || '#806040';

        // Counter and posts
        ctx.fillStyle = '#5a3a1c';
        ctx.fillRect(sx - 90, gy - 150, 8, 150);
        ctx.fillRect(sx + 82, gy - 150, 8, 150);
        ctx.fillStyle = '#6a4424';
        ctx.fillRect(sx - 95, gy - 45, 190, 45);

        // Striped awning
        for (let i = 0; i < 8; i++) {
            ctx.fillStyle = i % 2 === 0 ? awning : '#e8d8b0';
            ctx.fillRect(sx - 100 + i * 25, gy - 175, 25, 30);
        }

        // Sign
        ctx.fillStyle = '#c89040';
        ctx.fillRect(sx - 55, gy - 205, 110, 24);
        ctx.fillStyle = '#1a0a04';
        ctx.font = 'bold 12px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(labels[npc.shop] || 'SHOP', sx, gy - 188);
    }

    _drawDeadTrees(xs, color) {
        const { ctx } = this;
        const baseY = this._groundY();

        xs.forEach((wx, i) => {
            const sx = wx - this.camera.x;
            const bx = sx + (i % 3 - 1) * 8, by = baseY - 140;

            // Trunk + forked branches
            ctx.save();
            ctx.strokeStyle = color;
            ctx.lineCap = 'round';
            ctx.lineWidth = 8;
            ctx.beginPath(); ctx.moveTo(sx, baseY); ctx.lineTo(bx, by); ctx.stroke();
            ctx.lineWidth = 4;
            ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(bx - 40, by - 40); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(bx + 35, by - 35); ctx.stroke();
            ctx.lineWidth = 2;
            ctx.beginPath(); ctx.moveTo(bx - 40, by - 40); ctx.lineTo(bx - 60, by - 62); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(bx - 40, by - 40); ctx.lineTo(bx - 22, by - 68); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(bx + 35, by - 35); ctx.lineTo(bx + 55, by - 62); ctx.stroke();
            ctx.restore();
        });
    }

    _drawFog(color) {
        const { ctx, canvas } = this;
        const gy = this._groundY();
        const fog = ctx.createLinearGradient(0, gy - 70, 0, gy);
        fog.addColorStop(0, 'rgba(0,0,0,0)');
        fog.addColorStop(1, color);
        ctx.fillStyle = fog;
        ctx.fillRect(0, gy - 70, canvas.width, 70);
    }

    _drawSkulls(xs) {
        const { ctx } = this;
        const gy = this._groundY();

        xs.forEach(wx => {
            const sx = wx - this.camera.x;
            const sy = gy - 10;
            ctx.fillStyle = '#c0c0a0';
            ctx.beginPath(); ctx.arc(sx, sy - 4, 9, 0, Math.PI * 2); ctx.fill();
            ctx.fillStyle = '#101010';
            ctx.fillRect(sx - 6, sy - 6, 4, 4);
            ctx.fillRect(sx + 2, sy - 6, 4, 4);
            ctx.fillStyle = '#b0b090';
            ctx.fillRect(sx - 5, sy + 3, 10, 5);
        });
    }

    _drawGlowingEyes() {
        const { ctx } = this;
        const gy = this._groundY();
        const t  = Date.now() / 1000;

        // Pairs of red eyes blinking in the dark
        [150, 470, 640, 980, 1450].forEach((wx, i) => {
            if (Math.sin(t * 0.7 + i * 2) < -0.6) return;  // blink
            const sx = wx - this.camera.x;
            const sy = gy - 170 - (i % 3) * 25;
            ctx.fillStyle = 'rgba(255,40,40,0.8)';
            ctx.fillRect(sx - 6, sy, 4, 2);
            ctx.fillRect(sx + 2, sy, 4, 2);
        });
    }

    _drawThrone(wx) {
        const { ctx } = this;
        const sx = wx - this.camera.x;
        const gy = this._groundY();

        // Crude bone-and-wood throne behind the Goblin King
        ctx.fillStyle = '#2a1408';
        ctx.fillRect(sx - 70, gy - 190, 140, 190);
        ctx.fillStyle = '#3a1c0c';
        ctx.fillRect(sx - 85, gy - 90, 170, 90);
        ctx.fillStyle = '#c0b090';
        for (let i = -2; i <= 2; i++) {
            ctx.beginPath(); ctx.arc(sx + i * 28, gy - 195, 9, 0, Math.PI * 2); ctx.fill();
        }
    }

    // ─────────────────────────────────────────────
    //  EXITS / PORTALS
    // ─────────────────────────────────────────────
    /** Signpost and glow at each path exit */
    drawExitSigns(room, roomNames) {
        const { ctx } = this;
        const gy = this._groundY();

        ['left', 'right'].forEach(side => {
            const dest = room.exits?.[side];
            if (!dest) return;
            const wx = side === 'left' ? 40 : room.width - 40;
            const sx = wx - this.camera.x;

            // Edge glow showing the path continues
            const edgeX = side === 'left' ? -this.camera.x : room.width - this.camera.x;
            const g = ctx.createLinearGradient(edgeX, 0, edgeX + (side === 'left' ? 60 : -60), 0);
            g.addColorStop(0, 'rgba(255,220,120,0.25)');
            g.addColorStop(1, 'rgba(255,220,120,0)');
            ctx.fillStyle = g;
            ctx.fillRect(Math.min(edgeX, edgeX + (side === 'left' ? 60 : -60)), gy - 140, 60, 140);

            // Post and arrow board
            ctx.fillStyle = '#5a3a1c';
            ctx.fillRect(sx - 3, gy - 90, 6, 90);
            const label = `${side === 'left' ? '◀ ' : ''}${roomNames[dest] || dest}${side === 'right' ? ' ▶' : ''}`;
            ctx.font = 'bold 11px Cinzel, serif';
            const w = ctx.measureText(label).width + 16;
            ctx.fillStyle = '#8a6030';
            ctx.fillRect(sx - w / 2, gy - 100, w, 20);
            ctx.fillStyle = '#1a0a04';
            ctx.textAlign = 'center';
            ctx.fillText(label, sx, gy - 86);
        });
    }

    drawPortal(room, portal, roomNames, hovered) {
        const { ctx } = this;
        const sx = portal.x - this.camera.x;
        const sy = this._groundY() - 70;
        const t  = Date.now() / 1000;
        const r  = 40;
        const colA = '#9040ff', colB = '#c080ff';

        // Pulsing glow
        ctx.save();
        ctx.globalAlpha = (hovered ? 0.55 : 0.35) + 0.15 * Math.sin(t * 3);
        ctx.fillStyle = colA;
        ctx.beginPath(); ctx.ellipse(sx, sy, r * 0.75 + 10, r + 12, 0, 0, Math.PI * 2); ctx.fill();
        ctx.restore();

        // Swirl arcs
        for (let i = 0; i < 4; i++) {
            const angle = t * 2 + (Math.PI / 2) * i;
            ctx.save();
            ctx.strokeStyle = i % 2 === 0 ? colA : colB;
            ctx.lineWidth = 4;
            ctx.globalAlpha = 0.85;
            ctx.beginPath();
            ctx.ellipse(sx, sy, (r - i * 4) * 0.75, r - i * 4, 0, angle, angle + Math.PI * 0.7);
            ctx.stroke();
            ctx.restore();
        }

        // Dark centre
        ctx.save();
        ctx.fillStyle = '#000020';
        ctx.globalAlpha = 0.85;
        ctx.beginPath(); ctx.ellipse(sx, sy, (r - 12) * 0.75, r - 12, 0, 0, Math.PI * 2); ctx.fill();
        ctx.restore();

        // Label
        ctx.fillStyle = colB;
        ctx.font = 'bold 12px Cinzel, serif';
        ctx.textAlign = 'center';
        ctx.fillText(`✦ ${roomNames[portal.to] || portal.label} ✦`, sx, sy - r - 12);
    }

    // ─────────────────────────────────────────────
    //  NPCs
    // ─────────────────────────────────────────────
    drawNPC(room, npc, marker, hovered) {
        const { ctx } = this;
        const sx = npc.x - this.camera.x;
        const sy = this._groundY();
        const t  = Date.now() / 1000;

        // Role palette
        const looks = {
            seraphel: { robe: '#2040a0', hem: '#102080', prop: 'staff' },
            brom:     { robe: '#6a4020', hem: '#3a2010', prop: 'hammer' },
            hilda:    { robe: '#707888', hem: '#40485a', prop: 'shield' },
            pip:      { robe: '#2a7040', hem: '#164020', prop: 'flask' },
        };
        const look = looks[npc.id] || looks.seraphel;

        // Hover aura
        if (hovered) {
            const aura = ctx.createRadialGradient(sx, sy - 35, 0, sx, sy - 35, 60);
            aura.addColorStop(0, 'rgba(255,220,60,0.3)');
            aura.addColorStop(1, 'rgba(255,220,60,0)');
            ctx.fillStyle = aura;
            ctx.fillRect(sx - 60, sy - 95, 120, 120);
        }

        // Body, hem, head, eyes
        ctx.fillStyle = look.robe;
        ctx.fillRect(sx - 12, sy - 52, 24, 44);
        ctx.fillStyle = look.hem;
        ctx.fillRect(sx - 15, sy - 10, 30, 10);
        ctx.fillStyle = '#e8c88a';
        ctx.beginPath(); ctx.arc(sx, sy - 62, 12, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#20209a';
        ctx.fillRect(sx - 5, sy - 65, 3, 3);
        ctx.fillRect(sx + 2, sy - 65, 3, 3);

        // Held prop
        ctx.lineCap = 'round';
        if (look.prop === 'staff') {
            ctx.strokeStyle = '#8a6020'; ctx.lineWidth = 3;
            ctx.beginPath(); ctx.moveTo(sx + 20, sy); ctx.lineTo(sx + 20, sy - 80); ctx.stroke();
            ctx.fillStyle = '#ffe060';
            ctx.beginPath(); ctx.arc(sx + 20, sy - 83, 6, 0, Math.PI * 2); ctx.fill();
        } else if (look.prop === 'hammer') {
            const swing = Math.sin(t * 3) * 0.3;
            ctx.save(); ctx.translate(sx + 18, sy - 35); ctx.rotate(swing);
            ctx.strokeStyle = '#6a4020'; ctx.lineWidth = 3;
            ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, -28); ctx.stroke();
            ctx.fillStyle = '#909090'; ctx.fillRect(-8, -36, 16, 10);
            ctx.restore();
        } else if (look.prop === 'shield') {
            ctx.fillStyle = '#3050a0';
            ctx.beginPath();
            ctx.moveTo(sx - 30, sy - 50); ctx.lineTo(sx - 14, sy - 50);
            ctx.lineTo(sx - 14, sy - 30); ctx.lineTo(sx - 22, sy - 20); ctx.lineTo(sx - 30, sy - 30);
            ctx.closePath(); ctx.fill();
        } else if (look.prop === 'flask') {
            ctx.fillStyle = `hsl(${(t * 60) % 360},80%,55%)`;
            ctx.beginPath(); ctx.arc(sx + 20, sy - 30, 7, 0, Math.PI * 2); ctx.fill();
            ctx.fillStyle = '#d0d0d0'; ctx.fillRect(sx + 18, sy - 42, 4, 6);
        }

        // Name + title tag
        ctx.font = 'bold 11px Cinzel, serif';
        const tagW = Math.max(ctx.measureText(npc.name).width, 60) + 20;
        ctx.fillStyle = 'rgba(0,0,0,0.7)';
        ctx.fillRect(sx - tagW / 2, sy - 110, tagW, 30);
        ctx.fillStyle = '#ffe060';
        ctx.textAlign = 'center';
        ctx.fillText(npc.name, sx, sy - 97);
        ctx.font = '9px sans-serif';
        ctx.fillStyle = '#c0b090';
        ctx.fillText(npc.title || '', sx, sy - 85);

        // Quest marker bobbing above the head
        if (marker) {
            ctx.font = 'bold 24px sans-serif';
            ctx.fillStyle = marker === '?' ? '#60ff60' : '#ffd700';
            ctx.fillText(marker, sx, sy - 118 + Math.sin(t * 4) * 3);
        }
    }

    // ─────────────────────────────────────────────
    //  MONSTERS
    // ─────────────────────────────────────────────
    drawMonsters(s) {
        const players = Object.values(s.players || {});

        Object.values(s.monsters || {}).forEach(m => {
            if (m.isDead || m.hp <= 0) return;

            // Chasing / returning monsters face where the server says; idle ones face the closest player
            let facing = m.facing === 'right' ? 1 : -1;
            const moving = m._tx !== undefined && Math.abs(m._tx - m.x) > 1;
            if (!m.aggro && !moving) {
                let best = Infinity;
                players.forEach(p => {
                    const d = Math.abs(p.x - m.x);
                    if (d < best) { best = d; facing = p.x < m.x ? -1 : 1; }
                });
            }

            const sx = m.x - this.camera.x;
            const sy = this._groundY();
            const flashing = Date.now() - (this.hitFlash.get(m.id) || 0) < 120;

            // Target ring
            if (s.targetId === m.id || s.hoverId === m.id) {
                this._drawTargetRing(sx, sy, m.width * 0.7, s.targetId === m.id);
            }

            // Body
            flipDraw(this.ctx, sx, sy, facing, () => {
                if (m.sprite === 'goblin_king') this._drawGoblinKing(flashing);
                else                            this._drawGoblin(flashing);
            });

            // Crushing Blow wind-up: pulsing red glow + warning
            const wind = this.windups.get(m.id);
            if (wind) {
                const p = (Date.now() - wind.born) / wind.delay;
                if (p >= 1) this.windups.delete(m.id);
                else {
                    this.ctx.save();
                    this.ctx.globalAlpha = 0.35 + 0.4 * p;
                    const g = this.ctx.createRadialGradient(sx, sy - m.height / 2, 0, sx, sy - m.height / 2, m.width);
                    g.addColorStop(0, 'rgba(255,40,20,0.8)');
                    g.addColorStop(1, 'rgba(255,40,20,0)');
                    this.ctx.fillStyle = g;
                    this.ctx.fillRect(sx - m.width, sy - m.height * 1.2, m.width * 2, m.height * 1.4);
                    this.ctx.restore();
                    this.ctx.fillStyle = '#ff4030';
                    this.ctx.font = 'bold 28px sans-serif';
                    this.ctx.textAlign = 'center';
                    this.ctx.fillText('!', sx, sy - m.height - 40 - p * 10);
                }
            }

            // Melee slash
            this._drawSlash(m.id, sx, sy - m.height * 0.5);

            // HP bar + name
            const barW = m.sprite === 'goblin_king' ? 100 : 50;
            const by   = sy - m.height - 18;
            const pct  = Math.max(0, m.hp / m.maxHp);
            this.ctx.fillStyle = 'rgba(0,0,0,0.6)';
            this.ctx.fillRect(sx - barW / 2 - 1, by - 1, barW + 2, 8);
            this.ctx.fillStyle = '#600000';
            this.ctx.fillRect(sx - barW / 2, by, barW, 6);
            this.ctx.fillStyle = pct > 0.5 ? '#20c020' : pct > 0.25 ? '#e0a020' : '#e02020';
            this.ctx.fillRect(sx - barW / 2, by, barW * pct, 6);
            this.ctx.fillStyle = m.sprite === 'goblin_king' ? '#ffb030' : '#ff6060';
            this.ctx.font = `bold ${m.sprite === 'goblin_king' ? 13 : 10}px sans-serif`;
            this.ctx.textAlign = 'center';
            this.ctx.fillText(m.name, sx, by - 5);
        });
    }

    /** Small green goblin, drawn facing right at origin (feet at 0,0) */
    _drawGoblin(flash) {
        const { ctx } = this;
        const skin = flash ? '#ffffff' : '#4a9a3a';
        const bob  = Math.sin(Date.now() / 200) * 1.5;

        // Legs, tunic, arms
        ctx.fillStyle = flash ? '#fff' : '#3a2a18';
        ctx.fillRect(-10, -14, 7, 14);
        ctx.fillRect(3, -14, 7, 14);
        ctx.fillStyle = flash ? '#fff' : '#6a4a2a';
        ctx.fillRect(-13, -38 + bob, 26, 26);
        ctx.fillStyle = skin;
        ctx.fillRect(-18, -34 + bob, 6, 16);

        // Head with long ears
        ctx.beginPath(); ctx.arc(0, -46 + bob, 12, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.moveTo(-10, -50 + bob); ctx.lineTo(-24, -58 + bob); ctx.lineTo(-9, -42 + bob); ctx.fill();
        ctx.beginPath(); ctx.moveTo(10, -50 + bob);  ctx.lineTo(24, -58 + bob);  ctx.lineTo(9, -42 + bob);  ctx.fill();

        // Eyes + grin
        ctx.fillStyle = flash ? '#f88' : '#ffee00';
        ctx.fillRect(1, -50 + bob, 4, 3);
        ctx.fillRect(7, -50 + bob, 3, 3);
        ctx.fillStyle = '#200';
        ctx.fillRect(2, -41 + bob, 8, 2);

        // Rusty dagger
        ctx.strokeStyle = flash ? '#fff' : '#a0a0a0';
        ctx.lineWidth = 3;
        ctx.beginPath(); ctx.moveTo(14, -26 + bob); ctx.lineTo(28, -40 + bob); ctx.stroke();
        ctx.fillStyle = skin;
        ctx.fillRect(12, -30 + bob, 6, 6);
    }

    /** Big Goblin King with crown, cape and club */
    _drawGoblinKing(flash) {
        const { ctx } = this;
        const skin = flash ? '#ffffff' : '#3a7a2a';
        const bob  = Math.sin(Date.now() / 350) * 2;

        // Cape
        ctx.fillStyle = flash ? '#fff' : '#6a0a1a';
        ctx.beginPath();
        ctx.moveTo(-30, -100 + bob); ctx.lineTo(-48, 0); ctx.lineTo(20, 0); ctx.lineTo(10, -100 + bob);
        ctx.closePath(); ctx.fill();

        // Legs + belly
        ctx.fillStyle = flash ? '#fff' : '#2a1a10';
        ctx.fillRect(-26, -30, 18, 30);
        ctx.fillRect(8, -30, 18, 30);
        ctx.fillStyle = skin;
        ctx.beginPath(); ctx.ellipse(0, -62 + bob, 38, 40, 0, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = flash ? '#fff' : '#5a3a1a';
        ctx.fillRect(-36, -42 + bob, 72, 8);

        // Head, ears, tusks, eyes
        ctx.fillStyle = skin;
        ctx.beginPath(); ctx.arc(0, -110 + bob, 22, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.moveTo(-18, -116 + bob); ctx.lineTo(-44, -130 + bob); ctx.lineTo(-16, -102 + bob); ctx.fill();
        ctx.beginPath(); ctx.moveTo(18, -116 + bob);  ctx.lineTo(44, -130 + bob);  ctx.lineTo(16, -102 + bob);  ctx.fill();
        ctx.fillStyle = '#f0e8d0';
        ctx.fillRect(2, -98 + bob, 4, 8);
        ctx.fillRect(12, -98 + bob, 4, 8);
        ctx.fillStyle = flash ? '#f88' : '#ff3010';
        ctx.shadowColor = '#ff0000'; ctx.shadowBlur = flash ? 0 : 8;
        ctx.fillRect(2, -116 + bob, 6, 4);
        ctx.fillRect(12, -116 + bob, 6, 4);
        ctx.shadowBlur = 0;

        // Crown
        ctx.fillStyle = flash ? '#fff' : '#e0b020';
        ctx.beginPath();
        ctx.moveTo(-18, -128 + bob);
        [-18, -12, -6, 0, 6, 12, 18].forEach((x, i) => ctx.lineTo(x, (i % 2 ? -140 : -150) + bob));
        ctx.lineTo(18, -128 + bob);
        ctx.closePath(); ctx.fill();

        // Spiked club
        ctx.strokeStyle = flash ? '#fff' : '#5a3a1a';
        ctx.lineWidth = 7;
        ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(36, -60 + bob); ctx.lineTo(62, -120 + bob); ctx.stroke();
        ctx.fillStyle = flash ? '#fff' : '#4a2a10';
        ctx.beginPath(); ctx.arc(64, -124 + bob, 12, 0, Math.PI * 2); ctx.fill();
    }

    // ─────────────────────────────────────────────
    //  PLAYERS
    // ─────────────────────────────────────────────
    drawPlayers(s) {
        // Draw others first so the local player is always on top
        const list = Object.values(s.players || {}).sort((a, b) =>
            (a.id === s.selfId) - (b.id === s.selfId));
        list.forEach(p => this._drawPlayer(p, s));
    }

    _drawPlayer(p, s) {
        const { ctx } = this;
        const isLocal = p.id === s.selfId;
        const sx = p.x - this.camera.x;
        const sy = this._groundY();
        const facing = p.facing === 'left' ? -1 : 1;
        const flashing = Date.now() - (this.hitFlash.get(p.id) || 0) < 120;

        // Downed players lie on the ground as a grey ghost
        if (p.downed) {
            this._drawDownedPlayer(p, sx, sy, isLocal, s);
            return;
        }

        // Ground ring: gold for self, red for target / hover
        if (s.targetId === p.id || s.hoverId === p.id) {
            this._drawTargetRing(sx, sy, 22, s.targetId === p.id);
        } else if (isLocal) {
            ctx.strokeStyle = 'rgba(255,220,60,0.5)';
            ctx.lineWidth = 3;
            ctx.beginPath(); ctx.ellipse(sx, sy + 2, 18, 5, 0, 0, Math.PI * 2); ctx.stroke();
        }

        // Blessing: soft blue aura behind the sprite
        if (p.buffs?.bless) {
            const g = ctx.createRadialGradient(sx, sy - 45, 0, sx, sy - 45, 45);
            g.addColorStop(0, 'rgba(120,170,255,0.35)');
            g.addColorStop(1, 'rgba(120,170,255,0)');
            ctx.fillStyle = g;
            ctx.fillRect(sx - 45, sy - 90, 90, 90);
        }

        // Berserk: pulsing red glow
        if (p.buffs?.berserk) {
            ctx.save();
            ctx.shadowColor = '#ff2020';
            ctx.shadowBlur  = 18 + 8 * Math.sin(Date.now() / 100);
        }

        // Class sprite (+ the Goblin King's Crown if worn)
        this._drawClassSprite(p, sx, sy, facing, flashing);
        if (p.equipment?.head?.id === 'goblin_crown') this._drawCrown(p.class, sx, sy, facing);
        if (p.buffs?.berserk) ctx.restore();

        // Divine Immunity: golden dome
        if (p.buffs?.immune) {
            ctx.save();
            ctx.strokeStyle = `rgba(255,224,96,${0.6 + 0.3 * Math.sin(Date.now() / 150)})`;
            ctx.fillStyle   = 'rgba(255,224,96,0.12)';
            ctx.lineWidth   = 3;
            ctx.beginPath(); ctx.ellipse(sx, sy - 45, 36, 60, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
            ctx.restore();
        }

        // Melee slash
        this._drawSlash(p.id, sx, sy - 35);

        // Stun: stars circling the head
        if (Date.now() < (p.stunnedUntil || 0)) {
            const t = Date.now() / 160;
            ctx.save();
            ctx.font = '13px sans-serif';
            ctx.textAlign = 'center';
            for (let i = 0; i < 3; i++) {
                const a = t + (Math.PI * 2 / 3) * i;
                ctx.fillStyle = '#ffe060';
                ctx.fillText('★', sx + Math.cos(a) * 16, sy - 92 + Math.sin(a) * 5);
            }
            ctx.restore();
        }

        // Attack-buff sparkles
        if (p.buffs?.atk) {
            const t = Date.now() / 300;
            for (let i = 0; i < 6; i++) {
                const a = t + (Math.PI * 2 / 6) * i;
                ctx.fillStyle = `rgba(255,${120 + i * 20},40,${0.6 + 0.4 * Math.sin(t + i)})`;
                ctx.beginPath(); ctx.arc(sx + Math.cos(a) * 24, sy - 40 + Math.sin(a) * 14, 2.5, 0, Math.PI * 2); ctx.fill();
            }
        }

        // Two-line tag: level on top (small, gold), name below (gold for self)
        const name  = p.name || '?';
        const level = `Lv ${p.level || 1}`;
        ctx.font = 'bold 11px sans-serif';
        const nameW = Math.max(ctx.measureText(name).width, 34) + 12;
        ctx.fillStyle = 'rgba(0,0,0,0.65)';
        ctx.fillRect(sx - nameW / 2, sy - 154, nameW, 30);   // high enough to clear a crown
        ctx.textAlign = 'center';
        ctx.font = 'bold 9px sans-serif';
        ctx.fillStyle = '#e0b040';
        ctx.fillText(level, sx, sy - 143);
        ctx.font = 'bold 11px sans-serif';
        ctx.fillStyle = isLocal ? '#ffe060' : '#ffffff';
        ctx.fillText(name, sx, sy - 129);

        // HP bar
        const hpW = 44;
        const hpPct = Math.max(0, (p.hp || 0) / (p.maxHp || 1));
        ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fillRect(sx - hpW / 2 - 1, sy - 122, hpW + 2, 7);
        ctx.fillStyle = '#400000';         ctx.fillRect(sx - hpW / 2, sy - 121, hpW, 5);
        ctx.fillStyle = hpPct > 0.5 ? '#20c020' : hpPct > 0.25 ? '#e0a020' : '#e02020';
        ctx.fillRect(sx - hpW / 2, sy - 121, hpW * hpPct, 5);

        // Crossed swords over duelists
        if (s.duelIds?.includes(p.id)) {
            ctx.font = '18px sans-serif';
            ctx.fillText('⚔️', sx, sy - 160);
        }
    }

    /**
     * Small gold crown on top of a class sprite (feet at sx, sy).
     * Height follows each class's headgear so it sits on top of it.
     */
    _drawCrown(cls, sx, sy, facing) {
        const tops = { warrior: -84, paladin: -84, healer: -86, mage: -106 };
        const top  = tops[cls] ?? -84;
        flipDraw(this.ctx, sx, sy, facing, () => {
            const ctx = this.ctx;
            ctx.fillStyle   = '#e8b820';
            ctx.strokeStyle = '#7a5a00';
            ctx.lineWidth   = 1;
            ctx.beginPath();
            ctx.moveTo(-10, top);
            [-10, -6, -3, 0, 3, 6, 10].forEach((x, i) => ctx.lineTo(x, top - (i % 2 ? 4 : 10)));
            ctx.lineTo(10, top);
            ctx.closePath();
            ctx.fill(); ctx.stroke();
            ctx.fillStyle = '#e02030';
            ctx.beginPath(); ctx.arc(0, top - 3, 2, 0, Math.PI * 2); ctx.fill();
        });
    }

    /**
     * Draw a player's character (class sprite, colour, crown) into another
     * canvas, e.g. the inventory paper doll. Faces left so the weapon hand
     * is on the left.
     */
    drawPortrait(canvas, p, scale = 1.4) {
        const saved = this.ctx;
        const ctx   = canvas.getContext('2d');
        this.ctx    = ctx;
        const fx = canvas.width / 2, fy = canvas.height - 8;

        // Soft glow behind the figure
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        const g = ctx.createRadialGradient(fx, fy - 70, 0, fx, fy - 70, 90);
        g.addColorStop(0, 'rgba(201,168,76,0.22)');
        g.addColorStop(1, 'rgba(201,168,76,0)');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        // Figure, scaled up from the in-world sprite
        ctx.save();
        ctx.translate(fx, fy);
        ctx.scale(scale, scale);
        this._drawClassSprite(p, 0, 0, -1, false);
        if (p.equipment?.head?.id === 'goblin_crown') this._drawCrown(p.class, 0, 0, -1);
        ctx.restore();

        this.ctx = saved;
    }

    _drawClassSprite(p, sx, sy, facing, flashing) {
        flipDraw(this.ctx, sx, sy, facing, () => {
            switch (p.class) {
                case 'mage':    this._drawMage(p.color, flashing);    break;
                case 'healer':  this._drawHealer(p.color, flashing);  break;
                case 'paladin': this._drawPaladin(p.color, flashing); break;
                default:        this._drawWarrior(p.color, flashing); break;
            }
        });
    }

    /** Lying, greyed-out body with a countdown tag. */
    _drawDownedPlayer(p, sx, sy, isLocal, s) {
        const { ctx } = this;

        // Revive-target ring when hovered / targeted
        if (s.targetId === p.id || s.hoverId === p.id) this._drawTargetRing(sx, sy, 40, s.targetId === p.id);

        // Sprite rotated onto its back
        ctx.save();
        ctx.globalAlpha = 0.5;
        ctx.filter = 'grayscale(1)';
        ctx.translate(sx, sy - 6);
        ctx.rotate(-Math.PI / 2);
        ctx.translate(-sx, -sy);
        this._drawClassSprite(p, sx, sy, 1, false);
        ctx.restore();

        // Rising ghost wisp
        const t = (Date.now() / 1200) % 1;
        ctx.save();
        ctx.globalAlpha = 0.5 * (1 - t);
        ctx.fillStyle = '#d0e0ff';
        ctx.beginPath(); ctx.arc(sx, sy - 30 - t * 40, 8, 0, Math.PI * 2); ctx.fill();
        ctx.restore();

        // Name + countdown
        const secs = Math.max(0, Math.ceil(((p.downedUntil || 0) - Date.now()) / 1000));
        const label = `💀 ${p.name} · ${secs}s`;
        ctx.font = 'bold 11px sans-serif';
        const w = ctx.measureText(label).width + 12;
        ctx.fillStyle = 'rgba(40,0,0,0.75)';
        ctx.fillRect(sx - w / 2, sy - 70, w, 16);
        ctx.fillStyle = isLocal ? '#ffe060' : '#ffb0b0';
        ctx.textAlign = 'center';
        ctx.fillText(label, sx, sy - 58);
    }

    // Class sprites — drawn facing right with feet at (0, 0)
    _drawWarrior(color, flash) {
        const { ctx } = this;
        ctx.fillStyle = flash ? '#fff' : (color || '#e04020');
        ctx.fillRect(-13, -62, 26, 42);
        ctx.fillStyle = flash ? '#fff' : '#808080';
        ctx.fillRect(-18, -62, 10, 10);
        ctx.fillRect(8, -62, 10, 10);
        ctx.fillStyle = '#e8c88a';
        ctx.beginPath(); ctx.arc(0, -72, 11, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#606060';
        ctx.fillRect(-11, -83, 22, 12);
        ctx.fillStyle = '#404040';
        ctx.fillRect(-12, -20, 10, 20);
        ctx.fillRect(2, -20, 10, 20);
        ctx.strokeStyle = '#c0c0c0'; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.moveTo(18, -40); ctx.lineTo(18, -82); ctx.stroke();
        ctx.strokeStyle = '#804020'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(13, -50); ctx.lineTo(23, -50); ctx.stroke();
    }

    _drawMage(color, flash) {
        const { ctx } = this;
        ctx.fillStyle = flash ? '#fff' : (color || '#4040c0');
        ctx.beginPath();
        ctx.moveTo(-10, -65); ctx.lineTo(10, -65); ctx.lineTo(18, 0); ctx.lineTo(-18, 0);
        ctx.closePath(); ctx.fill();
        ctx.fillStyle = '#a0a0ff';
        ctx.font = '8px sans-serif'; ctx.textAlign = 'center';
        ctx.fillText('✦', -3, -30);
        ctx.fillText('✦', 4, -48);
        ctx.fillStyle = '#e8c88a';
        ctx.beginPath(); ctx.arc(0, -74, 10, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = flash ? '#fff' : (color || '#4040c0');
        ctx.beginPath(); ctx.moveTo(-13, -82); ctx.lineTo(0, -108); ctx.lineTo(13, -82); ctx.closePath(); ctx.fill();
        ctx.fillRect(-16, -84, 32, 5);
        ctx.strokeStyle = '#8a6020'; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.moveTo(20, 0); ctx.lineTo(20, -85); ctx.stroke();
        ctx.fillStyle = '#80e0ff';
        ctx.shadowColor = '#40c0ff'; ctx.shadowBlur = 8;
        ctx.beginPath(); ctx.arc(20, -88, 7, 0, Math.PI * 2); ctx.fill();
        ctx.shadowBlur = 0;
    }

    _drawHealer(color, flash) {
        const { ctx } = this;

        // White robe with coloured sash
        ctx.fillStyle = flash ? '#fff' : '#ece6d8';
        ctx.beginPath();
        ctx.moveTo(-10, -64); ctx.lineTo(10, -64); ctx.lineTo(16, 0); ctx.lineTo(-16, 0);
        ctx.closePath(); ctx.fill();
        ctx.fillStyle = flash ? '#fff' : (color || '#40a060');
        ctx.fillRect(-11, -40, 22, 5);
        ctx.fillRect(-3, -64, 6, 64);

        // Head, hood, halo
        ctx.fillStyle = '#e8c88a';
        ctx.beginPath(); ctx.arc(0, -73, 10, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = flash ? '#fff' : '#ece6d8';
        ctx.beginPath(); ctx.arc(0, -74, 12, Math.PI, 0); ctx.fill();
        ctx.strokeStyle = 'rgba(255,230,120,0.9)';
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.ellipse(0, -92, 11, 3, 0, 0, Math.PI * 2); ctx.stroke();

        // Staff with a green crystal
        ctx.strokeStyle = '#b08840'; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.moveTo(19, 0); ctx.lineTo(19, -80); ctx.stroke();
        ctx.fillStyle = '#70ffa0';
        ctx.shadowColor = '#40ff80'; ctx.shadowBlur = 8;
        ctx.beginPath(); ctx.moveTo(19, -94); ctx.lineTo(25, -84); ctx.lineTo(19, -78); ctx.lineTo(13, -84); ctx.closePath(); ctx.fill();
        ctx.shadowBlur = 0;
    }

    _drawPaladin(color, flash) {
        const { ctx } = this;
        ctx.fillStyle = flash ? '#fff' : (color || '#c0a020');
        ctx.fillRect(-13, -62, 26, 42);
        ctx.fillStyle = '#e0c040';
        ctx.fillRect(-8, -58, 16, 20);
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(-2, -56, 4, 14);
        ctx.fillRect(-7, -51, 14, 4);
        ctx.fillStyle = '#e8c88a';
        ctx.beginPath(); ctx.arc(0, -72, 11, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#c0a020';
        ctx.fillRect(-11, -83, 22, 12);
        ctx.fillStyle = '#e0e0e0';
        ctx.beginPath(); ctx.moveTo(-11, -77); ctx.bezierCurveTo(-25, -90, -22, -98, -14, -88); ctx.closePath(); ctx.fill();
        ctx.beginPath(); ctx.moveTo(11, -77);  ctx.bezierCurveTo(25, -90, 22, -98, 14, -88);  ctx.closePath(); ctx.fill();
        ctx.fillStyle = '#c0a020'; ctx.strokeStyle = '#806010'; ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(-24, -58); ctx.lineTo(-24, -38); ctx.lineTo(-16, -28); ctx.lineTo(-8, -38); ctx.lineTo(-8, -58);
        ctx.closePath(); ctx.fill(); ctx.stroke();
        ctx.fillStyle = '#908010';
        ctx.fillRect(-12, -20, 10, 20);
        ctx.fillRect(2, -20, 10, 20);
    }

    _drawTargetRing(sx, sy, rx, solid) {
        const { ctx } = this;
        ctx.save();
        ctx.strokeStyle = solid ? 'rgba(255,60,60,0.9)' : 'rgba(255,200,200,0.5)';
        ctx.lineWidth = solid ? 3 : 2;
        if (!solid) ctx.setLineDash([5, 4]);
        ctx.beginPath(); ctx.ellipse(sx, sy + 2, rx, rx * 0.28, 0, 0, Math.PI * 2); ctx.stroke();
        ctx.restore();
    }

    // ─────────────────────────────────────────────
    //  ATTACK EFFECTS
    // ─────────────────────────────────────────────
    /**
     * Visualise an attack between two entities. Physical = slash arc on the
     * attacker; magic = bolt flying to the target.
     */
    showAttack(attacker, target, damageType) {
        if (!attacker) return;
        const dir = target ? (target.x >= attacker.x ? 1 : -1) : 1;

        // Magic bolt
        if (damageType === 'magic' && target) {
            this.projectiles.push({
                fx: attacker.x + dir * 20, fy: attacker.y - 60,
                tx: target.x, ty: target.y - 40,
                color: '#5aa9ff', born: Date.now(),
            });
            return;
        }

        // Melee slash
        this.slashEffects.set(attacker.id, { born: Date.now(), dir, color: '#ffffff' });
    }

    /** Short burst ring for buffs / heals cast */
    showCast(entity, color) {
        if (!entity) return;
        this.puffs.push({ wx: entity.x, wy: entity.y - 40, born: Date.now(), color, ring: true });
    }

    _drawSlash(id, sx, sy) {
        const slash = this.slashEffects.get(id);
        if (!slash) return;
        const age = Date.now() - slash.born;
        if (age > 200) { this.slashEffects.delete(id); return; }

        // Fading arc in front of the attacker
        const { ctx } = this;
        const p = age / 200;
        ctx.save();
        ctx.strokeStyle = `rgba(255,240,200,${1 - p})`;
        ctx.lineWidth = 4;
        ctx.beginPath();
        if (slash.dir > 0) ctx.arc(sx + 18, sy, 26, -1.2 + p, 0.9 + p);
        else               ctx.arc(sx - 18, sy, 26, Math.PI - 0.9 - p, Math.PI + 1.2 - p);
        ctx.stroke();
        ctx.restore();
    }

    drawProjectiles() {
        const { ctx } = this;
        const now = Date.now();

        this.projectiles = this.projectiles.filter(b => {
            const p = (now - b.born) / 250;
            if (p >= 1) return false;

            // Interpolated glowing orb (or a spear shaft)
            const x = b.fx + (b.tx - b.fx) * p - this.camera.x;
            const y = b.fy + (b.ty - b.fy) * p - this.camera.y;
            if (b.spear) {
                const ang = Math.atan2(b.ty - b.fy, b.tx - b.fx);
                ctx.save();
                ctx.translate(x, y); ctx.rotate(ang);
                ctx.strokeStyle = '#6a4020'; ctx.lineWidth = 4;
                ctx.beginPath(); ctx.moveTo(-34, 0); ctx.lineTo(10, 0); ctx.stroke();
                ctx.fillStyle = '#d0d0d0';
                ctx.beginPath(); ctx.moveTo(10, -5); ctx.lineTo(22, 0); ctx.lineTo(10, 5); ctx.closePath(); ctx.fill();
                ctx.restore();
                return true;
            }
            ctx.save();
            ctx.fillStyle = b.color;
            ctx.shadowColor = b.color; ctx.shadowBlur = 14;
            ctx.beginPath(); ctx.arc(x, y, 7, 0, Math.PI * 2); ctx.fill();
            ctx.restore();
            return true;
        });
    }

    /** Telegraph a boss Crushing Blow. */
    addWindup(monsterId, delay) {
        this.windups.set(monsterId, { born: Date.now(), delay: delay || 800 });
    }

    /** Ground Slam shockwave rolling out to `radius`. */
    addShockwave(x, radius) {
        this.shockwaves.push({ x, radius, born: Date.now() });
    }

    drawShockwaves() {
        const { ctx } = this;
        const now = Date.now();
        const gy  = this._groundY();

        this.shockwaves = this.shockwaves.filter(w => {
            const p = (now - w.born) / 500;
            if (p >= 1) return false;

            // Dusty brown ring + cracks
            const sx = w.x - this.camera.x;
            ctx.save();
            ctx.globalAlpha = 1 - p;
            ctx.strokeStyle = '#c08040';
            ctx.lineWidth = 6 * (1 - p) + 2;
            ctx.beginPath(); ctx.ellipse(sx, gy, w.radius * p, 14 + 10 * p, 0, 0, Math.PI * 2); ctx.stroke();
            ctx.fillStyle = 'rgba(140,90,40,0.25)';
            ctx.fill();
            ctx.restore();
            return true;
        });
    }

    /** Spear Toss: a long brown projectile from the boss to its target. */
    addSpear(from, to) {
        if (!from || !to) return;
        this.projectiles.push({
            fx: from.x, fy: from.y - 100, tx: to.x, ty: to.y - 50,
            color: '#c0a070', born: Date.now(), spear: true,
        });
    }

    /** Golden level-up burst on a player (seen by everyone in the map). */
    addLevelBurst(entityId) {
        this.levelBursts.push({ entityId, born: Date.now() });
    }

    drawLevelBursts(s) {
        const { ctx } = this;
        const now = Date.now();
        const gy  = this._groundY();

        this.levelBursts = this.levelBursts.filter(b => {
            const p = (now - b.born) / 1600;
            const e = s.players?.[b.entityId];
            if (p >= 1 || !e) return false;
            const sx = e.x - this.camera.x, cy = gy - 50;

            ctx.save();
            ctx.globalAlpha = 1 - p;

            // Pillar of light
            const g = ctx.createLinearGradient(0, cy - 160, 0, gy);
            g.addColorStop(0, 'rgba(255,220,90,0)');
            g.addColorStop(1, 'rgba(255,220,90,0.45)');
            ctx.fillStyle = g;
            ctx.fillRect(sx - 26, cy - 160, 52, gy - cy + 160);

            // Spinning rays
            ctx.strokeStyle = '#ffe070';
            ctx.lineWidth = 3;
            ctx.shadowColor = '#ffc020'; ctx.shadowBlur = 12;
            for (let i = 0; i < 10; i++) {
                const a = (Math.PI * 2 / 10) * i + p * 2;
                const r0 = 20 + p * 30, r1 = 40 + p * 70;
                ctx.beginPath();
                ctx.moveTo(sx + Math.cos(a) * r0, cy + Math.sin(a) * r0 * 0.7);
                ctx.lineTo(sx + Math.cos(a) * r1, cy + Math.sin(a) * r1 * 0.7);
                ctx.stroke();
            }

            // Expanding ring on the ground
            ctx.beginPath();
            ctx.ellipse(sx, gy, 20 + p * 90, 6 + p * 18, 0, 0, Math.PI * 2);
            ctx.stroke();

            // Rising sparkles
            ctx.fillStyle = '#fff6c0';
            for (let i = 0; i < 8; i++) {
                const px = sx + Math.sin(i * 1.7) * 30;
                const py = gy - 20 - ((p * 140 + i * 17) % 140);
                ctx.beginPath(); ctx.arc(px, py, 2.5, 0, Math.PI * 2); ctx.fill();
            }
            ctx.restore();
            return true;
        });
    }

    /** Expanding ring for area skills (Cleave, Consecrate, Sanctuary, Blessing). */
    showAoe(x, radius, color) {
        if (x === undefined || !radius) return;
        this.aoes.push({ x, radius, color, born: Date.now() });
    }

    drawAoes() {
        const { ctx } = this;
        const now = Date.now();
        const gy  = this._groundY();

        this.aoes = this.aoes.filter(a => {
            const p = (now - a.born) / 600;
            if (p >= 1) return false;

            // Flat ellipse on the ground growing to the skill's radius
            ctx.save();
            ctx.globalAlpha = 1 - p;
            ctx.strokeStyle = a.color;
            ctx.fillStyle   = a.color;
            ctx.lineWidth   = 4;
            ctx.beginPath();
            ctx.ellipse(a.x - this.camera.x, gy, a.radius * (0.3 + 0.7 * p), 18, 0, 0, Math.PI * 2);
            ctx.stroke();
            ctx.globalAlpha = 0.15 * (1 - p);
            ctx.fill();
            ctx.restore();
            return true;
        });
    }

    /** Jagged bolts through a list of entities (caster first). */
    addLightning(entities) {
        if (entities.length < 2) return;
        this.lightning.push({ points: entities.map(e => ({ x: e.x, y: e.y - 50 })), born: Date.now() });
    }

    drawLightning() {
        const { ctx } = this;
        const now = Date.now();

        this.lightning = this.lightning.filter(l => {
            const p = (now - l.born) / 350;
            if (p >= 1) return false;

            // Zig-zag segment between each pair of points
            ctx.save();
            ctx.globalAlpha = 1 - p;
            ctx.strokeStyle = '#a0d8ff';
            ctx.shadowColor = '#60b0ff'; ctx.shadowBlur = 12;
            ctx.lineWidth = 3;
            ctx.beginPath();
            for (let i = 0; i < l.points.length - 1; i++) {
                const a = l.points[i], b = l.points[i + 1];
                ctx.moveTo(a.x - this.camera.x, a.y - this.camera.y);
                for (let k = 1; k <= 5; k++) {
                    const t = k / 6;
                    ctx.lineTo(a.x + (b.x - a.x) * t - this.camera.x,
                               a.y + (b.y - a.y) * t - this.camera.y + (Math.random() * 20 - 10));
                }
                ctx.lineTo(b.x - this.camera.x, b.y - this.camera.y);
            }
            ctx.stroke();
            ctx.restore();
            return true;
        });
    }

    /** Meteor falling onto world x over `delay` ms, then an impact blast. */
    addMeteor(x, delay, radius) {
        if (x === null || x === undefined) return;
        this.meteors.push({ x, radius, delay: delay || 1500, born: Date.now() });
    }

    drawMeteors() {
        const { ctx } = this;
        const now = Date.now();
        const gy  = this._groundY();

        this.meteors = this.meteors.filter(m => {
            const age = now - m.born;
            if (age > m.delay + 700) return false;
            const sx = m.x - this.camera.x;

            // Target marker + falling fireball
            if (age < m.delay) {
                const p = age / m.delay;
                ctx.save();
                ctx.strokeStyle = `rgba(255,80,40,${0.4 + 0.4 * Math.sin(now / 80)})`;
                ctx.lineWidth = 2;
                ctx.setLineDash([8, 6]);
                ctx.beginPath(); ctx.ellipse(sx, gy, m.radius, 20, 0, 0, Math.PI * 2); ctx.stroke();
                ctx.restore();
                const fx = sx - 250 * (1 - p), fy = gy - 520 * (1 - p);
                ctx.save();
                ctx.fillStyle = '#ffb040';
                ctx.shadowColor = '#ff4000'; ctx.shadowBlur = 30;
                ctx.beginPath(); ctx.arc(fx, fy, 22, 0, Math.PI * 2); ctx.fill();
                ctx.strokeStyle = 'rgba(255,120,40,0.6)'; ctx.lineWidth = 10;
                ctx.beginPath(); ctx.moveTo(fx, fy); ctx.lineTo(fx - 70, fy - 140); ctx.stroke();
                ctx.restore();
                return true;
            }

            // Impact explosion
            const p = (age - m.delay) / 700;
            ctx.save();
            ctx.globalAlpha = 1 - p;
            const g = ctx.createRadialGradient(sx, gy - 30, 0, sx, gy - 30, m.radius * (0.5 + p));
            g.addColorStop(0, 'rgba(255,240,180,0.9)');
            g.addColorStop(0.4, 'rgba(255,120,30,0.7)');
            g.addColorStop(1, 'rgba(120,20,0,0)');
            ctx.fillStyle = g;
            ctx.fillRect(sx - m.radius * 2, gy - m.radius * 2, m.radius * 4, m.radius * 2.4);
            ctx.restore();
            return true;
        });
    }

    /** Monster death puff */
    addPuff(entity, color) {
        if (!entity) return;
        this.puffs.push({ wx: entity.x, wy: entity.y - (entity.height || 60) / 2, born: Date.now(), color: color || 'rgba(160,160,160,' });
    }

    drawPuffs() {
        const { ctx } = this;
        const now = Date.now();

        this.puffs = this.puffs.filter(f => {
            const p = (now - f.born) / 500;
            if (p >= 1) return false;
            const sx = f.wx - this.camera.x, sy = f.wy - this.camera.y;

            // Ring burst (casts) or smoke puff (deaths)
            ctx.save();
            ctx.globalAlpha = 1 - p;
            if (f.ring) {
                ctx.strokeStyle = f.color; ctx.lineWidth = 3;
                ctx.beginPath(); ctx.arc(sx, sy, 10 + p * 40, 0, Math.PI * 2); ctx.stroke();
            } else {
                for (let i = 0; i < 6; i++) {
                    const a = (Math.PI * 2 / 6) * i;
                    ctx.fillStyle = f.color + (0.6 * (1 - p)) + ')';
                    ctx.beginPath(); ctx.arc(sx + Math.cos(a) * p * 40, sy + Math.sin(a) * p * 30, 12 * (1 - p) + 4, 0, Math.PI * 2); ctx.fill();
                }
            }
            ctx.restore();
            return true;
        });
    }

    /** Flash an entity white when hit */
    flash(entityId) {
        this.hitFlash.set(entityId, Date.now());
    }

    // ─────────────────────────────────────────────
    //  DAMAGE NUMBERS
    // ─────────────────────────────────────────────
    /**
     * @param {number} wx World X
     * @param {number} wy World Y
     * @param {string|number} value Text to display
     * @param {'physical'|'magic'|'heal'|'xp'|'gold'|'info'} type
     * @param {boolean} [big] Crit styling
     */
    addDamageNumber(wx, wy, value, type = 'physical', big = false) {
        const colors = {
            physical: '#ff9a3c', magic: '#5aa9ff', heal: '#40ff80',
            xp: '#c080ff', gold: '#ffd060', info: '#ffffff',
        };
        this.damageNumbers.push({
            wx: wx + (Math.random() * 16 - 8), wy,
            value,
            color: colors[type] || '#ffffff',
            big,
            born: Date.now(),
        });
    }

    drawDamageNumbers() {
        const { ctx } = this;
        const now = Date.now();

        this.damageNumbers = this.damageNumbers.filter(d => {
            const age = now - d.born;
            if (age > 1400) return false;

            // Float up and fade
            const p  = age / 1400;
            const sx = d.wx - this.camera.x;
            const sy = (d.wy - this.camera.y) - p * 50;
            ctx.save();
            ctx.globalAlpha = 1 - p;
            ctx.fillStyle = d.color;
            ctx.font = `bold ${d.big ? 22 : 15}px sans-serif`;
            ctx.textAlign = 'center';
            ctx.strokeStyle = 'rgba(0,0,0,0.8)'; ctx.lineWidth = 3;
            ctx.strokeText(d.value, sx, sy);
            ctx.fillText(d.value, sx, sy);
            ctx.restore();
            return true;
        });
    }

    // ─────────────────────────────────────────────
    //  EMOTES
    // ─────────────────────────────────────────────
    addEmote(entityId, emote) {
        const emoteMap = { wave: '👋', dance: '💃', bow: '🙇', cheer: '🎉', laugh: '😂', cry: '😢' };
        this.emotes.push({ entityId, emote: emoteMap[emote] || emote, born: Date.now() });
    }

    drawEmotes(s) {
        const { ctx } = this;
        const now = Date.now();

        this.emotes = this.emotes.filter(e => {
            if (now - e.born > 2500) return false;
            const p = s.players?.[e.entityId];
            if (!p) return false;

            // Bob above the head, fade out at the end
            const progress = (now - e.born) / 2500;
            const sx = p.x - this.camera.x;
            const sy = this._groundY() - 178 - Math.sin(progress * Math.PI * 4) * 4;
            ctx.save();
            ctx.globalAlpha = progress < 0.7 ? 1 : 1 - ((progress - 0.7) / 0.3);
            ctx.font = '26px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText(e.emote, sx, sy);
            ctx.restore();
            return true;
        });
    }
}

/**
 * Translate to (sx, sy), mirror horizontally when facing left, run draw(), restore.
 * @param {CanvasRenderingContext2D} ctx
 */
function flipDraw(ctx, sx, sy, facing, draw) {
    ctx.save();
    ctx.translate(sx, sy);
    if (facing < 0) ctx.scale(-1, 1);
    draw();
    ctx.restore();
}

window.Renderer = new CanvasRenderer(document.getElementById('game-canvas'));
