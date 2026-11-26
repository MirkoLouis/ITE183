# Realms of Etheryn: Browser MMORPG

ITE183 Laboratory Activity 4. A real-time multiplayer 2D side-scrolling RPG that runs in the browser. Players pick a class, explore rooms, fight goblins together, take quests, trade at shops, and duel each other.

## Tech stack
| Layer | Technology |
|---|---|
| Server | Node.js, Express 4 (static files), Socket.IO 4 (real-time events) |
| Client | Plain HTML/CSS/JavaScript, HTML5 Canvas rendering, Socket.IO client |
| Dev | nodemon (auto-restart) |

The server is **authoritative**: it owns combat, damage, rewards, quests, shops and room transitions. Clients only report their own x position and facing direction, and they render the `game:state` and event updates the server broadcasts.

## Getting started
Requirements: Node.js (tested with v22) and npm.

```bash
cd lab4-mmorpg
npm install
npm start          # or: npm run dev  (auto-restart with nodemon)
```

Open http://localhost:3000. To test multiplayer, open it in a second browser window or tab. The port can be changed with the `PORT` environment variable, e.g. `PORT=4000 npm start`.

## Gameplay
**Classes** (max level 5). Each class has 4 skills on Q / W / E / R:

| Class | Role | Skills |
|---|---|---|
| Warrior | High HP and defence | Shield Bash, Cleave, War Cry, Berserk |
| Mage | Ranged magic damage | Fireball, Chain Lightning, Arcane Surge, Meteor Strike |
| Paladin | Fights and heals | Holy Strike, Consecrate, Divine Heal, Divine Immunity |
| Healer | Keeps the party alive | Mend, Sanctuary, Blessing, Revive |

**World** (left → right):

| Room | Safe | What's there |
|---|---|---|
| Etheryn Market | yes | Shops: Brom (weapons), Hilda (armor), Pip (potions) |
| Etheryn Town | yes | Seraphel (quest giver), portal to Doomwood Forest |
| Doomwood Forest | no | Goblins |
| Deeper Forest | no | Goblins and the Goblin King boss |

**Quests** (a chain from Seraphel):
1. *Goblin Trouble*: defeat 3 Goblins.
2. *Crown of Rot*: defeat the Goblin King (unlocked by quest 1).

**Social:** chat, emotes (`/wave`, `/bow`, `/dance`, `/laugh`, `/cry`, `/cheer`), inspecting other players, and 1-v-1 duels (request → accept/decline).

## Controls
| Input | Action |
|---|---|
| A / D or ← / → | Move |
| Left-click | Move to, interact with NPCs or portals, attack monsters, open a player's menu (inspect / duel) |
| Q / W / E / R | Class skills 1–4 |
| F / G | Health / mana potion |
| T | Toggle auto-battle |
| J / K / L | Inventory / quests / stats panels |
| 1–9 | Choose a target when the target picker is open |
| Enter | Focus chat (Enter again sends) |
| Esc | Leave chat, close panels, cancel the current action |

## Project structure
```
lab4-mmorpg/
├── package.json
├── server/
│   ├── index.js       Express + Socket.IO server; all game logic and event handlers
│   ├── gameData.js    Static data: ITEMS, CLASSES, SKILLS, QUESTS, ROOMS, MONSTER_TEMPLATES, spawns
│   └── utils.js       Shared helpers
└── public/
    ├── index.html     Page, HUD markup and styles
    └── js/
        ├── game.js      Game loop, keyboard/mouse input, click-to-move, auto-attack
        ├── network.js   Socket.IO client wrapper (all emit/on in one place)
        ├── renderer.js  Canvas drawing
        ├── ui.js        Panels, modals (NPC dialogue, shop, inspect), chat
        ├── audio.js     Sound effects
        └── input.js     Alternative input manager (loaded but not initialised; game.js handles input)
```

## Socket.IO events
**Client → server:** `player:join`, `player:move`, `player:skill`, `player:emote`, `player:inspect`, `player:respawn`, `combat:attack`, `room:change`, `chat:send`, `inventory:use`, `inventory:equip`, `shop:buy`, `quest:accept`, `quest:complete`, `duel:request`, `duel:accept`, `duel:decline`

**Server → client** (main ones): `game:state`, `player:joined` / `player:left` / `player:moved`, `combat:damage`, `monster:died` / `monster:respawned` / `monsters:moved`, `player:levelup`, `player:xpGold`, `quest:accepted` / `quest:completed`, `shop:bought`, `inventory:updated`, `duel:started` / `duel:ended`, `boss:defeated`, `chat:message` / `chat:system`, and `error:*` for rejected actions.

The full list is in the header comment of `public/js/network.js`.

## Contributing (group members)
1. Branch from `main`: `git switch -c <type>/<short-description>` (e.g. `feat/lab4-new-room`, `fix/lab4-duel-timeout`).
2. Keep changes inside `lab4-mmorpg/`. Game content (items, rooms, quests, monsters) belongs in `server/gameData.js`, and new network events go through `public/js/network.js`.
3. Run it locally with two browser windows to check multiplayer behaviour.
4. Open a pull request into `main` that says what changed and how you tested it.
