# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

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

[Unreleased]: https://github.com/Terdious/gladys-beem-energy/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/Terdious/gladys-beem-energy/releases/tag/v1.0.0
