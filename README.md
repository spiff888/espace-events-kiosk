# Campus Board

A lobby TV display that shows today's room bookings from **eSPACE Event Scheduler**, one board per campus.

![Campus Board showing a day of events](docs/screenshot.png)

- Three columns (Time, Event and Room). The current event is highlighted and the one after it is tagged as next.
- Pulls from eSPACE once a day, then refreshes every 15 minutes to catch same-day changes (both configurable).
- Caches the last good pull to disk, so the boards keep showing it if eSPACE or your internet goes down.
- Runs on Windows, macOS, Linux or Docker (amd64 and arm64, so a Raspberry Pi works). It has no dependencies beyond Node 18+.
- Your eSPACE API token stays on your server and never reaches the TVs.

> **Unofficial.** This project is not affiliated with or endorsed by Smart Church Solutions / eSPACE.
> You need an eSPACE subscription tier that includes API access (check Settings > Other > Billing > Manage).

---

## How it works

```
eSPACE API  ──(daily + every 15 min)──▶  Campus Board server  ──▶  TV at /board/main
                                          (caches to disk)     ──▶  TV at /board/north
```

One server can run every campus. Each TV opens its own campus URL in a full-screen browser.

## Quick start

### 1. Get an eSPACE token

1. Create a dedicated eSPACE user for this, with read-only access to the calendars you want to show.
   If a staff member's personal login is used and they change their password, every board goes blank.
2. Open the [eSPACE API Swagger page](https://api.espace.cool/swagger/ui/index) and POST that user's credentials to `v2/requesttoken`.
3. Copy the returned JWT (without the quotes). It lasts about a year, or until that user's email or password changes.

### 2. Configure

```sh
cp config.example.json config.json
```

Edit `config.json`: paste the token, set your church name, and add one entry per campus using that campus's eSPACE location ID.
With no token, the server runs in **demo mode** and shows sample events, which is handy for testing TVs.

| Setting | Default | What it does |
|---|---|---|
| `org` | | Church name at the top left |
| `timezone` | `America/Los_Angeles` | Default time zone; a campus can override it with its own `timezone` |
| `dailyPullAt` | `04:00` | Full pull each morning, campus local time |
| `refreshMinutes` | `15` | Extra pulls through the day. `0` = once a day only |
| `espace.onlyApproved` | `true` | Hide pending or denied bookings |
| `espace.onlyPublic` | `false` | Set `true` to hide private or staff-only events on public screens |
| `campuses.<key>.hideRooms` | `[]` | Room names never shown on that campus's board (e.g. storage, offices) |

### 3. Run it

**Docker (recommended)**

```sh
docker run -d --name campus-board --restart unless-stopped -p 8080:8080 \
  -v "$PWD/config.json:/config/config.json:ro" -v campus-board-data:/data \
  -e TZ=America/Los_Angeles ghcr.io/OWNER/REPO:latest
```

Or use `docker compose up -d` with the included `docker-compose.yml`.

**Node, any OS**

```sh
node server.js --pull-now   # one test pull; prints what eSPACE returned
node server.js              # start the server on port 8080
```

To run it as a service that starts on boot, use one of the files in `deploy/`:

| OS | File |
|---|---|
| Linux | `campus-board.service` (systemd) |
| macOS | `org.campusboard.server.plist` (launchd) |
| Windows | `install-windows-service.ps1` (startup task and firewall rule) |

Open `http://<server>:8080/` to see a link to every campus board.

### 4. Point the TVs at it

Any device with a modern browser works: a Raspberry Pi, a mini PC, a Mac mini or a smart-TV browser. Launchers in `deploy/`:

```sh
deploy/kiosk-linux.sh      http://board-server:8080/board/main
deploy/kiosk-mac.command   http://board-server:8080/board/main
deploy/kiosk-windows.cmd   http://board-server:8080/board/main
```

Each board page reloads itself at 3am, so TVs pick up updates without anyone touching them.

## Endpoints

| Path | Returns |
|---|---|
| `/board/<campus>` | The TV display |
| `/api/today/<campus>` | Today's events as JSON |
| `/health` | `200` when every campus pulled today, `503` otherwise. Point your RMM or uptime monitor here |
| `POST /api/refresh` | Pull now (limited to once a minute) |

## Matching your eSPACE data

The eSPACE v2 field names are mapped in one function, `mapOccurrence()` in `server.js`, and the endpoint path and query parameters live in `config.json` under `espace`.
If `node server.js --pull-now` returns no events, or events with missing names or rooms, compare one real response from Swagger against `mapOccurrence()` and adjust. If you find the correct mapping, please open a PR so it works out of the box for everyone.

## Customizing the look

The display is a single file, `public/index.html`. Colors are CSS variables at the top. Text sizes scale with screen width, so the same page works on 1080p and 4K TVs.

## License

MIT
