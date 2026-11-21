import { LOG_PREFIX, STORAGE_KEYS, DEFAULT_SETTINGS } from './constants.js';

/**
 * 本地日志：console + localStorage 双写。
 * 铁律：绝不写凭据内容（JSON 原文、private_key、access token）。
 * 只允许写 id 前 8 位、label、项目号、计数、错误摘要。
 */

function readRaw() {
    try {
        const raw = localStorage.getItem(STORAGE_KEYS.logs);
        const arr = raw ? JSON.parse(raw) : [];
        return Array.isArray(arr) ? arr : [];
    } catch {
        return [];
    }
}

function writeRaw(list, limit) {
    try {
        localStorage.setItem(STORAGE_KEYS.logs, JSON.stringify(list.slice(-limit)));
    } catch {
        /* 配额满时静默丢弃，日志不能影响主流程 */
    }
}

export function createLogger({ limit = DEFAULT_SETTINGS.logLimit } = {}) {
    let max = limit;

    function push(level, message) {
        const entry = { t: Date.now(), level, message: String(message).slice(0, 400) };
        const line = `${LOG_PREFIX} ${entry.message}`;
        try {
            if (level === 'error') console.error(line);
            else if (level === 'warn') console.warn(line);
            else console.log(line);
        } catch {
            /* ignore */
        }
        const list = readRaw();
        const last = list[list.length - 1];
        // 同一句话在 5 秒内重复（例如反复刷新页面）只更新时间，不刷屏
        if (last && last.message === entry.message && entry.t - last.t < 5000) {
            last.t = entry.t;
            writeRaw(list, max);
            return entry;
        }
        list.push(entry);
        writeRaw(list, max);
        return entry;
    }

    return {
        info: message => push('info', message),
        warn: message => push('warn', message),
        error: message => push('error', message),
        list: () => readRaw(),
        clear: () => writeRaw([], max),
        setLimit(value) {
            const n = Number(value);
            if (Number.isFinite(n) && n >= 20) max = Math.min(2000, Math.floor(n));
            writeRaw(readRaw(), max);
        },
        export: () => readRaw().map(e => `${new Date(e.t).toISOString()} [${e.level}] ${e.message}`).join('\n'),
    };
}

/** 把 id 截短用于显示与日志，避免完整 id 出现在聊天记录/截图里 */
export function shortId(id) {
    const s = String(id ?? '');
    return s ? s.slice(0, 8) : '(none)';
}
