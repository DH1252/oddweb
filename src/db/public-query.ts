import { normalizeTag } from '../data/tags'

export const d1LikePatternMaxBytes = 50

export const publicVisibleSiteSql = `s.status = 'active'
  AND (s.source <> 'Submission' OR EXISTS (
    SELECT 1 FROM submissions submission
    WHERE submission.id = s.submission_id AND submission.status = 'approved'
  ))`

export const publicTagClosureCte = `WITH RECURSIVE tag_descendants(root_id, tag_id) AS (
  SELECT id, id FROM tags
  UNION
  SELECT closure.root_id, relation.child_tag_id
  FROM tag_descendants closure
  JOIN tag_parents relation ON relation.parent_tag_id = closure.tag_id
)`

type PublicSiteFilterInput = {
  query: string
  include: string[]
  exclude: string[]
}

const textEncoder = new TextEncoder()

export function d1LikePattern(value: string): string | null {
  const normalized = normalizeTag(value)
  if (!normalized) return ''

  let escaped = ''
  let byteLength = 2
  for (const character of normalized) {
    const piece =
      character === '\\' || character === '%' || character === '_'
        ? `\\${character}`
        : character
    const pieceBytes = textEncoder.encode(piece).byteLength
    if (byteLength + pieceBytes > d1LikePatternMaxBytes) return null
    escaped += piece
    byteLength += pieceBytes
  }

  return escaped ? `%${escaped}%` : ''
}

export function d1ExactAndFuzzySearch(value: string) {
  const exact = normalizeTag(value)
  return {
    exact,
    fuzzy: exact ? d1LikePattern(exact) || '' : '',
  }
}

export function buildPublicSiteFilter(input: PublicSiteFilterInput) {
  const clauses = [publicVisibleSiteSql]
  const bindings: string[] = []
  const search = d1ExactAndFuzzySearch(input.query)
  if (search.exact && !search.fuzzy) {
    clauses.push(`(
      lower(s.name) = ? OR lower(s.description) = ?
      OR EXISTS (
        SELECT 1 FROM site_tags searched_assignment
        JOIN tags searched_tag ON searched_tag.id = searched_assignment.tag_id
        WHERE searched_assignment.site_id = s.id AND (
          lower(searched_assignment.raw_name) = ?
          OR lower(searched_tag.name) = ?
          OR lower(searched_tag.slug) = ?
          OR EXISTS (
            SELECT 1 FROM tag_aliases searched_alias
            WHERE searched_alias.tag_id = searched_tag.id
              AND lower(searched_alias.alias) = ?
          )
        )
      )
    )`)
    bindings.push(...Array<string>(6).fill(search.exact))
  } else if (search.fuzzy) {
    clauses.push(`(
      lower(s.name || ' ' || s.description) LIKE ? ESCAPE '\\'
      OR EXISTS (
        SELECT 1 FROM site_tags searched_assignment
        JOIN tags searched_tag ON searched_tag.id = searched_assignment.tag_id
        WHERE searched_assignment.site_id = s.id AND (
          lower(searched_assignment.raw_name) LIKE ? ESCAPE '\\'
          OR lower(searched_tag.name) LIKE ? ESCAPE '\\'
          OR EXISTS (
            SELECT 1 FROM tag_aliases searched_alias
            WHERE searched_alias.tag_id = searched_tag.id
              AND searched_alias.alias LIKE ? ESCAPE '\\'
          )
        )
      )
    )`)
    bindings.push(search.fuzzy, search.fuzzy, search.fuzzy, search.fuzzy)
  }

  const include = normalizeFilterTokens(input.include)
  if (include.length) {
    clauses.push(`NOT EXISTS (
      SELECT 1 FROM json_each(?) requested
      WHERE NOT (${requestedTagMatchSql('requested')})
    )`)
    bindings.push(JSON.stringify(include))
  }

  const exclude = normalizeFilterTokens(input.exclude)
  if (exclude.length) {
    clauses.push(`NOT EXISTS (
      SELECT 1 FROM json_each(?) requested
      WHERE ${requestedTagMatchSql('requested')}
    )`)
    bindings.push(JSON.stringify(exclude))
  }

  return { sql: clauses.join(' AND '), bindings }
}

function normalizeFilterTokens(values: string[]) {
  return values
    .map((value) => {
      const freeform = value.startsWith('~')
      const normalized = normalizeTag(freeform ? value.slice(1) : value)
      if (!normalized) return undefined
      return freeform ? `~${normalized}` : normalized
    })
    .filter((value): value is string => Boolean(value))
}

function requestedTagMatchSql(alias: string) {
  const value = `CAST(${alias}.value AS TEXT)`
  return `EXISTS (
    SELECT 1 FROM site_tags assignment
    WHERE assignment.site_id = s.id AND (
      (substr(${value}, 1, 1) = '~'
        AND EXISTS (
          WITH RECURSIVE normalized_raw(value) AS (
            SELECT lower(trim(replace(replace(replace(
              trim(assignment.raw_name, '~'), char(9), ' '
            ), char(10), ' '), char(13), ' ')))
            UNION ALL
            SELECT replace(value, '  ', ' ')
            FROM normalized_raw WHERE instr(value, '  ') > 0
          )
          SELECT 1 FROM normalized_raw
          WHERE instr(value, '  ') = 0 AND value = substr(${value}, 2)
        ))
      OR (substr(${value}, 1, 1) <> '~' AND EXISTS (
        SELECT 1 FROM tags target
        JOIN tag_descendants closure
          ON closure.root_id = target.id AND closure.tag_id = assignment.tag_id
        WHERE target.canonical = 1 AND (
          lower(target.slug) = ${value}
          OR lower(target.name) = ${value}
          OR EXISTS (
            SELECT 1 FROM tag_aliases target_alias
            WHERE target_alias.tag_id = target.id
              AND lower(target_alias.alias) = ${value}
          )
        )
      ))
    )
  )`
}
