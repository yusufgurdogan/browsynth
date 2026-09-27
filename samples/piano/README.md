# Piano recordings

Salamander Grand Piano V3 by **Alexander Holm**, used under [Creative Commons Attribution 3.0](https://creativecommons.org/licenses/by/3.0/).

- Source: https://github.com/sfzinstruments/SalamanderGrandPiano
- Source revision: `3382bf9496bba2486f5ab0de55a264d1dfc38404`
- Original release: https://archive.org/details/SalamanderGrandPianoV3
- Full license: [LICENSE.txt](LICENSE.txt)

Browsynth uses 22 recorded notes from A1 through C7, each at three recorded strengths (layers 4, 8, and 12). Other notes are pitched from the nearest recording. The recordings are stereo; the engine blends adjacent strength layers in response to playing velocity.

Modifications: initial silence removed at −75 dB, tails limited to seven seconds with a one-second fade, resampled to 44.1 kHz and encoded to stereo MP3 at 112 kbps. The felt and dream variations use additional filtering and effects; they are treatments of the grand piano recordings, not separate recorded instruments.

Run `python scripts/prepare-piano.py` from the repository to reproduce the files. Requires ffmpeg. The manifest records filenames, source revision, sizes, and SHA-256 checksums. The SFZ mapping is not used.
