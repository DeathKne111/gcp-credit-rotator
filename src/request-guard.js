import {
    GENERATE_PATH,
    QUOTA_PEEK_BYTES,
    QUOTA_PEEK_STATUS,
    QUOTA_STATUS,
    QUOTA_TEXT_PATTERN,
} from './constants.js';

/**
 * 只做一件事：Vertex 生成请求撞上「上游额度类错误」时，换另一个凭据补发一次。
 *
 * 依据（实测自宿主 /scripts/openai.js）：
 *   const generate_url = '/api/backends/chat-completions/generate';
 *   const response = await fetch(generate_url, { method:'POST', body: JSON.stringify(generate_data), headers: getRequestHeaders(), signal });
 *   if (!response.ok) { tryParseStreamingError(response, await response.text()); throw ... }
 *
 * 判定方式（见 classify）：
 *   1) HTTP 402 / 429 —— 直接认定为配额错误
 *   2) 400 / 403 / 5xx —— 用 clone 读响应体前 2KB，命中 RESOURCE_EXHAUSTED /
 *      quota / billing 等关键字也算配额错误
 *   3) 其它状态（含 200）—— 一律透传，不解析 SSE 流内错误
 *
 * 第 2 条是必须的：实测 ST release 的 Vertex 非流式分支会把上游非 2xx 统一包成
 * `response.status(500).send(errorJson)`，429 被吞成 500，只看状态码会漏判。
 * clone 出来的流不会影响宿主继续消费原响应。
 */

function resolveGenerateUrl(input) {
    const raw = typeof input === 'string'
        ? input
        : input instanceof URL
            ? input.href
            : input?.url;
    if (!raw) return null;
    try {
        const url = new URL(raw, globalThis.location?.origin ?? 'http://localhost');
        return url.pathname === GENERATE_PATH ? url : null;
    } catch {
        return null;
    }
}

/** 读响应体前若干字节判断是否配额错误。用 clone，不影响宿主继续消费原响应 */
async function bodyLooksQuota(response) {
    if (!response?.body) return false;
    let text = '';
    try {
        const clone = response.clone();
        const reader = clone.body.getReader();
        const decoder = new TextDecoder();
        while (text.length < QUOTA_PEEK_BYTES) {
            const { done, value } = await reader.read();
            if (done) break;
            text += decoder.decode(value, { stream: true });
        }
        try {
            await reader.cancel();
        } catch {
            /* 已结束就无所谓 */
        }
    } catch {
        return false;
    }
    return QUOTA_TEXT_PATTERN.test(text);
}

/** @returns {Promise<{quota: boolean, reason: string}>} */
async function classify(response) {
    if (QUOTA_STATUS.includes(response.status)) {
        return { quota: true, reason: `HTTP ${response.status}` };
    }
    if (!QUOTA_PEEK_STATUS.includes(response.status)) {
        return { quota: false, reason: '' };
    }
    const hit = await bodyLooksQuota(response);
    return hit
        ? { quota: true, reason: `HTTP ${response.status} + 响应体配额关键字` }
        : { quota: false, reason: '' };
}

export function installRequestGuard({ rotator, log }) {
    let original = globalThis.fetch;
    if (typeof original !== 'function') {
        log?.error('宿主缺少 fetch，请求守卫未安装');
        return () => {};
    }

    const wrapped = async function gcrFetch(input, init) {
        // 总开关关闭、或当前渠道不是 Vertex：立刻原样转发，不读 body、不解析、不做任何判断
        if (!rotator?.isActive?.()) return original.call(this, input, init);

        const url = resolveGenerateUrl(input);
        if (!url) return original.call(this, input, init);

        const method = String(init?.method ?? input?.method ?? 'GET').toUpperCase();
        if (method !== 'POST') return original.call(this, input, init);

        const rawBody = typeof init?.body === 'string' ? init.body : null;
        if (!rawBody) return original.call(this, input, init);

        let data;
        try {
            data = JSON.parse(rawBody);
        } catch {
            return original.call(this, input, init);
        }
        if (String(data?.chat_completion_source ?? '').toLowerCase() !== 'vertexai') {
            return original.call(this, input, init);
        }

        const response = await original.call(this, input, init);
        const verdict = await classify(response);
        if (!verdict.quota) return response;
        if (init?.signal?.aborted) return response;

        let nextId = '';
        try {
            nextId = await rotator.handleQuota({
                status: response.status,
                reason: verdict.reason,
                previousSecretId: data?.secret_id,
            });
        } catch (error) {
            log?.warn(`换号异常：${error?.message ?? error}`);
        }
        if (!nextId) return response;

        // 原响应不能留着不读，否则会占着连接；取消掉再补发。
        try {
            await response.body?.cancel?.();
        } catch {
            /* 已消费或不可取消都无所谓 */
        }

        try {
            const retryBody = JSON.stringify({ ...data, secret_id: nextId });
            log?.info(`${verdict.reason}，已换号补发一次`);
            return await original.call(this, input, { ...init, body: retryBody });
        } catch (error) {
            log?.error(`补发失败：${error?.message ?? error}`);
            return response;
        }
    };

    Object.defineProperty(wrapped, '__gcrGuard__', { value: true });

    /**
     * 只管安装与卸载，不在运行时抢回最外层。
     *
     * 踩过的坑（TauriTavern 2.4.0 + 托梦脚本，两次爆栈）：
     * 页面里 fetch 可能有 2~3 层别人的包装，其中至少一层把自己的上一手 fetch
     * 存在闭包里、且会再回调 window.fetch。任何"把自己套到最外层"的做法，
     * 只要踩中那条闭包链就会形成环，`RangeError: Maximum call stack size exceeded`，
     * 整个页面所有请求一起挂掉。
     *
     * 结论：守卫只在安装那一刻进入调用链，之后被别人覆盖就只能让位。
     * `isInChain()` 用于面板如实显示当前是否仍能拦到请求。
     */
    function isInChain() {
        return globalThis.fetch === wrapped;
    }

    globalThis.fetch = wrapped;

    /**
     * 卸载。只在自己仍位于最外层时还原；被包在别人里面时不动，
     * 页面重载后自然消失，避免破坏别人的调用链。
     */
    const uninstall = function uninstall() {
        if (globalThis.fetch === wrapped) {
            globalThis.fetch = original;
        }
    };
    uninstall.wrapped = wrapped;
    uninstall.isInChain = isInChain;
    return uninstall;
}
