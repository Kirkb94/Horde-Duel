# Horde Duel Online

Up to 16 players per room, one Render web service. The service serves the game page and a small WebSocket relay.

## How it works
- The player who creates a room is the **host**. Their browser runs the whole simulation (bots, zombies, bullets).
- Everyone else sends inputs to the host and receives filtered snapshots, about 15 per second, through the relay.
- Empty slots are filled with bots. If a player disconnects, a bot takes over their fighter.
- If the host leaves, the room closes (no host migration).

## Deploy on Render (about 5 minutes)
1. Put this folder in a GitHub repo (or upload it as a zip to a new repo).
2. In Render choose **New → Blueprint** and pick the repo. `render.yaml` sets everything up.
   Or choose **New → Web Service** manually: Runtime Node, Build `npm install`, Start `npm start`, Health check path `/healthz`.
3. Open the `https://<your-service>.onrender.com` URL. Tap **Play online**, then **Create a room** and share the 4 letter code, or **Quick play** to join any open room.

## Things worth knowing
- **Free plan** services sleep after about 15 minutes idle. The first player waits up to a minute for it to wake up. Upgrade to a paid instance to avoid that.
- **The host tab must stay open and in front.** Browsers slow down background tabs, which freezes the match for everyone. A PC host on a decent connection is best.
- **Host upload:** roughly 40 KB/s per remote player at the busiest moments. A full 16 player room needs about 5 Mbps up (the server enables compression, which reduces it a lot).
- Only one match per room is active; after the final drop the host picks **Back to lobby** to play again.
- Server settings (environment variables): `PORT` (Render sets it), `MAX_ROOMS` (default 60), `DEFLATE=0` to turn off WebSocket compression.
- `GET /healthz` returns `ok`; `GET /stats` returns room and player counts.

## Run locally
```
npm install
npm start      # http://localhost:3000
```
Open it in two or more browser windows: create a room in one, join with the code in the others.

## Hosting the page somewhere else
If the game page lives on a different host than the server, open **Play online → Server address** and enter `wss://<your-service>.onrender.com/ws`.

## Editing the game
`public/index.html` is a build of the solo game plus the online layer in `dev/net.js`. `dev/build.py` shows how they were combined.
