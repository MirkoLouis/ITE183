/**
  * @fileoverview input.js - Keyboard & Mouse Input Manager for Realms of Etheryn
  * @description Centralises all player input:  WASD/arrow movement, skill
  *              hotkeys, panel toggles, canvas click-to-attack, and emote
  *              shortcuts typed in the chat box.
  * @module InputManager
  */

'use strict';

/**
  * @class InputManager
  * @description Tracks keyboard state and canvas mouse clicks, translates raw
  *              browser events into game-level intents, and drives the movement
  *              loop at 60 fps via requestAnimationFrame.
  */
class InputManager {
    constructor() {
        /** @type {Set<string>} Normalised key identifiers that are currently held. */
        this.keys = new Set();

        /**
          * @type {Object|null} Reference to the game object (set in `init()`).
          * Used so the input manager can call game-level methods directly.
          */
        this._game = null;

        /** @type {HTMLCanvasElement|null} The main game canvas. */
        this._canvas = null;

        /**
          * @type {Map<string, Function[]>}
          * Named callbacks registered externally (e.g. 'skill', 'panel', 'emote').
          */
        this._callbacks = new Map();

        /**
          * @type {number|null} requestAnimationFrame handle for the movement loop.
          */
        this._rafId = null;

        /**
          * @type {boolean} Whether the chat input currently has keyboard focus.
          * When true, WASD/arrow keys are NOT forwarded to movement.
          */
        this._chatFocused = false;

        /**
          * @type {Map<string, number>}
          * Timestamps of the last time each single-press key was triggered.
          * Used to distinguish a tap from a hold.
          */
        this._lastKeyDown = new Map();

        /**
          * @type {Map<string, boolean>}
          * Tracks whether a key's single-press action has already fired during
          * the current press so we don't repeat it on every frame.
          */
        this._singleFired = new Map();

        /** @type {number} Debounce window in ms for single-press actions. */
        this._DEBOUNCE_MS = 200;

        /** @type {Object} Camera / world-offset supplied by game.js for coordinate conversion. */
        this._camera = { x: 0, y: 0 };
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // INITIALISATION
    // ─────────────────────────────────────────────────────────────────────────────

    /**
      * Attach all event listeners and start the movement loop.
      * Must be called once after the DOM and canvas are ready.
      *
      * @param {HTMLCanvasElement} canvas  - The game's rendering canvas.
      * @param {Object}            gameRef - Reference to the main game object.
      */
    init(canvas, gameRef) {
        this._canvas = canvas;
        this._game   = gameRef;

        // Keyboard listeners on window so they work even when canvas isn't focused.
        window.addEventListener('keydown', (e) => this._onKeyDown(e));
        window.addEventListener('keyup',   (e) => this._onKeyUp(e));

        // Mouse / pointer listeners on the canvas only.
        this._canvas.addEventListener('click',       (e) => this._onCanvasClick(e));
        this._canvas.addEventListener('contextmenu', (e) => { e.preventDefault(); this._onCanvasRightClick(e); });

        // Chat input focus tracking – look for the element now or observe later.
        this._hookChatInput();

        // Start the 60 fps movement loop.
        this._startMovementLoop();

        console.log('[Input] Initialised – canvas:', canvas.id || canvas);
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // CHAT INPUT FOCUS TRACKING
    // ─────────────────────────────────────────────────────────────────────────────

    /**
      * Finds the chat input element and sets up focus/blur listeners.
      * If the element is not yet in the DOM, uses a MutationObserver to wait.
      * @private
      */
    _hookChatInput() {
        const tryHook = () => {
            const chatInput = document.getElementById('chat-input');
            if (!chatInput) return false;

            chatInput.addEventListener('focus', () => { this._chatFocused = true; });
            chatInput.addEventListener('blur',  () => { this._chatFocused = false; });

            // Also intercept the Enter key inside chat for emote shortcuts.
            chatInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    this._handleChatSubmit(chatInput.value.trim());
                    chatInput.value = '';
                    chatInput.blur();
                }
            });
            return true;
        };

        if (!tryHook()) {
            // DOM not ready yet – observe for insertion.
            const observer = new MutationObserver(() => {
                if (tryHook()) observer.disconnect();
            });
            observer.observe(document.body, { childList: true, subtree: true });
        }
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // KEYBOARD EVENTS
    // ─────────────────────────────────────────────────────────────────────────────

    /**
      * Normalise a KeyboardEvent into a short string for set membership.
      * @private
      * @param {KeyboardEvent} e
      * @returns {string} e.g. 'w', 'arrowleft', 'enter'
      */
    _normalise(e) {
        return e.key.toLowerCase();
    }

