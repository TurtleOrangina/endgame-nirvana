# Board sound attribution

## Result sounds (success / failure)

`success.mp3` and `failure.mp3` are each cut from a single **CC0 1.0** (public domain)
freesound.org recording (no attribution required, credited here for provenance):

- [Short Success Sound Glockenspiel Treasure Video Game.mp3](https://freesound.org/people/FunWithSound/sounds/456965/) — **FunWithSound** → `success.mp3`
- [Incorrect Chime](https://freesound.org/people/LaurenPonder/sounds/639427/) — **LaurenPonder** → `failure.mp3`

Both were trimmed with ffmpeg to cut leading silence and (for the success sound in
particular) a long ringing tail, given a short fade-in/out to avoid clicks at the new
edges, peak-normalized to -1.0 dBFS, and re-encoded with `libmp3lame -q:a 2`:

| File          | Source duration | Trimmed to            | Fade in / out |
| ------------- | --------------- | --------------------- | ------------- |
| `success.mp3` | 2.53 s          | 0.065–1.05 s (0.98 s) | 3 ms / 330 ms |
| `failure.mp3` | 1.62 s          | 0.335–1.30 s (0.96 s) | 3 ms / 250 ms |

## Board sounds (move / capture / castle / check / promote / checkmate)

All six board sounds are cut directly from three **CC0 1.0** (public domain) recordings of
chess pieces and wood foley on freesound.org:

- [Chess Pieces Drop](https://freesound.org/people/IENBA/sounds/755250/) — **IENBA**
- [piece_of_wood_thrown_or_dropped.wav](https://freesound.org/people/vibe_crc/sounds/59319/) — **vibe_crc**
- [Chess_foley.mp3](https://freesound.org/people/Amatsuuu/sounds/629181/) — **Amatsuuu**

CC0 requires no attribution; this file exists to document provenance and keep the sound set
reproducible. Each of the six files (`move`, `capture`, `castle`, `check`, `promote`,
`checkmate`) is a single segment manually trimmed out of one of the three recordings above in
Audacity — which recording fed which file wasn't recorded at the time, so that mapping isn't
reproduced here. No pitch-shifting, layering, or other source editing was applied.

## Post-processing (ffmpeg)

The raw Audacity cuts were peak-normalized, and four of the six had excess leading silence
trimmed (left over from imprecise selection in Audacity) — both applied uniformly with
ffmpeg, no other effects:

| File            | Leading silence trimmed     |
| --------------- | --------------------------- |
| `move.mp3`      | 434 ms → ~10 ms             |
| `capture.mp3`   | none (49 ms, already tight) |
| `castle.mp3`    | 213 ms → ~10 ms             |
| `check.mp3`     | none (16 ms, already tight) |
| `promote.mp3`   | 353 ms → ~10 ms             |
| `checkmate.mp3` | 185 ms → ~10 ms             |

A short 3 ms fade-in was applied after each trim to avoid a click at the new starting edge.
All six are peak-normalized to -1.0 dBFS and re-encoded with `libmp3lame -q:a 2`; each file's
original sample rate and channel layout are otherwise untouched (five files are 24 kHz
stereo, `checkmate.mp3` is 48 kHz mono — a difference carried over from the original Audacity
exports).
