# AshesAndAether WebClient — TODO

Server features that exist but have no client UI yet, roughly prioritized.

---

## High Priority

### Character Sheet / Stats Panel - Done for now
Server sends full `coreStats` (str, vit, dex, agi, int, wis) and ~18 `derivedStats`
(attackRating, defenseRating, evasion, glancingBlowChance, magicAttack, etc.)
on world_entry and state_update. None of this is displayed anywhere.
- Also: `statPoints` available for spending, `level`, `experience`

### Corruption System - Done for now
4-state machine: Clean → Stained → Warped → Lost (0-100 value).
Server sends `corruption_update` events and corruption data in CharacterState.
Benefits at higher corruption: cacheDetectionBonus, hazardResistBonus, deadSystemInterface.
- Needs: corruption meter/indicator on HUD, benefit descriptions, state transitions

### Status Effects / Buffs & Debuffs
Server sends effect id/name/duration in state_update payloads.
No buff/debuff icons displayed anywhere — important for combat readability.
- Needs: icon strip near action bar or player frame

### Special Charges / Combo Points
`combat.specialCharges` (e.g. `{"combo_point": 3}`) sent in state_update.
Not displayed — critical for ability-based combat feedback.
- Needs: charge indicators above action bar or on HUD

---

## Medium Priority

### Party System - V1
Full party management implemented server-side: invite, accept, decline, leave, kick,
lead, list. Redis-backed member tracking. Party chat channel exists.
- Needs: party frames (member HP/mana bars), invite dialog, party chat tab

### Market / Trading
Buy/sell/search/cancel orders, 2% listing fee, regional & world scope.
Complete WalletService for gold tracking.
- Needs: market window, order list, buy/sell dialogs, wallet/gold display

### Harvesting / Foraging
12+ plant species with growth stages. `/harvest` command exists server-side.
Plants render as entities but no interaction prompt.
- Needs: harvest interaction when clicking/targeting a plant, gather progress

### Item Detail Fields
`durability`, `properties`, `iconUrl` fields on ItemInfo are sent but
InventoryWindow only shows name/type/quantity.
- Needs: enhanced tooltips with durability bar, property list, icon display

### Entity Descriptions
Every entity has a `description` field. TargetWindow only shows name + HP.
- Needs: description text in target window or examine tooltip

---

## Low Priority

### Player Peek / Inspect
Server supports `player_peek_response` with level, title, guild, appearance,
equipment, pronouns, combat status, AFK status.
- Needs: inspect window when clicking other players

### Proximity Roster Visualization
Full spatial awareness with distance channels: touch, say, shout, see, hear, cfh.
Each channel has entity count, sample names, bearing/elevation/range.
- Needs: proximity HUD or "who's nearby" panel

### Zone Metadata Display
`description`, `lighting`, `contentRating` fields sent on zone entry.
Currently unused.
- Needs: zone entry splash or info panel

### Companion / NPC Inhabitant System
LLM-powered NPC control: inhabit_request/granted/denied/revoked flow.
- Needs: NPC selection UI, inhabit control panel, timer display

### Special Loadout (4 slots)
`specialLoadout` tracked in PlayerState but has no UI.
- Needs: determine purpose, add slots to ability window or action bar

### Unlocked Feats
`unlockedFeats` string array sent on world_entry but never displayed.
- Needs: feat log or achievement-style display

---

## Minor Gaps

- `character_roster_delta` event subscribed but never handled
- `pong` event subscribed but no latency display
- Character appearance hardcoded to `'TBD'` during creation
- `unlockedFeats` received but not stored or displayed
