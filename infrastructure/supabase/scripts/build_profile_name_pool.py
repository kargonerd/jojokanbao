"""Build the checked-in reader-code name pool from the TaiCOL archive."""

from __future__ import annotations

import argparse
import csv
import hashlib
import io
import re
import tempfile
import urllib.request
import zipfile
from collections import defaultdict
from pathlib import Path
from typing import Iterable

import zhconv


SOURCE_URL = "https://ipt.taibif.tw/archive.do?r=taibnet_com_all"
SOURCE_SHA256 = "56755faa08d74d64301e140df5f7fb4dabbab40c8b369cde2003f4582b794aa4"
SOURCE_CITATION = (
    "Shao K, Chung K (2024). The National Checklist of Taiwan "
    "(Catalogue of Life in Taiwan, TaiCOL). Version 1.13. "
    "https://doi.org/10.15468/auw1kd"
)

NAMES_PER_KIND = 1_500
SHORT_NAMES_PER_KIND = 1_350
CHINESE_NAME = re.compile(r"^[\u3400-\u9fff]{2,7}$")

CURATED_NAMES = {
    "animal": (
        "东北虎", "华南虎", "非洲狮", "金钱豹", "云豹", "猎豹", "北极熊",
        "棕熊", "黑熊", "灰狼", "狐狸", "浣熊", "水獭", "河狸", "兔狲",
        "雪豹", "猞猁", "赤狐", "麋鹿", "梅花鹿", "马鹿", "驼鹿", "驯鹿",
        "藏羚羊", "野牦牛", "牦牛", "野猪", "熊猫", "大熊猫", "小熊猫",
        "金丝猴", "长臂猿", "黑猩猩", "大猩猩", "松鼠", "花栗鼠", "刺猬",
        "袋鼠", "树袋熊", "鸭嘴兽", "食蚁兽", "水豚", "长颈鹿", "斑马",
        "犀牛", "河马", "非洲象", "亚洲象", "野骆驼", "羊驼", "穿山甲",
        "海狮", "海象", "海豚", "白鲸", "蓝鲸", "虎鲸", "儒艮", "座头鲸",
        "抹香鲸", "火烈鸟", "丹顶鹤", "朱鹮", "苍鹰", "翠鸟", "猫头鹰",
        "啄木鸟", "渡鸦", "企鹅", "帝企鹅", "孔雀", "天鹅", "鸳鸯",
        "扬子鳄", "眼镜蛇", "变色龙", "小丑鱼", "海星", "寄居蟹",
        "独角仙", "萤火虫",
    ),
    "plant": (
        "牡丹", "芍药", "梅花", "兰花", "菊花", "荷花", "莲花", "桃花",
        "杏花", "梨花", "桂花", "茉莉", "海棠", "山茶", "杜鹃", "紫薇",
        "木棉", "樱花", "腊梅", "月季", "玫瑰", "百合", "水仙", "郁金香",
        "向日葵", "蒲公英", "三色堇", "风信子", "勿忘我", "满天星",
        "康乃馨", "牵牛花", "虞美人", "金银花", "紫罗兰", "山楂", "枫树",
        "柳树", "杨树", "松树", "柏树", "榕树", "槐树", "梧桐", "桦树",
        "椰树", "芦苇", "芭蕉", "香蕉", "荔枝", "龙眼", "芒果", "石榴",
        "核桃", "葡萄", "草莓", "蓝莓", "西瓜", "南瓜", "冬瓜", "黄瓜",
        "番茄", "土豆", "玉米", "水稻", "小麦", "高粱", "大豆", "花生",
        "茶树", "棉花", "薄荷", "艾草", "人参", "灵芝", "枸杞", "甘草",
        "银杏", "玉兰", "薰衣草", "鸢尾", "雪松", "竹子", "紫云英",
        "樟树", "榆树", "桃树", "橘树", "油菜", "荞麦", "燕麦", "芝麻",
    ),
}

KINGDOM_TO_KIND = {
    "Animalia": "animal",
    "Plantae": "plant",
}


