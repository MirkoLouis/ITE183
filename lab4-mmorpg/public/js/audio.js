/**
  * AudioManager — Realms of Etheryn
  * All sounds are generated programmatically via Web Audio API.
  * No external audio files needed.
  */
class AudioManager {
    constructor() {
        this.ctx = null;
        this.masterGain = null;
        this.enabled = true;
        this.volume = 0.4;
        this._initialized = false;
    }

    /** Call on first user gesture to satisfy browser autoplay policy */
    init() {
        if (this._initialized) return;
        try {
            this.ctx = new (window.AudioContext || window.webkitAudioContext)();
            this.masterGain = this.ctx.createGain();
            this.masterGain.gain.value = this.volume;
            this.masterGain.connect(this.ctx.destination);
            this._initialized = true;
        } catch (e) {
            console.warn('[Audio] Web Audio API not available:', e);
        }
    }

    /** Internal: create and connect an oscillator burst */
    _play(type, freqStart, freqEnd, duration, gainVal = 0.3) {
        if (!this._initialized || !this.enabled) return;
        try {
            const osc = this.ctx.createOscillator();
            const gain = this.ctx.createGain();
            osc.connect(gain);
            gain.connect(this.masterGain);

            osc.type = type;
            const now = this.ctx.currentTime;
            osc.frequency.setValueAtTime(freqStart, now);
            osc.frequency.exponentialRampToValueAtTime(Math.max(freqEnd, 1), now + duration);

            gain.gain.setValueAtTime(gainVal, now);
            gain.gain.exponentialRampToValueAtTime(0.001, now + duration);

            osc.start(now);
            osc.stop(now + duration + 0.05);
        } catch (e) { /* ignore */ }
    }

    /** Short percussive click — basic attack */
    playAttack() {
        this._play('square', 200, 100, 0.1, 0.2);
    }

    /** Rising tone — skill used */
    playSkill() {
        this._play('sine', 300, 600, 0.3, 0.25);
    }

    /** Low thud — player/monster takes damage */
    playHurt() {
        this._play('sawtooth', 150, 80, 0.15, 0.35);
    }

    /** Triumphant arpeggio — level up (C4-E4-G4-C5) */
    playLevelUp() {
        if (!this._initialized || !this.enabled) return;
        const notes = [261.63, 329.63, 392.00, 523.25];
        notes.forEach((freq, i) => {
            setTimeout(() => this._play('sine', freq, freq, 0.15, 0.4), i * 120);
        });
    }

    /** Two quick high pings — gold/loot pickup */
    playCoinPickup() {
        this._play('sine', 800, 800, 0.05, 0.3);
        setTimeout(() => this._play('sine', 1200, 1200, 0.05, 0.3), 70);
    }

    /** Whoosh — portal travel */
    playPortal() {
        this._play('sine', 800, 200, 0.4, 0.2);
    }

    /** Descending tone — player death */
    playDeath() {
        this._play('sine', 400, 100, 0.8, 0.3);
    }

    /** Soft blip — chat message received */
    playChat() {
        this._play('sine', 600, 600, 0.05, 0.15);
    }

    /** Set master volume 0.0 – 1.0 */
    setVolume(vol) {
        this.volume = Math.max(0, Math.min(1, vol));
        if (this.masterGain) this.masterGain.gain.value = this.volume;
    }

    /** Toggle audio on/off */
    toggle() {
        this.enabled = !this.enabled;
        if (this.masterGain) {
            this.masterGain.gain.value = this.enabled ? this.volume : 0;
        }
        return this.enabled;
    }
}

window.Audio = new AudioManager();
