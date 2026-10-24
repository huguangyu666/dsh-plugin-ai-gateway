/**
 * WorkBuddy 国内版适配：@magpie-community/opencode-workbuddy-auth 0.1.24 (MIT)。
 * https://github.com/magpie-community/plugins/tree/main/packages/workbuddy
 * 完整许可见 THIRD_PARTY_NOTICES.md；DSH 生命周期与本地鉴权共用订阅服务。
 */
import { createSubscriptionService } from './subscription-service.js'
import { WorkBuddyAuthPlugin } from './vendor/workbuddy.mjs'

export const DEFAULT_WORKBUDDY_PORT = 8326
export function createWorkBuddyService(options = {}) {
  return createSubscriptionService({ port: DEFAULT_WORKBUDDY_PORT, ...options,
    label: 'WorkBuddy', providerId: 'workbuddy', authPlugin: WorkBuddyAuthPlugin,
    parseQuota(value) {
      const credits = value.windows?.find(w => w.name === 'Credits')
      const total = typeof credits?.limit === 'number' ? credits.limit : null
      const remaining = total !== null && typeof credits?.amount === 'number' ? Math.max(0, total - credits.amount) : null
      return { plan: value.plan || null, remaining, total, percent: total > 0 && remaining !== null ? Math.round(remaining / total * 100) : null }
    },
  })
}
