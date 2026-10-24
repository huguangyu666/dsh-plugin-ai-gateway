/**
 * Qoder 国内版适配：@magpie-community/opencode-qoder-auth 0.2.33 (MIT)。
 * https://github.com/magpie-community/plugins/tree/main/packages/qoder
 * 协议继承自 ufec/CLIProxyAPI (MIT)；完整许可见 THIRD_PARTY_NOTICES.md。
 */
import { createSubscriptionService } from './subscription-service.js'
import { QoderCNAuthPlugin } from './vendor/qoder.mjs'

export const DEFAULT_QODER_PORT = 8327
export function createQoderService(options = {}) {
  return createSubscriptionService({ port: DEFAULT_QODER_PORT, ...options,
    label: 'Qoder', providerId: 'qoder-cn', authPlugin: QoderCNAuthPlugin,
    parseQuota: value => ({ plan: value.plan || null, windows: value.windows || [] }),
  })
}
