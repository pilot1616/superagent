import { z } from 'zod'
import { workerAgentsSchema } from './profile.js'

const text = z.string().min(1).max(1024)
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const date = z.string().datetime()
export const requiredCapabilities = ['protocol_handshake', 'effective_profile', 'tool_filesystem_boundary', 'tool_network_boundary', 'protected_control_data', 'authenticated_model_turn', 'local_edit_and_check', 'approval_decline_round_trip', 'user_input_round_trip', 'cancellation_supported_scope', 'crash_reconciliation', 'real_multi_task_dag'] as const
export const checkSchema = z.object({ key: text, status: z.enum(['passed', 'failed', 'unknown', 'not_applicable']), reasonCode: text.optional(), nextAction: text.optional() }).strict()
export const inspectionSchema = z.object({
  id: z.string().uuid(), repositoryId: text, checkedAt: date, validUntil: date, fingerprint: hash,
  executable: z.object({ realpath: text, version: text, sha256: hash }).strict(),
  platform: z.object({ os: text, release: text, arch: text }).strict(),
  runtimeBuildHash: hash, protocolSchemaHash: hash, profileHash: hash, policyHash: hash, model: text,
  provider: z.object({ id: text, endpointOrigin: text.optional(), authMode: z.enum(['openai', 'env', 'none']) }).strict(),
  agents: workerAgentsSchema.optional(),
  auth: z.object({ status: z.enum(['configured', 'missing', 'expired', 'unsupported', 'unknown']), generation: z.number().int().nonnegative() }).strict(),
  checks: z.array(checkSchema).max(40),
}).strict()
export const verificationLimitsSchema = z.object({ deadlineSeconds: z.number().int().min(10).max(1200), maxModelTurns: z.number().int().min(1).max(8), maxModelInputTokens: z.number().int().min(1).max(120000), maxModelOutputTokens: z.number().int().min(1).max(16000), maxConcurrentWorkers: z.number().int().min(1).max(2) }).strict()
export const verificationSchema = z.object({
  id: z.string().uuid(), repositoryId: text, revision: z.number().int().positive(), fingerprint: hash, suiteVersion: text, mode: z.literal('restricted_local'),
  state: z.enum(['prepared', 'running', 'passed', 'failed', 'inconclusive', 'cancelled', 'cleanup_uncertain']),
  startedAt: date.optional(), finishedAt: date.optional(), validUntil: date.optional(), limits: verificationLimitsSchema,
  capabilities: z.record(z.string().max(100), z.object({ status: z.enum(['passed', 'failed', 'inconclusive', 'not_run']), evidenceIds: z.array(z.string().uuid()).max(100) }).strict()),
  evidence: z.array(z.object({ id: z.string().uuid(), relativePath: z.string().regex(/^[a-zA-Z0-9_-]+\.json$/), sha256: hash, source: z.enum(['harness', 'app_server', 'os_observation', 'human_review']) }).strict()).max(200),
  reasonCode: text.optional(), backend: z.literal('codex_named_permissions'),
}).strict()
export const enablementSchema = z.object({ id: z.string().uuid(), repositoryId: text, mode: z.literal('restricted_local'), fingerprint: hash, verificationId: z.string().uuid().optional(), daemonEpoch: z.string().uuid(), status: z.enum(['active', 'disabled', 'expired', 'invalidated']), capabilities: z.array(z.enum(requiredCapabilities)).max(12), operatorId: text, reason: text, createdAt: date, expiresAt: date }).strict()
export const runtimeStateSchema = z.object({ repositoryId: text, revision: z.number().int().positive(), fence: z.number().int().nonnegative(), mode: z.literal('restricted_local'), policyVersion: z.literal(1), inspectionId: z.string().uuid().optional(), inspectionFailure: z.object({ reasonCode: text, at: date }).strict().optional(), verificationId: z.string().uuid().optional(), enablementId: z.string().uuid().optional(), verificationRunId: z.string().uuid().optional(), quarantine: z.object({ reasonCode: text, since: date, assignmentIds: z.array(text).max(1000) }).strict().optional(), updatedAt: date }).strict()
export type RuntimeInspection = z.infer<typeof inspectionSchema>
export type RuntimeVerification = z.infer<typeof verificationSchema>
export type RuntimeEnablement = z.infer<typeof enablementSchema>
export type RuntimeState = z.infer<typeof runtimeStateSchema>
export type VerificationLimits = z.infer<typeof verificationLimitsSchema>
export type RuntimeSnapshot = { state: RuntimeState; inspection?: RuntimeInspection; verification?: RuntimeVerification; verificationEvidenceValid?: boolean; enablement?: RuntimeEnablement; daemonEpoch: string }
export const verificationDefaults: VerificationLimits = { deadlineSeconds: 1200, maxModelTurns: 8, maxModelInputTokens: 120000, maxModelOutputTokens: 16000, maxConcurrentWorkers: 2 }
