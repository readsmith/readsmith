/** A role that has no provider configured (chat/embedding/rerank). */
export class ModelNotConfiguredError extends Error {
  constructor(readonly role: string) {
    super(`no ${role} model is configured`);
    this.name = "ModelNotConfiguredError";
  }
}

/** A configured provider has no resolvable API key. The key value is never included. */
export class MissingKeyError extends Error {
  constructor(readonly provider: string) {
    super(`no API key resolved for provider "${provider}"`);
    this.name = "MissingKeyError";
  }
}
