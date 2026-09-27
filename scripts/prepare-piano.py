"""Rebuild the compact, attributed Salamander piano bank (requires ffmpeg)."""
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from urllib.request import urlopen, Request
from urllib.parse import quote
import hashlib
import json
import subprocess
import time

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'samples' / 'piano'
REVISION = '3382bf9496bba2486f5ab0de55a264d1dfc38404'
BASE = f'https://raw.githubusercontent.com/sfzinstruments/SalamanderGrandPiano/{REVISION}/'
NAMES = ['C', 'Cs', 'D', 'Ds', 'E', 'F', 'Fs', 'G', 'Gs', 'A', 'As', 'B']
OUT.mkdir(parents=True, exist_ok=True)

def fetch(url):
    for attempt in range(3):
        try:
            with urlopen(Request(url, headers={'User-Agent': 'Browsynth-sample-builder'}), timeout=45) as response:
                return response.read()
        except Exception:
            if attempt == 2:
                raise
            time.sleep(attempt + 1)

def prepare(midi, layer):
    note = NAMES[midi % 12] + str(midi // 12 - 1)
    source_name = note.replace('s', '#') + f'v{layer}.flac'
    dest = OUT / f'{note}-v{layer}.mp3'
    if not dest.exists():
        source = fetch(BASE + 'Samples/' + quote(source_name))
        subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y',
            '-i', 'pipe:0', '-af', 'silenceremove=start_periods=1:start_threshold=-75dB,atrim=duration=7,afade=t=out:st=6:d=1',
            '-ar', '44100', '-ac', '2', '-codec:a', 'libmp3lame', '-b:a', '112k',
            '-map_metadata', '-1', str(dest)], input=source, check=True)
    data = dest.read_bytes()
    return {'midi': midi, 'layer': layer, 'file': dest.name, 'source': source_name,
            'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}

if __name__ == '__main__':
    entries = []
    with ThreadPoolExecutor(max_workers=5) as pool:
        jobs = [pool.submit(prepare, midi, layer) for midi in range(33, 97, 3) for layer in (4, 8, 12)]
        for future in as_completed(jobs):
            entries.append(future.result())
            if len(entries) % 11 == 0:
                print(f'{len(entries)}/{len(jobs)} piano samples ready', flush=True)
    (OUT / 'LICENSE.txt').write_bytes(fetch(BASE + 'LICENSE'))
    (OUT / 'manifest.json').write_text(json.dumps({'sourceRevision': REVISION,
        'samples': sorted(entries, key=lambda x: (x['midi'], x['layer']))}, indent=2) + '\n', encoding='utf-8')
    print(f'Complete: {len(entries)} files, {sum(e["bytes"] for e in entries)/1024/1024:.1f} MiB', flush=True)
