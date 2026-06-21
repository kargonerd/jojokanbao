import os


def generate_magazine_vue(base_folder):
    base_folder_lower = base_folder.lower()
    vue_content = f"""<template>
  <doc-viewer :picker-options="pickerOptions" name="{base_folder_lower}" type="magazine"
              :fetch-seq-options="getSeqOptions" :gen-seq-text="genSeqText"></doc-viewer>
</template>

<style>
</style>

<script>
import DocViewer from "@/components/DocViewer.vue";

export default {{
  components: {{DocViewer}},
  data() {{
    return {{
      pickerOptions: {{
        disabledDate(time) {{
          let availableYears = [];
          // 遍历年份文件夹，收集所有存在的年份
          {generate_year_list(base_folder)}
          const minYear = Math.min(...availableYears);
          const maxYear = Math.max(...availableYears);
          const minDate = new Date(minYear, 0, 0);
          const maxDate = new Date(maxYear, 11, 31);
          if (time.getTime() < minDate.getTime()) {{
            return true;
          }}
          if (time.getTime() > maxDate.getTime()) {{
            return true;
          }}
          return!availableYears.includes(time.getFullYear());
        }},
      }},
    }};
  }},
  methods: {{
    getSeqOptions(date) {{
      const config = {{
"""
    # 用于记录各年份出现过的期数，格式为 {年份: [期数列表]}
    year_seq_dict = {}
    # 遍历年份文件夹
    for year_folder in os.listdir(base_folder):
        year_folder_path = os.path.join(base_folder, year_folder)
        if os.path.isdir(year_folder_path):
            year_seq_dict[year_folder] = []
            # 遍历年份文件夹下的PDF文件，提取期数信息
            for pdf_file in os.listdir(year_folder_path):
                if pdf_file.endswith('.pdf'):
                    year = pdf_file[:4]
                    seq = int(pdf_file[4:6])
                    if seq not in year_seq_dict[year]:
                        year_seq_dict[year].append(seq)
    # 对各年份的期数列表进行分析，尝试简化配置代码
    simplified_year_seq_dict = simplify_seq_config(year_seq_dict)
    # 将各年份及其对应的期数信息添加到Vue文件内容字符串中
    for year, seqs in simplified_year_seq_dict.items():
        vue_content += f'        "{year}": {generate_js_seq_config(seqs)},\n'
    vue_content += """
      };
      return config[date]
    },
    genSeqText(seq) {
      if (seq > 90) {
        const no = seq % 90
        return '增刊' + no
      }
      return '第' + seq + '期'
    },
}}
</script>"""
    return vue_content


def generate_year_list(base_folder):
    available_years = []
    for year_folder in os.listdir(base_folder):
        available_years.append(int(year_folder))
    return f"availableYears = {available_years};"


def simplify_seq_config(year_seq_dict):
    simplified_dict = {}
    for year, seqs in year_seq_dict.items():
        seqs.sort()
        if len(seqs) == 0:
            continue
        elif len(seqs) == 1:
            simplified_dict[year] = seqs
        else:
            diff_list = [seqs[i + 1] - seqs[i] for i in range(len(seqs) - 1)]
            if all(diff == 1 for diff in diff_list):
                start = seqs[0]
                end = seqs[-1]
                simplified_dict[year] = (start, end)
            else:
                # 处理有缺失期数的情况，查找连续段并记录缺失的期数
                continuous_segments = []
                start = seqs[0]
                current_segment = [start]
                for i in range(1, len(seqs)):
                    if seqs[i] - seqs[i - 1] == 1:
                        current_segment.append(seqs[i])
                    else:
                        continuous_segments.append(current_segment)
                        start = seqs[i]
                        current_segment = [start]
                continuous_segments.append(current_segment)
                # 根据连续段和缺失期数生成相应的配置表示
                final_seqs = []
                for segment in continuous_segments:
                    if len(segment) == 1:
                        final_seqs.append(segment[0])
                    else:
                        final_seqs.extend(segment)
                simplified_dict[year] = final_seqs
    return simplified_dict


def generate_js_seq_config(seqs):
    if isinstance(seqs, list):
        normal_seqs = [num for num in seqs if num < 90]  # 分离出正常期数
        extra_seqs = [num for num in seqs if num >= 90]  # 分离出增刊期数
        if len(normal_seqs) == 0:
            if len(extra_seqs) == 0:
                return "[]"
            else:
                return str(extra_seqs)
        elif len(normal_seqs) == 1:
            if len(extra_seqs) == 0:
                return str(normal_seqs)
            else:
                return str(normal_seqs + extra_seqs)
        else:
            all_nums = list(range(min(normal_seqs), max(normal_seqs) + 1))
            missing_nums = [num for num in all_nums if num not in normal_seqs]
            if len(missing_nums) <= 5:  # 根据缺失期数多少决定生成代码方式
                if len(missing_nums) == 0:
                    if normal_seqs[0] == 1:
                        normal_seq_str = f'[...Array({max(normal_seqs)}).keys()].map(i => i + 1)'
                    else:
                        normal_seq_str = f'[...Array({max(normal_seqs) - min(normal_seqs) + 1}).keys()].map(i => i + {min(normal_seqs)})'
                else:
                    filter_condition = " && ".join([f"i!== {num}" for num in missing_nums])
                    if normal_seqs[0] == 1:
                        normal_seq_str = f'[...Array({max(normal_seqs)}).keys()].map(i => i + 1).filter(i => {filter_condition})'
                    else:
                        normal_seq_str = f'[...Array({max(normal_seqs) - min(normal_seqs) + 1}).keys()].map(i => i + {min(normal_seqs)}).filter(i => {filter_condition})'
                if len(extra_seqs) == 0:
                    return normal_seq_str
                else:
                    return f"{normal_seq_str}.concat({str(extra_seqs)})"
            else:
                if len(extra_seqs) == 0:
                    return str(normal_seqs)
                else:
                    return str(normal_seqs + extra_seqs)
    elif isinstance(seqs, tuple):
        start, end = seqs
        if start == 1:
            return f'[...Array({end}).keys()].map(i => i + 1)'
        else:
            return f'[...Array({end - start + 1}).keys()].map(i => i + {start})'
    return "[]"


if __name__ == "__main__":
    base_folder = "SJZS"  # 这里可以修改为你实际想要的文件夹名称
    vue_file_content = generate_magazine_vue(base_folder)
    print(vue_file_content)