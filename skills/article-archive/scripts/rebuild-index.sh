#!/usr/bin/env bash
# rebuild-index.sh — 从文章文件重建 index.md（容错用）
# 用法: bash rebuild-index.sh [articles_dir]
# 默认: ~/clawd/data/articles

set -euo pipefail

ARTICLES_DIR="${1:-$HOME/clawd/data/articles}"
INDEX_FILE="$ARTICLES_DIR/index.md"
COUNT=0
ROWS=""

# 遍历所有 .md 文件（排除 index.md）
while IFS= read -r -d '' file; do
    relpath="${file#$ARTICLES_DIR/}"
    
    # 提取元数据
    title=""
    keywords=""
    date=""
    summary=""
    in_summary=false
    
    while IFS= read -r line; do
        # 标题: 第一个 # 开头的行
        if [[ -z "$title" && "$line" =~ ^#\  ]]; then
            title="${line#\# }"
        fi
        # 关键字
        if [[ "$line" =~ ^\-\ \*\*关键字\*\*:\ (.*) ]]; then
            keywords="${BASH_REMATCH[1]}"
        fi
        # 日期
        if [[ "$line" =~ ^\-\ \*\*日期\*\*:\ (.*) ]]; then
            date="${BASH_REMATCH[1]}"
        fi
        # 摘要段落
        if [[ "$line" == "## 摘要" ]]; then
            in_summary=true
            continue
        fi
        if $in_summary; then
            if [[ "$line" == "---" || "$line" == "## 正文" ]]; then
                in_summary=false
            elif [[ -n "$line" ]]; then
                # 截取前 20 字作为索引摘要
                if [[ -z "$summary" ]]; then
                    summary="${line:0:60}"
                fi
            fi
        fi
    done < "$file"
    
    if [[ -n "$title" ]]; then
        COUNT=$((COUNT + 1))
        ROWS="${ROWS}| ${title} | ${keywords} | ${summary} | ${date} | ${relpath} |\n"
    fi
done < <(find "$ARTICLES_DIR" -name "*.md" ! -name "index.md" -print0 | sort -z)

# 写入索引
TODAY=$(date +%Y-%m-%d)
cat > "$INDEX_FILE" << EOF
# 公众号文章归档索引

> 共 ${COUNT} 篇 | 最后更新: ${TODAY}

| 标题 | 关键字 | 摘要 | 日期 | 路径 |
|------|--------|------|------|------|
$(echo -e "$ROWS")
EOF

echo "✅ 索引已重建: ${COUNT} 篇文章 → ${INDEX_FILE}"
