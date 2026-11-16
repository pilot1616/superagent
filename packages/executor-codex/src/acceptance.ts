export const acceptance = Object.freeze({
  handshake: true,
  filesystemIsolation: false,
  approvalRoundTrip: false,
  cancellation: false,
  restartRecovery: false,
  authenticatedModelTurn: false,
})

export const executionVerified = (): boolean => Object.values(acceptance).every(Boolean)
