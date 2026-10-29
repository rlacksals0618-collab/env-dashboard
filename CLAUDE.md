# 학습공간 환경 모니터 — 작업 인계 메모

이 폴더를 여는 AI 코딩 에이전트(Claude Code, Codex 등)가 먼저 읽는 문서입니다.
Claude(Cowork) 대화에서 정한 내용을 정리했습니다. 내용을 바꿀 때는 사용자에게 먼저 확인합니다.

## 목적
- K-Digital 피지컬AI 과정, 사용자: 김찬민 (비전공 학습자 → 설명은 쉬운 말로)
- UNO 센서값을 웹 대시보드로 보고 조명(LED)을 제어하는 **학습공간 환경 모니터**
- 사용 맥락(ISO 9241-11): 수업 시연·평가. 처음 보는 강사·동료가 프로젝터 화면으로 봄
- 목표 과제: ① 현재 환경 파악 ② LED 수동/자동 전환 ③ 조도 기준 변경
- 접근성: **WCAG 2.2 AA** 충족 (README의 대응 표 참고)

## 하드웨어 (아두이노 고급키트 구성품만 사용)
- UNO 호환 R3 1대, 미니 브레드보드(17줄, 전원 레일 없음), 수–수 점퍼, 암–수 10개
- 외부 5V 전원 없음 → 서보·스텝모터·릴레이 구동 금지
- 연결 (UNO 핀 ↔ 부품) — `firmware/P01/pins.h`와 일치, **바꾸지 않음**

| UNO | 부품 |
|---|---|
| D8 | 저항(220Ω~1kΩ) → 빨강 LED + / LED − → GND |
| D2 | 택트 스위치 (반대쪽 GND, INPUT_PULLUP) |
| A0 | 가변저항 10K 가운데 (양끝 5V·GND) |
| A1 | 5V–CdS–(A1)–10kΩ–GND 분압. **어두울수록 값이 작음** |
| D4 | DHT11 DATA (VCC 5V, GND) |
| A4 / A5 | LCD1602 IIC SDA / SCL (VCC 5V, GND) |
- DHT11·LCD는 암–수 케이블로 UNO에 직접. UNO GND 핀 2개 사용. D0/D1 비움.

## 통신 규약 (강사 배포 P01 펌웨어, 원본 그대로)
- USB 시리얼 115200, 줄 끝 LF. PC→보드: `요청번호 명령 인수`
- 명령: `STATUS`, `PING`, `STOP`, `LED 0|1`(자동 해제), `AUTO 0|1`, `THRESH on off`(0–1023, on<off)
- 보드→PC: JSON 한 줄 `ack` / `error` / `state`(1초마다 request=0)
- state 필드: `pot_raw, light_raw, button_pressed, led(0/1), auto, lcd_ready, temperature_c, humidity_pct` (DHT 실패·측정 전은 null)
- 펌웨어는 THRESH 값을 state로 보내지 않음 → 브리지가 마지막 적용값을 기억, 보드 재시작(ms 감소) 시 350/450으로 되돌림

## 소프트웨어 구조
- `bridge/` Python FastAPI: COM 포트 단독 관리(`board_link.py`), 규약 검사(`protocol.py`), 웹 서버(`app.py`), 시뮬레이터(`mock_board.py`)
- `web/` 순수 HTML/CSS/JS (빌드 없음). WebSocket `/ws`로 상태 수신, `POST /api/command`로 명령
- 실행: `run_board.bat`(실물, COM 포트 입력) / `run_mock.bat`(시뮬레이션, 화면에 계속 표시됨)

## 반드시 지킬 규칙
- 출력 명령 **자동 재전송 금지**. 3초 응답 없으면 "적용 여부 알 수 없음"으로 표시
- 연결 직후 2초 대기 → STATUS로 P01 확인, 다른 회로면 명령 차단
- `null`(값 없음) · 숫자 0 · 오래됨(3초 초과) · 연결 끊김을 섞지 않음. 끊겼을 때 출력이 꺼졌다고 추정하지 않음
- ack는 "보드 프로그램이 적용"일 뿐, 실제 LED 점등은 눈으로 확인한다고 안내
- 시뮬레이션 값을 실제 측정처럼 기록·발표하지 않음
- 색만으로 상태를 전달하지 않음(글자+아이콘), 대비 4.5:1 / 3:1, 키보드 조작, 타깃 24px 이상

## 확정된 화면 요구사항
- 밝기: 어두움/보통/밝음 구간을 크게, 원시값·기준선은 작게 (구간 = 켜는 기준 미만 / 사이 / 끄는 기준 초과)
- 기록: 최근 5분 추이(브라우저 메모리), 그래프 일시정지, 30초 간격 표
- 경고: 온도 상한·습도 하한/상한을 화면에서 조절(기본 26°C, 30%, 70%), aria-live로 알림

## 다음 할 일
1. Arduino IDE로 `firmware/P01/P01.ino` 업로드 (라이브러리: DHT sensor library, Adafruit Unified Sensor, hd44780)
2. `run_board.bat` 실행 후 실제 값 확인
3. 강의실 조명 켬/끔/손으로 가림 상태의 `light_raw`를 기록해 THRESH 기준 확정
4. 키보드만으로 세 과제 수행 점검, 가능하면 NVDA로 확인
