import type { MerchantApi } from '../google/merchant-api.js';
import type { Account, AggregateProductStatus, Homepage, OnlineReturnPolicy, RenderedIssue, ShippingSettings } from '../google/types.js';
import type { Logger } from '../util/logger.js';
import type { AccountIssueRecord, AccountIssueStore } from './account-issue-store.js';
import type { EventLog } from './event-log.js';

/** A problem to show on the dashboard. `code` + `params` let the UI localise it; `message` is the English fallback. */
export interface AccountFlag {
  level: 'warning' | 'error' | 'info';
  message: string;
  code?: string;
  params?: Record<string, string | number>;
  documentationUri?: string;
}

export interface AccountOverview {
  account: Account | null;
  homepage: Homepage | null;
  issues: AccountIssueRecord[];
  aggregateStatuses: AggregateProductStatus[];
  /** Overall traffic-light computed from account issues + homepage claim. */
  health: 'ok' | 'warning' | 'error';
  flags: AccountFlag[];
  error?: string;
}

/** Account level information: details, issues, shipping and return policies. */
export class AccountService {
  constructor(
    private readonly api: MerchantApi,
    private readonly accountIssues: AccountIssueStore,
    private readonly events: EventLog,
    private readonly logger: Logger,
    private readonly getOptions: () => { languageCode: string; timeZone: string },
  ) {}

  private get options(): { languageCode: string; timeZone: string } {
    return this.getOptions();
  }

  async overview(): Promise<AccountOverview> {
    const [accountResult, homepageResult, aggregateResult] = await Promise.allSettled([
      this.api.getAccount(),
      this.api.getHomepage(),
      this.api.listAggregateProductStatuses(),
    ]);
    const account = accountResult.status === 'fulfilled' ? accountResult.value : null;
    const homepage = homepageResult.status === 'fulfilled' ? (homepageResult.value ?? null) : null;
    const aggregateStatuses = aggregateResult.status === 'fulfilled' ? aggregateResult.value : [];
    if (accountResult.status === 'rejected') this.logger.warn({ err: accountResult.reason }, 'Could not load account');

    // Always refresh the stored account issues when the overview is requested.
    let issues: AccountIssueRecord[];
    try {
      const diff = this.accountIssues.sync(await this.api.listAccountIssues());
      for (const issue of diff.newIssues) {
        this.events.record('account_issue.new', `New account issue: ${issue.title}`, { severity: issue.level === 'error' ? 'error' : 'warning', payload: issue });
      }
      for (const issue of diff.resolvedIssues) {
        this.events.record('account_issue.resolved', `Account issue resolved: ${issue.title}`, { payload: issue });
      }
      issues = this.accountIssues.list({ open: true });
    } catch (err) {
      this.logger.warn({ err }, 'Could not load account issues');
      issues = this.accountIssues.list({ open: true });
    }

    const flags: AccountOverview['flags'] = [];
    if (homepage && homepage.claimed === false) {
      flags.push({ level: 'error', code: 'homepage_not_claimed', params: { uri: homepage.uri ?? '' }, message: `Website ${homepage.uri ?? ''} is not claimed`, documentationUri: 'https://support.google.com/merchants/answer/176793' });
    }
    for (const issue of issues) {
      flags.push({ level: issue.level === 'error' ? 'error' : issue.level === 'warning' ? 'warning' : 'info', message: issue.title ?? 'Account issue', documentationUri: issue.documentationUri ?? undefined });
    }
    for (const agg of aggregateStatuses) {
      const disapproved = Number(agg.stats?.disapprovedCount ?? 0);
      const active = Number(agg.stats?.activeCount ?? 0);
      if (disapproved > 0 && disapproved >= active) {
        flags.push({ level: 'error', code: 'aggregate_disapproved', params: { context: agg.reportingContext ?? '', country: agg.country ?? '', disapproved, active }, message: `${agg.reportingContext}/${agg.country}: ${disapproved} disapproved vs ${active} active products` });
      }
    }
    const health = flags.some((f) => f.level === 'error') ? 'error' : flags.some((f) => f.level === 'warning') ? 'warning' : 'ok';
    return {
      account,
      homepage,
      issues,
      aggregateStatuses,
      health,
      flags,
      ...(accountResult.status === 'rejected' ? { error: (accountResult.reason as Error).message } : {}),
    };
  }

  renderAccountIssues(): Promise<RenderedIssue[]> {
    return this.api.renderAccountIssues(this.options.languageCode, this.options.timeZone);
  }

  renderProductIssues(productId: string): Promise<RenderedIssue[]> {
    return this.api.renderProductIssues(productId, this.options.languageCode, this.options.timeZone);
  }

  getShippingSettings(): Promise<ShippingSettings | undefined> {
    return this.api.getShippingSettings();
  }

  listReturnPolicies(): Promise<OnlineReturnPolicy[]> {
    return this.api.listReturnPolicies();
  }

  async createReturnPolicy(policy: OnlineReturnPolicy): Promise<OnlineReturnPolicy> {
    const created = await this.api.createReturnPolicy(policy);
    this.events.record('return_policy.created', `Created return policy "${created.label ?? created.returnPolicyId}"`, { payload: created });
    return created;
  }

  async updateReturnPolicy(id: string, policy: OnlineReturnPolicy): Promise<OnlineReturnPolicy> {
    const updated = await this.api.updateReturnPolicy(id, policy);
    this.events.record('return_policy.updated', `Updated return policy "${updated.label ?? id}"`, { payload: updated });
    return updated;
  }

  async deleteReturnPolicy(id: string): Promise<void> {
    await this.api.deleteReturnPolicy(id);
    this.events.record('return_policy.deleted', `Deleted return policy ${id}`, { severity: 'warning' });
  }
}
