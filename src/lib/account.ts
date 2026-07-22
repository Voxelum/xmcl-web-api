import type { Db } from "../db.ts";
import type { OAuthProvider, VerifiedIdentity } from "./oauth/types.ts";

export type AccountStatus =
  | "active"
  | "merged"
  | "deletion_pending"
  | "deleted";

export interface AccountIdentity {
  provider: OAuthProvider;
  subject: string;
  displayName?: string;
  linkedBy: "launcher_bootstrap" | "launcher_link" | "web_link";
  linkedAt: string;
}

export interface Account {
  accountId: string;
  status: AccountStatus;
  createdAt: string;
  identities: AccountIdentity[];
  sessionIds?: string[];
  mergedIntoAccountId?: string;
  deletionRequestedAt?: string;
  deletionEffectiveAt?: string;
}

export interface OAuthTransaction {
  transactionId: string;
  provider: OAuthProvider;
  intent: "sign_in" | "link";
  accountId?: string;
  redirectUri: string;
  state: string;
  nonce: string;
  codeChallenge: string;
  expiresAt: string;
  consumedAt?: string;
}

export interface SessionRecord {
  sessionId: string;
  familyId: string;
  accountId: string;
  scopes: string[];
  issuedAt: string;
  expiresAt: string;
  refreshHash: string;
  consumedRefreshHashes: string[];
  refreshExpiresAt: string;
  revokedAt?: string;
}

export interface MergeRecord {
  mergeId: string;
  sourceAccountId: string;
  targetAccountId: string;
  targetIdentity: { provider: OAuthProvider; subject: string };
  createdAt: string;
  expiresAt: string;
  status: "prepared" | "completed";
  taskId?: string;
}

export interface IdempotencyRecord {
  scope: string;
  key: string;
  fingerprint: string;
  response: unknown;
}

export interface AuditRecord {
  auditId: string;
  accountId: string;
  action: string;
  occurredAt: string;
  requestId: string;
  metadata?: Record<string, unknown>;
}

export interface AccountRepository {
  getAccount(accountId: string): Promise<Account | undefined>;
  saveAccount(account: Account): Promise<void>;
  findIdentity(
    provider: OAuthProvider,
    subject: string,
  ): Promise<{ accountId: string } | undefined>;
  claimIdentity(
    provider: OAuthProvider,
    subject: string,
    accountId: string,
  ): Promise<{ accountId: string }>;
  moveIdentity(
    provider: OAuthProvider,
    subject: string,
    fromAccountId: string,
    toAccountId: string,
  ): Promise<void>;
  deleteIdentity(provider: OAuthProvider, subject: string): Promise<void>;
  getTransaction(transactionId: string): Promise<OAuthTransaction | undefined>;
  saveTransaction(transaction: OAuthTransaction): Promise<void>;
  getSession(sessionId: string): Promise<SessionRecord | undefined>;
  saveSession(session: SessionRecord): Promise<void>;
  getMerge(mergeId: string): Promise<MergeRecord | undefined>;
  saveMerge(merge: MergeRecord): Promise<void>;
  getIdempotency(
    scope: string,
    key: string,
  ): Promise<IdempotencyRecord | undefined>;
  saveIdempotency(record: IdempotencyRecord): Promise<void>;
  saveAudit(record: AuditRecord): Promise<void>;
}

export class AccountError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 410 | 422 | 502 | 503,
    readonly code: string,
    message = code,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export function randomId(prefix: string) {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return `${prefix}_${base64Url(bytes)}`;
}

function base64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(
    /=+$/,
    "",
  );
}

export async function sha256(value: string) {
  return base64Url(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
  );
}

