#!/usr/bin/env python3
"""Rebuild bundled wordbooks from pinned, checksum-verified public sources (stdlib only)."""
import argparse
import csv
import hashlib
import json
from pathlib import Path
import re
import shutil
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / 'apps/web/public/wordbooks'
ECDICT_REV = 'bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b'
SOURCES = {
 'ecdict.csv': (f'https://raw.githubusercontent.com/skywind3000/ECDICT/{ECDICT_REV}/ecdict.csv', '1a6947e04785db63613a92e14903cdae7954f7e84860b10e68e5c7cbb3f9c3cf'),
 'ecdict-LICENSE.txt': (f'https://raw.githubusercontent.com/skywind3000/ECDICT/{ECDICT_REV}/LICENSE', 'f8552dd246f61a4e064569eae6194a01c6b3d63b03bf27c6ca863593c549ed0f'),
 'nawl-1.2.txt': ('https://static1.squarespace.com/static/64336926d7c6bb38965fdf3b/t/644e0e936f1c072f5a0503f8/1682837139514/NAWL_1.2_alphabetized_description.txt', '88a99099e10010ea40992cca4a5119102d05a0f2888ee5d43d4c8b4afd597fef'),
 'ngsl-1.2.txt': ('https://static1.squarespace.com/static/64336926d7c6bb38965fdf3b/t/644e0bd98eabfa3b566ca510/1682836441532/NGSL_1.2_alphabetized_description.txt', '8056a5252576ddc5a3c2e96b1422eb2bc7991bdc527ecb2e00181fadff51d9dc'),
 'CC-BY-SA-4.0.txt': ('https://creativecommons.org/licenses/by-sa/4.0/legalcode.txt', '28a9529c7d0bb4dc51f4bf5c116a3d16ef247a052f7591466768ddf563fd1cf5'),
}
WORD = re.compile(r"[a-zA-Z][a-zA-Z '’.-]*")
def sha(data): return hashlib.sha256(data).hexdigest()
def fetch(directory, name):
 path = directory / name
 if not path.exists():
  print('Downloading', name)
  with urllib.request.urlopen(SOURCES[name][0], timeout=120) as source, path.open('wb') as output:
   shutil.copyfileobj(source, output)
 if sha(path.read_bytes()) != SOURCES[name][1]:
  raise ValueError(f'Checksum mismatch: {name}; do not silently use a changed source')
 return path

def main():
 parser = argparse.ArgumentParser(description=__doc__)
 parser.add_argument('--source-dir', type=Path, default=Path('/tmp/vocabflow-wordbook-sources'))
 args = parser.parse_args(); args.source_dir.mkdir(parents=True, exist_ok=True)
 paths = {name: fetch(args.source_dir, name) for name in SOURCES}
 dictionary = {}; ielts = []
 with paths['ecdict.csv'].open(encoding='utf-8', newline='') as source:
  for row in csv.DictReader(source):
   if WORD.fullmatch(row['word']) and len(row['word']) <= 160 and row['translation'] and len(row['translation']) <= 4000:
    dictionary.setdefault(row['word'].lower(), row)
    if 'ielts' in row['tag'].split(): ielts.append(row)
 def translation(word):
  row = dictionary.get(word.lower())
  if not row: raise ValueError(f'Missing translation: {word}')
  zh = row['translation'].replace('\\n', '\n').replace('\r', '').strip()
  if not re.search(r'[\u4e00-\u9fff]', zh): raise ValueError(f'Missing Chinese meaning: {word}')
  return zh
 def official_words(name, first, count):
  lines = paths[name].read_text(encoding='utf-8-sig').splitlines()
  words = [line.strip() for line in lines[lines.index(first):] if line.strip()]
  if len(words) != count or len({w.lower() for w in words}) != count or any(not WORD.fullmatch(w) for w in words):
   raise ValueError(f'Unexpected wordlist shape: {name}')
  return words
 def frequency(row):
  bnc = int(row['bnc'] or 0); frq = int(row['frq'] or 0)
  return (bnc if bnc > 0 else frq if frq > 0 else 10**9, row['word'].lower())
 # The app calls these built-in lists, not an exam board's official syllabus.
 definitions = [
  dict(id='ielts-ecdict', title='雅思常用词', description='按 ECDICT 的 IELTS 标签整理，按词频优先排列，适合雅思词汇积累与查漏补缺。', version=f'ECDICT-{ECDICT_REV[:8]}', words=[r['word'] for r in sorted(ielts, key=frequency)], sourceName='ECDICT · IELTS 标签', sourceUrl=f'https://github.com/skywind3000/ECDICT/tree/{ECDICT_REV}', license='MIT', licenseUrl=f'https://github.com/skywind3000/ECDICT/blob/{ECDICT_REV}/LICENSE'),
  dict(id='nawl-12', title='NAWL 学术核心词', description='NGSL Project 的 NAWL 1.2 学术词表，配中文释义，适合学术阅读与写作拓展。', version='1.2-zh-1', words=official_words('nawl-1.2.txt','abdominal',957), sourceName='NGSL Project · NAWL', sourceUrl='https://www.newgeneralservicelist.com/new-academic-word-list', license='CC BY-SA 4.0', licenseUrl='https://creativecommons.org/licenses/by-sa/4.0/'),
  dict(id='ngsl-12', title='NGSL 基础高频词', description='NGSL Project 的 NGSL 1.2 通用高频词表，配中文释义，为雅思与学术英语打好基础。', version='1.2-zh-1', words=official_words('ngsl-1.2.txt','a',2809), sourceName='NGSL Project · NGSL', sourceUrl='https://www.newgeneralservicelist.com/new-general-service-list', license='CC BY-SA 4.0', licenseUrl='https://creativecommons.org/licenses/by-sa/4.0/'),
 ]
 DEST.mkdir(parents=True, exist_ok=True); (DEST / 'licenses').mkdir(exist_ok=True)
 catalog = []
 for definition in definitions:
  words = definition.pop('words')
  if len({w.lower() for w in words}) != len(words): raise ValueError('Duplicate headwords')
  rows = [[word, translation(word)] for word in words]
  data = ('[\n'+',\n'.join(json.dumps(row, ensure_ascii=False, separators=(',', ':')) for row in rows)+'\n]\n').encode('utf-8')
  digest = sha(data); filename = f"{definition['id']}.{digest[:12]}.json"
  (DEST / filename).write_bytes(data)
  candidates = {'ielts-ecdict': ['acquire','assess','concept','evidence','strategy'], 'nawl-12': ['hypothesis','empirical','variable','methodology','validity'], 'ngsl-12': ['ability','discuss','explain','improve','reason']}[definition['id']]
  sample = [word for word in candidates if word in words]
  book = {**definition, 'count': len(rows), 'sha256': digest, 'file': '/wordbooks/'+filename, 'sample': (sample + [word for word in words if word not in sample])[:5]}
  catalog.append(book); print(book['id'], book['count'], len(data), 'bytes', digest)
 (DEST / 'catalog.json').write_text(json.dumps(catalog, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
 shutil.copyfile(paths['ecdict-LICENSE.txt'], DEST / 'licenses/ECDICT-MIT.txt')
 shutil.copyfile(paths['CC-BY-SA-4.0.txt'], DEST / 'licenses/CC-BY-SA-4.0.txt')
 # Only remove old generated payloads, never notices or source documents.
 current = {Path(book['file']).name for book in catalog}
 for old in DEST.glob('*.json'):
  if old.name != 'catalog.json' and old.name not in current: old.unlink()

if __name__ == '__main__': main()
