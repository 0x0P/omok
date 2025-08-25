import { createServer } from "node:http";
import next from "next";
import { WebSocketServer } from "ws";

const dev = process.env.NODE_ENV !== "production";
const app = next({ dev });
const handle = app.getRequestHandler();

/**
 * roomId: {
 *   id: string,
 *   createdAt: number,
 *   players: { [clientId]: { color: 'B'|'W', score: number } },
 *   sockets: Set<WebSocket>,
 *   board: number[][], // 15x15, 0 empty, 1 black, 2 white
 *   turn: 1|2,
 *   started: boolean,
 *   winner: 0|1|2,
 *   restartVotes: Set<string>,
 *   code: string
 * }
 */
const rooms = new Map();

const BOARD_SIZE = 15;
const EMPTY = 0;
const BLACK = 1;
const WHITE = 2;

function generateInviteCode() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function createEmptyBoard() {
  return Array.from({ length: BOARD_SIZE }, () =>
    Array(BOARD_SIZE).fill(EMPTY)
  );
}

function createRoom() {
  const code = generateInviteCode();
  const id = code;
  const room = {
    id,
    createdAt: Date.now(),
    players: {},
    sockets: new Set(),
    board: createEmptyBoard(),
    turn: BLACK,
    started: false,
    winner: EMPTY,
    restartVotes: new Set(),
    code,
  };
  rooms.set(id, room);
  return room;
}

function serializeRoomPublic(room) {
  const players = Object.fromEntries(
    Object.entries(room.players).map(([cid, p]) => [
      cid,
      { color: p.color, score: p.score },
    ])
  );
  return {
    id: room.id,
    code: room.code,
    players,
    board: room.board,
    turn: room.turn,
    started: room.started,
    winner: room.winner,
  };
}

function checkWin(board, x, y) {
  const color = board[y][x];
  if (color === EMPTY) return false;
  const directions = [
    [1, 0], // horizontal
    [0, 1], // vertical
    [1, 1], // diag down-right
    [1, -1], // diag up-right
  ];
  for (const [dx, dy] of directions) {
    let count = 1;
    let nx = x + dx;
    let ny = y + dy;
    while (
      nx >= 0 &&
      nx < BOARD_SIZE &&
      ny >= 0 &&
      ny < BOARD_SIZE &&
      board[ny][nx] === color
    ) {
      count++;
      nx += dx;
      ny += dy;
    }
    nx = x - dx;
    ny = y - dy;
    while (
      nx >= 0 &&
      nx < BOARD_SIZE &&
      ny >= 0 &&
      ny < BOARD_SIZE &&
      board[ny][nx] === color
    ) {
      count++;
      nx -= dx;
      ny -= dy;
    }
    if (count >= 5) return true;
  }
  return false;
}

function pickColorsForTwo(clientIds) {
  const shuffled = [...clientIds].sort(() => Math.random() - 0.5);
  return new Map([
    [shuffled[0], BLACK],
    [shuffled[1], WHITE],
  ]);
}

function broadcast(room, type, payload) {
  const data = JSON.stringify({ type, payload });
  for (const ws of room.sockets) {
    try {
      ws.send(data);
    } catch {}
  }
}

