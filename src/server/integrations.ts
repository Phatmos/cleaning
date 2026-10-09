/**
 * External integrations. Each adapter reports whether it is CONFIGURED; when it
 * is not, callers must surface "not connected" and must never simulate success.
 */
import nodemailer from 'nodemailer';
import Anthropic from '@anthropic-ai/sdk';

export interface IntegrationStatus { key: string; name: string; state: 'connected' | 'configured-untested' | 'not-configured'; detail: string; env: string[] }

// ───────────── Email ─────────────
export interface EmailProvider {
  configured: boolean;
  send(msg: { to: string; subject: string; html: string; text: string; attachments?: { filename: string; content: Buffer }[]; idempotencyKey: string }): Promise<{ accepted: boolean; providerMessageId?: string; response?: string }>;
}

export function smtpProvider(env = process.env): EmailProvider {
  const configured = !!(env.SMTP_HOST && env.SMTP_FROM);
  const transport = configured
    ? nodemailer.createTransport({ host: env.SMTP_HOST, port: Number(env.SMTP_PORT ?? 587), secure: env.SMTP_SECURE === 'true', auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined })
    : null;
  return {
    configured,
    async send(m) {
      if (!transport) throw new Error('Email provider is not configured');
      const info = await transport.sendMail({ from: env.SMTP_FROM, to: m.to, subject: m.subject, html: m.html, text: m.text, attachments: m.attachments, headers: { 'X-Idempotency-Key': m.idempotencyKey } });
      // SMTP "accepted" = accepted by the relay, not delivered to the inbox.
      return { accepted: info.accepted.length > 0 && info.rejected.length === 0, providerMessageId: info.messageId, response: info.response };
    },
  };
}

// ───────────── Zoho CRM / Projects ─────────────
export interface ZohoConfig { clientId?: string; clientSecret?: string; refreshToken?: string; accountsUrl: string; apiDomain: string; projectsPortalId?: string }
export const zohoConfig = (env = process.env): ZohoConfig => ({
  clientId: env.ZOHO_CLIENT_ID, clientSecret: env.ZOHO_CLIENT_SECRET, refreshToken: env.ZOHO_REFRESH_TOKEN,
  accountsUrl: env.ZOHO_ACCOUNTS_URL ?? 'https://accounts.zoho.com', apiDomain: env.ZOHO_API_DOMAIN ?? 'https://www.zohoapis.com', projectsPortalId: env.ZOHO_PROJECTS_PORTAL_ID,
});
export const zohoConfigured = (c: ZohoConfig) => !!(c.clientId && c.clientSecret && c.refreshToken);

