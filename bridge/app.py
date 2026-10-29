"""P01 환경 모니터 브리지: 시리얼 ↔ 웹(WebSocket + REST).

실행 예
  실물 보드:   python app.py --port COM5
  보드 없이:   python app.py --mock
브라우저에서 http://127.0.0.1:8000 을 엽니다.
Arduino 시리얼 모니터는 반드시 닫아 둡니다(같은 COM 포트를 동시에 열 수 없음).
"""
import argparse
import asyncio
import contextlib
import json
from pathlib import Path

import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from board_link import BoardLink

WEB_DIR = Path(__file__).resolve().parent.parent / "web"


class Command(BaseModel):
    name: str
    args: list = []


def create_app(port: str | None, mock: bool) -> FastAPI:
    clients: set[asyncio.Queue] = set()
    loop_holder: dict = {}

    def publish(event: dict):
        """보드 스레드에서 호출 → 각 WebSocket 큐에 넣음."""
        loop = loop_holder.get("loop")
        if not loop:
            return
        for q in list(clients):
            loop.call_soon_threadsafe(_put_latest, q, event)

    def _put_latest(q: asyncio.Queue, event: dict):
        if q.full():  # 느린 브라우저는 오래된 이벤트를 버림
            with contextlib.suppress(asyncio.QueueEmpty):
                q.get_nowait()
        q.put_nowait(event)

    link = BoardLink(port=port, mock=mock, on_event=publish)

    async def health_ticker():
        # 1초마다 연결 상태와 데이터 나이를 보냄 → 화면이 '오래됨'을 판단
        while True:
            await asyncio.sleep(1)
            publish({**link.snapshot(), "kind": "health"})

    @contextlib.asynccontextmanager
    async def lifespan(_app):
        loop_holder["loop"] = asyncio.get_running_loop()
        link.start()
        task = asyncio.create_task(health_ticker())
        yield
        task.cancel()
        link.stop()

    app = FastAPI(title="P01 환경 모니터 브리지", lifespan=lifespan)

    @app.get("/api/snapshot")
    def snapshot():
        return link.snapshot()

    @app.post("/api/command")
    async def command(cmd: Command):
        result = await run_in_threadpool(link.send, cmd.name.upper(), cmd.args)
        publish({"kind": "command", "name": cmd.name.upper(), "args": cmd.args, **result})
        status = 200 if result["result"] in ("applied", "error", "timeout") else 422
        return JSONResponse(result, status_code=status)

    @app.websocket("/ws")
    async def ws(socket: WebSocket):
        await socket.accept()
        q: asyncio.Queue = asyncio.Queue(maxsize=50)
        clients.add(q)
        try:
            await socket.send_text(json.dumps(link.snapshot(), ensure_ascii=False))
            while True:
                event = await q.get()
                await socket.send_text(json.dumps(event, ensure_ascii=False))
        except WebSocketDisconnect:
            pass
        finally:
            clients.discard(q)

    app.mount("/", StaticFiles(directory=WEB_DIR, html=True), name="web")
    return app


def main():
    p = argparse.ArgumentParser(description="P01 환경 모니터 브리지")
    src = p.add_mutually_exclusive_group(required=True)
    src.add_argument("--list-ports", action="store_true", help="이 PC에 보이는 COM 포트 목록만 출력(포트를 열지 않음)")
    src.add_argument("--port", help="실제 COM 포트 (예: COM5, /dev/ttyACM0). 자동 검색하지 않습니다.")
    src.add_argument("--mock", action="store_true", help="보드 없이 시뮬레이션 데이터로 화면 시험")
    p.add_argument("--host", default="127.0.0.1", help="기본값은 이 PC에서만 접속")
    p.add_argument("--http-port", type=int, default=8000)
    a = p.parse_args()
    if a.list_ports:
        from serial.tools import list_ports
        ports = list(list_ports.comports())
        if not ports:
            print("COM 포트가 보이지 않습니다. USB 케이블(데이터용)과 드라이버를 확인하세요.")
        for port in ports:
            print(f"{port.device}\t{port.description}")
        return
    uvicorn.run(create_app(a.port, a.mock), host=a.host, port=a.http_port, log_level="warning")


if __name__ == "__main__":
    main()
