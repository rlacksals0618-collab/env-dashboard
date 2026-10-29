"""COM 포트 하나를 단독으로 맡아 P01 보드와 통신하는 연결 관리자.

- 포트를 연 뒤 UNO 재시작을 2초 기다리고 STATUS로 회로 ID(P01)를 확인합니다.
- 명령은 한 번에 하나만 보내며, 응답이 없으면 자동으로 다시 보내지 않습니다.
- 연결이 끊기면 3초 뒤 다시 열지만, 끊기기 전 명령을 재전송하지 않습니다.
"""
import threading
import time
from typing import Callable, Optional

from protocol import DEFAULT_THRESHOLDS, PROFILE, ProtocolError, build_command, decode_line

STALE_AFTER_S = 3.0      # 마지막 state가 이보다 오래되면 '오래됨'
COMMAND_TIMEOUT_S = 3.0
BOOT_WAIT_S = 2.0
RETRY_WAIT_S = 3.0


class BoardLink:
    def __init__(self, port: Optional[str], mock: bool, on_event: Callable[[dict], None]):
        self.port_name = "mock" if mock else port
        self.mock = mock
        self.on_event = on_event
        self._lock = threading.Lock()          # 상태 읽기/쓰기 보호
        self._cmd_lock = threading.Lock()      # 명령은 한 번에 하나
        self._port = None
        self._stop = threading.Event()
        self._next_req = 100
        self._pending: dict = {}
        # 공개 상태
        self.link = "connecting"
        self.link_detail = ""
        self.state: Optional[dict] = None
        self.state_at: Optional[float] = None
        self.thresholds = list(DEFAULT_THRESHOLDS)
        self.thresholds_source = "firmware_default"   # 보드는 기준값을 state로 보내지 않습니다
        self._last_ms = None

    # ---------- 외부에서 쓰는 함수 ----------
    def start(self):
        threading.Thread(target=self._run, daemon=True, name="board-link").start()

    def stop(self):
        self._stop.set()
        self._close()

    def snapshot(self) -> dict:
        with self._lock:
            age = None if self.state_at is None else round(time.time() - self.state_at, 2)
            link = self.link
            if link == "ok" and age is not None and age > STALE_AFTER_S:
                link = "stale"
            return {
                "kind": "snapshot",
                "link": link,
                "link_detail": self.link_detail,
                "port": self.port_name,
                "mock": self.mock,
                "state": self.state,
                "state_at": self.state_at,
                "age_s": age,
                "thresholds": {"on": self.thresholds[0], "off": self.thresholds[1],
                               "source": self.thresholds_source},
                "server_time": time.time(),
            }

    def send(self, name: str, args: list) -> dict:
        """명령 하나를 보내고 ack/error/timeout 결과를 돌려줍니다."""
        try:
            text = build_command(name, args)
        except ProtocolError as exc:
            return {"result": "rejected", "code": str(exc)}
        snap = self.snapshot()
        if snap["link"] != "ok":
            return {"result": "rejected", "code": "link_" + snap["link"]}
        if not self._cmd_lock.acquire(timeout=0.5):
            return {"result": "rejected", "code": "busy"}
        try:
            req = self._take_request_id()
            done = threading.Event()
            slot = {"event": done, "reply": None}
            with self._lock:
                self._pending[req] = slot
            started = time.monotonic()
            try:
                self._write(f"{req} {text}\n")
            except Exception as exc:  # 포트 오류
                with self._lock:
                    self._pending.pop(req, None)
                return {"result": "error", "code": "write_failed", "detail": str(exc)}
            ok = done.wait(COMMAND_TIMEOUT_S)
            with self._lock:
                self._pending.pop(req, None)
            latency = round((time.monotonic() - started) * 1000)
            if not ok:
                # 적용 여부를 알 수 없음. 다시 보내지 않고 화면에 그대로 알립니다.
                return {"result": "timeout", "request": req, "command": text, "latency_ms": latency}
            reply = slot["reply"]
            if reply["type"] == "ack":
                if name == "THRESH":
                    with self._lock:
                        self.thresholds = list(args)
                        self.thresholds_source = "applied"
                return {"result": "applied", "request": req, "command": text, "latency_ms": latency}
            if reply["type"] == "error":
                return {"result": "error", "request": req, "command": text,
                        "code": reply.get("code"), "latency_ms": latency}
            return {"result": "error", "request": req, "code": "unexpected_reply"}
        finally:
            self._cmd_lock.release()

    # ---------- 내부 ----------
    def _take_request_id(self) -> int:
        req = self._next_req
        self._next_req = 100 if self._next_req >= 65535 else self._next_req + 1
        return req

    def _set_link(self, link: str, detail: str = ""):
        with self._lock:
            changed = (self.link, self.link_detail) != (link, detail)
            self.link, self.link_detail = link, detail
        if changed:
            self.on_event({"kind": "link", "link": link, "link_detail": detail})

    def _open(self):
        if self.mock:
            from mock_board import MockP01
            return MockP01()
        import serial  # pyserial
        return serial.Serial(self.port_name, 115200, timeout=0.25)

    def _close(self):
        port, self._port = self._port, None
        if port is not None:
            try:
                port.close()
            except Exception:
                pass

    def _write(self, line: str):
        if self._port is None:
            raise IOError("port_closed")
        self._port.write(line.encode("ascii"))

    def _fail_pending(self):
        with self._lock:
            for slot in self._pending.values():
                slot["reply"] = {"type": "error", "code": "disconnected"}
                slot["event"].set()

    def _run(self):
        while not self._stop.is_set():
            try:
                self._set_link("connecting", "포트를 여는 중")
                self._port = self._open()
                time.sleep(BOOT_WAIT_S)               # 포트를 열면 UNO가 재시작함
                self._port.reset_input_buffer()
                self._write("1 STATUS\n")
                last_status = time.monotonic()
                while not self._stop.is_set():
                    raw = self._port.readline()
                    if raw:
                        self._handle(raw)
                    # 회로 확인이 안 됐으면 5초마다 STATUS 재요청(출력 명령은 보내지 않음)
                    if self.link in ("connecting", "profile_mismatch") and time.monotonic() - last_status > 5:
                        self._write("1 STATUS\n")
                        last_status = time.monotonic()
            except Exception as exc:
                self._set_link("disconnected", f"{type(exc).__name__}: {exc}")
                self._fail_pending()
                self._close()
                self._stop.wait(RETRY_WAIT_S)

    def _handle(self, raw: bytes):
        try:
            msg = decode_line(raw)
        except ProtocolError as exc:
            code = str(exc)
            if code.startswith("profile_mismatch"):
                self._set_link("profile_mismatch", code.split(":", 1)[1])
            return  # 형식이 맞지 않는 줄은 버립니다
        if msg["type"] == "state":
            now = time.time()
            with self._lock:
                if self._last_ms is not None and msg["ms"] < self._last_ms:
                    # 보드가 재시작됨 → 펌웨어 기준값으로 돌아감
                    self.thresholds = list(DEFAULT_THRESHOLDS)
                    self.thresholds_source = "firmware_default"
                self._last_ms = msg["ms"]
                self.state, self.state_at = msg, now
            self._set_link("ok", PROFILE)
            self.on_event({"kind": "state", "state": msg, "state_at": now,
                           "thresholds": {"on": self.thresholds[0], "off": self.thresholds[1],
                                          "source": self.thresholds_source}})
        req = msg["request"]
        if msg["type"] in ("ack", "error") and req:
            with self._lock:
                slot = self._pending.get(req)
            if slot and slot["reply"] is None:
                slot["reply"] = msg
                slot["event"].set()
