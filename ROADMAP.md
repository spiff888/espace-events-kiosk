# Roadmap

Planned work, roughly in order. Nothing here is built yet unless marked.

## Next

### Setup wizard
First run opens a setup page instead of the board, so no one edits JSON or opens eSPACE's Swagger page.
- Paste the eSPACE API key; the server confirms it by requesting a token
- Pick campuses from `GET /api/v2/ministry/locations`
- Pick colors and fonts with a live preview (writes the `theme` block)
- Finish on a page listing each campus's TV address, with copy buttons

### Installers
Download-and-double-click builds on the Releases page, produced by GitHub Actions on each `v*` tag.
- Windows `.exe`: installs as a background service, opens the setup wizard
- macOS: installer plus README steps for the unsigned-app prompt (System Settings > Privacy & Security > Open Anyway)
- Linux: Docker (already available)
- Unsigned for now; signing can be added later without other changes

## Banked

### Room signs on TRMNL e-ink displays
A small e-ink screen outside each room showing that room's schedule: what's on now, what's next, and the rest of today.

- **Room view.** New per-room endpoint, e.g. `/api/room/<campus>/<room>`, filtering today's events to one eSPACE space (match on `Items[].ItemId` rather than the name, so renaming a room doesn't break its sign).
- **Delivery, option A: TRMNL private plugin, webhook.** The server POSTs each room's data to that plugin's TRMNL webhook after every pull. Outbound only, so nothing on the church network is exposed to the internet. Webhook payloads are limited to 5 KB, which is plenty for one room's day if titles are trimmed.
- **Delivery, option B: TRMNL private plugin, polling.** TRMNL's cloud fetches a URL on our server. Simpler, but the server must be reachable from the internet (TRMNL publishes its IPs for allowlisting). Less suitable for a church LAN.
- **Delivery, option C: BYOS (bring your own server).** Point TRMNL devices at this server directly, with no TRMNL cloud. The server would implement TRMNL's device API and render each room as an 800x480 grayscale image. Most private, most work.
- **Layout.** Liquid markup template for the plugin (A/B): room name large, "Now" block, "Next" block, then a short list. Design for 1-bit/grayscale, no color; no "Now" highlight color, use inverted blocks instead.
- **Refresh.** Match the device's refresh schedule to the event pattern (every 15-30 min in the daytime); e-ink holds its image with no power, so a stale-but-correct sign is fine overnight.
- **Recommended path:** A first (fastest, no network exposure), C later for churches that want no cloud dependency.

### Light and scheduled themes
A light palette for bright lobbies, and `theme.mode`: `dark` | `light` | `auto` (by time of day or sunrise/sunset per campus). URL override `?theme=light` for testing.

### Raspberry Pi player image
A ready-to-flash SD card that boots straight into the board and, on first boot, shows "go to this address to finish setup."

## Done
- Day board with Time / Event / Room columns, Now and Next tags
- eSPACE API key auth with automatic token renewal; `--locations` helper
- Per-campus time zones, room hiding, approved/public filters
- Finished events drop off after a grace period (`hidePastAfterMinutes`)
- Scales to 720p, 1080p, 4K and portrait
- Brand theming via `config.json`
- Docker image on GHCR for amd64 and arm64
