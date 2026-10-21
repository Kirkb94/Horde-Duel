# Horde Duel Online

Up to 16 players per room on one Render web service. The service serves the game page and runs the multiplayer.

## Two modes (environment variable `MODE`)
| | `auth` (default) | `relay` |
|---|---|---|
| Who runs the match | **The server** (same game code, bots and zombies, headless) | The room creator's browser |
| Host tab must stay open | No | Yes |
| If the creator leaves | Match continues, next player becomes room leader | Room closes |
| Render plan | **Starter or higher** (about 10% of a core per match) | Free works |
| Lag | One network hop, one clock, no weak host | Host's PC and upload limit everyone |
| Rejoin after disconnect | Supported (auth only) | Not available: the server replies "Rejoin isn't available on this server" |

Rejoin is auth-only because the server owns the match state and can hold a player's slot. In relay mode the host's browser owns it, so a dropped player has to join a new room.
Players send inputs; the server sends each player a snapshot of what is near them 20 times a second.
Your own movement is predicted locally so it stays responsive. In `auth` mode every fighter, bullet and zombie is simulated in one place, so nobody has a different picture of the match.

## Deploy on Render (about 5 minutes)
1. Put this folder in a GitHub repo.
2. In Render choose **New → Blueprint** and pick the repo. `render.yaml` sets it up (Starter plan, `MODE=auth`).
   Or **New → Web Service** manually: Runtime Node, Build `npm install`, Start `npm start`, Health check `/healthz`, env `MODE=auth`.
3. Open the `https://<your-service>.onrender.com` URL, tap **Play online**, then **Create a room** and share the 4 letter code, or **Quick play**.
4. Pick a Render region close to your players.

**Free plan:** the sim needs more CPU than the free instance offers, so use `MODE=relay` there. Free services also sleep after about 15 minutes idle (first player waits up to a minute).

## Rejoin (auth mode only)
If a player drops mid-match, `MODE=auth` keeps their slot for a short time so they can rejoin the same match. The private session token the server issues when you join (not the socket ID or player ID) is the rejoin identity: the browser keeps it in `sessionStorage` for that tab, and the server only accepts a 32-hex token that matches a held slot, closes any stale old connection, and resends the match state. A socket gets 5 failed attempts before it is closed. The client shows "Reconnecting…" and retries for about 25 seconds (the slot is held for 30). `MODE=relay` does not support rejoin: the match lives in the creator's browser, so the server has nothing to hand back. A relay server answers a rejoin attempt with "Rejoin isn't available on this server", and a dropped player has to start or join a new room.

## Settings (environment variables)
- `MODE` = `auth` or `relay`
- `TICK_HZ` (default 30): server simulation rate
- `MAX_MATCHES` (default 4 in auth mode): matches the server runs at once. Each uses roughly 15 MB and 5 to 10% of a core.
- `MAX_ROOMS` (default 60), `DEFLATE=0` turns off WebSocket compression
- `ALLOWED_ORIGINS`: comma-separated origins (or bare hosts) whose pages may open the WebSocket, e.g. `https://mygame.example.com,other.example.org`. Use this only if the page is hosted somewhere other than this server. Always allowed without configuring: the server's own host (same-origin), `RENDER_EXTERNAL_URL`, `http(s)://localhost`, `127.0.0.1` and `[::1]` on any port (set `ALLOW_LOCALHOST=0` to turn that off), and non-browser clients that send no Origin header. `ALLOWED_ORIGINS=*` disables the check (not recommended). A rejected handshake gets HTTP 403 with a message naming the offending origin and this variable, and the server logs `ws: rejected origin ...`. Browsers show this as a failed WebSocket connection, so check the server log or the Network tab to see the message.
- `GET /healthz` returns `ok`. `GET /stats` shows mode, rooms, matches and the server tick time (`tickMsAvg` should stay well under 33).

## Run locally
```
npm install
npm start      # http://localhost:3000
```
Open it in several browser windows: create a room in one, join with the code in the others.

## Files
- `server.js` rooms, relay and match loop. `sim.js` runs the game's own code headlessly inside the server.
- `public/index.html` the game (solo plus online). `dev/` has the online layer source and the build script.

## Game modes
The room leader picks the mode in the lobby: **Battle royale** (lobby size slider 2–16, empty slots are bots), **1v1** (2 players) and **2v2** (4 players, each picks Team A/B; teammates cannot hurt each other). 1v1/2v2 use a small arena with a light zombie horde, first to 3 round wins. Solo play has the same modes in the main menu (2v2 solo = you + a bot ally vs two bots).

## Rematch and highlights
When a match ends, the room leader gets **Rematch** (same players, mode, teams and lobby size; everyone else sees a waiting note) or **Back to lobby**. Everyone gets a **Highlights** replay: the sim records the match at 10 samples a second and picks the best five moments (multi-kills, final blows, long shots, clutch kills). The reel is sent once with the final results, about 50 to 100 KB.
