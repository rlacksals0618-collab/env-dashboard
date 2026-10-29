"""P01 시리얼 규약(115200, '요청번호 명령 인수' → JSON 한 줄)을 검사하는 함수 모음.

보드가 보내는 줄은 믿지 않고 형식을 확인한 뒤에만 사용합니다.
웹에서 받은 명령도 여기서 허용 목록과 범위를 확인합니다.
"""
import json

PROFILE = "P01"
DEFAULT_THRESHOLDS = (350, 450)  # P01.ino의 onThreshold/offThreshold 시작값

# P01 state 필드와 허용 타입. None은 DHT 측정 전·실패를 뜻하는 null입니다.
STATE_FIELDS = {
    "pot_raw": int,
    "light_raw": int,
    "button_pressed": bool,
    "led": int,
    "auto": bool,
    "lcd_ready": bool,
    "temperature_c": (int, float, type(None)),
    "humidity_pct": (int, float, type(None)),
}


class ProtocolError(ValueError):
    """규약에 맞지 않는 줄 또는 명령."""


def decode_line(raw: bytes) -> dict:
    """보드가 보낸 한 줄을 검사해 dict로 돌려줍니다. 맞지 않으면 ProtocolError."""
    try:
        msg = json.loads(raw.decode("utf-8").strip())
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ProtocolError("not_json") from exc
    if not isinstance(msg, dict) or msg.get("v") != 1:
        raise ProtocolError("unsupported_version")
    kind = msg.get("type")
    if kind not in ("state", "ack", "error"):
        raise ProtocolError("unknown_type")
    req = msg.get("request")
    if type(req) is not int or not 0 <= req <= 65535:
        raise ProtocolError("bad_request_id")
    if kind == "state":
        if msg.get("profile") != PROFILE:
            # 다른 회로의 스케치가 올라간 경우. 값은 쓰지 않습니다.
            raise ProtocolError("profile_mismatch:" + str(msg.get("profile")))
        for name, allowed in STATE_FIELDS.items():
            value = msg.get(name)
            # bool은 int의 하위 타입이므로 int 필드에 true/false가 오면 거절합니다.
            if allowed is int and type(value) is not int:
                raise ProtocolError("bad_field:" + name)
            if allowed is not int and not isinstance(value, allowed):
                raise ProtocolError("bad_field:" + name)
        if type(msg.get("ms")) is not int:
            raise ProtocolError("bad_field:ms")
    if kind == "error" and not isinstance(msg.get("code"), str):
        raise ProtocolError("bad_error_code")
    return msg


def build_command(name: str, args: list) -> str:
    """웹 요청을 검사해 '명령 인수' 문자열을 만듭니다(요청번호는 붙이지 않음)."""
    if not isinstance(args, list):
        raise ProtocolError("args_must_be_list")
    if name in ("LED", "AUTO"):
        if len(args) != 1 or type(args[0]) is not int or args[0] not in (0, 1):
            raise ProtocolError("value_must_be_0_or_1")
        return f"{name} {args[0]}"
    if name == "THRESH":
        if len(args) != 2 or any(type(a) is not int for a in args):
            raise ProtocolError("thresh_needs_two_integers")
        on, off = args
        if not (0 <= on <= 1023 and 0 <= off <= 1023):
            raise ProtocolError("thresh_out_of_range")
        if on >= off:
            raise ProtocolError("thresh_on_must_be_below_off")
        return f"THRESH {on} {off}"
    if name == "STOP":
        if args:
            raise ProtocolError("stop_takes_no_args")
        return "STOP"
    raise ProtocolError("unsupported_command")
