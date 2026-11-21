/**
 * 全局常量与默认配置。
 *
 * SECRET_KEY 取值依据酒馆前端 `/scripts/secrets.js` 的
 * `SECRET_KEYS.VERTEXAI_SERVICE_ACCOUNT`，与 secrets.json 顶层 key 一致。
 */

export const EXT_ID = 'gcp_credit_rotator';
export const EXT_NAME = 'GCP 赠金轮询';
export const LOG_PREFIX = '[GCP Credit Rotator]';

/** 酒馆 secrets 里 Vertex 服务账号所在的 key（与宿主一致，勿改） */
export const SECRET_KEY = 'vertexai_service_account_json';

/** 这些 HTTP 状态本身就代表配额被拒，可直接换号 */
export const QUOTA_STATUS = Object.freeze([402, 429]);

/**
 * 其余状态码里可能也藏着配额错误。
 * 实测依据：ST release 的 Vertex 非流式分支会把上游非 2xx 统一包成
 * `response.status(500).send(errorJson)`，429 被吞掉，只看状态码会漏判；
 * 流式分支走 forwardFetchResponse 才可能透传。所以对 4xx/5xx 补读响应体。
 */
export const QUOTA_PEEK_STATUS = Object.freeze([400, 403, 413, 500, 502, 503, 504]);

/** 读响应体判断配额时最多读这么多字节，够覆盖错误 JSON 与首个 SSE 事件 */
export const QUOTA_PEEK_BYTES = 2048;

/** 上游配额/计费类错误在响应体里的关键字 */
export const QUOTA_TEXT_PATTERN = new RegExp([
    'RESOURCE_EXHAUSTED',
    'resource_exhausted',
    'exceeded your current quota',
    'insufficient_quota',
    'quotaExceeded',
    'quota_exceeded',
    'rateLimitExceeded',
    'rate_limit_exceeded',
    'BILLING_DISABLED',
    'billing_disabled',
].join('|'), 'i');

/** 生成接口路径，取自宿主 /scripts/openai.js */
export const GENERATE_PATH = '/api/backends/chat-completions/generate';

export const STORAGE_KEYS = Object.freeze({
    settings: 'gcr_settings_v1',
    stats: 'gcr_stats_v1',
    logs: 'gcr_logs_v1',
});

export const DEFAULT_SETTINGS = Object.freeze({
    // 默认关闭：装好之后什么都不做，用户在面板里手动打开才工作
    enabled: false,
    rotateEachTurn: true,
    retryOnQuota: true,
    cooldownMinutes: 10,
    logLimit: 200,
});

export const PANEL_ID = 'gcp-credit-rotator';
export const SINGLETON_KEY = '__GCP_CREDIT_ROTATOR__';
export const VERSION = '1.0.0';
