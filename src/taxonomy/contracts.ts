import { z } from 'zod'

const identifier = z.string().trim().min(1).max(128)
const evidence = z.string().trim().min(1).max(500)
const confidence = z.number().finite().min(0).max(1)

export const siteTagDecisionSchema = z.strictObject({
  tagId: identifier,
  decision: z.enum(['assign', 'do_not_assign', 'review']),
  confidence,
  margin: z.number().finite().min(0).max(1),
  evidence,
})

export const siteDecisionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  decisions: z.array(siteTagDecisionSchema).max(50),
})

const proposalBase = {
  confidence,
  evidence,
}

export const ontologyProposalSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('concept'),
    proposedName: z.string().trim().min(1).max(80),
    proposedSlug: z
      .string()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .max(80),
    ...proposalBase,
  }),
  z.strictObject({
    kind: z.literal('alias'),
    alias: z.string().trim().min(1).max(80),
    targetTagId: identifier,
    ...proposalBase,
  }),
  z.strictObject({
    kind: z.literal('parent'),
    childTagId: identifier,
    parentTagId: identifier,
    ...proposalBase,
  }),
  z.strictObject({
    kind: z.literal('merge'),
    sourceTagId: identifier,
    targetTagId: identifier,
    ...proposalBase,
  }),
])

export const ontologyProposalResponseSchema = z.strictObject({
  schemaVersion: z.literal(1),
  proposals: z.array(ontologyProposalSchema).max(25),
})

export type SiteTagDecision = z.infer<typeof siteTagDecisionSchema>
export type SiteDecision = z.infer<typeof siteDecisionSchema>
export type OntologyProposal = z.infer<typeof ontologyProposalSchema>
export type OntologyProposalResponse = z.infer<
  typeof ontologyProposalResponseSchema
>
