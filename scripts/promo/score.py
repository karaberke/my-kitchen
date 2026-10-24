#!/usr/bin/env python3
"""Compose the original, quiet instrumental bed used by the app recording.

No samples or music services are used. A sparse electric-piano arrangement,
slightly varied timing and dynamics, and a short stereo room keep the bed warm.
Interaction sounds are drawn only from the actual recorded event timestamps.
"""

import argparse
from array import array
import json
import math
from pathlib import Path
import random
import sys
import wave


SAMPLE_RATE = 32000
SEED = 20261023
TAU = 2 * math.pi
MOOD_TEMPOS = {"quiet": 77.5, "light": 90}


def add_note(channels, midi, start, duration, velocity, pan, rng):
    """A softly struck tine with a damped fundamental and quiet upper partials."""
    frequency = 440 * 2 ** ((midi - 69) / 12)
    first = max(0, int(start * SAMPLE_RATE))
    length = min(int(duration * SAMPLE_RATE), len(channels[0]) - first)
    left = math.sqrt((1 - pan) / 2)
    right = math.sqrt((1 + pan) / 2)
    phase = rng.uniform(-0.08, 0.08)
    for index in range(length):
        time = index / SAMPLE_RATE
        attack = 1 - math.exp(-time * 180)
        release = min(1, (length - index) / (SAMPLE_RATE * 0.3))
        body = (
            math.sin(TAU * frequency * time + phase) * math.exp(-time / 2.4)
            + 0.28 * math.sin(TAU * frequency * 2.001 * time) * math.exp(-time / 1.2)
            + 0.075 * math.sin(TAU * frequency * 3.998 * time) * math.exp(-time / 0.5)
            + 0.018 * math.sin(TAU * frequency * 6.983 * time) * math.exp(-time / 0.12)
        )
        sample = velocity * attack * release * body
        channels[0][first + index] += sample * left
        channels[1][first + index] += sample * right


def compose_music(channels, duration, mood):
    rng = random.Random(SEED)
    beat_seconds = 60 / MOOD_TEMPOS[mood]
    bar_seconds = 4 * beat_seconds
    # Dmaj9, Aadd9/C#, Bm7, Gmaj9: open voicings leave space for the app.
    progression = [
        (38, (57, 61, 64, 69)),
        (37, (57, 59, 64, 69)),
        (35, (57, 62, 66, 69)),
        (31, (54, 57, 62, 69)),
    ]
    bars = int(duration / bar_seconds)
    for bar in range(bars):
        start = 0.38 + bar * bar_seconds
        if start > duration - 5.5:
            break
        bass, chord = progression[(bar // 2) % len(progression)]
        if start >= duration - 10:
            bass, chord = progression[0]
        add_note(channels, bass, start, 4.5, 0.12, -0.05, rng)
        # Rolled chords and an occasional answering note, with no drum loop.
        for note_index, note in enumerate(chord):
            onset = start + note_index * 0.058 + rng.uniform(-0.015, 0.015)
            add_note(channels, note, onset, 4.0, rng.uniform(0.075, 0.095), 0.1, rng)
        if bar % 2 == 0 and bar < 16:
            add_note(
                channels,
                chord[-1] + (2 if bar % 4 == 0 else 0),
                start + 2.5 * beat_seconds + rng.uniform(-0.03, 0.03),
                2.8,
                0.046,
                -0.22,
                rng,
            )
        if mood == "light":
            for beat, note in zip((1.5, 2.5, 3.5), chord[:3]):
                add_note(
                    channels,
                    note,
                    start + beat * beat_seconds + rng.uniform(-0.025, 0.025),
                    1.6,
                    rng.uniform(0.03, 0.045),
                    -0.12 if beat == 2.5 else 0.12,
                    rng,
                )

    # A few reflections, rather than an obvious rhythmic delay.
    for channel_index, channel in enumerate(channels):
        dry = array("f", channel)
        other = channels[1 - channel_index]
        for delay_seconds, gain in ((0.043, 0.13), (0.079, 0.09), (0.131, 0.055)):
            delay = int((delay_seconds + channel_index * 0.006) * SAMPLE_RATE)
            for index in range(delay, len(channel)):
                channel[index] += dry[index - delay] * gain
        # Very quiet cross-feed approximates a small, soft room.
        delay = int(0.101 * SAMPLE_RATE)
        for index in range(delay, len(channel)):
            channel[index] += other[index - delay] * 0.018


def add_interactions(channels, events):
    rng = random.Random(SEED + 1)
    previous = -1
    for event in events:
        kind = event.get("kind")
        at = event.get("at", -1)
        if kind not in ("tap", "type") or at < 0 or at - previous < 0.09:
            continue
        previous = at
        first = round(at * SAMPLE_RATE)
        seconds = 0.028 if kind == "tap" else 0.018
        length = min(round(seconds * SAMPLE_RATE), len(channels[0]) - first)
        amplitude = 0.034 if kind == "tap" else 0.016
        frequency = 430 if kind == "tap" else 780
        smooth_noise = 0
        for index in range(max(0, length)):
            time = index / SAMPLE_RATE
            smooth_noise = 0.58 * smooth_noise + 0.42 * rng.uniform(-1, 1)
            envelope = (1 - math.exp(-time * 2400)) * math.exp(-time * 230)
            sample = amplitude * envelope * (
                0.8 * smooth_noise + 0.2 * math.sin(TAU * frequency * time)
            )
            channels[0][first + index] += sample
            channels[1][first + index] += sample


def write_wav(path, channels, duration, music_peak):
    pcm = array("h")
    peak = 0
    sum_squares = 0
    gain = min(1, 0.18 / max(music_peak, 0.001))
    for index in range(len(channels[0])):
        time = index / SAMPLE_RATE
        fade_in = min(1, time / 1.2)
        fade_out = min(1, max(0, (duration - time) / 5.5))
        fade = fade_in * fade_out
        for channel in channels:
            sample = max(-1, min(1, channel[index] * gain * fade))
            peak = max(peak, abs(sample))
            sum_squares += sample * sample
            pcm.append(round(sample * 32767))
    if sys.byteorder != "little":
        pcm.byteswap()
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as output:
        output.setnchannels(2)
        output.setsampwidth(2)
        output.setframerate(SAMPLE_RATE)
        output.writeframes(pcm.tobytes())
    rms = math.sqrt(sum_squares / max(1, len(pcm)))
    return {
        "peakDbfs": round(20 * math.log10(max(peak, 1e-9)), 2),
        "rmsDbfs": round(20 * math.log10(max(rms, 1e-9)), 2),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--duration", type=float, required=True)
    parser.add_argument("--events", type=Path)
    parser.add_argument("--mood", choices=MOOD_TEMPOS, default="quiet")
    args = parser.parse_args()
    if not 1 <= args.duration <= 120:
        parser.error("duration must be between 1 and 120 seconds")
    frames = round(args.duration * SAMPLE_RATE)
    channels = [array("f", [0]) * frames, array("f", [0]) * frames]
    compose_music(channels, args.duration, args.mood)
    music_peak = max(max(map(abs, channel)) for channel in channels)
    if args.events:
        events = json.loads(args.events.read_text(encoding="utf-8"))
        add_interactions(channels, events)
    levels = write_wav(args.output, channels, args.duration, music_peak)
    print(json.dumps({"path": str(args.output), "duration": args.duration, **levels}))


if __name__ == "__main__":
    main()
