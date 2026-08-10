export const DEFAULT_SELF_HOSTED_SERVER_NAME = 'Afluence Miro';

export function getSelfHostedServerName(serverName?: string | null) {
  return serverName?.trim() || DEFAULT_SELF_HOSTED_SERVER_NAME;
}
