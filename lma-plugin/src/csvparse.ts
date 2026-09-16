// 流式 CSV 解析器（RFC 4180，自研，零依赖）
// 支持：BOM、双引号包裹字段、字段内引号转义（""）、CRLF/LF、空行跳过、行数上限

export interface CsvParseResult {
  columns: string[]
  rows: string[][]
}

export function parseCsv(text: string, maxRows = 5000): CsvParseResult {
  let i = 0
  const n = text.length
  if (text.charCodeAt(0) === 0xfeff) i = 1 // BOM

  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let atFieldStart = true // 仅字段起点允许进入引号模式

  const pushField = () => { row.push(field); field = ''; atFieldStart = true }
  const pushRow = () => {
    pushField()
    if (row.length > 1 || row[0]?.trim() !== '') {
      rows.push(row)
      if (rows.length > maxRows) {
        throw new Error(`超过单次导入行数上限（${maxRows} 行），请拆分文件后重试`)
      }
    }
    row = []
    atFieldStart = true
  }

  while (i < n) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue }
        inQuotes = false; i++; continue
      }
      field += c; i++; continue
    }
    if (c === '"' && atFieldStart) { inQuotes = true; i++; continue }
    if (c === ',') { pushField(); i++; continue }
    if (c === '\r') { if (text[i + 1] === '\n') i++; i++; pushRow(); continue }
    if (c === '\n') { i++; pushRow(); continue }
    field += c; atFieldStart = false; i++
  }
  if (atFieldStart === false || row.length) pushRow()

  if (!rows.length) return { columns: [], rows: [] }
  const columns = rows.shift()!
  return { columns, rows }
}