export class AccountService {
  constructor(
    readonly repository: AccountRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async createAuthorization(input: {
    provider: OAuthProvider;
    intent: "sign_in" | "link";
    accountId?: string;
    redirectUri: string;
    state: string;
    codeChallenge: string;
    allowedRedirectUris: string[];
  }) {
    if (
      !input.allowedRedirectUris.includes(input.redirectUri) ||
      !input.state ||
      !input.codeChallenge
    ) {
      throw new AccountError(422, "invalid_oauth_request");
    }
    if (input.intent === "link" && !input.accountId) {
      throw new AccountError(401, "authentication_required");
    }
    const transaction: OAuthTransaction = {
      transactionId: randomId("oat"),
      provider: input.provider,
      intent: input.intent,
      accountId: input.accountId,
      redirectUri: input.redirectUri,
      state: input.state,
      nonce: randomId("nonce"),
      codeChallenge: input.codeChallenge,
      expiresAt: new Date(this.now().getTime() + 10 * 60_000).toISOString(),
    };
    await this.repository.saveTransaction(transaction);
    return transaction;
  }

  async consumeAuthorization(input: {
    transactionId: string;
    provider: OAuthProvider;
    state: string;
    codeVerifier: string;
  }) {
    const transaction = await this.repository.getTransaction(
      input.transactionId,
    );
    if (!transaction || transaction.provider !== input.provider) {
      throw new AccountError(404, "oauth_transaction_not_found");
    }
    if (transaction.consumedAt) {
      throw new AccountError(409, "oauth_transaction_replayed");
    }
    if (Date.parse(transaction.expiresAt) <= this.now().getTime()) {
      throw new AccountError(410, "oauth_transaction_expired");
    }
    if (transaction.state !== input.state) {
      throw new AccountError(422, "oauth_state_mismatch");
    }
    if (
      !input.codeVerifier ||
      await sha256(input.codeVerifier) !== transaction.codeChallenge
    ) {
      throw new AccountError(422, "pkce_verification_failed");
    }
    transaction.consumedAt = this.now().toISOString();
    await this.repository.saveTransaction(transaction);
    return transaction;
  }

  async consumeLauncherTransaction(input: {
    transactionId: string;
    provider: OAuthProvider;
    completedAt: string;
  }) {
    const completedAt = Date.parse(input.completedAt);
    const now = this.now().getTime();
    if (
      !input.transactionId || !Number.isFinite(completedAt) ||
      completedAt > now + 60_000 || completedAt < now - 5 * 60_000
    ) {
      throw new AccountError(422, "invalid_launcher_transaction");
    }
    if (await this.repository.getTransaction(input.transactionId)) {
      throw new AccountError(409, "launcher_transaction_replayed");
    }
    const transaction: OAuthTransaction = {
      transactionId: input.transactionId,
      provider: input.provider,
      intent: "sign_in",
      redirectUri: "xmcl-launcher:",
      state: "",
      nonce: "",
      codeChallenge: "",
      expiresAt: new Date(now + 5 * 60_000).toISOString(),
      consumedAt: new Date(now).toISOString(),
    };
    await this.repository.saveTransaction(transaction);
  }

  async bindIdentity(input: {
    identity: VerifiedIdentity;
    currentAccountId?: string;
    linkedBy: AccountIdentity["linkedBy"];
  }): Promise<{
    account: Account;
    bindingDisposition: "created" | "restored" | "linked";
  }> {
    const existing = await this.repository.findIdentity(
      input.identity.provider,
      input.identity.subject,
    );
    if (existing) {
      if (
        input.currentAccountId &&
        existing.accountId !== input.currentAccountId
      ) {
        throw new AccountError(
          409,
          "identity_conflict",
          "Identity belongs to another account",
          {
            mergeAvailable: true,
          },
        );
      }
      const account = await this.requireAccount(existing.accountId);
      if (account.status === "merged" || account.status === "deleted") {
        throw new AccountError(409, "account_unavailable");
      }
      if (account.status === "deletion_pending") {
        account.status = "active";
        delete account.deletionRequestedAt;
        delete account.deletionEffectiveAt;
        await this.repository.saveAccount(account);
      }
      return { account, bindingDisposition: "restored" };
    }

    let account: Account;
    let disposition: "created" | "linked";
    if (input.currentAccountId) {
      account = await this.requireActiveAccount(input.currentAccountId);
      disposition = "linked";
    } else {
      account = {
        accountId: randomId("acct"),
        status: "active",
        createdAt: this.now().toISOString(),
        identities: [],
      };
      disposition = "created";
    }

    const claimed = await this.repository.claimIdentity(
      input.identity.provider,
      input.identity.subject,
      account.accountId,
    );
    if (claimed.accountId !== account.accountId) {
      throw new AccountError(
        409,
        "identity_conflict",
        "Identity belongs to another account",
        {
          mergeAvailable: true,
        },
      );
    }
    account.identities.push({
      ...input.identity,
      linkedBy: input.linkedBy,
      linkedAt: this.now().toISOString(),
    });
    await this.repository.saveAccount(account);
    return { account, bindingDisposition: disposition };
  }

  async unlinkIdentity(
    accountId: string,
    provider: OAuthProvider,
    requestId: string,
  ) {
    const account = await this.requireActiveAccount(accountId);
    const identity = account.identities.find((item) =>
      item.provider === provider
    );
    if (!identity) throw new AccountError(404, "identity_not_found");
    if (account.identities.length === 1) {
      throw new AccountError(409, "last_identity");
    }
    account.identities = account.identities.filter((item) => item !== identity);
    await this.repository.saveAccount(account);
    await this.repository.deleteIdentity(identity.provider, identity.subject);
    await this.audit(accountId, "identity.unlinked", requestId, { provider });
  }

  async requestDeletion(
    accountId: string,
    idempotencyKey: string,
    requestId: string,
  ) {
    if (!idempotencyKey) {
      throw new AccountError(422, "idempotency_key_required");
    }
    const scope = `account-deletion:${accountId}`;
    const stored = await this.repository.getIdempotency(scope, idempotencyKey);
    if (stored) return stored.response as Record<string, unknown>;
    const account = await this.requireAccount(accountId);
    if (account.status === "merged" || account.status === "deleted") {
      throw new AccountError(409, "account_not_deletable");
    }
    const requestedAt = this.now();
    account.status = "deletion_pending";
    account.deletionRequestedAt = requestedAt.toISOString();
    account.deletionEffectiveAt = new Date(
      requestedAt.getTime() + 14 * 24 * 60 * 60_000,
    ).toISOString();
    await this.repository.saveAccount(account);
    const response = {
      taskId: randomId("task"),
      requestId,
      status: "queued",
      resource: { type: "account", id: accountId },
      createdAt: requestedAt.toISOString(),
      updatedAt: requestedAt.toISOString(),
      deletionEffectiveAt: account.deletionEffectiveAt,
    };
    await this.repository.saveIdempotency({
      scope,
      key: idempotencyKey,
      fingerprint: accountId,
      response,
    });
    await this.audit(accountId, "account.deletion_requested", requestId);
    return response;
  }

  async cancelDeletion(accountId: string, requestId: string) {
    const account = await this.requireAccount(accountId);
    if (account.status !== "deletion_pending") {
      throw new AccountError(409, "deletion_not_pending");
    }
    if (
      !account.deletionEffectiveAt ||
      Date.parse(account.deletionEffectiveAt) <= this.now().getTime()
    ) {
      throw new AccountError(410, "deletion_cancellation_window_closed");
    }
    account.status = "active";
    delete account.deletionRequestedAt;
    delete account.deletionEffectiveAt;
    await this.repository.saveAccount(account);
    await this.audit(accountId, "account.deletion_cancelled", requestId);
  }

  requireAccount = async (accountId: string) => {
    const account = await this.repository.getAccount(accountId);
    if (!account) throw new AccountError(404, "account_not_found");
    return account;
  };

  requireActiveAccount = async (accountId: string) => {
    const account = await this.requireAccount(accountId);
    if (account.status !== "active") {
      throw new AccountError(
        409,
        "account_not_active",
        "Account is not active",
        {
          status: account.status,
        },
      );
    }
    return account;
  };

  audit(
    accountId: string,
    action: string,
    requestId: string,
    metadata?: Record<string, unknown>,
  ) {
    return this.repository.saveAudit({
      auditId: randomId("audit"),
      accountId,
      action,
      occurredAt: this.now().toISOString(),
      requestId,
      metadata,
    });
  }
}

function identityKey(provider: OAuthProvider, subject: string) {
  return `${provider}:${subject}`;
}

export class MongoAccountRepository implements AccountRepository {
  constructor(private readonly db: Db) {}

