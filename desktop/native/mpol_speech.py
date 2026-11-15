"""One-shot, offline Russian voice command capture for MPOL Windows desktop.
Bundled with a pinned Apache-2.0 Vosk small Russian model and PyInstaller.
The microphone is opened only while a user explicitly presses the orb.
"""
import argparse
import json
import os
import queue
import sys
import time
from pathlib import Path


def emit(ok, **fields):
    sys.stdout.write(json.dumps({"ok": ok, **fields}, ensure_ascii=True) + "\n")
    sys.stdout.flush()



def alternatives_from_result(raw):
    """Vosk with SetMaxAlternatives() returns alternatives, not top-level text."""
    try:
        result = json.loads(raw)
    except (ValueError, TypeError):
        return []
    alternatives = result.get("alternatives", [])
    if alternatives:
        return [
            entry.get("text", "").strip() for entry in alternatives
            if isinstance(entry, dict) and entry.get("text", "").strip()
        ][:3]
    text = result.get("text", "").strip()
    return [text] if text else []


def recognize(model_path, max_seconds=9):
    try:
        import sounddevice as sd
        from vosk import KaldiRecognizer, Model, SetLogLevel
    except Exception as exc:
        return {"ok": False, "code": "engine", "message": "Локальный движок распознавания недоступен.", "details": type(exc).__name__}

    if not Path(model_path).is_dir():
        return {"ok": False, "code": "model", "message": "Не найдена русская модель распознавания."}

    try:
        SetLogLevel(-1)
        model = Model(str(model_path))
    except Exception as exc:
        return {"ok": False, "code": "model", "message": "Не удалось загрузить русскую речевую модель.", "details": type(exc).__name__}

    if max_seconds == 0:
        return {"ok": True, "code": "ready", "engine": "vosk-ru-offline"}

    audio_chunks = queue.Queue(maxsize=96)

    def on_audio(indata, frames, time_info, status):
        del frames, time_info, status
        try:
            audio_chunks.put_nowait(bytes(indata))
        except queue.Full:
            try:
                audio_chunks.get_nowait()
                audio_chunks.put_nowait(bytes(indata))
            except queue.Empty:
                pass

    try:
        device = sd.query_devices(kind="input")
        default_rate = int(device["default_samplerate"])
        rate = 16000
        try:
            sd.check_input_settings(samplerate=rate, channels=1, dtype="int16")
        except Exception:
            rate = default_rate

        recognizer = KaldiRecognizer(model, float(rate))
        recognizer.SetMaxAlternatives(3)
        timeout = time.monotonic() + max_seconds
        segments = []
        last_segment_at = None

        with sd.RawInputStream(samplerate=rate, blocksize=4000,
                               channels=1, dtype="int16", callback=on_audio):
            while time.monotonic() < timeout:
                if last_segment_at and time.monotonic() - last_segment_at >= .75:
                    break
                try:
                    chunk = audio_chunks.get(timeout=min(.2, max(.01, timeout - time.monotonic())))
                except queue.Empty:
                    continue
                if recognizer.AcceptWaveform(chunk):
                    variants = alternatives_from_result(recognizer.Result())
                    if variants:
                        segments.append(variants)
                        # Let the person finish a nickname after an early pause.
                        last_segment_at = time.monotonic()
                    continue

            final_variants = alternatives_from_result(recognizer.FinalResult())
            if final_variants:
                segments.append(final_variants)

        if not segments:
            return {"ok": False, "code": "no-speech",
                    "message": "Не удалось разобрать голос. Нажмите и повторите команду."}

        primary = " ".join(part[0] for part in segments).strip()[:160]
        options = [primary]
        # Try alternative hypotheses for ambiguous utterances without
        # requiring an AI API or a server-side speech upload.
        for index, part in enumerate(segments):
            for other in part[1:]:
                phrase = " ".join(
                    other if i == index else item[0]
                    for i, item in enumerate(segments)
                ).strip()[:160]
                if phrase and phrase not in options:
                    options.append(phrase)
        if primary:
            return {"ok": True, "text": primary,
                    "alternatives": options[1:6], "engine": "vosk-ru-offline"}
        return {"ok": False, "code": "no-speech",
                "message": "Не удалось разобрать голос. Нажмите и повторите команду."}
    except Exception as exc:
        return {"ok": False, "code": "microphone", "message": "Нет доступа к микрофону или он занят другим приложением.", "details": type(exc).__name__}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--max-seconds", type=float, default=9)
    parser.add_argument("--diagnose", action="store_true")
    args = parser.parse_args()
    try:
        result = recognize(args.model, 0 if args.diagnose else max(1, min(15, args.max_seconds)))
        emit(**result)
    except Exception as exc:
        emit(False, code="unexpected", message="Ошибка локального распознавания.", details=type(exc).__name__)
