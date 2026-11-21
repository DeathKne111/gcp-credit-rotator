/**
 * 服务账号 JSON 校验。
 *
 * 只做结构判断并抽三个元信息，**绝不保留 private_key**，
 * 返回值里也不会出现私钥片段（防止被日志或面板顺带打印）。
 */

const REQUIRED_STRING_FIELDS = ['project_id', 'client_email', 'private_key'];

export function parseServiceAccount(text) {
    if (typeof text !== 'string' || !text.trim()) {
        return { ok: false, error: '内容为空' };
    }
    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch (error) {
        return { ok: false, error: `不是合法 JSON：${error instanceof Error ? error.message : String(error)}` };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { ok: false, error: '顶层必须是 JSON 对象' };
    }
    if (parsed.type !== 'service_account') {
        return { ok: false, error: `type 必须是 service_account，当前是 ${String(parsed.type ?? '(缺失)')}` };
    }
    for (const field of REQUIRED_STRING_FIELDS) {
        const value = parsed[field];
        if (typeof value !== 'string' || !value.trim()) {
            return { ok: false, error: `缺少必填字段 ${field}` };
        }
    }
    const email = String(parsed.client_email).trim();
    // private_key_id 稳定且不含私钥本体；缺省时退回 client_email
    const fingerprint = String(parsed.private_key_id || email).trim();
    return {
        ok: true,
        meta: {
            projectId: String(parsed.project_id).trim(),
            clientEmail: email,
            fingerprint,
            type: 'service_account',
        },
    };
}

/** label 缺省时用服务账号邮箱，和酒馆原生保存行为保持一致 */
export function defaultLabelFor(meta) {
    return meta?.clientEmail || meta?.projectId || 'Vertex Service Account';
}

/** 判断候选指纹是否已存在：先比 fingerprint，再比 label（酒馆原生 label 就是邮箱） */
export function isDuplicate(meta, existing) {
    const fp = String(meta?.fingerprint ?? '');
    const email = String(meta?.clientEmail ?? '');
    return (existing ?? []).some(item => {
        const label = String(item?.label ?? '');
        if (fp && label === fp) return true;
        if (email && label === email) return true;
        return false;
    });
}
