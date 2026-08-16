const sqliteIdentifier = String.raw`(?:"(?:[^"]|"")*"|\x60(?:[^\x60]|\x60\x60)*\x60|\[[^\]]+\]|[^\s;]+)`
const sqliteRename = new RegExp(
  String.raw`\bALTER\s+TABLE\s+${sqliteIdentifier}\s+RENAME\s+(?:TO|COLUMN)\b`,
  'i',
)

export function hasDestructiveSchemaOperation(sql) {
  return (
    /\bDROP\s+(?:TABLE|COLUMN)\b/i.test(sql) ||
    /\bRENAME\s+(?:TABLE|COLUMN)\b/i.test(sql) ||
    sqliteRename.test(sql)
  )
}
