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

Players send inputs; the server sends each player a snapshot of what is near them 20 times a second.
Your own movement is predicted locally so it stays responsive. In `auth` mode every fighter, bullet and zombie is simulated in one place, so nobody has a different picture of the match.

## Deploy on Render (about 5 minutes)
1. Put this folder in a GitHub repo.
2. In Render choose **New → Blueprint** and pick the repo. `render.yaml` sets it up (Starter plan, `MODE=auth`).
   Or **New → Web Service** manually: Runtime Node, Build `npm install`, Start `npm start`, Health check `/healthz`, env `MODE=auth`.
3. Open the `https://<your-service>.onrender.com` URL, tap **Play online**, then **Create a room** and share the 4 letter code, or **Quick play**.
4. Pick a Render region close to your players.

**Free plan:** the sim needs more CPU than the free instance offers, so use `MODE=relay` there. Free services also sleep after about 15 minutes idle (first player waits up to a minute).

## Settings (environment variables)
- `MODE` = `auth` or `relay`
- `TICK_HZ` (default 30): server simulation rate
- `MAX_MATCHES` (default 4 in auth mode): matches the server runs at once. Each uses roughly 15 MB and 5 to 10% of a core.
- `MAX_ROOMS` (default 60), `DEFLATE=0` turns off WebSocket compression
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
