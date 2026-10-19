# Gladys Beem Energy — external integration

External integration that connects [Beem Energy](https://beem.energy) solar kits
(BeemBox, Beem On) to [Gladys Assistant](https://gladysassistant.com), built
with the official JavaScript SDK
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js).

> **User documentation** (configuration, widgets, savings, alerts,
> troubleshooting): [`docs/en.md`](docs/en.md) · [`docs/fr.md`](docs/fr.md).
> The store re-hosts these and Gladys links to them from the integration's
> Configuration screen. This README is the developer overview.

## What it does

- Signs in to the Beem cloud with the account of the Beem application
  (`POST /user/login`), keeps the token about an hour and stops calling the API
  for 20 minutes after a 429.
- Discovers every solar box of the account (`GET /devices`, re-read hourly)
  and reads all of them in one request (`POST /box/summary`) every
  `poll_frequency` seconds: power, production of the day and of the month,
  Wi-Fi signal, last report.
- Publishes, per box, the power (`energy-production-sensor` / `power`), a
  lifetime production **index** (`energy-production-sensor` / `index`, the
  feature Gladys' energy monitoring turns into thirty-minute production), the
  production of the day (`daily-production`) and the Wi-Fi quality
  (`signal`).
- Keeps under `/data` its own index (grown by the month total, the previous
  month's final total fetched on a month change), the daily and monthly
  totals and 48 h of 5-minute power averages; fetches the monthly history at
  startup.
- Four dashboard widgets (`box`, `site` single-phase / three-phase, `savings`,
  `history`), two scene triggers (`box_underperforming`,
  `daily_production_report`) and one scene action (`get_production`).

The Beem API is not public: the endpoints and field names are those documented
by the community, notably the Home Assistant integration
[CharlesP44/Beem_Energy](https://github.com/CharlesP44/Beem_Energy) (MIT
License). Only those facts are reused.

## Installation & updates

Requires **Gladys Assistant 5.1.0 or later** (`gladys_version` in the
manifest).

Once listed in the Gladys integration catalog (category _Energy_): open
**Integrations**, search for "Beem" and install it. Every release publishes the
multi-arch image `ghcr.io/terdious/gladys-beem-energy:<version>` (and `:latest`)
and its GitHub Release, whose notes are the matching section of
[`CHANGELOG.md`](CHANGELOG.md).

To test a development build, paste the manifest
(`gladys-assistant-integration.json`) under **Integrations → Install an
integration → Developer mode**: the summary of a manual run of the **Build and
publish image** workflow prints the manifest already pointing at that build.

## Project structure

```
index.js                  SDK wiring only: handlers registered before connect()
src/beem/client.js        Beem cloud REST client (token, 401 retry, 429 lock)
src/beem/boxes.js         /devices and /box/summary payloads -> box snapshots
src/devices/box.js        the Gladys device of a box, its features and states
src/site.js               the installation: refresh loop, topology, history backfill
src/store.js              /data store: lifetime index, days, months, power samples
src/production.js         sums over the boxes, series, underperformance detection
src/savings.js            tariff, value of a solar kWh, payback
src/alerts.js             scene triggers (underperforming box, daily report)
src/scenes.js             scene action handlers (manifest `scene_actions`)
src/actions.js            Configuration screen actions (manifest `actions`)
src/widgets.js            dashboard widget registry (manifest `widgets`)
src/dashboard/*.js        one file per widget content, plus shared helpers
src/config.js             DEFAULT_CONFIG (mirrors the manifest defaults) + normalization
src/time.js               local calendar of a timezone
test/                     node --test, against the SDK's fake Gladys and a fake Beem cloud
```

## Run it locally

```bash
npm install
GLADYS_HOST_API_URL="http://localhost:1443" \
GLADYS_INTEGRATION_TOKEN="<token>" \
GLADYS_INTEGRATION_SELECTOR="beem-energy" \
BEEM_DATA_DIR="./data" \
LOG_LEVEL=debug \
npm start
```

The three `GLADYS_*` variables are injected by the Gladys supervisor when the
integration runs inside its sandboxed container. `BEEM_DATA_DIR` (default
`/data`) is where the production store is saved.

## Development

Node.js 22 or later.

```bash
npm install
npm run format:check   # Prettier
npm run lint           # ESLint
npm test               # unit tests (node --test), never on the network
npx github:GladysAssistant/integration-store .   # store admission rules
```

Describe each change under `## [Unreleased]` in [`CHANGELOG.md`](CHANGELOG.md).
A release is cut from **Actions → Release → Run workflow** (patch / minor /
major): it bumps `package.json` and the manifest (`version` + `docker_image`),
rolls the changelog, tags `vX.Y.Z`, publishes the image and the GitHub Release.

## Translations

Every text the user reads ships in English and French: the manifest, the
runtime messages (connection status in `src/site.js`, action messages in
`src/actions.js`, widget texts in `src/dashboard/`) and the user documentation
(`docs/en.md`, `docs/fr.md`, same outline). `test/manifest.test.js` fails when a
manifest text misses a language.

## License

Apache-2.0