function attachSocket(ws, req) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const roomId = url.searchParams.get("room");
  const clientId =
    url.searchParams.get("cid") || Math.random().toString(36).slice(2);
  ws.clientId = clientId;

  const room = roomId && rooms.get(roomId);
  if (!room) {
  }

  ws.send(JSON.stringify({ type: "hello", payload: { clientId } }));

  ws.on("message", (buf) => {
    let msg;
    try {
      msg = JSON.parse(buf.toString());
    } catch {
      return;
    }
    const { type, payload } = msg || {};

    if (type === "create_room") {
      const created = createRoom();
      created.sockets.add(ws);
      created.players[clientId] = { color: null, score: 0 };
      ws.roomId = created.id;
      broadcast(created, "room_update", serializeRoomPublic(created));
      ws.send(
        JSON.stringify({
          type: "room_created",
          payload: serializeRoomPublic(created),
        })
      );
      return;
    }

    if (type === "join_room") {
      const { code } = payload || {};
      const target = code && rooms.get(code);
      if (!target) {
        ws.send(
          JSON.stringify({
            type: "error",
            payload: { message: "방을 찾을 수 없습니다." },
          })
        );
        return;
      }
      if (target.sockets.size >= 2) {
        ws.send(
          JSON.stringify({
            type: "error",
            payload: { message: "방이 가득 찼습니다." },
          })
        );
        return;
      }
      target.sockets.add(ws);
      ws.roomId = target.id;
      if (!target.players[clientId])
        target.players[clientId] = { color: null, score: 0 };
      if (target.sockets.size === 2) {
        const ids = Object.keys(target.players);
        if (ids.length >= 2) {
          const colors = pickColorsForTwo(ids.slice(0, 2));
          for (const [id, color] of colors.entries()) {
            if (target.players[id])
              target.players[id].color = color === BLACK ? "B" : "W";
          }
          target.started = true;
          target.turn = BLACK;
        }
      }
      broadcast(target, "room_update", serializeRoomPublic(target));
      return;
    }

    if (type === "place_stone") {
      const { x, y } = payload || {};
      const r = ws.roomId && rooms.get(ws.roomId);
      if (!r || !r.started || r.winner !== EMPTY) return;
      const player = r.players[clientId];
      if (!player) return;
      const playerColorNum = player.color === "B" ? BLACK : WHITE;
      if (playerColorNum !== r.turn) return;
      if (x < 0 || x >= BOARD_SIZE || y < 0 || y >= BOARD_SIZE) return;
      if (r.board[y][x] !== EMPTY) return;
      r.board[y][x] = playerColorNum;
      if (checkWin(r.board, x, y)) {
        r.winner = playerColorNum;
        player.score += 1;
        broadcast(r, "game_end", {
          winner: r.winner,
          board: r.board,
          players: r.players,
        });
      } else {
        r.turn = r.turn === BLACK ? WHITE : BLACK;
        broadcast(r, "move", { x, y, color: player.color, turn: r.turn });
      }
      return;
    }

    if (type === "request_restart") {
      const r = ws.roomId && rooms.get(ws.roomId);
      if (!r) return;
      r.restartVotes.add(clientId);
      if (r.restartVotes.size >= Math.min(2, r.sockets.size)) {
        r.board = createEmptyBoard();
        r.turn = BLACK;
        r.started = r.sockets.size >= 2;
        r.winner = EMPTY;
        r.restartVotes.clear();
        broadcast(r, "restart", serializeRoomPublic(r));
      } else {
        broadcast(r, "restart_vote", { votes: r.restartVotes.size });
      }
      return;
    }

    if (type === "leave_room") {
      const r = ws.roomId && rooms.get(ws.roomId);
      if (!r) return;
      r.sockets.delete(ws);
      delete r.players[clientId];
      r.started = false;
      r.winner = EMPTY;
      broadcast(r, "room_update", serializeRoomPublic(r));
      return;
    }
  });

  ws.on("close", () => {
    if (ws.roomId) {
      const r = rooms.get(ws.roomId);
      if (r) {
        r.sockets.delete(ws);
        delete r.players[ws.clientId];
        r.started = false;
        r.winner = EMPTY;
        broadcast(r, "room_update", serializeRoomPublic(r));
        if (r.sockets.size === 0) {
          rooms.delete(r.id);
        }
      }
    }
  });
}

await app.prepare();
const server = createServer(async (req, res) => {
  if (req.url.startsWith("/api/create")) {
    const room = createRoom();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ code: room.code }));
    return;
  }
  return handle(req, res);
});

const wss = new WebSocketServer({ noServer: true });
wss.on("connection", (ws, req) => attachSocket(ws, req));

server.on("upgrade", (req, socket, head) => {
  const { url } = req;
  if (url?.startsWith("/ws")) {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
    return;
  }
});

const port = process.env.PORT || 3000;
server.listen(port, () => {
  console.log(`> Ready on http://localhost:${port}`);
});
