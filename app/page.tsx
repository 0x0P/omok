"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import styles from "./page.module.css";

type PublicRoom = {
  id: string;
  code: string;
  players: Record<string, { color: "B" | "W" | null; score: number }>;
  board: number[][];
  turn: 1 | 2;
  started: boolean;
  winner: 0 | 1 | 2;
};

type HelloMsg = { type: "hello"; payload: { clientId: string } };
type RoomCreatedMsg = { type: "room_created"; payload: PublicRoom };
type RoomUpdateMsg = { type: "room_update"; payload: PublicRoom };
type MoveMsg = {
  type: "move";
  payload: { x: number; y: number; color: "B" | "W"; turn: 1 | 2 };
};
type GameEndMsg = {
  type: "game_end";
  payload: { winner: 1 | 2; board: number[][]; players: PublicRoom["players"] };
};
type RestartMsg = { type: "restart"; payload: PublicRoom };
type RestartVoteMsg = { type: "restart_vote"; payload: { votes: number } };
type ErrorMsg = { type: "error"; payload: { message: string } };

type ServerMessage =
  | HelloMsg
  | RoomCreatedMsg
  | RoomUpdateMsg
  | MoveMsg
  | GameEndMsg
  | RestartMsg
  | RestartVoteMsg
  | ErrorMsg;

const BOARD_SIZE = 15;