  async getAccount(accountId: string) {
    return await this.db.collection("xmcl_accounts").findOne({
      _id: accountId,
    }) ??
      undefined;
  }
  async saveAccount(account: Account) {
    await this.db.collection("xmcl_accounts").replaceOne(
      { _id: account.accountId },
      { _id: account.accountId, ...account },
      { upsert: true },
    );
  }
  async findIdentity(provider: OAuthProvider, subject: string) {
    const value = await this.db.collection("xmcl_identities").findOne({
      _id: identityKey(provider, subject),
    });
    return value ? { accountId: value.accountId as string } : undefined;
  }
  async claimIdentity(
    provider: OAuthProvider,
    subject: string,
    accountId: string,
  ) {
    const collection = this.db.collection("xmcl_identities");
    const _id = identityKey(provider, subject);
    await collection.updateOne(
      { _id },
      { $setOnInsert: { _id, provider, subject, accountId } },
      { upsert: true },
    );
    const value = await collection.findOne({ _id });
    return { accountId: value.accountId as string };
  }
  async deleteIdentity(provider: OAuthProvider, subject: string) {
    await this.db.collection("xmcl_identities").deleteOne({
      _id: identityKey(provider, subject),
    });
  }
  async moveIdentity(
    provider: OAuthProvider,
    subject: string,
    fromAccountId: string,
    toAccountId: string,
  ) {
    const collection = this.db.collection("xmcl_identities");
    const _id = identityKey(provider, subject);
    const existing = await collection.findOne({ _id });
    if (!existing || existing.accountId !== fromAccountId) {
      throw new AccountError(409, "identity_conflict");
    }
    await collection.replaceOne(
      { _id, accountId: fromAccountId },
      { _id, provider, subject, accountId: toAccountId },
    );
  }
  async getTransaction(transactionId: string) {
    return await this.db.collection("xmcl_oauth_transactions").findOne({
      _id: transactionId,
    }) ?? undefined;
  }
  async saveTransaction(transaction: OAuthTransaction) {
    await this.db.collection("xmcl_oauth_transactions").replaceOne(
      { _id: transaction.transactionId },
      { _id: transaction.transactionId, ...transaction },
      { upsert: true },
    );
  }
  async getSession(sessionId: string) {
    return await this.db.collection("xmcl_sessions").findOne({
      _id: sessionId,
    }) ??
      undefined;
  }
  async saveSession(session: SessionRecord) {
    await this.db.collection("xmcl_sessions").replaceOne(
      { _id: session.sessionId },
      { _id: session.sessionId, ...session },
      { upsert: true },
    );
  }
  async getMerge(mergeId: string) {
    return await this.db.collection("xmcl_account_merges").findOne({
      _id: mergeId,
    }) ?? undefined;
  }
  async saveMerge(merge: MergeRecord) {
    await this.db.collection("xmcl_account_merges").replaceOne(
      { _id: merge.mergeId },
      { _id: merge.mergeId, ...merge },
      { upsert: true },
    );
  }
  async getIdempotency(scope: string, key: string) {
    return await this.db.collection("xmcl_idempotency").findOne({
      _id: `${scope}:${key}`,
    }) ?? undefined;
  }
  async saveIdempotency(record: IdempotencyRecord) {
    await this.db.collection("xmcl_idempotency").replaceOne(
      { _id: `${record.scope}:${record.key}` },
      { _id: `${record.scope}:${record.key}`, ...record },
      { upsert: true },
    );
  }
  async saveAudit(record: AuditRecord) {
    await this.db.collection("xmcl_audit").replaceOne(
      { _id: record.auditId },
      { _id: record.auditId, ...record },
      { upsert: true },
    );
  }
}

export class MemoryAccountRepository implements AccountRepository {
  readonly accounts = new Map<string, Account>();
  readonly identities = new Map<string, { accountId: string }>();
  readonly transactions = new Map<string, OAuthTransaction>();
  readonly sessions = new Map<string, SessionRecord>();
  readonly merges = new Map<string, MergeRecord>();
  readonly idempotency = new Map<string, IdempotencyRecord>();
  readonly audits: AuditRecord[] = [];

