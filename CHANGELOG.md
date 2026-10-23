# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

## [1.2.2] - 2026-10-23

### Fixed

- Daily history: the hourly production of a week gets 60 s to answer instead
  of 20 s, a backfill stopped by an error resumes on its own an hour later
  (no restart nor **Reload the history** needed), and the weeks before the
  first month of production are not asked
  ([#7](https://github.com/Terdious/gladys-beem-energy/issues/7)).

## [1.2.1] - 2026-10-23

### Fixed

- Daily history: a week whose answer holds no day of any box is asked again
  at the next start instead of never, and the range is sent as local times
  with their offset, like the Beem application does
  ([#5](https://github.com/Terdious/gladys-beem-energy/issues/5)).

### Added

- **Diagnose the boxes** shows the shape of the hourly history answer and of a
  cloud summary entry (field names and types only, no value) when no past day
  could be read, to fix the parsing on a real account
  ([#5](https://github.com/Terdious/gladys-beem-energy/issues/5)).

## [1.2.0] - 2026-10-23

### Added

- Site, history and savings widgets: a **Period** button (a form with the
  periods of the widget on Gladys 5.2+, the next period on an older core) and
  **Previous** / **Next** buttons to browse the past periods, like the charts
  of the core. Site: 12 hours, day (power curves), week, month (production per
  day), year (per month); history and savings: month (per day), year (per
  month), all the years (per year). Tiles and rows follow the period; the
  history compares it with the same period one year before, like for like
  ([#3](https://github.com/Terdious/gladys-beem-energy/issues/3)).
- Daily history of the past days, fetched at startup from the hourly
  production of the Beem application (up to 400 days, one week per request,
  each week once); the **Diagnose the boxes** action tells how many days each
  box has ([#3](https://github.com/Terdious/gladys-beem-energy/issues/3)).

### Changed

- The 5-minute power averages are kept 14 days instead of 48 hours (the curves
  of the past days).
- History widget: the **Period** setting becomes the **Default period**
  (`days` → month, `months_12` / `months_24` → year)
  ([#3](https://github.com/Terdious/gladys-beem-energy/issues/3)).

## [1.1.0] - 2026-10-19

### Added

- Box widget: the **cuts of the day** — the moments of 5 minutes or more the
  box produced nothing while the other boxes produced, with the time of the
  last one — to diagnose a box that connects and disconnects
  ([#1](https://github.com/Terdious/gladys-beem-energy/issues/1)).
- Box widget: an **expected** curve next to the power curve of the day (the
  power the box would have at the median load of the other boxes), and a row
  with the yield of the box against the median of the boxes, always shown
  ([#1](https://github.com/Terdious/gladys-beem-energy/issues/1)).

### Changed

- Box widget: the power curve uses the 5-minute averages of the integration
  instead of the raw history (no more sawtooth from the 30 W steps of the
  cloud); the panel orientation reads as a compass point (`SE -30° · ∠30°`);
  the lifetime row tells its first month; yesterday is hidden until it is
  known ([#1](https://github.com/Terdious/gladys-beem-energy/issues/1)).
- Site, savings and history widgets: no heading repeating the card title, only
  the title set in the widget settings; the peak power gauges are no longer
  orange whatever their value
  ([#1](https://github.com/Terdious/gladys-beem-energy/issues/1)).

## [1.0.0] - 2026-10-19

### Added

- First release: discovery of every solar box of a Beem account (BeemBox 300 W
  kits, Beem On 500 W kits) through the Beem cloud, with their current power,
  production of the day, lifetime production index (Gladys energy monitoring)
  and Wi-Fi signal, read every two minutes in one request for all the boxes.
- Monthly production history fetched from the Beem cloud at startup (year and
  lifetime figures), and an index that loses nothing across a month change or a
  container downtime.
- Dashboard widgets: one box, the whole installation (single-phase or
  three-phase with one row per phase, power curve of the day and phase
  balance), the savings estimate (base or peak / off-peak tariff,
  self-consumption rate, resale, payback of the installation, CO2 avoided) and
  the production history (per day or per month, records, comparison with last
  year, ranking of the boxes).
- Detection of the boxes that produce clearly less than the others (silent
  box, low yield per kWp), shown on the dashboard and fired as the "Box
  underperforming" scene trigger; a "Daily production report" scene trigger at
  the end of the solar day; a "Get the solar production" scene action.
- Configuration actions: test the connection, diagnose the boxes, reload the
  history. Protection against the rate limit of the Beem API.

[Unreleased]: https://github.com/Terdious/gladys-beem-energy/compare/v1.2.2...HEAD
[1.2.2]: https://github.com/Terdious/gladys-beem-energy/compare/v1.2.1...v1.2.2
[1.2.1]: https://github.com/Terdious/gladys-beem-energy/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/Terdious/gladys-beem-energy/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/Terdious/gladys-beem-energy/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/Terdious/gladys-beem-energy/releases/tag/v1.0.0
