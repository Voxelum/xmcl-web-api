#!/usr/bin/env python3
# Classify translation records into hot/cold by Modrinth download popularity,
# train per-split zstd dictionaries, and dump length-prefixed blob files for Node to compress.
import json, os, re, sys
import zstandard as zstd

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TRANS = os.path.join(ROOT, 'translations')
pop = json.load(open(os.path.join(ROOT, 'scripts', 'modrinth_popularity.json'), encoding='utf-8'))
projects = sorted(pop['projects'], key=lambda p: -p['downloads'])
total = sum(p['downloads'] for p in projects)

# find K covering 95% of (top-10k) downloads
cum = 0
K = len(projects)
for i, p in enumerate(projects):
    cum += p['downloads']
    if cum / total >= 0.95:
        K = i + 1
        break
hot_ids = set(p['id'] for p in projects[:K])
top10k_ids = set(p['id'] for p in projects)
print(f"95% downloads threshold: rank K={K} (of top {len(projects)}); hot_ids={len(hot_ids)}")

B62 = re.compile(r'^[0-9A-Za-z]{8}$')

def read_blob(lang, name):
    j = json.load(open(os.path.join(TRANS, lang, name), encoding='utf-8'))
    c = j.get('content', '')
    if not isinstance(c, str):
        c = json.dumps(c, ensure_ascii=False)
    return c.encode('utf-8')

def dump(split_name, blobs):
    if not blobs:
        print(f"  {split_name}: EMPTY"); return
    dic = zstd.train_dictionary(112 * 1024, blobs)
    open(f'/tmp/hc_{split_name}.dict', 'wb').write(dic.as_bytes())
    with open(f'/tmp/hc_{split_name}.blobs', 'wb') as f:
        for b in blobs:
            f.write(len(b).to_bytes(4, 'little')); f.write(b)
    raw = sum(len(b) for b in blobs)
    print(f"  {split_name}: {len(blobs)} records, raw {raw/1e6:.1f}MB, dict {len(dic.as_bytes())//1024}KB")

for lang in ['zh-TW', 'ru']:
    files = os.listdir(os.path.join(TRANS, lang))
    modrinth = [f for f in files if B62.fullmatch(f[:-5]) and f.endswith('.json')]
    hot, cold = [], []
    in_top10k = 0
    for f in modrinth:
        pid = f[:-5]
        if pid in hot_ids:
            hot.append(read_blob(lang, f))
        else:
            cold.append(read_blob(lang, f))
        if pid in top10k_ids:
            in_top10k += 1
    print(f"\n[{lang}] modrinth records={len(modrinth)}, in-top10k={in_top10k} ({in_top10k/len(modrinth)*100:.0f}%), hot(in top-K)={len(hot)}, cold={len(cold)}")
    dump(f'{lang}_hot', hot)
    dump(f'{lang}_cold', cold)

# ru full (all records incl curseforge) for the standard single-db benchmark
ru_files = [f for f in os.listdir(os.path.join(TRANS, 'ru')) if f.endswith('.json')]
ru_all = [read_blob('ru', f) for f in ru_files]
print(f"\n[ru] ALL records={len(ru_all)}")
dump('ru_all', ru_all)
