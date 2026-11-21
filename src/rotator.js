import { DEFAULT_SETTINGS, EXT_ID, STORAGE_KEYS } from './constants.js';
import { readCredentials, activateCredential } from './secrets-bridge.js';

/**
 * 轮换状态机。
 *
 * 节奏为**每条回复后轮换**（一轮内多次请求保持同一账号）。
 * 事件依据实测自宿主 /script.js：
 *   eventSource.emit(event_types.GENERATION_STARTED, type, {...}, dryRun)
 *   eventSource.emit(event_types.GENERATION_ENDED, chat.length)
 * GENERATION_ENDED 在 abort/stop 时也可能触发，因此用 turn 对象做防重。
 */

function loadStats() {
    try {
        const raw = localStorage.getItem(STORAGE_KEYS.stats);
        const parsed = raw ? JSON.parse(raw) : null;
        if (parsed && typeof parsed === 'object') {
            return {
                byId: parsed.byId && typeof parsed.byId === 'object' ? parsed.byId : {},
                totalSwitches: Number(parsed.totalSwitches) || 0,
                totalThrottled: Number(parsed.totalThrottled) || 0,
            };
        }
    } catch {
        /* 坏数据直接重置 */
    }
    return { byId: {}, totalSwitches: 0, totalThrottled: 0 };
}

