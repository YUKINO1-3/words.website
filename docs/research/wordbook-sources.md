# 内置词库数据来源核对

核对日期：2026-10-23。首批面向雅思与学术英语。下列来源提供可再分发的数据；“应用内置词库”不表示 IELTS 考试机构发布或背书。

## 已选原始来源

| 用途                  | 原始来源与版本                                                                                                                                                    |                   实际词条数 | 数据许可     |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------: | ------------ |
| 学术核心              | [NAWL 官方页面](https://www.newgeneralservicelist.com/new-academic-word-list)，NAWL 1.2                                                                           |                          957 | CC BY-SA 4.0 |
| 基础高频              | [NGSL 官方页面](https://www.newgeneralservicelist.com/new-general-service-list)，NGSL 1.2                                                                         |                         2809 | CC BY-SA 4.0 |
| 中文释义与 IELTS 标签 | [skywind3000/ECDICT](https://github.com/skywind3000/ECDICT/tree/bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b)，固定 commit `bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b` | 由生成脚本根据标签筛选并记录 | MIT          |

### 官方站点与计数差异

[项目官方词表目录](https://www.newgeneralservicelist.com/word-lists)的页脚明确指出唯一官方网站为 `newgeneralservicelist.com`。本次下载直接使用此站链接，不使用 `.org` 镜像作为当前权威来源。

NAWL 1.2 的详细页面明确写 957 词；目录页约写 960。下载文件去掉说明与参考文献后恰为 957 个唯一单词。旧 NAWL 1.0 常见的 963 词不应标成当前 1.2 版的实际数量。官方 TXT 文件开头仍含原始历史 `.org` 参考链接，不影响本次由 `.com` 官方页面取得文件的来源记录。

NGSL 1.2 详细页标注 2809 词，下载文件去掉变更说明后恰为 2809 个唯一单词。未额外混入页面提供的补充文件，以避免改变本次源文件范围。

## 可复现下载

### NAWL 1.2

- 官方下载入口：<https://www.newgeneralservicelist.com/s/NAWL_12_alphabetized_description.txt>
- 本次解析后的资源 URL：<https://static1.squarespace.com/static/64336926d7c6bb38965fdf3b/t/644e0e936f1c072f5a0503f8/1682837139514/NAWL_1.2_alphabetized_description.txt>
- 原文件大小：10340 字节。
- 原文件 SHA-256：`88a99099e10010ea40992cca4a5119102d05a0f2888ee5d43d4c8b4afd597fef`。
- 本次研究下载路径：`/tmp/wordbook-sources/nawl-1.2.txt`。
- 解析说明：原文件前六行为说明、空行和参考文献；正式词表从 `abdominal` 开始，至 `yeast` 结束。957 个单词唯一且符合应用现有英文词条格式。

### NGSL 1.2

- 官方下载入口：<https://www.newgeneralservicelist.com/s/NGSL_12_alphabetized_description.txt>
- 本次解析后的资源 URL：<https://static1.squarespace.com/static/64336926d7c6bb38965fdf3b/t/644e0bd98eabfa3b566ca510/1682836441532/NGSL_1.2_alphabetized_description.txt>
- 原文件大小：24546 字节。
- 原文件 SHA-256：`8056a5252576ddc5a3c2e96b1422eb2bc7991bdc527ecb2e00181fadff51d9dc`。
- 本次研究下载路径：`/tmp/wordbook-sources/ngsl-1.2.txt`。
- 解析说明：正式词表从原文件第 20 行的 `a` 开始，至 `zone` 结束；前面是版本说明及变更表。2809 个单词唯一且符合应用现有英文词条格式。

## 署名与再分发

NAWL 与 NGSL 两个官方详细页面均明确标注 **Creative Commons Attribution-ShareAlike 4.0 International**，并署名 **Browne, C., Culligan, B., and Phillips, J.**；页面推荐的网页引用格式则以 Browne 与 Culligan（2013）列名。内置数据包保留三位作者署名、原始词表链接、版本、CC BY-SA 4.0 链接，并注明本项目添加中文释义等处理。

由这些词表与中文释义生成的数据包应单独标识为 CC BY-SA 4.0，保留 ECDICT 的 MIT 许可和版权说明；词表数据许可与项目应用代码的许可分开记录。参考：[CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/)。

ECDICT 固定版本的 [LICENSE](https://github.com/skywind3000/ECDICT/blob/bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b/LICENSE)为 MIT，版权行为 `Copyright (c) 2025 Linwei`。原许可文本下载至 `/tmp/wordbook-sources/ecdict-LICENSE.txt`，1063 字节，SHA-256 为 `f8552dd246f61a4e064569eae6194a01c6b3d63b03bf27c6ca863593c549ed0f`。再分发数据时保留该许可全文，不只写一个 MIT 标签。

ECDICT 的 [README](https://github.com/skywind3000/ECDICT/blob/bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b/README.md)说明其 CSV 包含单词、中文释义和标签等字段。IELTS 内置表可以据其 `ielts` 标签筛选，但来源名称应明确是 ECDICT 标签整理，不能写成 IELTS 官方大纲或保证覆盖考试。最终实际数量、缺失中文释义和过滤情况由生成脚本记录。
