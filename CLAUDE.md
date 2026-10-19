# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration**: a Node.js service (Node 22+, ESM,
no build step) that runs in its own sandboxed Docker container and talks to
Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js),
its only runtime dependency. It started from the official JavaScript template and follows the layout of
the other Terdious integrations (gladys-zendure, gladys-netatmo, gladys-tuya).

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
node --test test/site.test.js             # one file
node --test --test-name-pattern "three-phase"    # tests whose name matches
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run format                            # Prettier, fix in place
npx github:GladysAssistant/integration-store .   # store admission checks
```

The CI (`.github/workflows/ci.yml`) runs `format:check`, `lint` and `test` on
Node 22 and 24, and builds the Docker image: run the three commands before
pushing.

## Architecture

```
index.js                          SDK wiring only: handlers registered before connect()
src/beem/client.js                Beem cloud REST client (login, token cache, 401 retry, 429 lock)
src/beem/boxes.js                 /devices and /box/summary payloads -> plain box snapshots
src/devices/box.js                Gladys device of a box: features (keys forever) and states
src/site.js                       the installation: refresh loop, topology, month change, history backfill
src/store.js                      /data store: lifetime index, day / month totals, power samples, event marks
src/production.js                 sums over boxes, day / month / power series, underperformance detection
src/savings.js                    tariff, value of a solar kWh, payback
src/alerts.js                     scene triggers (manifest `scene_triggers`)
src/scenes.js                     scene action handlers (manifest `scene_actions`)
src/actions.js                    Configuration screen actions (manifest `actions`)
src/widgets.js, src/dashboard/    dashboard widgets (manifest `widgets`), one file per widget
src/config.js                     DEFAULT_CONFIG (mirrors the manifest defaults) + normalization
src/time.js                       local calendar of the configured timezone
gladys-assistant-integration.json manifest: name, config_schema, actions, widgets, scenes, image...
docs/en.md, docs/fr.md            user documentation, re-hosted by Gladys (mandatory)
test/                             node --test, SDK fake Gladys + fake Beem cloud (test/helpers)
.github/scripts/release.mjs       release helpers (manifest bump, changelog), tested in test/
```

The Beem API is not public (endpoints documented by the community): keep every
field read in `src/beem/boxes.js`, with aliases, so a payload change is fixed in
one place.

## Rules

- **External ids are forever.** Build them with
  `gladys.externalIds(type, platformId)`, `platformId` being the unique id the
  platform gives the device (serial, cloud id, MAC), never a label. Gladys keys
  devices, their history, scenes and dashboards on them: changing one creates a
  new device and orphans the old one. The same goes for every key users store:
  manifest `config_schema`, `actions`, widget and scene keys, feature keys.
- **The container rootfs is read-only.** Write only under `/data`, the one
  writable volume. Never log tokens, passwords or API keys.
- **Versions belong to the Release workflow** (Actions → Release). Never edit
  `version` in `package.json` or in the manifest, nor the `docker_image` tag,
  by hand — except on the README's hand-pushed tag path, which bumps all three
  together before tagging. `test/manifest.test.js` checks they agree.
- **Changelog.** Every user-visible change adds a line under `## [Unreleased]`
  in `CHANGELOG.md` (`### Added`, `Changed`, `Fixed`, `Removed`, `Security`).
  Never write a version heading: the Release workflow moves the section, and it
  becomes the notes of the GitHub Release.
- **Manifest.** Texts are multi-language objects `{ "en": ..., "fr": ... }`:
  `label`, `description` and `placeholder` alike, never a plain string. The
  catalog `description` holds 10 to 100 characters per language. A field the
  older cores do not know needs a higher `gladys_version` minimum
  (`categories`: 4.86.0; `widgets`, `scene_triggers`, `scene_actions`,
  `type: "provider"`: 5.1.0). `test/manifest.test.js` ties the manifest to the
  code (defaults, action, scene and widget handlers): change both sides
  together.
- **User-facing text** is bilingual (English and French): action messages,
  manifest texts, and `docs/en.md` / `docs/fr.md`, kept in sync.
- **Style.** Prettier formats, ESLint catches mistakes. Comments explain why,
  in English. Tests never touch the network.