export class ZohoClient {
  private token?: { value: string; exp: number };
  constructor(private c: ZohoConfig, private fetchImpl: typeof fetch = fetch) {}
  get configured() { return zohoConfigured(this.c); }
  private async accessToken(): Promise<string> {
    if (this.token && this.token.exp > Date.now() + 60_000) return this.token.value;
    const u = new URL('/oauth/v2/token', this.c.accountsUrl);
    u.search = new URLSearchParams({ refresh_token: this.c.refreshToken!, client_id: this.c.clientId!, client_secret: this.c.clientSecret!, grant_type: 'refresh_token' }).toString();
    const r = await this.fetchImpl(u, { method: 'POST' });
    const j: any = await r.json();
    if (!r.ok || !j.access_token) throw new Error(`Zoho token refresh failed: ${j.error ?? r.status}`);
    this.token = { value: j.access_token, exp: Date.now() + (j.expires_in ?? 3600) * 1000 };
    return this.token.value;
  }
  async api(method: string, path: string, body?: unknown): Promise<any> {
    if (!this.configured) throw new Error('Zoho is not configured');
    const r = await this.fetchImpl(new URL(path, this.c.apiDomain), { method, headers: { Authorization: `Zoho-oauthtoken ${await this.accessToken()}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    const j = text ? JSON.parse(text) : {};
    if (!r.ok) throw new Error(`Zoho ${method} ${path} → ${r.status}: ${text.slice(0, 300)}`);
    return j;
  }
  /** Meetings (Events) owned by a Zoho user in a window. */
  listMeetings(fromIso: string, toIso: string) {
    return this.api('POST', '/crm/v6/coql', { select_query: `select id, Event_Title, Start_DateTime, End_DateTime, Owner, What_Id, Who_Id, Venue, Description from Events where Start_DateTime between '${fromIso}' and '${toIso}' limit 200` });
  }
  updateDealStage(dealId: string, stage: string) {
    return this.api('PUT', `/crm/v6/Deals/${encodeURIComponent(dealId)}`, { data: [{ Stage: stage }], trigger: [] });
  }
}

// ───────────── AI photo assistant ─────────────
export interface AiSuggestionOut { kind: 'question' | 'concern'; text: string }
export const AI_MODEL = 'claude-opus-5-5';

export function aiConfigured(env = process.env) { return !!(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN); }

const AI_SYSTEM = `You help a deck salesperson during an on-site visit. You see one photo of an existing deck, house wall, or yard.
Return ONLY follow-up QUESTIONS the salesperson should ask or check, and VISIBLE CONCERNS worth confirming in person (e.g. unclear support layout, apparent rot or damage, uncertain ledger attachment, brick veneer, missing flashing, inaccessible areas, slope, narrow access).
Never state dimensions, quantities, prices, code compliance, structural adequacy, or concealed conditions as facts — you cannot determine those from a photo. Phrase concerns as things to verify.`;

export async function analyzePhoto(image: Buffer, mime: string, context: string): Promise<AiSuggestionOut[]> {
  const client = new Anthropic();
  const media = (['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(mime) ? mime : 'image/jpeg') as 'image/jpeg';
  const response = await client.beta.messages.create({
    model: AI_MODEL,
    max_tokens: 4000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: {
      effort: 'low',
      format: {
        type: 'json_schema',
        schema: {
          type: 'object', additionalProperties: false, required: ['items'],
          properties: { items: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['kind', 'text'], properties: { kind: { type: 'string', enum: ['question', 'concern'] }, text: { type: 'string' } } } } },
        },
      },
    },
    system: AI_SYSTEM,
    messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: media, data: image.toString('base64') } },
      { type: 'text', text: `Photo context from the salesperson: ${context || 'none'}. List at most 8 items.` },
    ] }],
  } as any);
  if ((response as any).stop_reason === 'refusal') return [];
  const text = (response.content as any[]).filter((b) => b.type === 'text').map((b) => b.text).join('');
  try {
    const parsed = JSON.parse(text);
    return (parsed.items ?? []).filter((i: any) => i && (i.kind === 'question' || i.kind === 'concern') && typeof i.text === 'string').slice(0, 8);
  } catch {
    return [];
  }
}

export function integrationStatuses(env = process.env): IntegrationStatus[] {
  const z = zohoConfig(env);
  return [
    { key: 'email', name: 'Email (SMTP)', state: smtpProvider(env).configured ? 'configured-untested' : 'not-configured', detail: 'Sends proposals from the visit. "Accepted" means accepted by your SMTP relay, not proven inbox delivery.', env: ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM'] },
    { key: 'zoho-crm', name: 'Zoho CRM', state: zohoConfigured(z) ? 'configured-untested' : 'not-configured', detail: 'Pull assigned appointments, map contacts/deals by Zoho ID, push stage changes from the outbox.', env: ['ZOHO_CLIENT_ID', 'ZOHO_CLIENT_SECRET', 'ZOHO_REFRESH_TOKEN', 'ZOHO_API_DOMAIN', 'ZOHO_ACCOUNTS_URL'] },
    { key: 'zoho-projects', name: 'Zoho Projects hand-off', state: zohoConfigured(z) && z.projectsPortalId ? 'configured-untested' : 'not-configured', detail: 'Creates the project after a VERIFIED signed contract. Hand-offs queue until configured.', env: ['ZOHO_PROJECTS_PORTAL_ID'] },
    { key: 'esign', name: 'E-signature', state: 'not-configured', detail: 'No signature provider connected. A manager can record a signed copy (upload) to complete a contract.', env: [] },
    { key: 'sms', name: 'SMS follow-ups', state: 'not-configured', detail: 'Follow-up cadence is modelled; no SMS provider is connected and nothing is sent.', env: [] },
    { key: 'ai', name: 'AI photo assistant', state: aiConfigured(env) ? 'configured-untested' : 'not-configured', detail: `Optional. Suggests questions/concerns from photos for human confirmation (model ${AI_MODEL}).`, env: ['ANTHROPIC_API_KEY'] },
  ];
}