export default function Home() {
  const [clientId, setClientId] = useState<string | null>(null);
  const [room, setRoom] = useState<PublicRoom | null>(null);
  const [status, setStatus] = useState<string>("");
  const [inviteInput, setInviteInput] = useState<string>("");
  const wsRef = useRef<WebSocket | null>(null);

  const myColor = useMemo<"B" | "W" | null>(() => {
    if (!room || !clientId) return null;
    const me = room.players[clientId];
    return me ? me.color : null;
  }, [room, clientId]);

  const cells = useMemo(() => {
    return Array.from({ length: BOARD_SIZE * BOARD_SIZE }, (_, idx) => ({
      x: idx % BOARD_SIZE,
      y: Math.floor(idx / BOARD_SIZE),
      id: `c-${idx % BOARD_SIZE}-${Math.floor(idx / BOARD_SIZE)}`,
    }));
  }, []);

  // 안전 전송: OPEN 상태에서만 전송하고, 아니면 open까지 대기
  const sendJson = useCallback((data: unknown) => {
    const ws = wsRef.current;
    if (!ws) return;
    const payload = JSON.stringify(data);
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
      return;
    }
    const onOpen = () => {
      try {
        ws.send(payload);
      } finally {
        ws.removeEventListener("open", onOpen);
      }
    };
    ws.addEventListener("open", onOpen);
  }, []);

  useEffect(() => {
    const ws = new WebSocket(
      `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`,
    );
    wsRef.current = ws;

    ws.addEventListener("message", (ev) => {
      try {
        const msg: ServerMessage = JSON.parse(ev.data);
        if (msg.type === "hello") {
          setClientId(msg.payload.clientId);
        } else if (msg.type === "room_created") {
          setRoom(msg.payload);
          setStatus(`방 생성됨 (코드: ${msg.payload.code})`);
          const url = new URL(location.href);
          url.searchParams.set("code", msg.payload.code);
          history.replaceState(null, "", url.toString());
        } else if (msg.type === "room_update") {
          setRoom(msg.payload);
        } else if (msg.type === "move") {
          setRoom((prev) => {
            if (!prev) return prev;
            const nextBoard = prev.board.map((row) => row.slice());
            nextBoard[msg.payload.y][msg.payload.x] =
              msg.payload.color === "B" ? 1 : 2;
            return {
              ...prev,
              turn: msg.payload.turn,
              board: nextBoard,
            } as PublicRoom;
          });
        } else if (msg.type === "game_end") {
          setStatus(msg.payload.winner === 1 ? "흑 승리" : "백 승리");
          setRoom((prev) =>
            prev
              ? {
                  ...prev,
                  board: msg.payload.board,
                  winner: msg.payload.winner,
                  players: msg.payload.players,
                }
              : prev,
          );
        } else if (msg.type === "restart") {
          setStatus("새 게임 시작");
          setRoom(msg.payload);
        } else if (msg.type === "restart_vote") {
          setStatus(`재시작 요청 중... (${msg.payload.votes})`);
        } else if (msg.type === "error") {
          setStatus(msg.payload.message);
        }
      } catch {}
    });

    return () => {
      ws.close();
    };
  }, []);

  useEffect(() => {
    const ws = wsRef.current;
    if (!ws) return;
    const url = new URL(location.href);
    const code = url.searchParams.get("code");
    if (!code || room) return;
    if (ws.readyState === WebSocket.OPEN) {
      sendJson({ type: "join_room", payload: { code } });
    } else {
      const onOpen = () => {
        sendJson({ type: "join_room", payload: { code } });
        ws.removeEventListener("open", onOpen);
      };
      ws.addEventListener("open", onOpen);
    }
  }, [room, sendJson]);

  const createRoom = () => {
    sendJson({ type: "create_room" });
  };

  const joinRoom = (code: string) => {
    sendJson({ type: "join_room", payload: { code } });
  };

  const leaveRoom = () => {
    sendJson({ type: "leave_room" });
    setRoom(null);
    const url = new URL(location.href);
    url.searchParams.delete("code");
    history.replaceState(null, "", url.toString());
  };

  const handleCellClick = (x: number, y: number) => {
    if (!room || room.winner !== 0) return;
    if (!myColor) return;
    if (
      (myColor === "B" && room.turn !== 1) ||
      (myColor === "W" && room.turn !== 2)
    )
      return;
    if (room.board[y][x] !== 0) return;
    sendJson({ type: "place_stone", payload: { x, y } });
    setRoom((prev) => {
      if (!prev) return prev;
      const next = prev.board.map((row) => row.slice());
      next[y][x] = myColor === "B" ? 1 : 2;
      return { ...prev, board: next };
    });
  };

  const requestRestart = () => {
    sendJson({ type: "request_restart" });
  };

  const inviteUrl = useMemo(() => {
    if (!room) return "";
    const url = new URL(location.href);
    url.searchParams.set("code", room.code);
    return url.toString();
  }, [room]);

  const copyInvite = async () => {
    if (!inviteUrl) return;

    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(inviteUrl);
        setStatus("초대링크 복사 완료");
        return;
      } catch (err) {
        console.warn("Clipboard API failed:", err);
      }
    }

    const textArea = document.createElement("textarea");
    textArea.value = inviteUrl;
    textArea.style.position = "fixed";
    textArea.style.left = "-999999px";
    textArea.style.top = "-999999px";
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();

    try {
      const successful = document.execCommand("copy");
      if (successful) {
        setStatus("초대링크 복사 완료");
      } else {
        setStatus("복사 실패 - 링크를 직접 선택해주세요");
      }
    } catch (err) {
      console.error("Fallback copy failed:", err);
      setStatus("복사 실패 - 링크를 직접 선택해주세요");
    } finally {
      document.body.removeChild(textArea);
    }
  };

  return (
    <main>
      <div className={styles.container}>
        <div className={styles.card}>
          <div className={styles.toolbar}>
            <div className={styles.row}>
              <div className={styles.title}>김가연 바보</div>
            </div>
            <div className={styles.row}>
              {!room ? (
                <button
                  className={`${styles.btn} ${styles.primary}`}
                  type="button"
                  onClick={createRoom}
                >
                  방 생성
                </button>
              ) : (
                <button
                  className={styles.btn}
                  type="button"
                  onClick={leaveRoom}
                >
                  나가기
                </button>
              )}
            </div>
          </div>
          <div className={styles.spacer} />
          {!room ? (
            <div className={styles.grid}>
              <div className={styles.card}>
                <div className={styles.label}>초대코드로 참가</div>
                <div className={styles.controlsRow}>
                  <input
                    className={styles.input}
                    placeholder="코드 입력"
                    value={inviteInput}
                    onChange={(e) =>
                      setInviteInput(e.target.value.toUpperCase())
                    }
                  />
                  <button
                    className={styles.btn}
                    type="button"
                    onClick={() => joinRoom(inviteInput)}
                  >
                    참가
                  </button>
                </div>
              </div>
              <div className={styles.card}>
                <div className={styles.label}>새 방 생성</div>
                <button
                  className={`${styles.btn} ${styles.primary}`}
                  type="button"
                  onClick={createRoom}
                >
                  초대코드 생성
                </button>
              </div>
            </div>
          ) : (
            <div className={styles.grid}>
              <div className={styles.card}>
                <div
                  className={styles.row}
                  style={{ justifyContent: "space-between" }}
                >
                  <div>
                    <div className={styles.label}>방 코드</div>
                    <div style={{ fontSize: 24, fontWeight: 700 }}>
                      {room.code}
                    </div>
                  </div>
                  <div className={styles.row}>
                    <button
                      className={styles.btn}
                      type="button"
                      onClick={copyInvite}
                    >
                      초대링크 복사
                    </button>
                  </div>
                </div>
                <div className={styles.spacer} />
                <details className={styles.details}>
                  <summary className={styles.summary}>초대 링크 보기</summary>
                  <input
                    className={styles.input}
                    value={inviteUrl}
                    readOnly
                    onClick={(e) => e.currentTarget.select()}
                    style={{ fontSize: 12, fontFamily: "monospace" }}
                  />
                </details>
                <div className={styles.spacer} />
                <div
                  className={styles.row}
                  style={{ justifyContent: "space-between" }}
                >
                  <div>
                    <div className={styles.label}>내 색</div>
                    <div>
                      {myColor === "B" ? "흑" : myColor === "W" ? "백" : "미정"}
                    </div>
                  </div>
                  <div>
                    <div className={styles.label}>턴</div>
                    <div>{room.turn === 1 ? "흑" : "백"}</div>
                  </div>
                  <div>
                    <div className={styles.label}>상태</div>
                    <div>
                      {room.winner === 0
                        ? room.started
                          ? "진행 중"
                          : "대기 중"
                        : room.winner === 1
                          ? "흑 승"
                          : "백 승"}
                    </div>
                  </div>
                </div>
                <div className={styles.spacer} />
                <div
                  className={styles.row}
                  style={{ justifyContent: "space-between" }}
                >
                  <div>
                    <div className={styles.label}>스코어</div>
                    <div style={{ display: "flex", gap: 12 }}>
                      {Object.entries(room.players).map(([id, p]) => (
                        <div
                          key={id}
                          className={styles.card}
                          style={{ padding: "8px 12px" }}
                        >
                          <div style={{ fontSize: 12, color: "#666" }}>
                            {id === clientId ? "나" : id.slice(0, 4)}
                          </div>
                          <div style={{ fontWeight: 700 }}>
                            {p.color === "B"
                              ? "흑"
                              : p.color === "W"
                                ? "백"
                                : "?"}{" "}
                            · {p.score}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div>
                    <button
                      className={styles.btn}
                      type="button"
                      onClick={requestRestart}
                    >
                      재시작 요청
                    </button>
                  </div>
                </div>
              </div>
              <div className={styles.card}>
                <div className={styles.boardWrapper}>
                  <div className={styles.board}>
                    <div className={styles.boardGrid}>
                      {cells.map(({ x, y, id }) => {
                        const v = room.board[y][x];
                        return (
                          <button
                            key={`${room.id}-${id}`}
                            className={styles.cell}
                            type="button"
                            aria-label={`(${x}, ${y})`}
                            onClick={() => handleCellClick(x, y)}
                          >
                            {v !== 0 && (
                              <div
                                className={`${styles.stone} ${
                                  v === 1 ? styles.black : styles.white
                                }`}
                              />
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
        {status && (
          <div className={`${styles.card} ${styles.status}`}>{status}</div>
        )}
      </div>
    </main>
  );
}