export function createRotator({ context, log }) {
    const listeners = new Set();
    let settings = readSettings();
    let credentials = [];
    let stats = loadStats();
    const cooldownUntil = new Map();
    let turn = null;
    let lastReason = '';
    let busy = false;

    function store() {
        try {
            context.extensionSettings[EXT_ID] = { ...settings };
            context.saveSettingsDebounced?.();
        } catch {
            /* 持久化失败不影响内存状态 */
        }
    }

    function readSettings() {
        try {
            const stored = context.extensionSettings?.[EXT_ID];
            if (stored && typeof stored === 'object') {
                return { ...DEFAULT_SETTINGS, ...stored };
            }
        } catch {
            /* 落到默认值 */
        }
        return { ...DEFAULT_SETTINGS };
    }

    function persistStats() {
        try {
            localStorage.setItem(STORAGE_KEYS.stats, JSON.stringify(stats));
        } catch {
            /* ignore */
        }
    }

    function notify() {
        const snap = snapshot();
        for (const listener of listeners) {
            try {
                listener(snap);
            } catch (error) {
                log?.warn(`面板刷新失败：${error?.message ?? error}`);
            }
        }
    }

    function subscribe(listener) {
        if (typeof listener !== 'function') return () => {};
        listeners.add(listener);
        try {
            listener(snapshot());
        } catch {
            /* 首次推送失败不影响订阅 */
        }
        return () => listeners.delete(listener);
    }

    function entryFor(id) {
        if (!stats.byId[id]) {
            stats.byId[id] = { label: '', switches: 0, throttled: 0, lastUsedAt: 0 };
        }
        return stats.byId[id];
    }

    function activeId() {
        return credentials.find(item => item.active)?.id ?? '';
    }

    /** 当前连接源，读宿主的 chatCompletionSettings */
    function currentSource() {
        try {
            return String(context.chatCompletionSettings?.chat_completion_source ?? '').toLowerCase();
        } catch {
            return '';
        }
    }

    /**
     * 只有当前渠道是 Vertex 时插件才工作。
     * 其它渠道一律静默：不轮换、不切凭据、不解析请求体。
     */
    function isVertexActive() {
        return currentSource() === 'vertexai';
    }

    /**
     * 真正干活的条件：用户在面板里打开了总开关，且当前渠道是 Vertex。
     * 默认关闭，所以全新安装的插件不会读 secrets、不会拦请求、不会切账号。
     */
    function isActive() {
        return settings.enabled === true && isVertexActive();
    }

    function cooldownRemainingMs(id) {
        const until = cooldownUntil.get(String(id)) ?? 0;
        return Math.max(0, until - Date.now());
    }

    function isCooling(id) {
        return cooldownRemainingMs(id) > 0;
    }

    /** 环形取下一个：优先跳过冷却中的，只有全部冷却时才退让 */
    function pickNext({ excludeId = '' } = {}) {
        if (!credentials.length) return null;
        const currentIndex = credentials.findIndex(item => item.active);
        const now = Date.now();
        const healthy = credentials.filter(item => (cooldownUntil.get(item.id) ?? 0) <= now);
        const pool = new Set((healthy.length ? healthy : credentials).map(item => item.id));

        for (let step = 1; step <= credentials.length; step += 1) {
            const candidate = credentials[((currentIndex < 0 ? 0 : currentIndex) + step) % credentials.length];
            if (!candidate || !pool.has(candidate.id)) continue;
            if (credentials.length > 1 && candidate.id === excludeId) continue;
            return candidate;
        }
        return credentials.find(item => item.id !== excludeId) ?? null;
    }

    async function switchTo(target, reason) {
        if (!target) return '';
        await activateCredential(target.id);
        credentials = credentials.map(item => ({ ...item, active: item.id === target.id }));
        const entry = entryFor(target.id);
        entry.label = target.label;
        entry.switches += 1;
        entry.lastUsedAt = Date.now();
        stats.totalSwitches += 1;
        persistStats();
        lastReason = reason;
        log?.info(`切换到 ${target.label || target.id.slice(0, 8)}（${reason}）`);
        notify();
        return target.id;
    }

    async function refresh() {
        try {
            credentials = await readCredentials();
            for (const item of credentials) {
                const entry = entryFor(item.id);
                entry.label = item.label;
            }
            persistStats();
        } catch (error) {
            log?.error(`读取凭据失败：${error?.message ?? error}`);
        }
        notify();
        return snapshot();
    }

    function snapshot() {
        const active = credentials.find(item => item.active) ?? null;
        return {
            settings: { ...settings },
            credentials: credentials.map(item => {
                const entry = stats.byId[item.id] ?? { label: item.label, switches: 0, throttled: 0, lastUsedAt: 0 };
                return {
                    ...item,
                    switches: entry.switches,
                    throttled: entry.throttled,
                    lastUsedAt: entry.lastUsedAt,
                    coolingMs: cooldownRemainingMs(item.id),
                };
            }),
            activeId: active?.id ?? '',
            activeLabel: active?.label ?? '',
            totalSwitches: stats.totalSwitches,
            totalThrottled: stats.totalThrottled,
            lastReason,
            turnActive: Boolean(turn),
            vertexActive: isVertexActive(),
            active: isActive(),
        };
    }

    function onGenerationStarted() {
        if (!isActive()) {
            turn = null;
            return;
        }
        turn = { startedAt: Date.now(), switched: false };
        notify();
    }

    async function onGenerationEnded() {
        const current = turn;
        turn = null;
        if (!current) {
            notify();
            return;
        }
        // 总开关关闭、或当前不是 Vertex 渠道：一律不动
        if (!isActive()) {
            notify();
            return;
        }
        if (!settings.enabled || !settings.rotateEachTurn) {
            notify();
            return;
        }
        if (credentials.length < 2 || busy) {
            notify();
            return;
        }
        busy = true;
        try {
            const next = pickNext({ excludeId: current.switched ? activeId() : '' });
            if (next) await switchTo(next, '本轮结束');
        } catch (error) {
            log?.warn(`轮换失败：${error?.message ?? error}`);
        } finally {
            busy = false;
            notify();
        }
    }

    /** 429/402：把当前号按冷却处理，立刻切到另一个并返回新 id */
    async function handleQuota({ status = 0, reason = '', previousSecretId = '' } = {}) {
        if (!isActive()) return '';
        if (!settings.enabled || !settings.retryOnQuota) return '';
        if (credentials.length < 2) return '';
        const label = reason || `HTTP ${status}`;
        const currentId = String(previousSecretId || activeId());
        const entry = entryFor(currentId);
        entry.throttled += 1;
        entry.label = credentials.find(item => item.id === currentId)?.label ?? entry.label;
        stats.totalThrottled += 1;
        persistStats();

        const minutes = Number(settings.cooldownMinutes) || 0;
        if (minutes > 0 && currentId) {
            cooldownUntil.set(currentId, Date.now() + minutes * 60_000);
        }
        log?.warn(`${label}，${entry.label || currentId.slice(0, 8)} 进入冷却 ${minutes} 分钟`);

        const next = pickNext({ excludeId: currentId });
        if (!next) {
            notify();
            return '';
        }
        busy = true;
        try {
            const id = await switchTo(next, label);
            if (turn) turn.switched = true;
            return id;
        } catch (error) {
            log?.error(`换号失败：${error?.message ?? error}`);
            return '';
        } finally {
            busy = false;
            notify();
        }
    }

    async function manualNext() {
        if (!isActive()) return '';
        if (credentials.length < 2) return '';
        const next = pickNext({ excludeId: activeId() });
        if (!next) return '';
        busy = true;
        try {
            return await switchTo(next, '手动切换');
        } finally {
            busy = false;
            notify();
        }
    }

    function updateSettings(patch) {
        const wasEnabled = settings.enabled === true;
        settings = { ...settings, ...patch };
        store();
        notify();
        // 从关闭切到开启：补一次凭据读取，否则面板会显示「未配置凭据」
        if (!wasEnabled && settings.enabled === true && isVertexActive()) {
            void refresh();
        }
        return { ...settings };
    }

    function clearCooldowns() {
        cooldownUntil.clear();
        notify();
    }

    return {
        refresh,
        snapshot,
        subscribe,
        onGenerationStarted,
        onGenerationEnded,
        handleQuota,
        manualNext,
        updateSettings,
        clearCooldowns,
        getSettings: () => ({ ...settings }),
        getActiveId: () => activeId(),
        isVertexActive,
        isActive,
    };
}
