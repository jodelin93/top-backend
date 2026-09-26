import { requestContext } from '../common/context/request-context';

/**
 * What an approval token is being used for in the current request.
 * Set by PermissionsGuard at the start of every protected request, read by
 * ApprovalsService.verify (also when a service verifies a token itself) and by
 * ApprovalUsesInterceptor, which releases the tokens of a request that failed.
 */
export interface ApprovalScope {
  // Normalised "METHOD /path" of the command, e.g. "POST /sales/<id>/void"
  action: string;
  // GET, or a preview of a command (quote, preview-close): tokens are checked, not used up
  readOnly: boolean;
  // Token ids (jti) this request has used up so far
  claimed: string[];
}

const SCOPE = Symbol('approvalScope');
type ScopedContext = { [SCOPE]?: ApprovalScope };

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const apiPrefix = () =>
  '/' + (process.env.API_PREFIX || 'api/v1').replace(/^\/+|\/+$/g, '');

function normalisePath(url: string): string {
  let path = (url.split('?')[0] || '/').replace(/\/{2,}/g, '/');
  if (!path.startsWith('/')) path = `/${path}`;
  const prefix = apiPrefix();
  if (path === prefix || path.startsWith(`${prefix}/`)) {
    path = path.slice(prefix.length) || '/';
  }
  return path.length > 1 ? path.replace(/\/+$/, '') : path;
}

/**
 * The action a request performs, for binding approvals to it.
 * A preview shares the action of the command it previews, so one approval covers
 * both (the till prices the cart with POST /sales/quote, then POST /sales):
 * - POST .../quote          → POST ...
 * - POST .../preview-<cmd>  → POST .../<cmd>
 */
export function approvalAction(
  method: string,
  url: string,
): { action: string; readOnly: boolean } {
  const verb = method.toUpperCase();
  const path = normalisePath(url);
  if (READ_METHODS.has(verb)) {
    return { action: `${verb} ${path}`, readOnly: true };
  }
  const quote = /^(.*)\/quote$/.exec(path);
  if (quote) {
    return { action: `${verb} ${quote[1] || '/'}`, readOnly: true };
  }
  const preview = /^(.*)\/preview-([a-z][a-z-]*)$/.exec(path);
  if (preview) {
    return { action: `${verb} ${preview[1]}/${preview[2]}`, readOnly: true };
  }
  return { action: `${verb} ${path}`, readOnly: false };
}

/**
 * Normalise an action sent by a client ("post /api/v1/sales/1/void?x=1" →
 * "POST /sales/1/void"); null when it isn't "METHOD /path"
 */
export function normaliseAction(value: string | null | undefined) {
  const match = /^\s*([A-Za-z]+)\s+(\S+)\s*$/.exec(value ?? '');
  return match ? approvalAction(match[1], match[2]).action : null;
}

export function beginApprovalScope(method: string, url: string): ApprovalScope {
  const scope: ApprovalScope = { ...approvalAction(method, url), claimed: [] };
  const context = requestContext.get() as ScopedContext | undefined;
  if (context) context[SCOPE] = scope;
  return scope;
}

export function currentApprovalScope(): ApprovalScope | undefined {
  return (requestContext.get() as ScopedContext | undefined)?.[SCOPE];
}