def stable_key(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def download_archive() -> Path:
    target = Path(tempfile.gettempdir()) / "jojo-taicol-1.13.zip"
    request = urllib.request.Request(
        SOURCE_URL,
        headers={"User-Agent": "JOJO-Platform profile-name-pool builder"},
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        target.write_bytes(response.read())
    return target


def verify_archive(path: Path) -> None:
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    if digest != SOURCE_SHA256:
        raise ValueError(
            f"TaiCOL archive checksum changed: expected {SOURCE_SHA256}, got {digest}"
        )


def load_candidates(archive_path: Path) -> dict[str, dict[str, set[str]]]:
    candidates: dict[str, dict[str, set[str]]] = {
        "animal": defaultdict(set),
        "plant": defaultdict(set),
    }

    with zipfile.ZipFile(archive_path) as archive:
        with archive.open("taxon.txt") as raw_file:
            text_file = io.TextIOWrapper(raw_file, encoding="utf-8", newline="")
            for row in csv.DictReader(text_file, delimiter="\t"):
                kind = KINGDOM_TO_KIND.get(row["kingdom"])
                if (
                    kind is None
                    or row["taxonomicStatus"] != "accepted"
                    or row["taxonRank"] != "species"
                ):
                    continue

                name = zhconv.convert(row["vernacularName"].strip(), "zh-hans")
                if not CHINESE_NAME.fullmatch(name):
                    continue

                taxonomic_group = row["class"] or row["phylum"] or "other"
                candidates[kind][taxonomic_group].add(name)

    return candidates


def round_robin_names(
    groups: dict[str, set[str]],
    *,
    short: bool,
    excluded: set[str],
) -> Iterable[str]:
    buckets = {
        group: sorted(
            (
                name
                for name in names
                if (len(name) <= 3) is short and name not in excluded
            ),
            key=stable_key,
        )
        for group, names in groups.items()
    }
    group_order = sorted(buckets, key=stable_key)

    while True:
        yielded = False
        for group in group_order:
            bucket = buckets[group]
            while bucket and bucket[-1] in excluded:
                bucket.pop()
            if not bucket:
                continue
            yielded = True
            yield bucket.pop()
        if not yielded:
            return


def build_pool(
    candidates: dict[str, dict[str, set[str]]],
) -> dict[str, list[str]]:
    curated_names = {
        name
        for names in CURATED_NAMES.values()
        for name in names
    }
    if len(curated_names) != sum(map(len, CURATED_NAMES.values())):
        raise ValueError("curated animal and plant names must not overlap")

    selected = {
        kind: list(names)
        for kind, names in CURATED_NAMES.items()
    }
    used = set(curated_names)

    for kind in ("animal", "plant"):
        short_needed = SHORT_NAMES_PER_KIND - sum(
            len(name) <= 3 for name in selected[kind]
        )
        for name in round_robin_names(
            candidates[kind],
            short=True,
            excluded=used,
        ):
            selected[kind].append(name)
            used.add(name)
            short_needed -= 1
            if short_needed == 0:
                break
        if short_needed:
            raise ValueError(f"not enough short {kind} names")

        long_needed = NAMES_PER_KIND - len(selected[kind])
        for name in round_robin_names(
            candidates[kind],
            short=False,
            excluded=used,
        ):
            selected[kind].append(name)
            used.add(name)
            long_needed -= 1
            if long_needed == 0:
                break
        if long_needed:
            raise ValueError(f"not enough long {kind} names")

    return selected


def format_array(names: list[str]) -> str:
    lines = []
    for index in range(0, len(names), 8):
        values = ", ".join(f"'{name}'" for name in names[index : index + 8])
        lines.append(f"  {values}")
    return ",\n".join(lines)


def render_sql(pool: dict[str, list[str]]) -> str:
    animal_names = format_array(pool["animal"])
    plant_names = format_array(pool["plant"])
    return f"""-- 3,000 reviewable base names for generated reader codes.
--
-- Generated by scripts/build_profile_name_pool.py from:
-- {SOURCE_CITATION}
-- Licensed under CC BY 4.0: https://creativecommons.org/licenses/by/4.0/
-- Source archive SHA-256: {SOURCE_SHA256}
--
-- Each category contains 1,350 names of no more than three Chinese
-- characters and 150 longer names. Familiar curated names are included first;
-- the remaining names are selected deterministically across taxonomic classes.

insert into private.profile_name_pool (kind, name)
select 'animal', source.name
from pg_catalog.unnest(array[
{animal_names}
]::text[]) as source(name);

insert into private.profile_name_pool (kind, name)
select 'plant', source.name
from pg_catalog.unnest(array[
{plant_names}
]::text[]) as source(name);
"""


def parse_args() -> argparse.Namespace:
    default_output = (
        Path(__file__).resolve().parents[1]
        / "migrations"
        / "202608030002_profile_name_pool_data.sql"
    )
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--archive",
        type=Path,
        help="Existing TaiCOL 1.13 Darwin Core archive; downloads it if omitted.",
    )
    parser.add_argument("--output", type=Path, default=default_output)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    archive_path = args.archive or download_archive()
    verify_archive(archive_path)
    pool = build_pool(load_candidates(archive_path))
    args.output.write_text(render_sql(pool), encoding="utf-8", newline="\n")

    short_count = sum(
        len(name) <= 3
        for names in pool.values()
        for name in names
    )
    print(
        f"Wrote {sum(map(len, pool.values()))} names to {args.output} "
        f"({short_count} short names, {short_count / 3000:.0%})."
    )


if __name__ == "__main__":
    main()