    /**
      * Handle keydown – adds to held set and fires single-press actions.
      * @private
      * @param {KeyboardEvent} e
      */
    _onKeyDown(e) {
        const key = this._normalise(e);

        // Allow browser shortcuts (Ctrl+…) to pass through unmodified.
        if (e.ctrlKey || e.metaKey) return;

        const wasHeld = this.keys.has(key);
        this.keys.add(key);

        if (!wasHeld) {
            // Record the timestamp of the initial press.
            this._lastKeyDown.set(key, performance.now());
            this._singleFired.set(key, false);
        }

        // ── Chat focus toggle ────────────────────────────────────────────────────
        if (key === 'enter' && !this._chatFocused) {
            e.preventDefault();
            const chatInput = document.getElementById('chat-input');
            if (chatInput) chatInput.focus();
            return;
        }

        // While typing in chat, suppress all game hotkeys.
        if (this._chatFocused) return;

        // ── Prevent browser scroll on arrow/space ────────────────────────────────
        const suppressBrowser = ['arrowup','arrowdown','arrowleft','arrowright',' '];
        if (suppressBrowser.includes(key)) e.preventDefault();

        // ── Single-press hotkeys (fire once per press) ───────────────────────────
        if (!wasHeld) {
            this._handleHotkey(key, e);
        }
    }

    /**
      * Handle keyup – removes from held set.
      * @private
      * @param {KeyboardEvent} e
      */
    _onKeyUp(e) {
        const key = this._normalise(e);
        this.keys.delete(key);
        this._lastKeyDown.delete(key);
        this._singleFired.delete(key);
    }

