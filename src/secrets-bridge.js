import { SECRET_KEY } from './constants.js';

/**
 * 酒馆 secrets 桥接层。
 *
 * 依据（实测自宿主的 /scripts/secrets.js）：
 *   export let secret_state = {}                       // live binding
 *   export async function readSecretState()            // 刷新 secret_state，不触发 UI
 *   export async function writeSecret(key, value, label) -> id
 *   export async function deleteSecret(key, id)        // 内部会触发 #main_api change
 *   export async function renameSecret(key, id, label)  // 同样触发
 *   export async function rotateSecret(key, id)        // 内部会触发 #main_api change
 *   requestSecret(action, body) => POST /api/secrets/<action>
 *
 * 本插件只做三件事：读列表、切换 active、增删改名。
 * 切换刻意**不调用** rotateSecret()，因为它会 `$('#main_api').trigger('change')`，
 * 生成过程中触发会让宿主重载 API 面板；改为直接 POST /api/secrets/rotate，
 * 再调 readSecretState() 刷新 live binding —— /scripts/openai.js 每次请求前
 * 用 secret_state[key].find(s => s.active) 取 secret_id，刷新后即生效。
 */

let modulePromise = null;

/** 动态导入宿主的 secrets 模块；失败时返回 null，由 REST 兜底 */
export function loadSecretsModule() {
    if (!modulePromise) {
        modulePromise = import('/scripts/secrets.js').catch(() => null);
    }
    return modulePromise;
}

function getContext() {
    return globalThis.SillyTavern?.getContext?.();
}

function requestHeaders() {
    const context = getContext();
    if (typeof context?.getRequestHeaders === 'function') {
        try {
            return context.getRequestHeaders();
        } catch {
            /* 落到下面的默认头 */
        }
    }
    return { 'Content-Type': 'application/json' };
}

async function postSecret(action, body) {
    const response = await fetch(`/api/secrets/${action}`, {
        method: 'POST',
        headers: requestHeaders(),
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
        let detail = response.statusText;
        try {
            detail = (await response.text()) || detail;
        } catch {
            /* 保留 statusText */
        }
        throw new Error(`/api/secrets/${action} ${response.status}: ${String(detail).slice(0, 160)}`);
    }
    return response;
}

/**
 * 只保留 id / label / active 三个元信息。
 *
 * 刻意不读取 `item.value`：宿主的 /api/secrets/read 可能返回明文私钥，
 * 本插件连它的长度都不取，避免任何把它带出作用域的机会。
 * 需要写回时由调用方直接把自己手上的 JSON 交给 writeSecret，与本函数无关。
 */
function normalizeList(raw) {
    if (!Array.isArray(raw)) return [];
    return raw
        .map(item => ({
            id: String(item?.id ?? ''),
            label: String(item?.label ?? ''),
            active: item?.active === true,
        }))
        .filter(item => item.id);
}

async function refreshModuleState() {
    const mod = await loadSecretsModule();
    if (typeof mod?.readSecretState === 'function') {
        try {
            await mod.readSecretState();
        } catch {
            /* 刷新失败不阻断主流程，下一次读取会再试 */
        }
    }
}

/** 读取 Vertex 服务账号条目列表（元信息） */
export async function readCredentials() {
    const mod = await loadSecretsModule();
    if (typeof mod?.readSecretState === 'function') {
        try {
            await mod.readSecretState();
            return normalizeList(mod.secret_state?.[SECRET_KEY]);
        } catch {
            /* 落到 REST */
        }
    }
    const response = await postSecret('read');
    const json = await response.json().catch(() => ({}));
    return normalizeList(json?.[SECRET_KEY]);
}

/** 切换哪一个条目生效 */
export async function activateCredential(id) {
    const target = String(id ?? '');
    if (!target) throw new Error('缺少凭据 id');
    await postSecret('rotate', { key: SECRET_KEY, id: target });
    await refreshModuleState();
    return target;
}

/** 新增条目，返回新 id。注意：酒馆语义下写入即 active，调用方需自行恢复原 active */
export async function createCredential(value, label) {
    const mod = await loadSecretsModule();
    if (typeof mod?.writeSecret === 'function') {
        const id = await mod.writeSecret(SECRET_KEY, value, label);
        await refreshModuleState();
        return String(id ?? '');
    }
    const response = await postSecret('write', { key: SECRET_KEY, value, label });
    const json = await response.json().catch(() => ({}));
    await refreshModuleState();
    return String(json?.id ?? '');
}

export async function removeCredential(id) {
    const target = String(id ?? '');
    if (!target) throw new Error('缺少凭据 id');
    const mod = await loadSecretsModule();
    if (typeof mod?.deleteSecret === 'function') {
        await mod.deleteSecret(SECRET_KEY, target);
        await refreshModuleState();
        return true;
    }
    await postSecret('delete', { key: SECRET_KEY, id: target });
    await refreshModuleState();
    return true;
}

export async function renameCredential(id, label) {
    const target = String(id ?? '');
    if (!target) throw new Error('缺少凭据 id');
    const mod = await loadSecretsModule();
    if (typeof mod?.renameSecret === 'function') {
        await mod.renameSecret(SECRET_KEY, target, label);
        await refreshModuleState();
        return true;
    }
    await postSecret('rename', { key: SECRET_KEY, id: target, label });
    await refreshModuleState();
    return true;
}

export { SECRET_KEY };
