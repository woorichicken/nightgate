// The six kinds of decision that must reach a human in the morning.
// Everything else an overnight agent may decide on its own, as long as it
// leaves a recommendation and evidence behind.
export const HUMAN_CATEGORIES = [
    {
        id: 'irreversible',
        label: 'Hard to undo',
        hint: 'deleting data or branches, force-push, rewriting history, revoking keys'
    },
    {
        id: 'external_publish',
        label: 'Goes outside',
        hint: 'git push, deploy to production, sending email/Slack/SMS, posting publicly, submitting forms'
    },
    {
        id: 'db_schema_data',
        label: 'Database schema or data',
        hint: 'migrations, ALTER/DROP, bulk updates, touching production rows'
    },
    {
        id: 'product_direction',
        label: 'Product direction',
        hint: 'scope, priorities, UX or pricing choices only the owner can make'
    },
    {
        id: 'customer_ops',
        label: 'Customer operations',
        hint: 'anything a customer sees or is billed for, support replies, refunds'
    },
    {
        id: 'account_risk',
        label: 'Account or money risk',
        hint: 'payments, credentials, permissions, paid plans, credit use, logins'
    }
] as const

export type HumanCategoryId = (typeof HUMAN_CATEGORIES)[number]['id']
export type CategoryId = HumanCategoryId | 'none'

export const CATEGORY_IDS: readonly CategoryId[] = [...HUMAN_CATEGORIES.map((c) => c.id), 'none']

export function isCategoryId(value: unknown): value is CategoryId {
    return typeof value === 'string' && (CATEGORY_IDS as readonly string[]).includes(value)
}