    /**
      * Fire single-press panel toggles, skill hotkeys, and item shortcuts.
      * @private
      * @param {string}       key - Normalised key string.
      * @param {KeyboardEvent} e
      */
    _handleHotkey(key, e) {
        switch (key) {
            // ── Skills ──────────────────────────────────────────────────────────────
            case 'q':
                this._dispatch('skill', { skillIndex: 0, skillId: 'skill1' });
                break;
            case 'e':
                this._dispatch('skill', { skillIndex: 1, skillId: 'skill2' });
                break;
            case 'r':
                // Use a health potion from inventory.
                this._dispatch('useItem', { itemId: 'health_potion' });
                break;

            // ── UI panel toggles ─────────────────────────────────────────────────────
            case 'i':
                this._dispatch('panel', { panel: 'inventory' });
                break;
            case 'j':
                this._dispatch('panel', { panel: 'quests' });
                break;
            case 'k':
                this._dispatch('panel', { panel: 'stats' });
                break;
            case 'm':
                this._dispatch('panel', { panel: 'map' });
                break;
            case 'escape':
                this._dispatch('panel', { panel: 'close_all' });
                break;

            default:
                break;
        }
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // CHAT SUBMIT & EMOTE DETECTION
    // ─────────────────────────────────────────────────────────────────────────────

    /**
      * Called when the player presses Enter inside the chat box.
      * Detects /emote shortcuts; otherwise emits a normal chat message.
      * @private
      * @param {string} text - Raw trimmed text from the chat input.
      */
    _handleChatSubmit(text) {
        if (!text) return;

        // Emote shortcuts: /wave, /dance, /bow (case-insensitive).
        const emoteMatch = text.match(/^\/(\w+)$/i);
        if (emoteMatch) {
            const emote = emoteMatch[1].toLowerCase();
            const validEmotes = new Set(['wave', 'dance', 'bow', 'cheer', 'sit', 'laugh']);
            if (validEmotes.has(emote)) {
                this._dispatch('emote', { emote });
                return; // Don't also send as chat.
            }
        }

        // Regular chat message.
        this._dispatch('chat', { message: text });
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // CANVAS MOUSE INPUT
    // ─────────────────────────────────────────────────────────────────────────────

    /**
      * Convert a MouseEvent into canvas-relative pixel coordinates.
      * @private
      * @param {MouseEvent} e
      * @returns {{ cx:number, cy:number }} Canvas-relative coords.
      */
    _canvasCoords(e) {
        const rect = this._canvas.getBoundingClientRect();
        // Account for CSS scaling between the canvas logical and displayed sizes.
        const scaleX = this._canvas.width  / rect.width;
        const scaleY = this._canvas.height / rect.height;
        return {
            cx: (e.clientX - rect.left) * scaleX,
            cy: (e.clientY - rect.top)  * scaleY,
        };
    }

    /**
      * Convert canvas coordinates to world coordinates using the current camera.
      * @param {number} cx - Canvas X.
      * @param {number} cy - Canvas Y.
      * @returns {{ wx:number, wy:number }}
      */
    canvasToWorld(cx, cy) {
        return {
            wx: cx + this._camera.x,
            wy: cy + this._camera.y,
        };
    }

    /**
      * Update the camera offset so coordinate conversion stays accurate.
      * Called each frame by game.js.
      * @param {number} x - Camera world X.
      * @param {number} y - Camera world Y.
      */
    setCamera(x, y) {
        this._camera.x = x;
        this._camera.y = y;
    }

    /**
      * Handle a left-click on the canvas.  Fires the 'canvasClick' event with
      * both canvas-relative and world coordinates.
      * @private
      * @param {MouseEvent} e
      */
    _onCanvasClick(e) {
        const { cx, cy } = this._canvasCoords(e);
        const { wx, wy } = this.canvasToWorld(cx, cy);
        this._dispatch('canvasClick', { cx, cy, wx, wy, button: 0 });
    }

    /**
      * Handle a right-click on the canvas (context menu suppressed).
      * Could be used for alternate actions such as inspecting entities.
      * @private
      * @param {MouseEvent} e
      */
    _onCanvasRightClick(e) {
        const { cx, cy } = this._canvasCoords(e);
        const { wx, wy } = this.canvasToWorld(cx, cy);
        this._dispatch('canvasClick', { cx, cy, wx, wy, button: 2 });
    }

    /**
      * Register a click listener on the canvas.
      * Convenience wrapper kept for backward compatibility with older game.js code.
      *
      * @param {HTMLCanvasElement} _canvas   - Ignored (uses canvas from init()).
      * @param {Function}          callback  - Called with { cx, cy, wx, wy, button }.
      */
    onCanvasClick(_canvas, callback) {
        this.on('canvasClick', callback);
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // MOVEMENT LOOP (60 fps)
    // ─────────────────────────────────────────────────────────────────────────────

    /**
      * Start the requestAnimationFrame loop that emits movement vectors.
      * @private
      */
    _startMovementLoop() {
        const loop = () => {
            this._rafId = requestAnimationFrame(loop);

            // Skip movement processing while typing in chat.
            if (this._chatFocused) return;

            const vec = this.getMovementVector();
            if (vec.dx !== 0 || vec.dy !== 0) {
                this._dispatch('move', vec);
            }
        };
        this._rafId = requestAnimationFrame(loop);
    }

    /**
      * Stop the movement loop (e.g. when the game is paused).
      */
    stopMovementLoop() {
        if (this._rafId !== null) {
            cancelAnimationFrame(this._rafId);
            this._rafId = null;
        }
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // PUBLIC QUERY API
    // ─────────────────────────────────────────────────────────────────────────────

    /**
      * Calculate the normalised movement vector from currently held keys.
      * Supports WASD and arrow keys simultaneously; diagonal movement is allowed.
      *
      * @returns {{ dx:number, dy:number }} Each component is -1, 0, or 1.
      */
    getMovementVector() {
        let dx = 0;
        let dy = 0;

        if (this.keys.has('w') || this.keys.has('arrowup'))    dy -= 1;
        if (this.keys.has('s') || this.keys.has('arrowdown'))  dy += 1;
        if (this.keys.has('a') || this.keys.has('arrowleft'))  dx -= 1;
        if (this.keys.has('d') || this.keys.has('arrowright')) dx += 1;

        return { dx, dy };
    }

    /**
      * Check if a key is currently held.
      * @param {string} key - Normalised key string (e.g. 'w', 'shift', 'enter').
      * @returns {boolean}
      */
    isKeyDown(key) {
        return this.keys.has(key.toLowerCase());
    }

    /**
      * Determine whether a key has been held longer than the debounce threshold.
      * Useful for distinguishing a tap (single action) from a sustained press.
      *
      * @param {string} key       - Normalised key string.
      * @param {number} [thresholdMs=200] - How many ms before it counts as a hold.
      * @returns {boolean} `true` if the key has been held past the threshold.
      */
    isHeld(key, thresholdMs = this._DEBOUNCE_MS) {
        const k = key.toLowerCase();
        if (!this.keys.has(k)) return false;
        const downAt = this._lastKeyDown.get(k);
        return downAt !== undefined && (performance.now() - downAt) > thresholdMs;
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // CALLBACK SYSTEM
    // ─────────────────────────────────────────────────────────────────────────────

    /**
      * Register a listener for an internal input event.
      *
      * @param {string}   event    - Event name: 'move', 'skill', 'panel',
      *                              'canvasClick', 'chat', 'emote', 'useItem'.
      * @param {Function} callback - Called with event-specific payload.
      * @returns {InputManager} `this` for chaining.
      */
    on(event, callback) {
        if (!this._callbacks.has(event)) {
            this._callbacks.set(event, []);
        }
        this._callbacks.get(event).push(callback);
        return this;
    }

    /**
      * Remove a listener.
      * @param {string}    event
      * @param {Function} [callback] - Omit to remove all listeners for `event`.
      * @returns {InputManager} `this` for chaining.
      */
    off(event, callback) {
        if (!callback) {
            this._callbacks.delete(event);
        } else {
            const list = this._callbacks.get(event) || [];
            this._callbacks.set(event, list.filter((cb) => cb !== callback));
        }
        return this;
    }

    /**
      * Fire all registered listeners for `event`.
      * @private
      * @param {string} event
      * @param {*}      payload
      */
    _dispatch(event, payload) {
        const list = this._callbacks.get(event);
        if (!list) return;
        for (const cb of list) {
            try { cb(payload); }
            catch (err) { console.error(`[Input] Error in "${event}" handler:`, err); }
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// SINGLETON EXPORT
// ─────────────────────────────────────────────────────────────────────────────

/**
  * Global singleton – import via `window.Input` anywhere in the client.
  * @type {InputManager}
  */
window.Input = new InputManager();
