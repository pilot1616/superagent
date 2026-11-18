import { z } from 'zod'
import type { CommandExecutionRequestApprovalResponse } from '../protocol/0.154.0-alpha.6.2/v2/CommandExecutionRequestApprovalResponse.js'
import type { FileChangeRequestApprovalResponse } from '../protocol/0.154.0-alpha.6.2/v2/FileChangeRequestApprovalResponse.js'
import type { PermissionsRequestApprovalResponse } from '../protocol/0.154.0-alpha.6.2/v2/PermissionsRequestApprovalResponse.js'
import type { ToolRequestUserInputResponse } from '../protocol/0.154.0-alpha.6.2/v2/ToolRequestUserInputResponse.js'

const identifier = z.string().min(1).max(200)
const binding = z.object({ threadId: identifier, turnId: identifier, itemId: identifier })
const optionalText = z.string().max(30000).nullish()
export const questionSchema = z.object({ id: identifier, header: z.string().max(300), question: z.string().max(10000), isOther: z.boolean(), isSecret: z.boolean(), options: z.array(z.object({ label: z.string().max(1000), description: z.string().max(3000) }).strict()).max(30).nullable() }).strict()
export const answersSchema = z.record(identifier, z.object({ answers: z.array(z.string().max(10000)).min(1).max(30) }).strict())
export const userInputSchema = binding.extend({ questions: z.array(questionSchema).min(1).max(10), isBlocking: z.boolean(), autoResolutionMs: z.number().nonnegative().nullable() }).strict()
const permissions = binding.extend({ environmentId: z.string().max(200).nullable(), startedAtMs: z.number().nonnegative(), cwd: z.string().max(4096), reason: z.string().max(30000).nullable(), permissions: z.object({ network: z.object({ enabled: z.boolean().nullable() }).strict().nullable(), fileSystem: z.object({ read: z.array(z.string().max(4096)).max(100).nullable(), write: z.array(z.string().max(4096)).max(100).nullable(), globScanMaxDepth: z.number().int().nonnegative().optional(), entries: z.array(z.unknown()).max(100).optional() }).strict().nullable() }).strict() }).strict()
const command = binding.extend({ kind: z.string().max(100), startedAtMs: z.number().nonnegative(), approvalId: optionalText, environmentId: z.string().max(200).nullable(), reason: optionalText, command: optionalText, cwd: optionalText, networkApprovalContext: z.unknown().optional(), commandActions: z.array(z.unknown()).max(100).nullish(), proposedExecpolicyAmendment: z.unknown().optional(), proposedNetworkPolicyAmendments: z.array(z.unknown()).max(100).nullish() }).strict()
const fileChange = binding.extend({ startedAtMs: z.number().nonnegative(), reason: optionalText, grantRoot: optionalText }).strict()
export function decodeRequest(method: string, params: unknown) {
  if (Buffer.byteLength(JSON.stringify(params) ?? '') > 60000) throw new Error('Request exceeds supported bounds')
  if (method === 'item/tool/requestUserInput') return { kind: 'input' as const, params: userInputSchema.parse(params) }
  if (method === 'item/commandExecution/requestApproval') return { kind: 'permission' as const, params: command.parse(params) }
  if (method === 'item/fileChange/requestApproval') return { kind: 'permission' as const, params: fileChange.parse(params) }
  if (method === 'item/permissions/requestApproval') return { kind: 'permission' as const, params: permissions.parse(params) }
  throw new Error('Unsupported App Server request')
}
export function declineResponse(method: string): CommandExecutionRequestApprovalResponse | FileChangeRequestApprovalResponse | PermissionsRequestApprovalResponse | ToolRequestUserInputResponse {
  if (method === 'item/permissions/requestApproval') return { permissions: {}, scope: 'turn' }
  if (method === 'item/tool/requestUserInput') return { answers: {} }
  return { decision: 'decline' }
}
export function inputResponse(questions: z.infer<typeof questionSchema>[], raw: unknown): ToolRequestUserInputResponse {
  const answers = answersSchema.parse(raw)
  if (questions.some(question => question.isSecret)) throw new Error('Secret answers must not be sent through the task controller')
  const identifiers = new Set(questions.map(question => question.id))
  if (identifiers.size !== questions.length || Object.keys(answers).length !== identifiers.size || Object.keys(answers).some(id => !identifiers.has(id)) || questions.some(question => !answers[question.id])) throw new Error('Answer every current question exactly once')
  return { answers }
}
