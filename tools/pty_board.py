"""가상 시리얼 포트(pty) 뒤에 P01 흉내 장치를 두어, 실제 pyserial 경로를 시험합니다 (Linux/macOS 전용).
사용: python tools/pty_board.py [--drop LED] [--profile P02]  → 출력된 /dev/pts/N 을 app.py --port 로 지정
"""
import argparse, os, sys, threading, time, json
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "bridge"))
from mock_board import MockP01

p = argparse.ArgumentParser(); p.add_argument("--drop", default=""); p.add_argument("--profile", default="P01")
a = p.parse_args()
master, slave = os.openpty()
print(os.ttyname(slave), flush=True)
board = MockP01()
def to_host():
    while True:
        line = board.readline()
        if line:
            if a.profile != "P01":
                m = json.loads(line); m["profile"] = a.profile if m.get("type") == "state" else m.get("profile")
                line = (json.dumps({k: v for k, v in m.items() if v is not None or k not in ("profile",)}) + "\n").encode()
            os.write(master, line)
threading.Thread(target=to_host, daemon=True).start()
buf = b""
while True:
    buf += os.read(master, 256)
    while b"\n" in buf:
        line, buf = buf.split(b"\n", 1)
        if a.drop and f" {a.drop} ".encode() in line + b" ":
            continue  # 응답 없음 시험
        board.write(line + b"\n")
