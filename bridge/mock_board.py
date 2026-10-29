"""보드 없이 화면을 시험하기 위한 P01 흉내 장치.

P01.ino와 같은 규칙으로 응답합니다. 값은 만든 값이므로 화면 상단에
'시뮬레이션'이 계속 표시됩니다. 실제 측정 기록으로 쓰지 않습니다.
"""
import json
import math
import queue
import random
import threading
import time


class MockP01:
    def __init__(self, seed: int = 7):
        self._rng = random.Random(seed)
        self._out = queue.Queue()
        self._lock = threading.Lock()
        self._t0 = time.monotonic()
        self.led = False
        self.automatic = False
        self.on_th, self.off_th = 350, 450
        self.light = 520
        self.pot = 300
        self.temp = None
        self.hum = None
        self._last_state = 0.0
        self._last_dht = 0.0
        self._stop = threading.Event()
        threading.Thread(target=self._loop, daemon=True).start()

    # --- pyserial와 같은 이름의 메서드 ---
    def write(self, data: bytes):
        for line in data.decode("ascii").splitlines():
            self._dispatch(line.strip())
        return len(data)

    def readline(self) -> bytes:
        try:
            return self._out.get(timeout=0.25)
        except queue.Empty:
            return b""

    def reset_input_buffer(self):
        while not self._out.empty():
            self._out.get_nowait()

    def close(self):
        self._stop.set()

    # --- 내부 동작 ---
    def _ms(self) -> int:
        return int((time.monotonic() - self._t0) * 1000)

    def _emit(self, obj):
        self._out.put((json.dumps(obj, separators=(",", ":")) + "\n").encode())

    def _ack(self, req):
        self._emit({"v": 1, "type": "ack", "request": req, "applied": True})

    def _err(self, req, code):
        self._emit({"v": 1, "type": "error", "request": req, "code": code})

    def _state(self, req):
        with self._lock:
            self._emit({
                "v": 1, "type": "state", "profile": "P01", "request": req, "ms": self._ms(),
                "pot_raw": self.pot, "light_raw": self.light,
                "button_pressed": self._rng.random() < 0.04,
                "led": 1 if self.led else 0, "auto": self.automatic, "lcd_ready": True,
                "temperature_c": self.temp, "humidity_pct": self.hum,
            })

    def _dispatch(self, line):
        parts = line.split(" ")
        if len(parts) < 2 or not parts[0].isdigit():
            return self._err(0, "format")
        req, name, args = int(parts[0]), parts[1], parts[2:]
        with self._lock:
            if name == "STATUS" and not args:
                pass
            elif name == "PING" and not args:
                return self._ack(req)
            elif name == "STOP" and not args:
                self.automatic = False
                self.led = False
                self._ack(req)
            elif name in ("LED", "AUTO") and args in (["0"], ["1"]):
                if name == "LED":
                    self.automatic = False
                    self.led = args[0] == "1"
                else:
                    self.automatic = args[0] == "1"
                return self._ack(req)
            elif name == "THRESH" and len(args) == 2 and all(a.isdigit() for a in args) \
                    and int(args[0]) < int(args[1]) <= 1023:
                self.on_th, self.off_th = int(args[0]), int(args[1])
                return self._ack(req)
            else:
                return self._err(req, "unsupported_or_range")
        self._state(req)

    def _loop(self):
        while not self._stop.is_set():
            now = time.monotonic() - self._t0
            with self._lock:
                # 천천히 어두워졌다 밝아지는 조도
                self.light = max(0, min(1023, int(430 + 220 * math.sin(now / 25) + self._rng.gauss(0, 8))))
                self.pot = max(0, min(1023, self.pot + self._rng.randint(-3, 3)))
                if self.automatic:
                    if self.light < self.on_th:
                        self.led = True
                    elif self.light > self.off_th:
                        self.led = False
                if now - self._last_dht >= 2.0 and now >= 2.0:
                    self._last_dht = now
                    if self._rng.random() < 0.05:  # 가끔 DHT 읽기 실패 → null
                        self.temp = self.hum = None
                    else:
                        self.temp = round(24.0 + 2.6 * math.sin(now / 60) + self._rng.gauss(0, 0.2), 1)
                        self.hum = round(48 + 8 * math.sin(now / 90) + self._rng.gauss(0, 0.5), 1)
            if now - self._last_state >= 1.0:
                self._last_state = now
                self._state(0)
            time.sleep(0.05)
