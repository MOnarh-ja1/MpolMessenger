"""Offline recognizer protocol tests. No live microphone required."""
import importlib.util
import json
from pathlib import Path

root = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location(
    "mpol_speech", root / "desktop" / "native" / "mpol_speech.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

assert module.alternatives_from_result(json.dumps({
    "text": "открой чат с ноус"
}, ensure_ascii=False)) == ["открой чат с ноус"]
assert module.alternatives_from_result(json.dumps({
    "alternatives": [
        {"text": "открой чад с наус", "confidence": 40},
        {"text": "открой чат с ноус", "confidence": 38},
        {"text": "открой чаты", "confidence": 20}
    ]
}, ensure_ascii=False)) == [
    "открой чад с наус",
    "открой чат с ноус",
    "открой чаты"
]
assert module.alternatives_from_result("{}") == []
assert module.alternatives_from_result("not-json") == []
assert len(module.alternatives_from_result(json.dumps({
    "alternatives": [{"text": str(i)} for i in range(10)]
}))) == 3
print("PASS: Vosk alternatives and fallback transcript protocol")