  getAccount(id: string) {
    return Promise.resolve(this.accounts.get(id));
  }
  saveAccount(value: Account) {
    this.accounts.set(value.accountId, structuredClone(value));
    return Promise.resolve();
  }
  findIdentity(provider: OAuthProvider, subject: string) {
    return Promise.resolve(this.identities.get(identityKey(provider, subject)));
  }
  claimIdentity(provider: OAuthProvider, subject: string, accountId: string) {
    const key = identityKey(provider, subject);
    const value = this.identities.get(key) ?? { accountId };
    this.identities.set(key, value);
    return Promise.resolve(value);
  }
  deleteIdentity(provider: OAuthProvider, subject: string) {
    this.identities.delete(identityKey(provider, subject));
    return Promise.resolve();
  }
  moveIdentity(
    provider: OAuthProvider,
    subject: string,
    fromAccountId: string,
    toAccountId: string,
  ) {
    const key = identityKey(provider, subject);
    const existing = this.identities.get(key);
    if (!existing || existing.accountId !== fromAccountId) {
      return Promise.reject(new AccountError(409, "identity_conflict"));
    }
    this.identities.set(key, { accountId: toAccountId });
    return Promise.resolve();
  }
  getTransaction(id: string) {
    return Promise.resolve(this.transactions.get(id));
  }
  saveTransaction(value: OAuthTransaction) {
    this.transactions.set(value.transactionId, structuredClone(value));
    return Promise.resolve();
  }
  getSession(id: string) {
    return Promise.resolve(this.sessions.get(id));
  }
  saveSession(value: SessionRecord) {
    this.sessions.set(value.sessionId, structuredClone(value));
    return Promise.resolve();
  }
  getMerge(id: string) {
    return Promise.resolve(this.merges.get(id));
  }
  saveMerge(value: MergeRecord) {
    this.merges.set(value.mergeId, structuredClone(value));
    return Promise.resolve();
  }
  getIdempotency(scope: string, key: string) {
    return Promise.resolve(this.idempotency.get(`${scope}:${key}`));
  }
  saveIdempotency(value: IdempotencyRecord) {
    this.idempotency.set(`${value.scope}:${value.key}`, structuredClone(value));
    return Promise.resolve();
  }
  saveAudit(value: AuditRecord) {
    this.audits.push(structuredClone(value));
    return Promise.resolve();
  }
}
